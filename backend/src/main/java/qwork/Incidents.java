package qwork;

import java.sql.Connection;
import java.sql.SQLException;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

import static qwork.Domain.error;
import static qwork.Domain.field;
import static qwork.Domain.number;

final class Incidents {
    private static final ZoneId COMPANY_ZONE = ZoneId.of("Asia/Almaty");
    private static final Set<String> NOT_STARTED = Set.of("assigned", "accepted", "travel", "arrived");
    private static final Set<String> IN_PROGRESS = Set.of("work", "rework", "paused");
    private static final String SELECT = """
        SELECT i.*, u.name AS employee_name, t.title AS task_title
        FROM incidents i JOIN users u ON u.id = i.employee_id
        LEFT JOIN tasks t ON t.id = i.task_id
        WHERE i.company_id = ?
        """;
    private static final String RECENT = " ORDER BY CASE WHEN i.status = 'open' THEN 0 ELSE 1 END, i.id DESC LIMIT 150";

    static final String SQLITE_SCHEMA = """
        CREATE TABLE IF NOT EXISTS incidents (
            id INTEGER PRIMARY KEY,
            company_id INTEGER NOT NULL REFERENCES companies(id),
            employee_id INTEGER NOT NULL REFERENCES users(id),
            reporter_id INTEGER NOT NULL REFERENCES users(id),
            task_id INTEGER REFERENCES tasks(id),
            kind TEXT NOT NULL CHECK (kind IN ('urgent_leave', 'lateness', 'emergency')),
            status TEXT NOT NULL DEFAULT 'open',
            reason TEXT NOT NULL,
            safe INTEGER CHECK (safe IS NULL OR safe IN (0, 1)),
            minutes INTEGER,
            event_uuid TEXT,
            occurred_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            decision_reason TEXT,
            decided_at TEXT,
            decided_by INTEGER REFERENCES users(id),
            UNIQUE (company_id, employee_id, event_uuid)
        );
        CREATE INDEX IF NOT EXISTS incidents_company_recent ON incidents(company_id, id);
        CREATE UNIQUE INDEX IF NOT EXISTS incidents_open_leave ON incidents(company_id, employee_id)
            WHERE kind = 'urgent_leave' AND status = 'open';
        CREATE UNIQUE INDEX IF NOT EXISTS incidents_open_emergency ON incidents(company_id, task_id)
            WHERE kind = 'emergency' AND status = 'open';
        CREATE TABLE IF NOT EXISTS incident_tasks (
            incident_id INTEGER NOT NULL REFERENCES incidents(id),
            task_id INTEGER NOT NULL REFERENCES tasks(id),
            original_status TEXT NOT NULL,
            transferred_to INTEGER REFERENCES users(id),
            PRIMARY KEY (incident_id, task_id)
        );
        """;

    private Incidents() {}

    static Map<String, Object> list(Connection db, Map<String, Object> user) throws SQLException {
        long company = number(user, "company_id");
        List<Map<String, Object>> rows = employee(user)
            ? Db.rows(db, SELECT + " AND i.employee_id = ?" + RECENT, company, number(user, "id"))
            : Db.rows(db, SELECT + RECENT, company);
        var items = new ArrayList<Map<String, Object>>(rows.size());
        for (var row : rows) items.add(json(db, row));
        return Map.of("incidents", items);
    }

    static Map<String, Object> create(Connection db, Map<String, Object> user, Map<String, Object> payload)
            throws SQLException {
        String kind = field(payload, "kind", "Тип события", 20, false);
        return switch (kind) {
            case "urgent_leave" -> urgentLeave(db, user, payload);
            case "lateness" -> lateness(db, user, payload);
            case "emergency" -> emergency(db, user, payload);
            default -> throw error(400, "Неизвестный тип события.");
        };
    }

