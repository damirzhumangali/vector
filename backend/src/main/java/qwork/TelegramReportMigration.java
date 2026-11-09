package qwork;

import org.sqlite.SQLiteConfig;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.Collections;
import java.util.List;

final class TelegramReportMigration {
    private static final List<Table> TABLES = List.of(
        new Table("telegram_drafts", "engineer_id, site_id, before_message, after_message, result, documents", true),
        new Table("telegram_reports", "id, update_id, engineer_id, archive_chat_id, header, created_at, before_message,"
            + " after_message, documents, next_index, failed", true),
        new Table("telegram_report_versions", "delivery_id, report_number, revision, site_id, summary_message, decision,"
            + " reviewer_id, reviewer_name, decision_at, reason, notice_step", false),
        new Table("telegram_review_prompts", "delivery_id, reviewer_id, message_id", false),
        new Table("telegram_revision_drafts", "engineer_id, source_delivery_id", false),
        new Table("telegram_webhook_updates", "queue_id, update_id, payload, completed_at", false)
    );

    private record Table(String name, String columns, boolean required) {}

    public static void main(String[] args) {
        String target = System.getenv(TelegramReportStore.POSTGRES_ENV);
        if (args.length != 1 || target == null || target.isBlank()) {
            System.err.println("Передайте путь к копии SQLite и задайте QWORK_TELEGRAM_DATABASE_URL.");
            System.exit(2);
        }
        try {
            long reports = migrate(Path.of(args[0]), target);
            System.out.println("База TMS Report перенесена. Отчётов: " + reports + ".");
        } catch (IOException | IllegalArgumentException | IllegalStateException error) {
            System.err.println(error.getMessage());
            System.exit(1);
        } catch (SQLException error) {
            System.err.println("Перенос базы TMS Report завершился с ошибкой SQL (" + error.getSQLState() + ").");
            System.exit(1);
        }
    }

    static long migrate(Path snapshot, String databaseUrl) throws SQLException, IOException {
        if (!Files.isRegularFile(snapshot)) throw new IOException("Копия SQLite не найдена.");
        var sqlite = new SQLiteConfig();
        sqlite.setReadOnly(true);
        sqlite.setBusyTimeout(5_000);
        try (var source = sqlite.createConnection("jdbc:sqlite:" + snapshot.toRealPath())) {
            source.setAutoCommit(false);
            var state = Db.one(source, "SELECT next_offset FROM telegram_state WHERE id = 1");
            if (state == null) throw new IOException("В копии SQLite нет состояния TMS Report.");
            if (!"ok".equals(Db.one(source, "PRAGMA quick_check").get("quick_check"))
                    || Db.one(source, "PRAGMA foreign_key_check") != null) {
                throw new IOException("Копия SQLite не прошла проверку целостности.");
            }

            TelegramReportStore.initializePostgres(databaseUrl);
            try (var target = TelegramReportStore.openPostgres(databaseUrl)) {
                target.setAutoCommit(false);
                if (!TelegramReportStore.tryWebhookWorkerLock(target)) {
                    throw new IllegalStateException("Сначала остановите обработку отчётов в базе PostgreSQL.");
                }
                // Ingress and an overlapping migration cannot add rows between the emptiness check and commit.
                Db.update(target, "LOCK TABLE telegram_webhook_updates IN ACCESS EXCLUSIVE MODE");
                for (Table table : TABLES) {
                    if (count(target, table.name()) > 0) {
                        throw new IllegalStateException("Целевая база TMS Report уже содержит данные.");
                    }
                }
                Db.update(target, "UPDATE telegram_state SET next_offset = ? WHERE id = 1", state.get("next_offset"));
                for (Table table : TABLES) copyTable(source, target, table);
                restartIdentity(target, "telegram_reports", "id");
                restartIdentity(target, "telegram_webhook_updates", "queue_id");
                long reports = count(target, "telegram_reports");
                target.commit();
                return reports;
            }
        }
    }

    private static void copyTable(Connection source, Connection target, Table table) throws SQLException, IOException {
        if (Db.one(source, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table.name()) == null) {
            if (table.required()) throw new IOException("В копии SQLite отсутствует таблица " + table.name() + ".");
            return;
        }
        String sourceSql = "SELECT " + table.columns() + " FROM " + table.name();
        try (var select = source.prepareStatement(sourceSql); var rows = select.executeQuery()) {
            int columns = rows.getMetaData().getColumnCount();
            String parameters = String.join(",", Collections.nCopies(columns, "?"));
            String targetSql = "INSERT INTO " + table.name() + " (" + table.columns() + ") VALUES (" + parameters + ")";
            try (var insert = target.prepareStatement(targetSql)) {
                int batch = 0;
                while (rows.next()) {
                    for (int index = 1; index <= columns; index++) insert.setObject(index, rows.getObject(index));
                    insert.addBatch();
                    if (++batch == 500) {
                        insert.executeBatch();
                        batch = 0;
                    }
                }
                if (batch > 0) insert.executeBatch();
            }
        }
        if (count(source, table.name()) != count(target, table.name())) {
            throw new IOException("Число строк не совпадает в таблице " + table.name() + ".");
        }
    }

    private static long count(Connection db, String table) throws SQLException {
        return ((Number) Db.one(db, "SELECT COUNT(*) AS n FROM " + table).get("n")).longValue();
    }

    private static void restartIdentity(Connection db, String table, String column) throws SQLException {
        long next = ((Number) Db.one(db, "SELECT COALESCE(MAX(" + column + "), 0) + 1 AS n FROM " + table)
            .get("n")).longValue();
        Db.update(db, "ALTER TABLE " + table + " ALTER COLUMN " + column + " RESTART WITH " + next);
    }
}
