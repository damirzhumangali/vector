package qwork;

import com.fasterxml.jackson.core.type.TypeReference;
import org.sqlite.SQLiteConfig;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.channels.OverlappingFileLockException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.util.List;
import java.util.Map;

final class TelegramReportStore implements AutoCloseable {
    static final String POSTGRES_ENV = "QWORK_TELEGRAM_DATABASE_URL";
    private static final long SCHEMA_LOCK = 0x5147544D53524442L;
    private static final long WORKER_LOCK = 0x5147544D5352574BL;
    private static final long WEBHOOK_HISTORY_MILLIS = Duration.ofDays(2).toMillis();
    private static final TypeReference<List<Long>> DOCUMENTS = new TypeReference<>() {};
    private static final String SCHEMA = """
        CREATE TABLE IF NOT EXISTS telegram_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            next_offset BIGINT NOT NULL DEFAULT 0
        );
        INSERT INTO telegram_state(id) VALUES (1) ON CONFLICT DO NOTHING;
        CREATE TABLE IF NOT EXISTS telegram_drafts (
            engineer_id BIGINT PRIMARY KEY NOT NULL,
            site_id TEXT,
            before_message BIGINT,
            after_message BIGINT,
            result TEXT,
            documents TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS telegram_reports (
            id %s PRIMARY KEY,
            update_id BIGINT NOT NULL UNIQUE,
            engineer_id BIGINT NOT NULL,
            archive_chat_id BIGINT NOT NULL,
            header TEXT NOT NULL,
            created_at TEXT NOT NULL,
            before_message BIGINT NOT NULL,
            after_message BIGINT NOT NULL,
            documents TEXT NOT NULL,
            next_index INTEGER NOT NULL DEFAULT 0,
            failed INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS telegram_report_versions (
            delivery_id BIGINT PRIMARY KEY NOT NULL REFERENCES telegram_reports(id),
            report_number BIGINT NOT NULL,
            revision INTEGER NOT NULL,
            site_id TEXT NOT NULL,
            summary_message BIGINT,
            decision TEXT CHECK (decision IN ('accepted', 'rework')),
            reviewer_id BIGINT,
            reviewer_name TEXT,
            decision_at TEXT,
            reason TEXT,
            notice_step INTEGER NOT NULL DEFAULT 0,
            UNIQUE(report_number, revision)
        );
        CREATE TABLE IF NOT EXISTS telegram_review_prompts (
            delivery_id BIGINT NOT NULL REFERENCES telegram_report_versions(delivery_id),
            reviewer_id BIGINT NOT NULL,
            message_id BIGINT NOT NULL,
            PRIMARY KEY (delivery_id, reviewer_id)
        );
        CREATE TABLE IF NOT EXISTS telegram_revision_drafts (
            engineer_id BIGINT PRIMARY KEY NOT NULL REFERENCES telegram_drafts(engineer_id) ON DELETE CASCADE,
            source_delivery_id BIGINT NOT NULL REFERENCES telegram_report_versions(delivery_id)
        );
        CREATE TABLE IF NOT EXISTS telegram_webhook_updates (
            queue_id %s PRIMARY KEY,
            update_id BIGINT NOT NULL UNIQUE,
            payload TEXT,
            completed_at BIGINT,
            CHECK ((payload IS NULL) = (completed_at IS NOT NULL))
        );
        CREATE INDEX IF NOT EXISTS telegram_webhook_pending ON telegram_webhook_updates(queue_id) WHERE payload IS NOT NULL;
        CREATE INDEX IF NOT EXISTS telegram_webhook_completed ON telegram_webhook_updates(completed_at) WHERE completed_at IS NOT NULL;
        """;

    record WebhookUpdate(long id, String payload) {}

    record Draft(long engineerId, String siteId, Long before, Long after, String result, List<Long> documents) {
        Draft {
            documents = List.copyOf(documents);
        }
    }

    record Report(long id, ReportNumber number, long engineerId, long archiveChatId, String header,
                  Long before, Long after, List<Long> documents, int nextIndex) {
        Report {
            documents = List.copyOf(documents);
        }
    }