    private static Map<String, Object> urgentLeave(Connection db, Map<String, Object> user,
                                                   Map<String, Object> payload) throws SQLException {
        requireEmployee(user);
        long company = number(user, "company_id");
        long actor = number(user, "id");
        String reason = field(payload, "reason", "Причина срочного ухода", 500, false);
        if (!(payload.get("safe") instanceof Boolean safe)) {
            throw error(400, "Укажите, безопасно ли оставлен объект.");
        }
        String eventId = field(payload, "eventId", "Идентификатор срочного ухода", 36, false)
            .toLowerCase(java.util.Locale.ROOT);
        if (!eventId.matches("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")) {
            throw error(400, "Некорректный идентификатор срочного ухода.");
        }
        lockCompany(db, company);
        var previous = Db.one(db, SELECT + " AND i.employee_id = ? AND i.event_uuid = ?", company, actor, eventId);
        if (previous != null) {
            if (!reason.equals(previous.get("reason")) || (number(previous, "safe") != 0) != safe
                || (payload.get("occurredAt") != null && !parseTime(payload.get("occurredAt")).equals(Instant.parse((String) previous.get("occurred_at"))))) {
                throw error(409, "Идентификатор уже использован для другого срочного ухода.");
            }
            return Map.of("incident", json(db, previous));
        }
        var openLeave = Db.one(db, SELECT + " AND i.employee_id = ? AND i.kind = 'urgent_leave' AND i.status = 'open'", company, actor);
        if (openLeave != null) {
            throw error(409, "Срочный уход уже отмечен. Сначала отметьте возвращение.");
        }
        Instant now = Instant.now();
        Instant occurred = payload.get("occurredAt") == null ? now : parseTime(payload.get("occurredAt"));
        if (occurred.isAfter(now.plus(5, ChronoUnit.MINUTES)) || occurred.isBefore(now.minus(7, ChronoUnit.DAYS))) {
            throw error(400, "Проверьте время срочного ухода.");
        }
        Shift.setAvailable(db, company, actor, false);
        long id = add(db, company, actor, actor, null, "urgent_leave", reason, safe ? 1 : 0, null, eventId, occurred);
        var active = Db.rows(db, """
            SELECT id FROM tasks WHERE company_id = ? AND assignee_id = ?
                AND status IN ('assigned','accepted','travel','arrived','work','rework','paused')
                ORDER BY id
            """, company, actor);
        String transitionReason = safe ? "Срочный уход сотрудника: " + reason : "Срочный уход, объект оставлен небезопасно: " + reason;
        for (var item : active) {
            long taskId = number(item, "id");
            Db.lockTask(db, company, taskId);
            var task = task(db, company, taskId);
            if (number(task, "assignee_id") != actor) continue;
            String status = (String) task.get("status");
            if (NOT_STARTED.contains(status) || IN_PROGRESS.contains(status)) {
                linkTask(db, id, taskId, status);
                changeStatus(db, user, taskId, status, NOT_STARTED.contains(status) ? "unassigned" : "paused",
                    transitionReason, occurred, now);
            }
        }
        return response(db, user, id);
    }

    private static Map<String, Object> lateness(Connection db, Map<String, Object> user,
                                                 Map<String, Object> payload) throws SQLException {
        requireEmployee(user);
        long company = number(user, "company_id");
        long actor = number(user, "id");
        String reason = field(payload, "reason", "Причина опоздания", 500, false);
        Object reported = payload.get("minutes");
        if (!(reported instanceof Integer || reported instanceof Long)
            || ((Number) reported).longValue() < 1 || ((Number) reported).longValue() > 1440) {
            throw error(400, "Укажите продолжительность опоздания от 1 до 1440 минут.");
        }
        Long taskId = payload.get("taskId") == null ? null : id(payload, "taskId", "Заявка");
        if (taskId != null && number(task(db, company, taskId), "assignee_id") != actor) {
            throw error(404, "Заявка не найдена.");
        }
        long id = add(db, company, actor, actor, taskId, "lateness", reason, null,
            ((Number) reported).intValue(), null, Instant.now());
        return response(db, user, id);
    }

