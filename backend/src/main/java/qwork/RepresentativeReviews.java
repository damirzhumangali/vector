package qwork;

import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

import static qwork.Domain.error;
import static qwork.Domain.field;
import static qwork.Domain.number;

final class RepresentativeReviews {
    static final int MAX_BODY = 7 * 1024 * 1024;
    static final String SQLITE_SCHEMA = """
        CREATE TABLE IF NOT EXISTS task_representative_reviews (
            id INTEGER PRIMARY KEY,
            task_id INTEGER NOT NULL REFERENCES tasks(id),
            report_event_id INTEGER NOT NULL REFERENCES task_events(id),
            issued_by INTEGER NOT NULL REFERENCES users(id),
            token_hash BLOB UNIQUE,
            expires_at INTEGER NOT NULL,
            decision TEXT CHECK (decision IN ('confirmed', 'remark')),
            method TEXT NOT NULL DEFAULT 'link',
            representative_name TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL DEFAULT '',
            comment TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            decided_at TEXT,
            photo BLOB,
            UNIQUE (task_id, report_event_id)
        );
        """;

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9_-]{43}");
    private static final Set<String> REVIEWABLE = Set.of("review", "done");
    private static final String SUMMARY_COLUMNS = """
        id, report_event_id, decision, method, representative_name, reason, comment, decided_at,
        expires_at, CASE WHEN photo IS NOT NULL THEN 1 ELSE 0 END AS has_photo
        """;
    private static final String LINK_QUERY = """
        SELECT r.id, r.task_id, r.report_event_id, r.expires_at, t.company_id,
            t.title, t.object, t.status, c.name AS company_name
        FROM task_representative_reviews r JOIN tasks t ON t.id = r.task_id
        JOIN companies c ON c.id = t.company_id
        WHERE r.token_hash = ? AND r.decision IS NULL
        """;

    private RepresentativeReviews() {}

    static Map<String, Object> summary(Connection db, Map<String, Object> user, long taskId) throws SQLException {
        var task = officeTask(db, user, taskId);
        Long reportId = latestReport(db, taskId);
        var rows = Db.rows(db, "SELECT " + SUMMARY_COLUMNS + """
            FROM task_representative_reviews WHERE task_id = ? ORDER BY id DESC LIMIT 50
            """, taskId);
        var history = rows.stream().filter(row -> row.get("decision") != null).map(RepresentativeReviews::json).toList();
        var current = rows.stream().filter(row -> reportId != null && number(row, "report_event_id") == reportId)
            .findFirst().orElse(null);
        var result = new LinkedHashMap<String, Object>();
        result.put("eligible", reportId != null && REVIEWABLE.contains(task.get("status")) &&
            (current == null || current.get("decision") == null));
        result.put("current", current == null ? null : json(current));
        result.put("history", history);
        return result;
    }

    static Map<String, Object> issue(Connection db, Map<String, Object> user, long taskId) throws SQLException {
        Accounts.requireManager(user);
        Db.lockTask(db, number(user, "company_id"), taskId);
        var task = officeTask(db, user, taskId);
        Long reportId = latestReport(db, taskId);
        if (reportId == null || !REVIEWABLE.contains(task.get("status"))) {
            throw error(409, "Сначала отправьте отчёт по выезду.");
        }
        byte[] random = new byte[32];
        RANDOM.nextBytes(random);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(random);
        Instant now = Instant.now();
        Instant expires = now.plus(2, ChronoUnit.DAYS);
        int written = Db.update(db, """
            INSERT INTO task_representative_reviews(task_id, report_event_id, issued_by, token_hash, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(task_id, report_event_id) DO UPDATE SET
                issued_by = excluded.issued_by, token_hash = excluded.token_hash,
                expires_at = excluded.expires_at, created_at = excluded.created_at
            WHERE task_representative_reviews.decision IS NULL
            """, taskId, reportId, number(user, "id"), Accounts.tokenDigest(token), expires.getEpochSecond(), now.toString());
        if (written != 1) throw error(409, "Ответ представителя уже записан.");
        return Map.of("token", token, "expiresAt", expires.toString());
    }

    static Map<String, Object> preview(Connection db, Map<String, Object> payload) throws SQLException {
        var row = validLink(db, Accounts.tokenDigest(token(payload)));
        return Map.of("title", row.get("title"), "object", row.get("object"), "company", row.get("company_name"));
    }

    static Map<String, Object> decide(Connection db, Map<String, Object> payload) throws SQLException {
        byte[] digest = Accounts.tokenDigest(token(payload));
        var first = validLink(db, digest);
        Db.lockTask(db, number(first, "company_id"), number(first, "task_id"));
        var row = validLink(db, digest);
        String decision = field(payload, "decision", "Решение", 12, false);
        if (!Set.of("confirmed", "remark").contains(decision)) throw error(400, "Выберите решение по работе.");
        String name = field(payload, "name", "Имя представителя", 120, false);
        boolean remark = "remark".equals(decision);
        String reason = remark ? field(payload, "reason", "Причина замечания", 400, false) : "";
        String comment = remark ? field(payload, "comment", "Комментарий", 1500, true) : "";
        byte[] photo = remark && payload.containsKey("imageBase64") ? Media.representativePhoto(payload) : null;
        var now = Instant.now();
        int written = Db.update(db, """
            UPDATE task_representative_reviews
            SET token_hash = NULL, decision = ?, representative_name = ?, reason = ?, comment = ?, decided_at = ?, photo = ?
            WHERE id = ? AND token_hash = ? AND decision IS NULL AND expires_at > ?
            """, decision, name, reason, comment, now.toString(), photo, number(row, "id"), digest, now.getEpochSecond());
        if (written != 1) throw unavailable();
        return Map.of("decision", decision, "decidedAt", now.toString());
    }

    static byte[] photo(Connection db, Map<String, Object> user, long taskId, long reviewId) throws SQLException {
        officeTask(db, user, taskId);
        var row = Db.one(db, "SELECT photo FROM task_representative_reviews WHERE task_id = ? AND id = ?", taskId, reviewId);
        if (row == null || !(row.get("photo") instanceof byte[] image)) throw error(404, "Фото замечания не найдено.");
        return image;
    }

    static boolean hasCurrentRemark(Connection db, long taskId) throws SQLException {
        return "remark".equals(currentDecision(db, taskId));
    }

    static String currentDecision(Connection db, long taskId) throws SQLException {
        var row = Db.one(db, """
            SELECT r.decision FROM task_representative_reviews r JOIN tasks t ON t.id = r.task_id
            WHERE r.task_id = ? AND t.status IN ('review', 'done')
                AND r.report_event_id = (SELECT MAX(id) FROM task_events WHERE task_id = ? AND status = 'review')
            """, taskId, taskId);
        return row == null ? null : (String) row.get("decision");
    }

    private static Map<String, Object> officeTask(Connection db, Map<String, Object> user, long taskId) throws SQLException {
        Accounts.requireManager(user);
        var task = Db.one(db, "SELECT status FROM tasks WHERE company_id = ? AND id = ?", number(user, "company_id"), taskId);
        if (task == null) throw error(404, "Заявка не найдена.");
        return task;
    }

    private static Map<String, Object> validLink(Connection db, byte[] digest) throws SQLException {
        var row = Db.one(db, LINK_QUERY, digest);
        if (row == null || number(row, "expires_at") <= Instant.now().getEpochSecond() ||
                !REVIEWABLE.contains(row.get("status"))) throw unavailable();
        Long latest = latestReport(db, number(row, "task_id"));
        if (latest == null || latest != number(row, "report_event_id")) throw unavailable();
        return row;
    }

    private static String token(Map<String, Object> payload) {
        if (!(payload.get("token") instanceof String token) || !TOKEN.matcher(token).matches()) throw unavailable();
        return token;
    }

    private static Long latestReport(Connection db, long taskId) throws SQLException {
        var row = Db.one(db, "SELECT id FROM task_events WHERE task_id = ? AND status = 'review' ORDER BY id DESC LIMIT 1", taskId);
        return row == null ? null : number(row, "id");
    }

    private static Map<String, Object> json(Map<String, Object> row) {
        var result = new LinkedHashMap<String, Object>();
        result.put("id", row.get("id").toString());
        result.put("reportEventId", row.get("report_event_id").toString());
        result.put("decision", row.get("decision"));
        result.put("method", row.get("method"));
        result.put("name", row.get("representative_name"));
        result.put("reason", row.get("reason"));
        result.put("comment", row.get("comment"));
        result.put("decidedAt", row.get("decided_at"));
        result.put("expiresAt", Instant.ofEpochSecond(number(row, "expires_at")).toString());
        result.put("hasPhoto", number(row, "has_photo") != 0);
        return result;
    }

    private static Domain.Failure unavailable() {
        return error(404, "Ссылка недействительна или уже использована. Обратитесь к сотруднику qwork.");
    }
}
