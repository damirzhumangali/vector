package qwork;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

import static qwork.Domain.error;
import static qwork.Domain.field;
import static qwork.Domain.number;

final class TripRequests {
    static final String SQLITE_SCHEMA = """
        CREATE TABLE IF NOT EXISTS work_trip_requests (
            id INTEGER PRIMARY KEY,
            company_id INTEGER NOT NULL REFERENCES companies(id),
            employee_id INTEGER NOT NULL REFERENCES users(id),
            destination TEXT NOT NULL, purpose TEXT NOT NULL,
            planned_start TEXT NOT NULL, planned_end TEXT NOT NULL CHECK (planned_end > planned_start),
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
            reason TEXT NOT NULL DEFAULT '',
            trip_id INTEGER UNIQUE REFERENCES work_trips(id),
            created_at TEXT NOT NULL,
            decided_at TEXT,
            decided_by INTEGER REFERENCES users(id),
            CHECK ((status = 'approved') = (trip_id IS NOT NULL)),
            CHECK ((status = 'pending') = (decided_at IS NULL)),
            CHECK ((decided_at IS NULL) = (decided_by IS NULL)),
            CHECK (status <> 'declined' OR reason <> '')
        );
        CREATE INDEX IF NOT EXISTS work_trip_requests_by_company_employee
            ON work_trip_requests(company_id, employee_id, status, created_at);
        CREATE TABLE IF NOT EXISTS work_trip_request_tasks (
            request_id INTEGER NOT NULL REFERENCES work_trip_requests(id),
            task_id INTEGER NOT NULL REFERENCES tasks(id),
            PRIMARY KEY (request_id, task_id)
        );
        """;

    private static final String SELECT = """
        SELECT r.*, employee.name AS employee_name,
            trip.planned_start AS approved_start, trip.planned_end AS approved_end
        FROM work_trip_requests r
        JOIN users employee ON employee.id = r.employee_id AND employee.company_id = r.company_id
        LEFT JOIN work_trips trip ON trip.id = r.trip_id AND trip.company_id = r.company_id
        WHERE r.company_id = ?
        """;
    private TripRequests() {}

    static Map<String, Object> list(Connection db, Map<String, Object> user) throws SQLException {
        long company = number(user, "company_id");
        boolean employee = Trips.isEmployee(user);
        if (!employee) Trips.requireOffice(user);
        String order = " ORDER BY CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, r.created_at DESC, r.id DESC";
        String scope = employee ? " AND r.employee_id = ?" : "";
        Object[] parameters = employee ? new Object[] {company, number(user, "id")} : new Object[] {company};
        var rows = Db.rows(db, SELECT + scope + order, parameters);
        return Map.of("requests", details(db, rows, scope, parameters));
    }

    static Map<String, Object> decide(Connection db, Map<String, Object> user, long id, Map<String, Object> body)
            throws SQLException {
        Trips.requireOffice(user);
        long company = number(user, "company_id");
        long actor = number(user, "id");
        String decision = field(body, "decision", "Решение", 7, false);
        if (!"approve".equals(decision) && !"decline".equals(decision)) throw error(400, "Выберите решение по запросу.");
        String reason = field(body, "reason", "Причина", 500, "approve".equals(decision));
        long employee = number(find(db, company, id), "employee_id");
        Trips.lockEmployee(db, company, employee);
        var row = find(db, company, id);
        String nextStatus = "approve".equals(decision) ? "approved" : "declined";
        if (nextStatus.equals(row.get("status"))) return result(db, company, id);
        if (!"pending".equals(row.get("status"))) throw error(409, "По запросу уже принято решение.");

        Long tripId = null;
        if ("approve".equals(decision)) {
            String start = body.containsKey("plannedStart") ? Trips.plannedTime(body, "plannedStart", "Начало командировки")
                : (String) row.get("planned_start");
            String end = body.containsKey("plannedEnd") ? Trips.plannedTime(body, "plannedEnd", "Окончание командировки")
                : (String) row.get("planned_end");
            var taskIds = body.containsKey("taskIds") ? Trips.taskIds(body.get("taskIds"), true)
                : taskIds(db, id, company, employee);
            var destination = Trips.destination(db, user, body, (String) row.get("destination"));
            tripId = Trips.schedule(db, company, employee, actor, destination, "Запрос сотрудника",
                (String) row.get("purpose"), start, end, taskIds, TripBudget.read(body.get("budget")),
                TripBudget.load(row.get("estimate")));
        }
        Db.update(db, """
            UPDATE work_trip_requests SET status = ?, reason = ?, trip_id = ?, decided_at = ?, decided_by = ?
            WHERE company_id = ? AND id = ?
            """, nextStatus, reason, tripId, Trips.now(), actor, company, id);
        return result(db, company, id);
    }

