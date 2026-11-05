package qwork;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

import static qwork.Domain.error;
import static qwork.Domain.number;

/** Persists deliveries with the incident, then talks to Expo outside the transaction. */
final class IncidentPush {
    static final String CHANNEL = "qwork-incidents";
    private static final URI SEND = URI.create("https://exp.host/--/api/v2/push/send");
    private static final URI RECEIPTS = URI.create("https://exp.host/--/api/v2/push/getReceipts");
    private static final Pattern TOKEN = Pattern.compile("(?:Exponent|Expo)PushToken\\[[A-Za-z0-9_-]{10,160}\\]");
    private static final int BATCH_SIZE = 50;
    private static final int MAX_ATTEMPTS = 8;
    private static final long EXPIRES_AFTER = 6 * 60 * 60;
    private static final long RECEIPT_DELAY = 15 * 60;
    private static final long LEASE = 120;
    private static final String ACCESS_TOKEN = System.getenv().getOrDefault("QWORK_EXPO_PUSH_ACCESS_TOKEN", "");

    static final String SQLITE_SCHEMA = """
        CREATE TABLE IF NOT EXISTS push_devices (
            token TEXT PRIMARY KEY,
            session_hash BLOB NOT NULL UNIQUE REFERENCES sessions(token_hash) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS incident_push_jobs (
            incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
            token TEXT NOT NULL REFERENCES push_devices(token) ON DELETE CASCADE,
            next_attempt INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            ticket_id TEXT,
            PRIMARY KEY (incident_id, token)
        );
        CREATE INDEX IF NOT EXISTS incident_push_jobs_due ON incident_push_jobs(next_attempt);
        CREATE INDEX IF NOT EXISTS incident_push_jobs_device ON incident_push_jobs(token);
        """;

    private record Delivery(long incident, String token, byte[] sessionHash, long user, String kind,
                            String ticket, int attempts) {
        Map<String, Object> message() {
            boolean urgent = "urgent_leave".equals(kind);
            return Map.of(
                "to", token, "channelId", CHANNEL, "sound", "default", "priority", "high", "ttl", 3600,
                "title", urgent ? "Срочный уход сотрудника" : "Аварийное назначение",
                "body", urgent ? "Откройте рабочее время в qwork." : "Откройте qwork и ответьте на назначение.",
                "data", Map.of("type", kind, "userId", Long.toString(user))
            );
        }
    }

    private IncidentPush() {}

    static Map<String, Object> register(Connection db, String bearer, Map<String, Object> body)
            throws SQLException {
        if (!(body.get("token") instanceof String token) || !TOKEN.matcher(token).matches()) {
            throw error(400, "Некорректный токен уведомлений.");
        }
        byte[] hash = Accounts.tokenDigest(bearer);
        String lock = Db.postgres() ? " FOR NO KEY UPDATE" : "";
        if (Db.one(db, "SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?" + lock,
                hash, now()) == null) throw error(401, "Войдите в qwork снова.");
        // Remove outstanding deliveries if this installation is now signed into another account.
        Db.update(db, """
            DELETE FROM push_devices
            WHERE (session_hash = ? AND token <> ?) OR (token = ? AND session_hash <> ?)
            """, hash, token, token, hash);
        Db.update(db, "INSERT INTO push_devices(token, session_hash) VALUES (?, ?) ON CONFLICT DO NOTHING",
            token, hash);
        if (Db.one(db, "SELECT token FROM push_devices WHERE token = ? AND session_hash = ?", token, hash) == null) {
            throw error(409, "Повторите подключение уведомлений.");
        }
        return Map.of("registered", true);
    }

    static void enqueue(Connection db, long incident, long company, Long employee) throws SQLException {
        long now = now();
        String recipients = employee == null ? "u.role IN ('dispatcher', 'manager')" : "u.id = ? AND u.role = 'employee'";
        String sql = """
            INSERT INTO incident_push_jobs(incident_id, token, next_attempt, expires_at)
            SELECT ?, d.token, ?, ? FROM push_devices d
            JOIN sessions s ON s.token_hash = d.session_hash JOIN users u ON u.id = s.user_id
            WHERE u.company_id = ? AND u.invite_required = 0 AND s.expires_at > ? AND
            """ + recipients + " ON CONFLICT (incident_id, token) DO NOTHING";
        if (employee == null) Db.update(db, sql, incident, now, now + EXPIRES_AFTER, company, now);
        else Db.update(db, sql, incident, now, now + EXPIRES_AFTER, company, now, employee);
    }