    record ReportNumber(long id, int revision) {
        String label() {
            return "Отчёт №" + id + (revision == 1 ? "" : " · версия " + revision);
        }
    }

    record Review(long deliveryId, ReportNumber number, long engineerId, long chatId, String header,
                  Long summaryMessage, String decision, String reviewer, String decidedAt, String reason,
                  int noticeStep, boolean current) {
        boolean open() {
            return current && summaryMessage != null && decision == null;
        }
    }

    private static final String REVIEW_SELECT = """
        SELECT v.*, r.engineer_id, r.archive_chat_id, r.header,
            NOT EXISTS (SELECT 1 FROM telegram_report_versions newer
                JOIN telegram_reports delivery ON delivery.id = newer.delivery_id
                WHERE newer.report_number = v.report_number AND newer.revision > v.revision AND delivery.failed = 0)
                AS current_version
        FROM telegram_report_versions v JOIN telegram_reports r ON r.id = v.delivery_id
        """;

    private final FileChannel instanceLock;
    private final Connection db;
    private final String postgresUrl;
    private final String documentCount;
    private Connection webhookLock;

    TelegramReportStore(Path path) throws IOException, SQLException {
        postgresUrl = null;
        documentCount = "json_array_length(documents)";
        Path absolute = path.toAbsolutePath().normalize();
        Files.createDirectories(absolute.getParent());
        Path database = absolute.getParent().toRealPath().resolve(absolute.getFileName());
        if (Files.exists(database)) database = database.toRealPath();
        instanceLock = FileChannel.open(database.resolveSibling(database.getFileName() + ".lock"),
            StandardOpenOption.CREATE, StandardOpenOption.WRITE);
        try {
            try {
                if (instanceLock.tryLock() == null) throw alreadyRunning();
            } catch (OverlappingFileLockException locked) {
                throw alreadyRunning();
            }
            db = openSqlite(database);
        } catch (IOException | SQLException | RuntimeException failure) {
            try {
                instanceLock.close();
            } catch (IOException closeFailure) {
                failure.addSuppressed(closeFailure);
            }
            throw failure;
        }
    }

    TelegramReportStore(String databaseUrl) throws SQLException {
        instanceLock = null;
        postgresUrl = databaseUrl;
        documentCount = "json_array_length(CAST(documents AS json))";
        db = openPostgres(databaseUrl);
    }

    private static IOException alreadyRunning() {
        return new IOException("Другой экземпляр бота уже использует эту базу отчётов.");
    }

    private static Connection openSqlite(Path database) throws SQLException {
        var config = new SQLiteConfig();
        config.setBusyTimeout(5_000);
        config.enforceForeignKeys(true);
        Connection connection = config.createConnection("jdbc:sqlite:" + database);
        try {
            createTables(connection, "INTEGER");
            return connection;
        } catch (SQLException failure) {
            try {
                connection.close();
            } catch (SQLException closeFailure) {
                failure.addSuppressed(closeFailure);
            }
            throw failure;
        }
    }

    static Connection openPostgres(String url) throws SQLException {
        var connection = Db.openPostgres(url, POSTGRES_ENV);
        try {
            connection.setNetworkTimeout(Runnable::run, 15_000);
            return connection;
        } catch (SQLException failure) {
            try {
                connection.close();
            } catch (SQLException closeFailure) {
                failure.addSuppressed(closeFailure);
            }
            throw failure;
        }
    }

    static void initializePostgres(String url) throws SQLException {
        try (var connection = openPostgres(url)) {
            connection.setAutoCommit(false);
            Db.one(connection, "SELECT pg_advisory_xact_lock(?)", SCHEMA_LOCK);
            createTables(connection, "BIGINT GENERATED BY DEFAULT AS IDENTITY");
            connection.commit();
        }
    }

    private static void createTables(Connection connection, String identity) throws SQLException {
        try (var statement = connection.createStatement()) {
            for (String sql : SCHEMA.formatted(identity, identity).split(";")) {
                if (!sql.isBlank()) statement.execute(sql);
            }
        }
    }

