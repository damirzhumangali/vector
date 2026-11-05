package qwork;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

import static qwork.Domain.error;
import static qwork.Domain.number;

final class AutoAssignment {
    static final String SQLITE_SCHEMA = """
        CREATE TABLE IF NOT EXISTS assignment_settings (
            company_id INTEGER PRIMARY KEY REFERENCES companies(id),
            enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
            max_active_tasks INTEGER NOT NULL CHECK (max_active_tasks BETWEEN 1 AND 50)
        );
        """;

    private static final DateTimeFormatter TIMESTAMP = new DateTimeFormatterBuilder().appendInstant(3).toFormatter();
    private static final int BATCH_SIZE = 100;
    private static final int DEFAULT_LIMIT = 3;
    private static final String ELIGIBLE = """
        FROM users u
        WHERE u.company_id = ? AND u.role = 'employee'
            AND NOT EXISTS (SELECT 1 FROM unavailable_employees a
                WHERE a.company_id = u.company_id AND a.employee_id = u.id)
            AND EXISTS (SELECT 1 FROM shifts s
                WHERE s.company_id = u.company_id AND s.employee_id = u.id AND s.finished_at IS NULL
                    AND s.starts_at <= ? AND s.ends_at > ?)
        """;

    private AutoAssignment() {}

    private record Settings(boolean enabled, int limit) {
        Map<String, Object> json() {
            return Map.of("enabled", enabled, "maxActiveTasks", limit);
        }
    }

    private record Position(double latitude, double longitude) {
        double distanceTo(Position target) {
            double lat1 = Math.toRadians(latitude);
            double lat2 = Math.toRadians(target.latitude);
            double lonDelta = Math.toRadians(target.longitude - longitude);
            double a = Math.pow(Math.sin((lat2 - lat1) / 2), 2)
                + Math.cos(lat1) * Math.cos(lat2) * Math.pow(Math.sin(lonDelta / 2), 2);
            return 2 * 6_371_000 * Math.asin(Math.sqrt(Math.min(1, a)));
        }
    }

    private record Worker(long id, Position position, int load) {
        double distanceTo(Position target) {
            return position == null ? Double.POSITIVE_INFINITY : position.distanceTo(target);
        }

        Worker assignedAnother() {
            return new Worker(id, position, load + 1);
        }
    }

    static Map<String, Object> settings(Connection db, Map<String, Object> user, Map<String, Object> body)
            throws SQLException {
        Accounts.requireDispatcher(user);
        long company = number(user, "company_id");
        if (body == null) {
            return readSettings(db, company).json();
        }
        if (!(body.get("enabled") instanceof Boolean enabled)) {
            throw error(400, "Укажите, включено ли автоназначение.");
        }
        if (!(body.get("maxActiveTasks") instanceof Integer limit) || limit < 1 || limit > 50) {
            throw error(400, "Лимит активных заявок должен быть целым числом от 1 до 50.");
        }
        Planning.lockCompany(db, company);
        Db.update(db, """
            INSERT INTO assignment_settings(company_id, enabled, max_active_tasks) VALUES (?, ?, ?)
            ON CONFLICT (company_id) DO UPDATE SET enabled = excluded.enabled,
                max_active_tasks = excluded.max_active_tasks
            """, company, enabled ? 1 : 0, limit);
        return new Settings(enabled, limit).json();
    }

    static Map<String, Object> list(Connection db, Map<String, Object> user) throws SQLException {
        Accounts.requireDispatcher(user);
        String now = TIMESTAMP.format(Instant.now());
        var rows = Db.rows(db, """
            SELECT j.*, w.name AS object_name, u.name AS assignee_name, t.status AS task_status,
                (SELECT e.created_at FROM task_events e
                    WHERE e.task_id = j.task_id AND e.status = 'review'
                    ORDER BY e.id DESC LIMIT 1) AS submitted_at
            FROM planned_jobs j JOIN work_sites w ON w.id = j.object_id AND w.company_id = j.company_id
            LEFT JOIN tasks t ON t.id = j.task_id AND t.company_id = j.company_id
            LEFT JOIN users u ON u.id = t.assignee_id AND u.company_id = j.company_id
            WHERE j.company_id = ?
            ORDER BY CASE WHEN j.task_id IS NULL AND j.scheduled_at <= ? THEN 0
                          WHEN j.task_id IS NULL THEN 1 ELSE 2 END, j.scheduled_at, j.id
            """, number(user, "company_id"), now);
        return Map.of("jobs", rows.stream().map(row -> jobJson(row, now)).toList());
    }

