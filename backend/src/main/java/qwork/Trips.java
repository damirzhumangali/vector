package qwork;

import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static qwork.Domain.error;
import static qwork.Domain.field;
import static qwork.Domain.number;

final class Trips {
    static final String SQLITE_SCHEMA = """
        CREATE TABLE IF NOT EXISTS work_trips (
            id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
            employee_id INTEGER NOT NULL REFERENCES users(id), created_by INTEGER NOT NULL REFERENCES users(id),
            destination TEXT NOT NULL, basis TEXT NOT NULL, purpose TEXT NOT NULL,
            planned_start TEXT NOT NULL, planned_end TEXT NOT NULL CHECK (planned_end > planned_start),
            started_at TEXT,
            finished_at TEXT CHECK (finished_at IS NULL OR (started_at IS NOT NULL AND finished_at >= started_at)),
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS work_trips_by_company_employee ON work_trips(company_id, employee_id, planned_start);
        CREATE UNIQUE INDEX IF NOT EXISTS work_trips_one_active ON work_trips(company_id, employee_id)
            WHERE started_at IS NOT NULL AND finished_at IS NULL;
        CREATE TABLE IF NOT EXISTS work_trip_tasks (
            trip_id INTEGER NOT NULL REFERENCES work_trips(id),
            task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id),
            PRIMARY KEY (trip_id, task_id)
        );
        CREATE TABLE IF NOT EXISTS employee_work_modes (
            employee_id INTEGER PRIMARY KEY REFERENCES users(id),
            work_mode TEXT NOT NULL CHECK (work_mode IN ('stationary', 'field'))
        );
        """;

    private static final DateTimeFormatter STAMP = new DateTimeFormatterBuilder().appendInstant(3).toFormatter();
    private static final Set<String> UNLINKABLE = Set.of("unassigned", "cancelled", "repeated", "refused");
    private static final String SELECT = """
        SELECT trip.*, employee.name AS employee_name, offer.id AS offer_id, offer.comment AS offer_comment
        FROM work_trips trip
        JOIN users employee ON employee.id = trip.employee_id AND employee.company_id = trip.company_id
        LEFT JOIN work_trip_offers offer ON offer.trip_id = trip.id AND offer.company_id = trip.company_id
        WHERE trip.company_id = ?
        """;

    record Destination(Long objectId, String name, String address) {}

    private Trips() {}

    static Map<String, Object> list(Connection db, Map<String, Object> user) throws SQLException {
        long company = number(user, "company_id");
        boolean employee = isEmployee(user);
        long employeeId = number(user, "id");
        var rows = employee
            ? Db.rows(db, SELECT + " AND trip.employee_id = ? ORDER BY trip.planned_start DESC, trip.id DESC", company, employeeId)
            : Db.rows(db, SELECT + " ORDER BY trip.planned_start DESC, trip.id DESC", company);
        var counts = new LinkedHashMap<Long, Long>();
        for (var row : Db.rows(db, """
            SELECT link.trip_id, COUNT(*) AS total
            FROM work_trip_tasks link
            JOIN work_trips trip ON trip.id = link.trip_id
            JOIN tasks task ON task.id = link.task_id AND task.company_id = trip.company_id
            WHERE trip.company_id = ?
            """ + (employee ? " AND trip.employee_id = ? AND task.assignee_id = ? AND task.status <> 'unassigned'" : "")
            + " GROUP BY link.trip_id", employee ? new Object[] {company, employeeId, employeeId} : new Object[] {company})) {
            counts.put(number(row, "trip_id"), number(row, "total"));
        }
        var trips = rows.stream().map(row -> {
            var trip = json(row);
            trip.put("taskCount", counts.getOrDefault(number(row, "id"), 0L));
            return trip;
        }).toList();
        if (!employee) return Map.of("trips", trips);
        var mode = Db.one(db, "SELECT work_mode FROM employee_work_modes WHERE employee_id = ?", employeeId);
        return Map.of("trips", trips, "workMode", mode == null ? "stationary" : mode.get("work_mode"));
    }