    private static Map<String, Object> emergency(Connection db, Map<String, Object> user,
                                                  Map<String, Object> payload) throws SQLException {
        Accounts.requireDispatcher(user);
        long company = number(user, "company_id");
        long actor = number(user, "id");
        long assignee = id(payload, "assigneeId", "Исполнитель");
        long taskId = id(payload, "taskId", "Заявка");
        String reason = field(payload, "reason", "Причина аварийного назначения", 500, false);
        lockCompany(db, company);
        requireAssignee(db, company, assignee);
        Shift.requireAvailable(db, company, assignee);
        Db.lockTask(db, company, taskId);
        if (!"assigned".equals(task(db, company, taskId).get("status"))) {
            throw error(409, "Аварийное назначение доступно для заявки в статусе «Назначена».");
        }
        if (Db.one(db, SELECT + " AND i.task_id = ? AND i.kind = 'emergency' AND i.status = 'open'", company, taskId) != null) {
            throw error(409, "Для заявки уже ожидается ответ сотрудника.");
        }
        return response(db, user, add(db, company, assignee, actor, taskId, "emergency", reason, null, null, null, Instant.now()));
    }

    static Map<String, Object> decide(Connection db, Map<String, Object> user, long incidentId,
                                      Map<String, Object> payload) throws SQLException {
        long company = number(user, "company_id");
        long actor = number(user, "id");
        String action = field(payload, "action", "Решение", 20, false);
        lockCompany(db, company);
        var incident = incident(db, user, incidentId);
        if (!"open".equals(incident.get("status"))) {
            throw error(409, "Решение по событию уже принято.");
        }
        long employee = number(incident, "employee_id");
        String kind = (String) incident.get("kind");
        String status;
        String reason;
        switch (kind) {
            case "urgent_leave":
                requireEmployee(user);
                if (!"return".equals(action)) throw error(400, "Выберите действие «Вернуться к работе».");
                Shift.setAvailable(db, company, employee, true);
                status = "returned";
                reason = "";
                break;
            case "lateness":
                if (!"manager".equals(user.get("role"))) {
                    throw error(403, "Решение об опоздании принимает руководитель.");
                }
                if (!Set.of("approve", "reject").contains(action)) throw error(400, "Выберите решение об опоздании.");
                reason = field(payload, "reason", "Причина решения", 500, !"reject".equals(action));
                if ("approve".equals(action)) checkLatenessAllowance(db, company, employee, incident);
                status = "approve".equals(action) ? "approved" : "rejected";
                break;
            case "emergency":
                requireEmployee(user);
                if (!Set.of("accept", "decline").contains(action)) throw error(400, "Примите или отклоните назначение.");
                reason = field(payload, "reason", "Причина отказа", 500, !"decline".equals(action));
                if ("accept".equals(action)) acceptEmergency(db, user, incident);
                status = "accept".equals(action) ? "accepted" : "declined";
                break;
            default: throw error(409, "Неизвестное событие.");
        }
        Db.update(db, "UPDATE incidents SET status = ?, decision_reason = ?, decided_at = ?, decided_by = ? WHERE id = ?",
            status, reason, Instant.now().toString(), actor, incidentId);
        return response(db, user, incidentId);
    }

    private static void checkLatenessAllowance(Connection db, long company, long employee, Map<String, Object> incident)
            throws SQLException {
        if (number(incident, "minutes") > 30) {
            throw error(409, "Можно обосновать опоздание не более чем на 30 минут.");
        }
        var day = Instant.parse((String) incident.get("occurred_at")).atZone(COMPANY_ZONE).toLocalDate().withDayOfMonth(1);
        String start = day.atStartOfDay(COMPANY_ZONE).toInstant().toString();
        String end = day.plusMonths(1).atStartOfDay(COMPANY_ZONE).toInstant().toString();
        var count = Db.one(db, """
            SELECT COUNT(*) AS total FROM incidents
            WHERE company_id = ? AND employee_id = ? AND kind = 'lateness' AND status = 'approved'
                AND occurred_at >= ? AND occurred_at < ?
            """, company, employee, start, end);
        if (number(count, "total") >= 3) {
            throw error(409, "За этот месяц уже обоснованы три опоздания.");
        }
    }