    static Map<String, Object> run(Connection db, Map<String, Object> user) throws Exception {
        Accounts.requireDispatcher(user);
        return distribute(db, number(user, "company_id"), false);
    }

    static Map<String, Object> runCompany(Connection db, long company) throws Exception {
        return distribute(db, company, true);
    }

    static List<Long> dueCompanies(Connection db) throws SQLException {
        String now = TIMESTAMP.format(Instant.now());
        return Db.rows(db, """
            SELECT DISTINCT j.company_id FROM planned_jobs j
            LEFT JOIN assignment_settings s ON s.company_id = j.company_id
            WHERE j.task_id IS NULL AND j.scheduled_at <= ? AND COALESCE(s.enabled, 1) = 1
            ORDER BY j.company_id
            """, now).stream().map(row -> number(row, "company_id")).toList();
    }

    private static Map<String, Object> distribute(Connection db, long company, boolean automatic) throws Exception {
        Planning.lockCompany(db, company);
        var settings = readSettings(db, company);
        String now = TIMESTAMP.format(Instant.now());
        int assigned = 0;
        if (!automatic || settings.enabled()) {
            var jobs = Db.rows(db, """
                SELECT j.*, w.latitude, w.longitude, u.name AS actor_name
                FROM planned_jobs j JOIN work_sites w ON w.id = j.object_id AND w.company_id = j.company_id
                JOIN users u ON u.id = j.actor_id AND u.company_id = j.company_id
                WHERE j.company_id = ? AND j.task_id IS NULL AND j.scheduled_at <= ?
                ORDER BY j.priority DESC, j.deadline, j.scheduled_at, j.id LIMIT ?
                """, company, now, BATCH_SIZE);
            if (!jobs.isEmpty()) {
                assigned = assign(db, company, jobs, workers(db, company, now, settings.limit()), settings.limit());
            }
        }
        var remaining = Db.one(db, """
            SELECT COUNT(*) AS total FROM planned_jobs WHERE company_id = ? AND task_id IS NULL AND scheduled_at <= ?
            """, company, now);
        return Map.of("assigned", assigned, "waiting", number(remaining, "total"));
    }

    private static int assign(Connection db, long company, List<Map<String, Object>> jobs,
                              List<Worker> workers, int limit) throws Exception {
        int assigned = 0;
        for (var job : jobs) {
            var target = new Position(((Number) job.get("latitude")).doubleValue(),
                ((Number) job.get("longitude")).doubleValue());
            var selected = workers.stream()
                .filter(worker -> worker.load() < limit)
                .min(Comparator.comparingDouble((Worker worker) -> worker.distanceTo(target))
                    .thenComparingInt(Worker::load).thenComparingLong(Worker::id));
            if (selected.isEmpty()) {
                break;
            }
            var worker = selected.get();
            var actor = Map.<String, Object>of(
                "id", number(job, "actor_id"), "company_id", company, "name", job.get("actor_name"), "role", "dispatcher");
            long plannedPriority = number(job, "priority");
            int priority = plannedPriority < 3 ? 1 : plannedPriority == 3 ? 2 : 3;
            var fields = Map.<String, Object>of(
                "assigneeId", Long.toString(worker.id()), "objectId", job.get("object_id").toString(),
                "title", job.get("title"), "description", job.get("description"), "deadline", job.get("deadline"),
                "priority", priority);
            var created = Tasks.createTask(db, actor, fields);
            String taskId = (String) ((Map<?, ?>) created.get("task")).get("id");
            int linked = Db.update(db, """
                UPDATE planned_jobs SET task_id = ? WHERE company_id = ? AND id = ? AND task_id IS NULL
                """, Long.parseLong(taskId), company, number(job, "id"));
            if (linked != 1) {
                throw error(409, "Очередь изменилась. Запустите распределение снова.");
            }
            workers.set(workers.indexOf(worker), worker.assignedAnother());
            assigned++;
        }
        return assigned;
    }