    static Map<String, Object> create(Connection db, Map<String, Object> user, Map<String, Object> body)
            throws SQLException {
        requireOffice(user);
        long company = number(user, "company_id");
        long employee = identifier(body.get("employeeId"), "Сотрудник");
        var destination = destination(db, user, body, null);
        String basis = field(body, "basis", "Основание", 500, true);
        String purpose = field(body, "purpose", "Цель командировки", 1000, false);
        String start = plannedTime(body, "plannedStart", "Начало командировки");
        String end = plannedTime(body, "plannedEnd", "Окончание командировки");
        long id = schedule(db, company, employee, number(user, "id"), destination, basis, purpose, start, end,
            taskIds(body.get("taskIds"), true), TripBudget.read(body.get("budget")), null);
        return report(db, user, id);
    }

    static Destination destination(Connection db, Map<String, Object> user, Map<String, Object> body, String fallback)
            throws SQLException {
        if (body.get("objectId") != null) {
            var place = Places.resolve(db, user, body);
            return new Destination(place.objectId(), place.name(), place.address());
        }
        String name = fallback == null || body.containsKey("destination")
            ? field(body, "destination", "Место назначения", 300, false) : fallback;
        return new Destination(null, name, "");
    }

    static long schedule(Connection db, long company, long employee, long actor, Destination destination, String basis,
                         String purpose, String start, String end, List<Long> taskIds, TripBudget budget,
                         TripBudget estimate) throws SQLException {
        if (end.compareTo(start) <= 0) throw error(400, "Окончание командировки должно быть позже начала.");
        lockEmployee(db, company, employee);
        if (Db.one(db, """
            SELECT id FROM work_trips WHERE company_id = ? AND employee_id = ? AND finished_at IS NULL
              AND planned_start < ? AND planned_end > ?
            """, company, employee, end, start) != null) {
            throw error(409, "У сотрудника уже есть командировка на этот период.");
        }
        validateTasks(db, company, employee, taskIds);
        long id = Db.insert(db, """
            INSERT INTO work_trips(company_id, employee_id, created_by, destination, basis, purpose,
                planned_start, planned_end, created_at, object_id, address, budget, estimate)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, company, employee, actor, destination.name(), basis, purpose, start, end, now(),
            destination.objectId(), destination.address(), TripBudget.store(budget), TripBudget.store(estimate));
        addTaskLinks(db, id, taskIds);
        return id;
    }

    static Map<String, Object> updateBudget(Connection db, Map<String, Object> user, long id, boolean estimate,
                                            Map<String, Object> body) throws SQLException {
        if (estimate) {
            if (!isEmployee(user)) throw error(403, "Оценку расходов заполняет сотрудник.");
        } else {
            requireOffice(user);
        }
        var trip = find(db, user, id);
        if (estimate && trip.get("offer_id") != null) {
            throw error(409, "Ставка уже согласована диспетчером.");
        }
        String amountColumn = estimate ? "estimate" : "budget";
        Db.update(db, "UPDATE work_trips SET " + amountColumn + " = ? WHERE id = ? AND company_id = ?",
            TripBudget.store(TripBudget.read(body)), id, number(user, "company_id"));
        return report(db, user, id);
    }

    static Map<String, Object> attachTasks(Connection db, Map<String, Object> user, long id, Map<String, Object> body)
            throws SQLException {
        requireOffice(user);
        long company = number(user, "company_id");
        long employee = number(find(db, user, id), "employee_id");
        lockEmployee(db, company, employee);
        if (find(db, user, id).get("finished_at") != null) {
            throw error(409, "Командировка уже завершена.");
        }
        var linked = new HashSet<Long>();
        for (var row : Db.rows(db, "SELECT task_id FROM work_trip_tasks WHERE trip_id = ?", id)) {
            linked.add(number(row, "task_id"));
        }
        var newIds = taskIds(body.get("taskIds"), false).stream().filter(taskId -> !linked.contains(taskId)).toList();
        if (linked.size() + newIds.size() > 50) throw error(400, "К командировке можно привязать до 50 заявок.");
        validateTasks(db, company, employee, newIds);
        addTaskLinks(db, id, newIds);
        return report(db, user, id);
    }

    static List<Long> taskIds(Object value, boolean optional) {
        if (value == null && optional) return List.of();
        if (!(value instanceof List<?> input) || (!optional && input.isEmpty()) || input.size() > 50) {
            throw error(400, optional ? "Выберите до 50 заявок сотрудника." : "Выберите от одной до 50 заявок сотрудника.");
        }
        var ids = new HashSet<Long>();
        for (var item : input) {
            if (!ids.add(identifier(item, "Заявка"))) throw error(400, "Одна заявка выбрана несколько раз.");
        }
        return ids.stream().sorted().toList();
    }

    static void validateTasks(Connection db, long company, long employee, List<Long> taskIds) throws SQLException {
        for (long taskId : taskIds) {
            Db.lockTask(db, company, taskId);
            var task = Db.one(db, """
                SELECT status FROM tasks WHERE id = ? AND company_id = ? AND assignee_id = ?
                """, taskId, company, employee);
            if (task == null || UNLINKABLE.contains(task.get("status"))) {
                throw error(400, "Выберите действующие заявки назначенного сотрудника.");
            }
            if (Db.one(db, "SELECT trip_id FROM work_trip_tasks WHERE task_id = ?", taskId) != null) {
                throw error(409, "Заявка уже связана с другой командировкой.");
            }
        }
    }

    private static void addTaskLinks(Connection db, long id, List<Long> taskIds) throws SQLException {
        for (long taskId : taskIds) {
            Db.update(db, "INSERT INTO work_trip_tasks(trip_id, task_id) VALUES (?, ?)", id, taskId);
        }
    }

    static Map<String, Object> act(Connection db, Map<String, Object> user, long id, String action) throws SQLException {
        if (!isEmployee(user)) throw error(403, "Начало и окончание отмечает сотрудник.");
        long company = number(user, "company_id");
        long employeeId = number(user, "id");
        lockEmployee(db, company, employeeId);
        var row = find(db, user, id);
        if ("start".equals(action)) {
            if (row.get("finished_at") != null) throw error(409, "Командировка уже завершена.");
            if (row.get("started_at") != null) return report(db, user, id);
            if (Db.one(db, """
                SELECT id FROM work_trips WHERE company_id = ? AND employee_id = ?
                  AND started_at IS NOT NULL AND finished_at IS NULL
                """, company, employeeId) != null) throw error(409, "Сначала завершите текущую командировку.");
            Db.update(db, "UPDATE work_trips SET started_at = ? WHERE id = ?", now(), id);
        } else if ("finish".equals(action)) {
            if (row.get("started_at") == null) throw error(409, "Сначала отметьте начало командировки.");
            if (row.get("finished_at") == null) {
                TripRoutes.requireCompleted(db, user, id);
                Db.update(db, "UPDATE work_trips SET finished_at = ? WHERE id = ?", now(), id);
            }
        } else {
            throw error(400, "Неизвестное действие с командировкой.");
        }
        return report(db, user, id);
    }

    static Map<String, Object> report(Connection db, Map<String, Object> user, long id) throws SQLException {
        var row = find(db, user, id);
        boolean employee = isEmployee(user);
        var tasks = new ArrayList<Map<String, Object>>();
        var rows = Db.rows(db, """
            SELECT task.id, task.title, task.object, task.status, task.deadline
            FROM work_trip_tasks link JOIN tasks task ON task.id = link.task_id
            WHERE link.trip_id = ? AND task.company_id = ?
            """ + (employee ? " AND task.assignee_id = ? AND task.status <> 'unassigned'" : "") + " ORDER BY task.id",
            employee ? new Object[] {id, number(user, "company_id"), number(user, "id")}
                : new Object[] {id, number(user, "company_id")});
        long completed = 0;
        long awaitingReview = 0;
        for (var item : rows) {
            var task = new LinkedHashMap<String, Object>(item);
            task.put("id", item.get("id").toString());
            tasks.add(task);
            if ("done".equals(item.get("status"))) completed++;
            if ("review".equals(item.get("status"))) awaitingReview++;
        }
        var trip = json(row);
        trip.put("taskCount", tasks.size());
        trip.put("stops", TripRoutes.forTrip(db, user, id));
        trip.put("actualExpenses", TripActualExpenses.read(db, row));
        Long elapsed = null;
        if (row.get("finished_at") instanceof String finish && row.get("started_at") instanceof String start) {
            elapsed = Duration.between(Instant.parse(start), Instant.parse(finish)).toMinutes();
        }
        var summary = new LinkedHashMap<String, Object>();
        summary.put("completed", completed);
        summary.put("awaitingReview", awaitingReview);
        summary.put("elapsedMinutes", elapsed);
        return Map.of("trip", trip, "tasks", tasks, "summary", summary);
    }

    static void requireOffice(Map<String, Object> user) {
        if (!Set.of("dispatcher", "manager").contains(user.get("role"))) {
            throw error(403, "Раздел доступен диспетчеру и руководителю.");
        }
    }

    static void lockEmployee(Connection db, long company, long employee) throws SQLException {
        if (Db.one(db, "SELECT id FROM users WHERE company_id = ? AND id = ? AND role = 'employee'"
                + (Db.postgres() ? " FOR UPDATE" : ""), company, employee) == null) {
            throw error(400, "Выберите сотрудника вашей компании.");
        }
    }

    static long identifier(Object value, String label) {
        if (value instanceof String || value instanceof Number) {
            try {
                long id = Long.parseLong(value.toString());
                if (id > 0) return id;
            } catch (NumberFormatException invalid) {
                // Large and fractional identifiers are invalid as well.
            }
        }
        throw error(400, "Проверьте поле «" + label + "».");
    }

    static String status(Map<String, Object> row) {
        if (row.get("finished_at") != null) return "finished";
        return row.get("started_at") == null ? "planned" : "active";
    }

    static Map<String, Object> find(Connection db, Map<String, Object> user, long id) throws SQLException {
        var row = Db.one(db, SELECT + " AND trip.id = ?", number(user, "company_id"), id);
        if (row == null || (isEmployee(user) && number(row, "employee_id") != number(user, "id"))) {
            throw error(404, "Командировка не найдена.");
        }
        return row;
    }

    static boolean isEmployee(Map<String, Object> user) {
        return "employee".equals(user.get("role"));
    }

    static String plannedTime(Map<String, Object> body, String key, String label) {
        try {
            String time = STAMP.format(OffsetDateTime.parse(field(body, key, label, 40, false)).toInstant());
            if (time.length() == 24) return time;
        } catch (DateTimeParseException invalid) {
            // Only four-digit UTC years sort chronologically in the stored text format.
        }
        throw error(400, "Проверьте дату и время в поле «" + label + "».");
    }

    static String now() {
        return STAMP.format(Instant.now());
    }

    private static Map<String, Object> json(Map<String, Object> row) {
        var out = new LinkedHashMap<String, Object>();
        out.put("id", row.get("id").toString());
        out.put("employeeId", row.get("employee_id").toString());
        out.put("employeeName", row.get("employee_name"));
        out.put("destination", row.get("destination"));
        out.put("objectId", row.get("object_id") == null ? null : row.get("object_id").toString());
        out.put("address", row.get("address"));
        out.put("basis", row.get("basis"));
        out.put("purpose", row.get("purpose"));
        out.put("offerId", row.get("offer_id") == null ? null : row.get("offer_id").toString());
        out.put("comment", row.get("offer_comment"));
        out.put("plannedStart", row.get("planned_start"));
        out.put("plannedEnd", row.get("planned_end"));
        out.put("startedAt", row.get("started_at"));
        out.put("finishedAt", row.get("finished_at"));
        out.put("status", status(row));
        long days = TripBudget.plannedDays(row);
        out.put("plannedDays", days);
        out.put("budget", TripBudget.json(row.get("budget"), days));
        out.put("estimate", TripBudget.json(row.get("estimate"), days));
        return out;
    }
}