    boolean acquireWebhookWorker() throws SQLException {
        if (postgresUrl == null || webhookLock != null) return true;
        var lock = openPostgres(postgresUrl);
        try {
            lock.setAutoCommit(false);
            if (tryWebhookWorkerLock(lock)) {
                webhookLock = lock;
                return true;
            }
            return false;
        } finally {
            if (webhookLock != lock) lock.close();
        }
    }

    static boolean tryWebhookWorkerLock(Connection connection) throws SQLException {
        return Boolean.TRUE.equals(Db.one(connection, "SELECT pg_try_advisory_xact_lock(?) AS locked", WORKER_LOCK)
            .get("locked"));
    }

    boolean enqueueWebhookUpdate(long id, String payload) throws SQLException {
        return Db.update(db, """
            INSERT INTO telegram_webhook_updates(update_id, payload) VALUES (?, ?)
            ON CONFLICT(update_id) DO NOTHING
            """, id, payload) == 1;
    }

    WebhookUpdate pendingWebhookUpdate() throws SQLException {
        var row = Db.one(db, """
            SELECT update_id, payload FROM telegram_webhook_updates WHERE payload IS NOT NULL ORDER BY queue_id LIMIT 1
            """);
        return row == null ? null : new WebhookUpdate(nullableLong(row.get("update_id")), (String) row.get("payload"));
    }

    void completeWebhookUpdate(long id) throws SQLException {
        long now = System.currentTimeMillis();
        Db.update(db, """
            UPDATE telegram_webhook_updates SET payload = NULL, completed_at = ?
            WHERE update_id = ? AND payload IS NOT NULL
            """, now, id);
        Db.update(db, "DELETE FROM telegram_webhook_updates WHERE completed_at < ?", now - WEBHOOK_HISTORY_MILLIS);
    }

    long offset() throws SQLException {
        return ((Number) Db.one(db, "SELECT next_offset FROM telegram_state WHERE id = 1").get("next_offset"))
            .longValue();
    }

    void advance(long nextOffset) throws SQLException {
        Db.update(db, "UPDATE telegram_state SET next_offset = ? WHERE id = 1 AND next_offset < ?", nextOffset, nextOffset);
    }

    void resetOffset() throws SQLException {
        Db.update(db, "UPDATE telegram_state SET next_offset = 0 WHERE id = 1 AND next_offset <> 0");
    }

    Draft draft(long engineerId) throws SQLException, IOException {
        var row = Db.one(db, "SELECT * FROM telegram_drafts WHERE engineer_id = ?", engineerId);
        if (row == null) return null;
        return new Draft(engineerId, (String) row.get("site_id"), nullableLong(row.get("before_message")),
            nullableLong(row.get("after_message")), (String) row.get("result"),
            Db.JSON.readValue((String) row.get("documents"), DOCUMENTS));
    }

    void save(Draft draft) throws SQLException, IOException {
        Db.update(db, """
            INSERT INTO telegram_drafts(engineer_id, site_id, before_message, after_message, result, documents)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (engineer_id) DO UPDATE SET site_id = excluded.site_id,
                before_message = excluded.before_message, after_message = excluded.after_message,
                result = excluded.result, documents = excluded.documents
            """, draft.engineerId(), draft.siteId(), draft.before(), draft.after(), draft.result(),
            Db.JSON.writeValueAsString(draft.documents()));
    }

    void clear(long engineerId) throws SQLException, IOException {
        transaction(() -> {
            deleteDraft(engineerId);
            return null;
        });
    }

    private void deleteDraft(long engineerId) throws SQLException {
        Db.update(db, "DELETE FROM telegram_revision_drafts WHERE engineer_id = ?", engineerId);
        Db.update(db, "DELETE FROM telegram_drafts WHERE engineer_id = ?", engineerId);
    }