    private static List<Worker> workers(Connection db, long company, String now, int limit) throws SQLException {
        // The company lock serializes queue writers. Employee locks also serialize against manual
        // assignment and shift decisions, which use the same employee rows.
        if (Db.postgres()) {
            Db.rows(db, "SELECT u.id " + ELIGIBLE + " ORDER BY u.id FOR NO KEY UPDATE OF u", company, now, now);
        }
        var rows = Db.rows(db, """
            SELECT u.id,
                (SELECT COUNT(*) FROM tasks t WHERE t.company_id = u.company_id AND t.assignee_id = u.id
                    AND t.status IN ('assigned', 'accepted', 'travel', 'arrived', 'work', 'rework', 'paused')) AS load,
                (SELECT e.position FROM task_events e WHERE e.actor_id = u.id
                    AND e.status = 'arrived' AND e.position IS NOT NULL ORDER BY e.id DESC LIMIT 1) AS position
            """ + ELIGIBLE, company, now, now);
        var workers = new ArrayList<Worker>();
        for (var row : rows) {
            long load = number(row, "load");
            if (load < limit) {
                workers.add(new Worker(number(row, "id"), position(row.get("position")), (int) load));
            }
        }
        return workers;
    }

    private static Position position(Object value) {
        if (!(value instanceof String encoded)) {
            return null;
        }
        try {
            JsonNode node = Db.JSON.readTree(encoded);
            if (node != null && node.path("latitude").isNumber() && node.path("longitude").isNumber()) {
                double latitude = node.path("latitude").doubleValue();
                double longitude = node.path("longitude").doubleValue();
                if (Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
                    return new Position(latitude, longitude);
                }
            }
        } catch (IOException ignored) {
            // An unusable historical location should not prevent assignment.
        }
        return null;
    }

    private static Settings readSettings(Connection db, long company) throws SQLException {
        var saved = Db.one(db, "SELECT enabled, max_active_tasks FROM assignment_settings WHERE company_id = ?", company);
        return saved == null ? new Settings(true, DEFAULT_LIMIT)
            : new Settings(number(saved, "enabled") != 0, (int) number(saved, "max_active_tasks"));
    }

    private static Map<String, Object> jobJson(Map<String, Object> row, String now) {
        String taskId = Objects.toString(row.get("task_id"), null);
        String scheduledAt = (String) row.get("scheduled_at");
        String deadline = (String) row.get("deadline");
        String taskStatus = (String) row.get("task_status");
        var json = new LinkedHashMap<String, Object>();
        json.put("id", row.get("id").toString());
        json.put("planId", Objects.toString(row.get("plan_id"), null));
        json.put("taskId", taskId);
        json.put("title", row.get("title"));
        json.put("description", row.get("description"));
        json.put("objectId", row.get("object_id").toString());
        json.put("objectName", row.get("object_name"));
        json.put("scheduledAt", scheduledAt);
        json.put("deadline", deadline);
        json.put("priority", row.get("priority"));
        json.put("status", taskId != null ? "assigned" : scheduledAt.compareTo(now) > 0 ? "scheduled" : "waiting");
        json.put("overdue", overdue(deadline, taskStatus, row.get("submitted_at"), now));
        json.put("assigneeName", "unassigned".equals(taskStatus) ? null : row.get("assignee_name"));
        json.put("taskStatus", taskStatus);
        return json;
    }

    private static boolean overdue(String deadline, String status, Object submittedAt, String now) {
        if (deadline == null || deadline.isBlank() || "cancelled".equals(status) || "repeated".equals(status)) {
            return false;
        }
        String reference = now;
        if ("review".equals(status) || "done".equals(status)) {
            if (!(submittedAt instanceof String submitted)) return false;
            reference = submitted;
        }
        try {
            return OffsetDateTime.parse(reference).toInstant().isAfter(OffsetDateTime.parse(deadline).toInstant());
        } catch (DateTimeParseException invalidHistoricalDate) {
            return false;
        }
    }
}