    private static void acceptEmergency(Connection db, Map<String, Object> user, Map<String, Object> incident)
            throws SQLException {
        long company = number(user, "company_id");
        long worker = number(user, "id");
        long taskId = number(incident, "task_id");
        Shift.requireAvailable(db, company, worker);
        Db.lockTask(db, company, taskId);
        var target = task(db, company, taskId);
        if (!"assigned".equals(target.get("status"))) {
            throw error(409, "Состояние аварийной заявки изменилось. Обратитесь к диспетчеру.");
        }
        var activeEmergency = Db.one(db, """
            SELECT i.id FROM incidents i JOIN tasks t ON t.id = i.task_id
            WHERE i.company_id = ? AND i.employee_id = ? AND i.kind = 'emergency' AND i.status = 'accepted'
              AND t.status NOT IN ('review', 'done', 'cancelled', 'repeated', 'unassigned')
            LIMIT 1
            """, company, worker);
        if (activeEmergency != null) {
            throw error(409, "Сначала завершите текущую аварийную заявку.");
        }
        var active = Db.rows(db, """
            SELECT id FROM tasks WHERE company_id = ? AND assignee_id = ? AND status IN ('work', 'rework') ORDER BY id
            """, company, worker);
        for (var item : active) {
            long current = number(item, "id");
            Db.lockTask(db, company, current);
            var task = task(db, company, current);
            if (number(task, "assignee_id") == worker && Set.of("work", "rework").contains(task.get("status"))) {
                String oldStatus = (String) task.get("status");
                linkTask(db, number(incident, "id"), current, oldStatus);
                changeStatus(db, user, current, oldStatus, "paused", "Работа приостановлена из-за аварийного назначения.");
            }
        }
        Db.update(db, "UPDATE tasks SET assignee_id = ?, status = 'accepted', revision = revision + 1 WHERE id = ?", worker, taskId);
        event(db, user, taskId, "accepted", "Принято аварийное назначение.");
    }

    static Map<String, Object> transfer(Connection db, Map<String, Object> user, long incidentId,
                                        Map<String, Object> payload) throws Exception {
        requireOffice(user);
        var incident = incident(db, user, incidentId);
        if (!"urgent_leave".equals(incident.get("kind"))) throw error(409, "Передача доступна для срочного ухода.");
        long taskId = id(payload, "taskId", "Заявка");
        long assigneeId = id(payload, "assigneeId", "Исполнитель");
        long company = number(user, "company_id");
        requireAssignee(db, company, assigneeId);
        Shift.requireAvailable(db, company, assigneeId);
        Db.lockTask(db, company, taskId);
        if (Db.one(db, "SELECT task_id FROM incident_tasks WHERE incident_id = ? AND task_id = ? AND transferred_to IS NULL",
                   incidentId, taskId) == null || number(task(db, company, taskId), "assignee_id") != number(incident, "employee_id")) {
            throw error(404, "Заявка не ожидает передачи в этом событии.");
        }
        var result = new LinkedHashMap<>(reassign(db, user, taskId, assigneeId));
        result.put("incident", json(db, incident(db, user, incidentId)));
        return result;
    }

    static Map<String, Object> reassign(Connection db, Map<String, Object> user, long taskId, long assigneeId)
            throws Exception {
        requireOffice(user);
        long company = number(user, "company_id");
        requireAssignee(db, company, assigneeId);
        Shift.requireAvailable(db, company, assigneeId);
        Db.lockTask(db, company, taskId);
        var task = task(db, company, taskId);
        String status = (String) task.get("status");
        if (!Set.of("paused", "unassigned").contains(status)) {
            throw error(409, "Передать можно приостановленную заявку или заявку без исполнителя.");
        }
        if (assigneeId == number(task, "assignee_id") && !"unassigned".equals(status)) {
            throw error(409, "Выберите другого сотрудника.");
        }
        String newStatus = status.equals("unassigned") ? "assigned" : "paused";
        Db.update(db, """
            UPDATE tasks SET assignee_id = ?, status = ?, revision = revision + 1,
                arrival = CASE WHEN status = 'unassigned' THEN NULL ELSE arrival END
            WHERE id = ?
            """, assigneeId, newStatus, taskId);
        Db.update(db, """
            UPDATE incident_tasks SET transferred_to = ? WHERE task_id = ? AND transferred_to IS NULL
                AND incident_id IN (SELECT id FROM incidents WHERE company_id = ? AND kind = 'urgent_leave')
            """, assigneeId, taskId, company);
        var assignee = Db.one(db, "SELECT name FROM users WHERE id = ? AND company_id = ?", assigneeId, company);
        event(db, user, taskId, newStatus, "Заявка передана: " + assignee.get("name"));
        return Tasks.taskResponse(db, user, taskId);
    }