    ReportNumber queue(Draft draft, long archiveChatId, String header, String createdAt, long updateId)
            throws SQLException, IOException {
        String documents = Db.JSON.writeValueAsString(draft.documents());
        return transaction(() -> {
            int inserted = Db.update(db, """
                INSERT INTO telegram_reports(update_id, engineer_id, archive_chat_id, header,
                    created_at, before_message, after_message, documents)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (update_id) DO NOTHING
                """, updateId, draft.engineerId(), archiveChatId, header, createdAt, draft.before(),
                draft.after(), documents);
            long id = ((Number) Db.one(db, "SELECT id FROM telegram_reports WHERE update_id = ?", updateId)
                .get("id")).longValue();
            if (inserted == 1) {
                Long sourceId = revisionSource(draft.engineerId());
                var source = sourceId == null ? null : review(sourceId);
                if (source != null && (!source.current() || !"rework".equals(source.decision()))) {
                    throw new SQLException("Исходная версия отчёта уже закрыта.");
                }
                long number = source == null ? id : source.number().id();
                int revision = source == null ? 1 : ((Number) Db.one(db, """
                    SELECT MAX(revision) + 1 AS next_revision FROM telegram_report_versions WHERE report_number = ?
                    """, number).get("next_revision")).intValue();
                Db.update(db, """
                    INSERT INTO telegram_report_versions(delivery_id, report_number, revision, site_id)
                    VALUES (?, ?, ?, ?)
                    """, id, number, revision, draft.siteId());
                deleteDraft(draft.engineerId());
            }
            advance(updateId + 1);
            var version = review(id);
            return version == null ? new ReportNumber(id, 1) : version.number();
        });
    }

    private <T> T transaction(Transaction<T> work) throws SQLException, IOException {
        db.setAutoCommit(false);
        try {
            T result = work.run();
            db.commit();
            return result;
        } catch (SQLException | IOException | RuntimeException failure) {
            try {
                db.rollback();
            } catch (SQLException rollbackFailure) {
                failure.addSuppressed(rollbackFailure);
                try {
                    db.close();
                } catch (SQLException closeFailure) {
                    failure.addSuppressed(closeFailure);
                }
            }
            throw failure;
        } finally {
            if (!db.isClosed()) db.setAutoCommit(true);
        }
    }

    @FunctionalInterface
    private interface Transaction<T> {
        T run() throws SQLException, IOException;
    }

    Report pending() throws SQLException, IOException {
        var row = Db.one(db, """
            SELECT r.*, COALESCE(v.report_number, r.id) AS report_number, COALESCE(v.revision, 1) AS revision
            FROM telegram_reports r LEFT JOIN telegram_report_versions v ON v.delivery_id = r.id
            WHERE failed = 0 AND next_index < 3 + %s ORDER BY r.id LIMIT 1
            """.formatted(documentCount));
        if (row == null) return null;
        var number = new ReportNumber(((Number) row.get("report_number")).longValue(), ((Number) row.get("revision")).intValue());
        return new Report(((Number) row.get("id")).longValue(), number, ((Number) row.get("engineer_id")).longValue(),
            ((Number) row.get("archive_chat_id")).longValue(), (String) row.get("header"),
            nullableLong(row.get("before_message")), nullableLong(row.get("after_message")),
            Db.JSON.readValue((String) row.get("documents"), DOCUMENTS), ((Number) row.get("next_index")).intValue());
    }

    void delivered(long reportId, int nextIndex, Long summaryMessage) throws SQLException, IOException {
        transaction(() -> {
            int updated = Db.update(db, """
                UPDATE telegram_reports SET next_index = ? WHERE id = ? AND failed = 0
                AND next_index = ? AND next_index < 3 + %s
                """.formatted(documentCount), nextIndex, reportId, nextIndex - 1);
            if (updated != 1) throw new SQLException("Не удалось сохранить шаг отправки отчёта.");
            if (summaryMessage != null) {
                Db.update(db, "UPDATE telegram_report_versions SET summary_message = ? WHERE delivery_id = ?",
                    summaryMessage, reportId);
            }
            return null;
        });
    }

    void fail(long reportId) throws SQLException {
        Db.update(db, "UPDATE telegram_reports SET failed = 1 WHERE id = ?", reportId);
    }

    Review review(long deliveryId) throws SQLException {
        return readReview(Db.one(db, REVIEW_SELECT + "WHERE v.delivery_id = ?", deliveryId));
    }

    Review pendingNotice() throws SQLException {
        return readReview(Db.one(db, REVIEW_SELECT
            + "WHERE v.decision IS NOT NULL AND v.notice_step < 2 ORDER BY v.delivery_id LIMIT 1"));
    }

