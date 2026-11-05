package qwork;

import com.fasterxml.jackson.databind.SerializationFeature;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;

import static qwork.Domain.error;
import static qwork.Domain.field;
import static qwork.Domain.number;

final class Sync {
    private static final Pattern EVENT_ID = Pattern.compile(
        "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
    );
    private static final Duration MAX_AGE = Duration.ofDays(7);
    private static final Duration CLOCK_TOLERANCE = Duration.ofMinutes(5);
    private static final String CONFLICT_SELECT = """
        SELECT e.*, t.title AS task_title, employee.name AS employee_name, reviewer.name AS resolved_by_name
        FROM sync_events e
        JOIN tasks t ON t.id = e.task_id AND t.company_id = e.company_id
        JOIN users employee ON employee.id = e.actor_id AND employee.company_id = e.company_id
        LEFT JOIN users reviewer ON reviewer.id = e.resolved_by AND reviewer.company_id = e.company_id
        WHERE e.company_id = ? AND e.conflict_reason IS NOT NULL
        """;

    static final String SQLITE_SCHEMA = """
        CREATE TABLE IF NOT EXISTS sync_events (
            company_id INTEGER NOT NULL REFERENCES companies(id),
            event_id TEXT NOT NULL,
            task_id INTEGER NOT NULL REFERENCES tasks(id),
            actor_id INTEGER NOT NULL REFERENCES users(id),
            kind TEXT NOT NULL CHECK (kind IN ('patch', 'photo')),
            expected_revision INTEGER NOT NULL,
            payload_hash TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            received_at TEXT NOT NULL,
            requested_status TEXT,
            photo_kind TEXT,
            conflict_reason TEXT,
            server_status TEXT,
            server_revision INTEGER,
            resolved_at TEXT,
            resolved_by INTEGER REFERENCES users(id),
            PRIMARY KEY (company_id, event_id)
        );
        CREATE INDEX IF NOT EXISTS sync_events_by_task ON sync_events(task_id, expected_revision);
        CREATE INDEX IF NOT EXISTS sync_conflicts_by_company ON sync_events(company_id, received_at)
            WHERE conflict_reason IS NOT NULL;
        """;

    private Sync() {}

    static Map<String, Object> apply(Connection db, Map<String, Object> user, Map<String, Object> payload)
            throws Exception {
        if (!"employee".equals(user.get("role"))) {
            throw error(403, "Офлайн-действия отправляет назначенный сотрудник.");
        }
        Instant receivedAt = Instant.now();
        String eventId = eventId(field(payload, "eventId", "Идентификатор действия", 36, false));
        long taskId = taskId(field(payload, "taskId", "Заявка", 19, false));
        String kind = field(payload, "kind", "Вид действия", 10, false);
        if (!Set.of("patch", "photo").contains(kind)) {
            throw error(400, "Неизвестный вид офлайн-действия.");
        }
        Instant occurredAt = occurrenceTime(field(payload, "occurredAt", "Время действия", 40, false));
        var body = body(payload.get("body"));
        long expectedRevision = expectedRevision(body.get("expectedRevision"));
        long companyId = number(user, "company_id");
        long actorId = number(user, "id");
        String hash = payloadHash(taskId, kind, occurredAt, body);
        String requestedStatus = kind.equals("patch") ? preview(body.get("status")) : null;
        String photoKind = kind.equals("photo") ? preview(body.get("kind")) : null;
        if (kind.equals("photo") && !Set.of("before", "after").contains(Objects.toString(photoKind, ""))) {
            throw error(400, "Укажите вид фотографии «до» или «после».");
        }

        // Authorize before recording an event; authorize again after the mutation lock.
        getAssignedTask(db, companyId, actorId, taskId);
        Db.lockTask(db, companyId, taskId);
        var current = getAssignedTask(db, companyId, actorId, taskId);
        int inserted = Db.update(db, """
            INSERT INTO sync_events(company_id, event_id, task_id, actor_id, kind, expected_revision,
                payload_hash, occurred_at, received_at, requested_status, photo_kind)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (company_id, event_id) DO NOTHING
            """, companyId, eventId, taskId, actorId, kind, expectedRevision, hash, occurredAt.toString(),
                receivedAt.toString(), requestedStatus, photoKind);
        if (inserted == 0) {
            return replay(db, user, companyId, actorId, taskId, eventId, hash);
        }

        if (occurredAt.isAfter(receivedAt.plus(CLOCK_TOLERANCE)) || occurredAt.isBefore(receivedAt.minus(MAX_AGE))) {
            throw error(400, "Время офлайн-действия выходит за допустимый период. Проверьте часы устройства.");
        }
        String serverStatus = (String) current.get("status");
        long serverRevision = number(current, "revision");
        String reason = null;
        if ("cancelled".equals(serverStatus)) {
            reason = "Заявку отменили до синхронизации действия.";
        } else if ("unassigned".equals(serverStatus)) {
            reason = "Заявку сняли с сотрудника до синхронизации действия.";
        } else if (expectedRevision != serverRevision) {
            reason = "Версия заявки изменилась до синхронизации действия.";
        } else if (outOfOrder(db, taskId, eventId, occurredAt)) {
            reason = "Время действия на телефоне предшествует последнему изменению заявки.";
        }

        if (reason != null) {
            Db.update(db, """
                UPDATE sync_events SET conflict_reason = ?, server_status = ?, server_revision = ?
                WHERE company_id = ? AND event_id = ?
                """, reason, serverStatus, serverRevision, companyId, eventId);
            return response(db, user, taskId, conflict(db, companyId, eventId), false);
        }

        if (kind.equals("patch")) {
            var result = new LinkedHashMap<>(Tasks.updateTask(db, user, taskId, body, occurredAt));
            result.put("duplicate", false);
            return result;
        }
        Media.upload(db, user, taskId, body);
        return response(db, user, taskId, null, false);
    }