    static void markForHandoff(Connection db, Map<String, Object> user, long taskId, String reason)
            throws SQLException {
        long company = number(user, "company_id");
        Db.lockTask(db, company, taskId);
        var task = task(db, company, taskId);
        if (employee(user) && number(task, "assignee_id") != number(user, "id")) {
            throw error(404, "Заявка не найдена.");
        }
        String status = (String) task.get("status");
        if (NOT_STARTED.contains(status)) changeStatus(db, user, taskId, status, "unassigned", reason);
        else if (IN_PROGRESS.contains(status)) changeStatus(db, user, taskId, status, "paused", reason);
        else throw error(409, "На этом этапе заявка недоступна для передачи.");
    }

    private static long add(Connection db, long company, long employee, long reporter, Long taskId, String kind,
                            String reason, Integer safe, Integer minutes, String eventId, Instant occurred)
            throws SQLException {
        return Db.insert(db, """
            INSERT INTO incidents(company_id, employee_id, reporter_id, task_id, kind, reason, safe,
                minutes, event_uuid, occurred_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, company, employee, reporter, taskId, kind, reason, safe, minutes, eventId,
            occurred.toString(), Instant.now().toString());
    }

    private static void linkTask(Connection db, long incident, long task, String status) throws SQLException {
        Db.update(db, "INSERT INTO incident_tasks(incident_id, task_id, original_status) VALUES (?, ?, ?)", incident, task, status);
    }

    private static void changeStatus(Connection db, Map<String, Object> user, long taskId,
                                     String oldStatus, String newStatus, String reason) throws SQLException {
        if (oldStatus.equals(newStatus)) return;
        Db.update(db, "UPDATE tasks SET status = ?, revision = revision + 1 WHERE id = ?", newStatus, taskId);
        event(db, user, taskId, newStatus, reason);
    }

    private static void changeStatus(Connection db, Map<String, Object> user, long taskId,
                                     String oldStatus, String newStatus, String reason,
                                     Instant occurredAt, Instant receivedAt) throws SQLException {
        if (oldStatus.equals(newStatus)) return;
        var latest = Db.one(db, "SELECT created_at FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 1", taskId);
        Instant effectiveAt = occurredAt;
        if (latest != null) {
            Instant lastEvent = Instant.parse((String) latest.get("created_at"));
            if (occurredAt.isBefore(lastEvent)) {
                effectiveAt = lastEvent.isAfter(receivedAt) ? lastEvent : receivedAt;
                reason += " Изменение статуса применено при синхронизации: после времени ухода заявка уже менялась.";
            }
        }
        Db.update(db, "UPDATE tasks SET status = ?, revision = revision + 1 WHERE id = ?", newStatus, taskId);
        event(db, user, taskId, newStatus, reason, effectiveAt, receivedAt);
    }

    private static void event(Connection db, Map<String, Object> user, long taskId, String status, String reason)
            throws SQLException {
        Instant now = Instant.now();
        event(db, user, taskId, status, reason, now, now);
    }

    private static void event(Connection db, Map<String, Object> user, long taskId, String status, String reason,
                              Instant occurredAt, Instant receivedAt) throws SQLException {
        Db.update(db, """
            INSERT INTO task_events(task_id, status, actor_id, actor_name, created_at, reason, received_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """, taskId, status, user.get("id"), user.get("name"), occurredAt.toString(), reason, receivedAt.toString());
    }

    private static void lockCompany(Connection db, long company) throws SQLException {
        if (Db.postgres()) Db.one(db, "SELECT id FROM companies WHERE id = ? FOR NO KEY UPDATE", company);
    }

    private static Map<String, Object> incident(Connection db, Map<String, Object> user, long id) throws SQLException {
        var incident = Db.one(db, SELECT + " AND i.id = ?", number(user, "company_id"), id);
        if (incident == null || (employee(user) && number(incident, "employee_id") != number(user, "id"))) {
            throw error(404, "Событие не найдено.");
        }
        return incident;
    }

    private static Map<String, Object> task(Connection db, long company, long id) throws SQLException {
        var task = Db.one(db, "SELECT id, assignee_id, status FROM tasks WHERE company_id = ? AND id = ?", company, id);
        if (task == null) throw error(404, "Заявка не найдена.");
        return task;
    }

    private static void requireAssignee(Connection db, long company, long assignee) throws SQLException {
        if (Db.one(db, "SELECT id FROM users WHERE company_id = ? AND id = ? AND role = 'employee'", company, assignee) == null) {
            throw error(400, "Выберите сотрудника вашей компании.");
        }
    }

    private static Map<String, Object> response(Connection db, Map<String, Object> user, long id) throws SQLException {
        return Map.of("incident", json(db, incident(db, user, id)));
    }

    private static Map<String, Object> json(Connection db, Map<String, Object> row) throws SQLException {
        var out = new LinkedHashMap<String, Object>();
        out.put("id", row.get("id").toString());
        out.put("employeeId", row.get("employee_id").toString());
        out.put("employeeName", row.get("employee_name"));
        out.put("taskId", Objects.toString(row.get("task_id"), null));
        out.put("taskTitle", row.get("task_title"));
        out.put("kind", row.get("kind"));
        out.put("status", row.get("status"));
        out.put("reason", row.get("reason"));
        out.put("safe", row.get("safe") == null ? null : number(row, "safe") != 0);
        out.put("minutes", row.get("minutes"));
        out.put("occurredAt", row.get("occurred_at"));
        out.put("createdAt", row.get("created_at"));
        out.put("decisionReason", row.get("decision_reason"));
        out.put("decidedAt", row.get("decided_at"));
        var tasks = Db.rows(db, """
            SELECT t.id, t.title, t.status, t.assignee_id, it.transferred_to, it.original_status
            FROM incident_tasks it JOIN tasks t ON t.id = it.task_id
            WHERE it.incident_id = ? ORDER BY t.id
            """, row.get("id"));
        var affected = new ArrayList<Map<String, Object>>(tasks.size());
        for (var task : tasks) {
            affected.add(Map.of("taskId", task.get("id").toString(), "title", task.get("title"),
                "status", task.get("status"), "assigneeId", task.get("assignee_id").toString(),
                "originalStatus", task.get("original_status"), "transferred", task.get("transferred_to") != null));
        }
        out.put("affectedTasks", affected);
        return out;
    }

    static long id(Map<String, Object> payload, String key, String label) {
        Object value = payload.get(key);
        String text = value instanceof String s ? s
            : value instanceof Integer || value instanceof Long ? value.toString() : "";
        try {
            if (text.matches("[0-9]{1,19}")) {
                long id = Long.parseLong(text);
                if (id > 0) return id;
            }
        } catch (NumberFormatException ignored) {
            // Invalid identifiers use the same error as missing input.
        }
        throw error(400, "Проверьте поле «" + label + "».");
    }

    private static Instant parseTime(Object value) {
        if (value instanceof String text) {
            try { return Instant.parse(text); } catch (DateTimeParseException ignored) { }
        }
        throw error(400, "Проверьте время срочного ухода.");
    }

    private static boolean employee(Map<String, Object> user) {
        return "employee".equals(user.get("role"));
    }

    private static void requireEmployee(Map<String, Object> user) {
        if (!employee(user)) throw error(403, "Действие доступно сотруднику.");
    }

    private static void requireOffice(Map<String, Object> user) {
        if (employee(user)) throw error(403, "Передать заявку может диспетчер или руководитель.");
    }
}