    private static Review readReview(Map<String, Object> row) {
        if (row == null) return null;
        var number = new ReportNumber(((Number) row.get("report_number")).longValue(), ((Number) row.get("revision")).intValue());
        return new Review(((Number) row.get("delivery_id")).longValue(), number,
            ((Number) row.get("engineer_id")).longValue(), ((Number) row.get("archive_chat_id")).longValue(),
            (String) row.get("header"), nullableLong(row.get("summary_message")), (String) row.get("decision"),
            (String) row.get("reviewer_name"), (String) row.get("decision_at"), (String) row.get("reason"),
            ((Number) row.get("notice_step")).intValue(), isTrue(row.get("current_version")));
    }

    private static boolean isTrue(Object value) {
        return value instanceof Boolean bool ? bool : ((Number) value).intValue() != 0;
    }

    void saveReviewPrompt(long deliveryId, long reviewerId, long messageId) throws SQLException {
        Db.update(db, """
            INSERT INTO telegram_review_prompts(delivery_id, reviewer_id, message_id) VALUES (?, ?, ?)
            ON CONFLICT(delivery_id, reviewer_id) DO UPDATE SET message_id = excluded.message_id
            """, deliveryId, reviewerId, messageId);
    }

    Review reviewForReply(long chatId, long reviewerId, long replyTo) throws SQLException {
        return readReview(Db.one(db, REVIEW_SELECT + """
            JOIN telegram_review_prompts p ON p.delivery_id = v.delivery_id
            WHERE r.archive_chat_id = ? AND p.reviewer_id = ? AND p.message_id = ?
            """, chatId, reviewerId, replyTo));
    }

    boolean decide(Review review, long reviewerId, String reviewer, String decidedAt, String reason)
            throws SQLException, IOException {
        return transaction(() -> {
            int changed = Db.update(db, """
                UPDATE telegram_report_versions
                SET decision = ?, reviewer_id = ?, reviewer_name = ?, decision_at = ?, reason = ?
                WHERE delivery_id = ? AND summary_message IS NOT NULL AND decision IS NULL
                """, reason == null ? "accepted" : "rework", reviewerId, reviewer, decidedAt, reason, review.deliveryId());
            if (changed == 1) Db.update(db, "DELETE FROM telegram_review_prompts WHERE delivery_id = ?", review.deliveryId());
            return changed == 1;
        });
    }

    void advanceNotice(long deliveryId, int nextStep) throws SQLException {
        Db.update(db, "UPDATE telegram_report_versions SET notice_step = ? WHERE delivery_id = ? AND notice_step = ?",
            nextStep, deliveryId, nextStep - 1);
    }

    Long revisionSource(long engineerId) throws SQLException {
        var row = Db.one(db, "SELECT source_delivery_id FROM telegram_revision_drafts WHERE engineer_id = ?", engineerId);
        return row == null ? null : nullableLong(row.get("source_delivery_id"));
    }

    Draft startRevision(Review source, boolean replaceMaterials) throws SQLException, IOException {
        return transaction(() -> {
            var row = Db.one(db, """
                SELECT r.before_message, r.after_message, r.documents, v.site_id FROM telegram_report_versions v
                JOIN telegram_reports r ON r.id = v.delivery_id WHERE v.delivery_id = ?
                """, source.deliveryId());
            var draft = new Draft(source.engineerId(), (String) row.get("site_id"),
                replaceMaterials ? null : nullableLong(row.get("before_message")),
                replaceMaterials ? null : nullableLong(row.get("after_message")), null,
                replaceMaterials ? List.of() : Db.JSON.readValue((String) row.get("documents"), DOCUMENTS));
            save(draft);
            Db.update(db, "INSERT INTO telegram_revision_drafts(engineer_id, source_delivery_id) VALUES (?, ?)",
                source.engineerId(), source.deliveryId());
            return draft;
        });
    }

    private static Long nullableLong(Object number) {
        return number == null ? null : ((Number) number).longValue();
    }

    @Override
    public void close() throws SQLException, IOException {
        try (var lock = instanceLock; var advisoryLock = webhookLock; var connection = db) {
            // The connection closes before releasing the process lock.
        }
    }
}
