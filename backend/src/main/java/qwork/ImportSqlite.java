package qwork;

import org.sqlite.SQLiteConfig;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

final class ImportSqlite {
    private static final int BATCH_SIZE = 1_000;
    private static final Set<String> OPTIONAL_TABLES = Set.of("work_sites", "task_events", "task_media", "sync_events",
        "shift_calendar", "shifts", "shift_task_actions", "unavailable_employees", "incidents", "incident_tasks",
        "work_plans", "planned_jobs", "assignment_settings", "planning_imports", "login_registry", "password_resets",
        "field_work_defaults", "task_representative_reviews", "work_trips", "work_trip_tasks", "employee_work_modes",
        "work_trip_requests", "work_trip_request_tasks");
    private static final List<Table> TABLES = List.of(
        new Table("companies", "id code name", ""),
        new Table("users", "id company_id name login role is_owner password_hash password_salt",
            "last_login_at invite_hash invite_expires_at invite_required department "
                + "email email_verified email_verify_hash email_verify_expires_at"),
        new Table("sessions", "token_hash user_id expires_at", ""),
        new Table("work_sites", "id company_id name address latitude longitude radius", ""),
        new Table("tasks", "id company_id assignee_id title object address description status checks photo_before photo_after rework_reason revision",
            "location deadline arrival repeat_of cancel_reason result object_id "
                + "purpose priority manager_id checklist outcome photo_pairs repeat_reason"),
        new Table("task_events", "id task_id status actor_id actor_name created_at reason", "position received_at"),
        new Table("task_media",
            "id task_id author_id author_name kind caption created_at captured_at latitude longitude accuracy "
                + "sha256 width height original_image display_image rejected_reason rejected_at rejected_by", "pair_key checklist_id"),
        new Table("field_work_defaults", "company_id scope scope_key manager_id", ""),
        new Table("task_representative_reviews",
            "id task_id report_event_id issued_by expires_at method representative_name reason comment created_at",
            "token_hash decision decided_at photo"),
        new Table("work_trips", "id company_id employee_id created_by destination basis purpose planned_start planned_end created_at",
            "started_at finished_at"),
        new Table("work_trip_tasks", "trip_id task_id", ""),
        new Table("work_trip_requests", "id company_id employee_id destination purpose planned_start planned_end status reason created_at",
            "trip_id decided_at decided_by"),
        new Table("work_trip_request_tasks", "request_id task_id", ""),
        new Table("employee_work_modes", "employee_id work_mode", ""),
        new Table("sync_events",
            "company_id event_id task_id actor_id kind expected_revision payload_hash occurred_at received_at "
                + "requested_status photo_kind conflict_reason server_status server_revision resolved_at resolved_by", ""),
        new Table("shift_calendar", "company_id work_date day_type label", ""),
        new Table("shifts", "id company_id employee_id work_date starts_at ends_at kind decision decided_at finished_at transfer_task_id", ""),
        new Table("shift_task_actions", "shift_id task_id decision requested_at transferred_at", ""),
        new Table("unavailable_employees", "company_id employee_id unavailable_since", ""),
        new Table("incidents", "id company_id employee_id reporter_id task_id kind status reason safe minutes event_uuid "
            + "occurred_at created_at decision_reason decided_at decided_by", ""),
        new Table("incident_tasks", "incident_id task_id original_status transferred_to", ""),
        new Table("work_plans", "id company_id actor_id object_id title description start_date start_time zone "
            + "frequency repeat_interval horizon_days holiday_rule priority duration_minutes enabled generated_through", ""),
        new Table("planned_jobs", "id company_id actor_id object_id title description scheduled_at deadline priority "
            + "task_id plan_id occurrence_date", ""),
        new Table("assignment_settings", "company_id enabled max_active_tasks", ""),
        new Table("planning_imports", "company_id fingerprint", ""),
        new Table("login_registry", "login user_id", ""),
        new Table("password_resets", "token_hash user_id expires_at", "")
    );

    private record Table(String name, String required, String optional) {
        List<String> requiredColumns() {
            return List.of(required.split(" "));
        }

        List<String> optionalColumns() {
            return optional.isEmpty() ? List.of() : List.of(optional.split(" "));
        }
    }

    private static final class ImportException extends Exception {
        ImportException(String message) {
            super(message);
        }
    }

    private ImportSqlite() {}

    public static void main(String[] arguments) {
        if (arguments.length == 1 && ("--help".equals(arguments[0]) || "-h".equals(arguments[0]))) {
            System.out.println("Usage: qwork.ImportSqlite <SQLite snapshot>");
            System.out.println("Set QWORK_DATABASE_URL to an empty PostgreSQL database.");
            return;
        }
        if (arguments.length != 1 || !Db.postgres()) {
            System.err.println("Укажите путь к копии SQLite и задайте QWORK_DATABASE_URL для PostgreSQL.");
            System.exit(2);
        }
        try {
            importSnapshot(Path.of(arguments[0])).forEach((table, count) -> System.out.printf("%s: %d%n", table, count));
        } catch (ImportException error) {
            System.err.println("Перенос остановлен. " + error.getMessage());
            System.exit(1);
        } catch (IOException | SQLException | RuntimeException error) {
            // Do not include credentials, SQL parameters, or user values from failing rows.
            System.err.println("Перенос остановлен. Ошибка " + error.getClass().getSimpleName() + ".");
            System.exit(1);
        }
    }