    static Map<String, Object> conflicts(Connection db, Map<String, Object> user) throws SQLException {
        requireManager(user);
        var records = Db.rows(db, CONFLICT_SELECT + """
             ORDER BY CASE WHEN e.resolved_at IS NULL THEN 0 ELSE 1 END,
                e.received_at DESC, e.event_id DESC LIMIT 200
            """, number(user, "company_id"));
        var result = new ArrayList<Map<String, Object>>(records.size());
        for (var row : records) {
            result.add(conflictJson(row));
        }
        return Map.of("conflicts", result);
    }

    static Map<String, Object> resolve(Connection db, Map<String, Object> user, String id) throws SQLException {
        requireManager(user);
        long companyId = number(user, "company_id");
        String eventId = eventId(id);
        Db.update(db, """
            UPDATE sync_events SET resolved_at = ?, resolved_by = ?
            WHERE company_id = ? AND event_id = ? AND conflict_reason IS NOT NULL AND resolved_at IS NULL
            """, Instant.now().toString(), number(user, "id"), companyId, eventId);
        var result = conflict(db, companyId, eventId);
        if (result == null) {
            throw error(404, "Конфликт не найден.");
        }
        return Map.of("conflict", result);
    }

    private static Map<String, Object> replay(Connection db, Map<String, Object> user, long companyId,
            long actorId, long taskId, String eventId, String hash) throws Exception {
        var existing = Db.one(db, """
            SELECT task_id, actor_id, payload_hash FROM sync_events WHERE company_id = ? AND event_id = ?
            """, companyId, eventId);
        if (existing == null || number(existing, "task_id") != taskId ||
            number(existing, "actor_id") != actorId || !hash.equals(existing.get("payload_hash"))) {
            throw error(409, "Идентификатор офлайн-действия уже используется.");
        }
        return response(db, user, taskId, conflict(db, companyId, eventId), true);
    }

    private static Map<String, Object> response(Connection db, Map<String, Object> user, long taskId,
            Map<String, Object> conflict, boolean duplicate) throws Exception {
        var current = getAssignedTask(db, number(user, "company_id"), number(user, "id"), taskId);
        var result = "unassigned".equals(current.get("status")) ? new LinkedHashMap<String, Object>()
            : new LinkedHashMap<>(Tasks.taskResponse(db, user, taskId));
        result.put("duplicate", duplicate);
        if (conflict != null) {
            result.put("conflict", conflict);
        }
        return result;
    }

    private static Map<String, Object> getAssignedTask(Connection db, long companyId, long actorId, long taskId)
            throws SQLException {
        var task = Db.one(db, """
            SELECT status, revision FROM tasks WHERE id = ? AND company_id = ? AND assignee_id = ?
            """, taskId, companyId, actorId);
        if (task == null) {
            throw error(404, "Заявка не найдена.");
        }
        return task;
    }