    static void run() {
        try {
            drain(SEND, RECEIPTS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        } catch (Exception failure) {
            System.err.printf("qwork incident push failure: %s%n", failure.getClass().getSimpleName());
        }
    }

    static void drain(URI send, URI receipts) throws SQLException, InterruptedException {
        var jobs = claim();
        if (jobs.isEmpty()) return;
        try (var client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()) {
            deliver(client, send, jobs.stream().filter(job -> job.ticket() == null).toList(), false);
            deliver(client, receipts, jobs.stream().filter(job -> job.ticket() != null).toList(), true);
        }
    }

    private static List<Delivery> claim() throws SQLException {
        var jobs = new ArrayList<Delivery>();
        long now = now();
        try (var db = Db.connect(true)) {
            Db.update(db, """
                DELETE FROM incident_push_jobs WHERE expires_at <= ? OR (attempts >= ? AND next_attempt <= ?)
                OR (ticket_id IS NULL AND incident_id IN (SELECT id FROM incidents WHERE status <> 'open'))
                OR token IN (SELECT d.token FROM push_devices d
                    JOIN sessions s ON s.token_hash = d.session_hash WHERE s.expires_at <= ?)
                """, now, MAX_ATTEMPTS, now, now);
            var ready = Db.rows(db, """
                SELECT j.*, d.session_hash, s.user_id, i.kind FROM incident_push_jobs j
                JOIN push_devices d ON d.token = j.token
                JOIN sessions s ON s.token_hash = d.session_hash
                JOIN incidents i ON i.id = j.incident_id
                WHERE j.next_attempt <= ? ORDER BY j.next_attempt, j.incident_id LIMIT ?
                """, now, BATCH_SIZE);
            for (var row : ready) {
                long incident = number(row, "incident_id");
                String token = (String) row.get("token");
                int attempts = (int) number(row, "attempts");
                if (Db.update(db, """
                    UPDATE incident_push_jobs SET attempts = ?, next_attempt = ?
                    WHERE incident_id = ? AND token = ? AND attempts = ? AND next_attempt <= ?
                    """, attempts + 1, now + LEASE, incident, token, attempts, now) == 1) {
                    jobs.add(new Delivery(incident, token, (byte[]) row.get("session_hash"), number(row, "user_id"),
                        (String) row.get("kind"), (String) row.get("ticket_id"), attempts + 1));
                }
            }
            db.commit();
        }
        return jobs;
    }

    private static void deliver(HttpClient client, URI endpoint, List<Delivery> jobs, boolean receipts)
            throws SQLException, InterruptedException {
        if (jobs.isEmpty()) return;
        JsonNode data;
        try {
            Object body = receipts ? Map.of("ids", jobs.stream().map(Delivery::ticket).toList())
                : jobs.stream().map(Delivery::message).toList();
            var request = HttpRequest.newBuilder(endpoint).timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json").header("Accept", "application/json");
            if (!ACCESS_TOKEN.isBlank()) request.header("Authorization", "Bearer " + ACCESS_TOKEN);
            var response = client.send(request.POST(HttpRequest.BodyPublishers.ofByteArray(
                Db.JSON.writeValueAsBytes(body))).build(), HttpResponse.BodyHandlers.ofByteArray());
            if (response.statusCode() != 200) throw new IOException("HTTP " + response.statusCode());
            var reply = Db.JSON.readTree(response.body());
            data = reply == null ? Db.JSON.nullNode() : reply.path("data");
            if (receipts ? !data.isObject() : !data.isArray() || data.size() != jobs.size()) {
                throw new IOException("Invalid Expo reply");
            }
        } catch (IOException failure) {
            System.err.printf("qwork Expo push request failed: %s%n", failure.getClass().getSimpleName());
            try (var db = Db.connect(true)) {
                for (var job : jobs) retry(db, job, job.ticket());
                db.commit();
            }
            return;
        }
        try (var db = Db.connect(true)) {
            for (int index = 0; index < jobs.size(); index++) {
                var job = jobs.get(index);
                var result = receipts ? data.path(job.ticket()) : data.path(index);
                String code = result.path("details").path("error").asText();
                String status = result.path("status").asText();
                if ("DeviceNotRegistered".equals(code)) {
                    Db.update(db, "DELETE FROM push_devices WHERE token = ? AND session_hash = ?",
                        job.token(), job.sessionHash());
                } else if ("MessageRateExceeded".equals(code)) {
                    retry(db, job, null);
                } else if ("error".equals(status) || (receipts && "ok".equals(status))) {
                    finish(db, job);
                    if ("error".equals(status)) System.err.println("qwork Expo rejected an incident notification");
                } else if (!receipts && "ok".equals(status) && !result.path("id").asText().isBlank()) {
                    Db.update(db, """
                        UPDATE incident_push_jobs SET ticket_id = ?, next_attempt = ?, attempts = 0
                        WHERE incident_id = ? AND token = ? AND attempts = ?
                        """, result.path("id").asText(), now() + RECEIPT_DELAY, job.incident(), job.token(), job.attempts());
                } else {
                    retry(db, job, job.ticket());
                }
            }
            db.commit();
        }
    }

    private static void retry(Connection db, Delivery job, String ticket) throws SQLException {
        long delay = Math.min(3600, 30L << (job.attempts() - 1));
        Db.update(db, """
            UPDATE incident_push_jobs SET ticket_id = ?, next_attempt = ?
            WHERE incident_id = ? AND token = ? AND attempts = ?
            """, ticket, now() + delay, job.incident(), job.token(), job.attempts());
    }

    private static void finish(Connection db, Delivery job) throws SQLException {
        Db.update(db, "DELETE FROM incident_push_jobs WHERE incident_id = ? AND token = ? AND attempts = ?",
            job.incident(), job.token(), job.attempts());
    }

    private static long now() {
        return Instant.now().getEpochSecond();
    }
}