    static Map<String, Long> importSnapshot(Path snapshot) throws IOException, SQLException, ImportException {
        if (!Files.isRegularFile(snapshot)) {
            throw new ImportException("Файл SQLite не найден.");
        }
        if (!Db.postgres()) {
            throw new ImportException("Задайте QWORK_DATABASE_URL для PostgreSQL.");
        }

        SQLiteConfig config = new SQLiteConfig();
        config.setReadOnly(true);
        config.setBusyTimeout(10_000);
        try (Connection source = config.createConnection("jdbc:sqlite:" + snapshot.toRealPath())) {
            source.setAutoCommit(false);
            List<Map<String, Object>> quickCheck = Db.rows(source, "PRAGMA quick_check");
            if (quickCheck.size() != 1 || !quickCheck.getFirst().containsValue("ok")) {
                throw new ImportException("Проверка целостности SQLite завершилась ошибкой.");
            }
            Map<Table, List<String>> columns = new LinkedHashMap<>();
            for (Table table : TABLES) {
                columns.put(table, sourceColumns(source, table));
            }

            Db.initialize();
            try (Connection target = Db.connect()) {
                Db.update(target, "SET LOCAL lock_timeout = '10s'");
                String tables = TABLES.stream().map(Table::name).map(ImportSqlite::identifier).collect(Collectors.joining(", "));
                Db.update(target, "LOCK TABLE " + tables + " IN ACCESS EXCLUSIVE MODE");
                for (Table table : TABLES) {
                    if (Db.one(target, "SELECT 1 FROM " + identifier(table.name()) + " LIMIT 1") != null) {
                        throw new ImportException("Таблица PostgreSQL " + table.name() + " уже содержит данные.");
                    }
                }

                Db.update(target, "SET CONSTRAINTS ALL DEFERRED");
                Map<String, Long> counts = new LinkedHashMap<>();
                for (var entry : columns.entrySet()) {
                    String table = entry.getKey().name();
                    counts.put(table, copyTable(source, target, table, entry.getValue()));
                }
                boolean hasEmailColumn = columns.entrySet().stream()
                    .anyMatch(entry -> entry.getKey().name().equals("users") && entry.getValue().contains("email"));
                if (!hasEmailColumn) Db.update(target, "UPDATE users SET email = login WHERE is_owner = 1");
                Db.update(target, """
                    INSERT INTO login_registry(login, user_id)
                    SELECT login, CASE WHEN COUNT(*) = 1 THEN MIN(id) ELSE NULL END
                    FROM users GROUP BY login ON CONFLICT (login) DO NOTHING
                    """);
                Db.update(target, "SET CONSTRAINTS ALL IMMEDIATE");
                for (Table table : TABLES) {
                    if (table.requiredColumns().contains("id")) {
                        resetIdentity(target, table.name());
                    }
                }
                target.commit();
                return counts;
            }
        }
    }

    private static List<String> sourceColumns(Connection source, Table table) throws SQLException, ImportException {
        Set<String> available = new HashSet<>();
        for (var row : Db.rows(source, "PRAGMA table_info(" + identifier(table.name()) + ")")) {
            available.add((String) row.get("name"));
        }
        if (available.isEmpty() && OPTIONAL_TABLES.contains(table.name())) {
            return List.of();
        }
        if (!available.containsAll(table.requiredColumns())) {
            throw new ImportException("В SQLite отсутствуют обязательные поля таблицы " + table.name() + ".");
        }
        List<String> columns = new ArrayList<>(table.requiredColumns());
        for (String column : table.optionalColumns()) {
            if (available.contains(column)) {
                columns.add(column);
            }
        }
        if (!columns.containsAll(available)) {
            throw new ImportException("Неизвестные поля таблицы " + table.name() + ". Проверьте версию базы SQLite.");
        }
        return columns;
    }

    private static long copyTable(Connection source, Connection target, String table, List<String> columns) throws SQLException {
        if (columns.isEmpty()) {
            return 0;
        }
        // Image rows can contain several MiB of binary data each.
        int batchSize = table.equals("task_media") ? 1 : BATCH_SIZE;
        String fields = columns.stream().map(ImportSqlite::identifier).collect(Collectors.joining(", "));
        String placeholders = String.join(", ", Collections.nCopies(columns.size(), "?"));
        String query = "SELECT " + fields + " FROM " + identifier(table);
        String insert = "INSERT INTO " + identifier(table) + " (" + fields + ") VALUES (" + placeholders + ")";
        try (var from = source.createStatement();
             var rows = from.executeQuery(query);
             var into = target.prepareStatement(insert)) {
            long count = 0;
            while (rows.next()) {
                for (int index = 1; index <= columns.size(); index++) {
                    into.setObject(index, rows.getObject(index));
                }
                into.addBatch();
                count++;
                if (count % batchSize == 0) {
                    into.executeBatch();
                }
            }
            if (count % batchSize != 0) {
                into.executeBatch();
            }
            return count;
        }
    }

    private static void resetIdentity(Connection target, String table) throws SQLException {
        Number maxId = (Number) Db.one(target, "SELECT max(id) AS max_id FROM " + identifier(table)).get("max_id");
        long nextId = maxId == null ? 1 : Math.max(1, Math.addExact(maxId.longValue(), 1));
        // ALTER TABLE RESTART participates in the same transaction as the data import.
        Db.update(target, "ALTER TABLE " + identifier(table) + " ALTER COLUMN id RESTART WITH " + nextId);
    }

    private static String identifier(String value) {
        // Called with table and column names declared in TABLES.
        return "\"" + value + "\"";
    }
}