    private static Map<String, Object> conflict(Connection db, long companyId, String eventId) throws SQLException {
        var row = Db.one(db, CONFLICT_SELECT + " AND e.event_id = ?", companyId, eventId);
        return row == null ? null : conflictJson(row);
    }

    private static Map<String, Object> conflictJson(Map<String, Object> row) {
        var result = new LinkedHashMap<String, Object>();
        result.put("eventId", row.get("event_id"));
        result.put("taskId", row.get("task_id").toString());
        result.put("taskTitle", row.get("task_title"));
        result.put("employeeName", row.get("employee_name"));
        result.put("kind", row.get("kind"));
        result.put("requestedStatus", row.get("requested_status"));
        result.put("photoKind", row.get("photo_kind"));
        result.put("serverStatus", row.get("server_status"));
        result.put("expectedRevision", row.get("expected_revision"));
        result.put("serverRevision", row.get("server_revision"));
        result.put("reason", row.get("conflict_reason"));
        result.put("occurredAt", row.get("occurred_at"));
        result.put("receivedAt", row.get("received_at"));
        result.put("resolvedAt", row.get("resolved_at"));
        result.put("resolvedByName", row.get("resolved_by_name"));
        return result;
    }

    private static boolean outOfOrder(Connection db, long taskId, String eventId, Instant occurredAt) throws SQLException {
        var history = Db.one(db, """
            SELECT created_at FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 1
            """, taskId);
        var previous = Db.one(db, """
            SELECT occurred_at FROM sync_events
            WHERE task_id = ? AND event_id <> ? AND conflict_reason IS NULL
            ORDER BY expected_revision DESC LIMIT 1
            """, taskId, eventId);
        // Phone clocks record milliseconds. Avoid rejecting two actions within the same millisecond.
        return earlierThan(occurredAt, history, "created_at") || earlierThan(occurredAt, previous, "occurred_at");
    }

    private static boolean earlierThan(Instant occurredAt, Map<String, Object> row, String key) {
        return row != null && occurredAt.isBefore(Instant.parse((String) row.get(key)).truncatedTo(ChronoUnit.MILLIS));
    }

    private static String preview(Object value) {
        return value instanceof String text && text.length() <= 40 && text.indexOf(0) < 0 ? text : null;
    }

    private static String eventId(String value) {
        if (!EVENT_ID.matcher(value).matches()) {
            throw error(400, "Некорректный идентификатор офлайн-действия.");
        }
        return value.toLowerCase(Locale.ROOT);
    }

    private static long taskId(String value) {
        try {
            if (value.matches("[0-9]{1,19}")) {
                long id = Long.parseLong(value);
                if (id > 0) {
                    return id;
                }
            }
        } catch (NumberFormatException ignored) {
            // Reject numbers outside the database ID range.
        }
        throw error(400, "Некорректный идентификатор заявки.");
    }

    private static Instant occurrenceTime(String value) {
        try {
            return Instant.parse(value);
        } catch (DateTimeParseException ignored) {
            throw error(400, "Укажите время офлайн-действия с часовым поясом.");
        }
    }

    private static long expectedRevision(Object value) {
        if ((value instanceof Integer || value instanceof Long) && ((Number) value).longValue() > 0) {
            return ((Number) value).longValue();
        }
        throw error(400, "Укажите версию заявки для синхронизации.");
    }

    private static Map<String, Object> body(Object value) {
        if (!(value instanceof Map<?, ?> map)) {
            throw error(400, "Заполните данные офлайн-действия.");
        }
        var result = new LinkedHashMap<String, Object>();
        for (var entry : map.entrySet()) {
            if (!(entry.getKey() instanceof String key)) {
                throw error(400, "Некорректные данные офлайн-действия.");
            }
            result.put(key, entry.getValue());
        }
        return result;
    }

    private static String payloadHash(long taskId, String kind, Instant occurredAt, Map<String, Object> body)
            throws Exception {
        byte[] canonical = Db.JSON.writer(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)
            .writeValueAsBytes(Map.of("taskId", taskId, "kind", kind, "occurredAt", occurredAt.toString(), "body", body));
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(canonical));
    }

    private static void requireManager(Map<String, Object> user) {
        if (!"manager".equals(user.get("role"))) {
            throw error(403, "Конфликты синхронизации доступны руководителю.");
        }
    }
}