    private static Map<String, Object> result(Connection db, long company, long id) throws SQLException {
        var row = find(db, company, id);
        return Map.of("request", details(db, List.of(row), " AND r.id = ?", company, id).getFirst());
    }

    private static Map<String, Object> find(Connection db, long company, long id) throws SQLException {
        var row = Db.one(db, SELECT + " AND r.id = ?", company, id);
        if (row == null) throw error(404, "Запрос на командировку не найден.");
        return row;
    }

    private static List<Long> taskIds(Connection db, long id, long company, long employee) throws SQLException {
        return Db.rows(db, """
            SELECT link.task_id FROM work_trip_request_tasks link
            JOIN tasks task ON task.id = link.task_id
            WHERE link.request_id = ? AND task.company_id = ? AND task.assignee_id = ?
            ORDER BY link.task_id
            """, id, company, employee).stream().map(row -> number(row, "task_id")).toList();
    }

    private static List<Map<String, Object>> details(Connection db, List<Map<String, Object>> requests,
                                                       String scope, Object... parameters) throws SQLException {
        if (requests.isEmpty()) return List.of();
        var taskIds = new LinkedHashMap<Long, List<String>>();
        for (var row : Db.rows(db, """
            SELECT r.id AS request_id, task.id AS task_id FROM work_trip_requests r
            JOIN work_trip_request_tasks link ON link.request_id = r.id
            JOIN tasks task ON task.id = link.task_id AND task.company_id = r.company_id AND task.assignee_id = r.employee_id
            WHERE r.company_id = ?
            """ + scope + " ORDER BY r.id, task.id", parameters)) {
            taskIds.computeIfAbsent(number(row, "request_id"), key -> new ArrayList<>()).add(row.get("task_id").toString());
        }
        boolean pending = requests.stream().anyMatch(row -> "pending".equals(row.get("status")));
        var conflicts = pending ? TripScheduleConflicts.read(db, TripScheduleConflicts.Source.REQUEST, scope, parameters)
            : Map.<Long, TripScheduleConflicts.Conflicts>of();
        return requests.stream().map(row -> {
            long id = number(row, "id");
            return json(row, taskIds.getOrDefault(id, List.of()),
                conflicts.getOrDefault(id, TripScheduleConflicts.EMPTY).json());
        }).toList();
    }

    private static Map<String, Object> json(Map<String, Object> row, List<String> taskIds, Map<String, Object> conflicts) {
        var out = new LinkedHashMap<String, Object>();
        out.put("id", row.get("id").toString());
        out.put("employeeId", row.get("employee_id").toString());
        out.put("employeeName", row.get("employee_name"));
        out.put("destination", row.get("destination"));
        out.put("purpose", row.get("purpose"));
        out.put("plannedStart", row.get("planned_start"));
        out.put("plannedEnd", row.get("planned_end"));
        out.put("approvedStart", row.get("approved_start"));
        out.put("approvedEnd", row.get("approved_end"));
        out.put("status", row.get("status"));
        out.put("reason", row.get("reason"));
        out.put("tripId", Objects.toString(row.get("trip_id"), null));
        out.put("createdAt", row.get("created_at"));
        out.put("decidedAt", row.get("decided_at"));
        long days = TripBudget.plannedDays(row);
        out.put("plannedDays", days);
        out.put("estimate", TripBudget.json(row.get("estimate"), days));
        out.put("taskIds", taskIds);
        out.put("conflicts", conflicts);
        return out;
    }

}
