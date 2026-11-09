package qwork;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.sqlite.SQLiteConfig;

import java.io.IOException;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;

final class Db {
    static final ObjectMapper JSON = new ObjectMapper();
    private static final String DATABASE_URL = System.getenv().getOrDefault("QWORK_DATABASE_URL", "");
    private static final long MIGRATION_LOCK = 0x51574F524BL;
    private static final List<String> MIGRATIONS = List.of(
        "0001_initial.sql", "0002_media.sql", "0003_places.sql", "0004_sync.sql",
        "0005_shifts.sql", "0006_incidents.sql", "0007_planning.sql", "0008_auto_assignment.sql",
        "0009_xlsx_import.sql", "0010_departments.sql", "0011_login_registry.sql", "0012_optional_email.sql",
        "0013_field_reports.sql", "0014_representative_reviews.sql", "0015_field_operations.sql", "0016_trip_requests.sql",
        "0017_task_assignment_changes.sql", "0018_import_journal.sql", "0019_incident_push.sql",
        "0020_trip_budgets.sql", "0021_task_schedule.sql", "0022_trip_offers.sql",
        "0023_trip_offer_history.sql", "0024_trip_route.sql", "0025_trip_actual_expenses.sql",
        "0026_trip_organizations.sql", "0027_unified_manager_role.sql", "0028_trip_approvals.sql"
    );
    private static final String SQLITE_SCHEMA = """
        CREATE TABLE IF NOT EXISTS companies (
            id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
            name TEXT NOT NULL, login TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('employee', 'dispatcher', 'manager')),
            is_owner INTEGER NOT NULL DEFAULT 0, password_hash BLOB NOT NULL, password_salt BLOB NOT NULL,
            last_login_at TEXT, invite_hash BLOB, invite_expires_at INTEGER,
            invite_required INTEGER NOT NULL DEFAULT 0, UNIQUE (company_id, login)
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash BLOB PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
            expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS login_registry (
            login TEXT PRIMARY KEY,
            user_id INTEGER REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS password_resets (
            token_hash BLOB PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id),
            expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS password_resets_by_user ON password_resets(user_id);
        CREATE INDEX IF NOT EXISTS password_resets_by_expiry ON password_resets(expires_at);
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
            assignee_id INTEGER NOT NULL REFERENCES users(id),
            title TEXT NOT NULL, object TEXT NOT NULL, address TEXT NOT NULL, description TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'assigned',
            checks TEXT NOT NULL DEFAULT '[false,false,false,false,false]',
            photo_before INTEGER NOT NULL DEFAULT 0, photo_after INTEGER NOT NULL DEFAULT 0,
            rework_reason TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
            location TEXT, deadline TEXT, arrival TEXT, repeat_of INTEGER REFERENCES tasks(id),
            cancel_reason TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS tasks_by_company_assignee ON tasks(company_id, assignee_id);
        CREATE TABLE IF NOT EXISTS task_events (
            id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id),
            status TEXT NOT NULL, actor_id INTEGER NOT NULL REFERENCES users(id),
            actor_name TEXT NOT NULL, created_at TEXT NOT NULL, reason TEXT NOT NULL, position TEXT
        );
        CREATE INDEX IF NOT EXISTS events_by_task ON task_events(task_id, id);
        """;

    private Db() {}

    static boolean postgres() {
        return !DATABASE_URL.isBlank();
    }

    private static Path sqlitePath() {
        String defaultPath = Files.isDirectory(Path.of("backend")) ? "backend/data/qwork.sqlite3" : "data/qwork.sqlite3";
        return Path.of(System.getenv().getOrDefault("QWORK_DB", defaultPath)).toAbsolutePath();
    }

    private static Connection openPostgres() throws SQLException {
        return openPostgres(DATABASE_URL, "QWORK_DATABASE_URL");
    }

    static Connection openPostgres(String databaseUrl, String variableName) throws SQLException {
        Properties properties = new Properties();
        properties.setProperty("connectTimeout", "5");
        if (databaseUrl.startsWith("jdbc:postgresql:")) {
            return DriverManager.getConnection(databaseUrl, properties);
        }

        try {
            URI uri = URI.create(databaseUrl);
            if (!List.of("postgres", "postgresql").contains(uri.getScheme()) || uri.getHost() == null) {
                throw new IllegalArgumentException();
            }
            String userInfo = uri.getRawUserInfo();
            if (userInfo != null) {
                String[] credentials = userInfo.split(":", 2);
                properties.setProperty("user", decodeUriComponent(credentials[0]));
                if (credentials.length == 2) {
                    properties.setProperty("password", decodeUriComponent(credentials[1]));
                }
            }
            String port = uri.getPort() < 0 ? "" : ":" + uri.getPort();
            String query = uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery();
            String path = uri.getRawPath() == null ? "" : uri.getRawPath();
            return DriverManager.getConnection("jdbc:postgresql://" + uri.getHost() + port + path + query, properties);
        } catch (IllegalArgumentException | NullPointerException error) {
            // Connection strings may contain secrets, so do not propagate the URI parser's error.
            throw new SQLException("Invalid " + variableName);
        }
    }

    private static String decodeUriComponent(String value) {
        return URLDecoder.decode(value.replace("+", "%2B"), StandardCharsets.UTF_8);
    }

    private static Connection openSqlite(boolean write) throws SQLException {
        SQLiteConfig config = new SQLiteConfig();
        config.enforceForeignKeys(true);
        config.setBusyTimeout(10_000);
        config.setTransactionMode(write ? SQLiteConfig.TransactionMode.IMMEDIATE : SQLiteConfig.TransactionMode.DEFERRED);
        return config.createConnection("jdbc:sqlite:" + sqlitePath());
    }

    static Connection connect() throws SQLException {
        return connect(true);
    }

    static Connection connect(boolean write) throws SQLException {
        Connection connection = postgres() ? openPostgres() : openSqlite(write);
        try {
            connection.setAutoCommit(false);
            return connection;
        } catch (SQLException error) {
            connection.close();
            throw error;
        }
    }

    static void initialize() throws SQLException, IOException {
        if (postgres()) {
            initializePostgres();
            return;
        }
        Files.createDirectories(sqlitePath().getParent());
        try (Connection db = openSqlite(false); Statement statement = db.createStatement()) {
            statement.execute("PRAGMA journal_mode = WAL");
        }
        try (Connection db = connect()) {
            try (Statement statement = db.createStatement()) {
                for (String sql : (SQLITE_SCHEMA + Media.SQLITE_SCHEMA + Places.SQLITE_SCHEMA + Sync.SQLITE_SCHEMA
                        + Shift.SQLITE_SCHEMA + Incidents.SQLITE_SCHEMA + Planning.SQLITE_SCHEMA
                        + AutoAssignment.SQLITE_SCHEMA + XlsxImport.SQLITE_SCHEMA
                        + RepresentativeReviews.SQLITE_SCHEMA + Trips.SQLITE_SCHEMA + TripRequests.SQLITE_SCHEMA
                        + IncidentPush.SQLITE_SCHEMA + TripOffers.SQLITE_SCHEMA + TripRoutes.SQLITE_SCHEMA
                        + TripActualExpenses.SQLITE_SCHEMA + TripOrganizations.SQLITE_SCHEMA
                        + TripApprovals.SQLITE_SCHEMA).split(";")) {
                    if (!sql.isBlank()) {
                        statement.execute(sql);
                    }
                }
            }
            boolean emailWasMissing = rows(db, "PRAGMA table_info(users)").stream()
                .noneMatch(column -> "email".equals(column.get("name")));
            addMissingColumns(db, "users", Map.of(
                "last_login_at", "TEXT", "invite_hash", "BLOB", "invite_expires_at", "INTEGER",
                "invite_required", "INTEGER NOT NULL DEFAULT 0", "department", "TEXT NOT NULL DEFAULT ''"
            ));
            addMissingColumns(db, "users", Map.of(
                "email", "TEXT", "email_verified", "INTEGER NOT NULL DEFAULT 0",
                "email_verify_hash", "BLOB", "email_verify_expires_at", "INTEGER"
            ));
            if (emailWasMissing) update(db, "UPDATE users SET email = login WHERE is_owner = 1");
            update(db, "UPDATE users SET role = 'manager' WHERE role = 'dispatcher'");
            allowLoginAliases(db);
            update(db, """
                CREATE UNIQUE INDEX IF NOT EXISTS users_by_email_verification
                ON users(email_verify_hash) WHERE email_verify_hash IS NOT NULL
                """);
            addMissingColumns(db, "tasks", Map.of(
                "location", "TEXT", "deadline", "TEXT", "arrival", "TEXT",
                "repeat_of", "INTEGER REFERENCES tasks(id)", "cancel_reason", "TEXT NOT NULL DEFAULT ''",
                "result", "TEXT NOT NULL DEFAULT ''"
            ));
            addMissingColumns(db, "tasks", Map.of(
                "object_id", "INTEGER REFERENCES work_sites(id)", "scheduled_start", "TEXT"
            ));
            addMissingColumns(db, "task_events", Map.of("position", "TEXT", "received_at", "TEXT"));
            addMissingColumns(db, "work_trips", Map.of(
                "object_id", "INTEGER REFERENCES work_sites(id)", "address", "TEXT NOT NULL DEFAULT ''",
                "budget", "TEXT", "estimate", "TEXT"
            ));
            addMissingColumns(db, "work_trip_requests", Map.of("estimate", "TEXT"));
            addMissingColumns(db, "work_trip_offers", Map.of("proposal_estimate", "TEXT", "declined_at", "TEXT",
                "self_requested", "INTEGER NOT NULL DEFAULT 0"));
            FieldWork.initSqlite(db);
            Sync.initSqlite(db);
            update(db, """
                CREATE INDEX IF NOT EXISTS task_events_gps_arrivals ON task_events(actor_id, id)
                WHERE status = 'arrived' AND position IS NOT NULL
                """);
            update(db, "CREATE UNIQUE INDEX IF NOT EXISTS users_by_invite ON users(invite_hash) WHERE invite_hash IS NOT NULL");
            update(db, "CREATE UNIQUE INDEX IF NOT EXISTS task_repeat ON tasks(repeat_of) WHERE repeat_of IS NOT NULL");
            update(db, """
                INSERT INTO login_registry(login, user_id)
                SELECT login, CASE WHEN COUNT(*) = 1 THEN MIN(id) ELSE NULL END
                FROM users GROUP BY login
                ON CONFLICT (login) DO NOTHING
                """);
            db.commit();
        }
    }

    private static void allowLoginAliases(Connection db) throws SQLException {
        for (var index : rows(db, "PRAGMA index_list(login_registry)")) {
            if (((Number) index.get("unique")).intValue() == 0) continue;
            String indexName = ((String) index.get("name")).replace("'", "''");
            var columns = rows(db, "PRAGMA index_info('" + indexName + "')");
            if (columns.size() == 1 && "user_id".equals(columns.getFirst().get("name"))) {
                update(db, "CREATE TABLE login_registry_next (login TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id))");
                update(db, "INSERT INTO login_registry_next(login, user_id) SELECT login, user_id FROM login_registry");
                update(db, "DROP TABLE login_registry");
                update(db, "ALTER TABLE login_registry_next RENAME TO login_registry");
                break;
            }
        }
        update(db, "CREATE INDEX IF NOT EXISTS login_registry_by_user ON login_registry(user_id)");
    }

    private static void addMissingColumns(Connection db, String table, Map<String, String> definitions) throws SQLException {
        List<Map<String, Object>> columns = rows(db, "PRAGMA table_info(" + table + ")");
        for (var definition : definitions.entrySet()) {
            if (columns.stream().noneMatch(column -> definition.getKey().equals(column.get("name")))) {
                update(db, "ALTER TABLE " + table + " ADD COLUMN " + definition.getKey() + " " + definition.getValue());
            }
        }
    }

    private static void initializePostgres() throws SQLException, IOException {
        try (Connection db = connect()) {
            one(db, "SELECT pg_advisory_xact_lock(?)", MIGRATION_LOCK);
            update(db, """
                CREATE TABLE IF NOT EXISTS qwork_schema_migrations (
                    version TEXT PRIMARY KEY,
                    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """);
            for (String migration : MIGRATIONS) {
                if (one(db, "SELECT version FROM qwork_schema_migrations WHERE version = ?", migration) != null) {
                    continue;
                }
                try (var source = Db.class.getResourceAsStream("/migrations/" + migration);
                     Statement statement = db.createStatement()) {
                    if (source == null) {
                        throw new IOException("Missing PostgreSQL migration " + migration);
                    }
                    statement.execute(new String(source.readAllBytes(), StandardCharsets.UTF_8));
                }
                update(db, "INSERT INTO qwork_schema_migrations(version) VALUES (?)", migration);
            }
            db.commit();
        }
    }

    static void lockTask(Connection db, long companyId, long taskId) throws SQLException {
        // SQLite write connections take the lock at transaction start.
        if (postgres()) {
            one(db, "SELECT id FROM tasks WHERE company_id = ? AND id = ? FOR UPDATE", companyId, taskId);
        }
    }

    private static PreparedStatement prepare(Connection db, String sql, Object[] params) throws SQLException {
        PreparedStatement statement = db.prepareStatement(sql);
        try {
            for (int index = 0; index < params.length; index++) {
                statement.setObject(index + 1, params[index]);
            }
            return statement;
        } catch (SQLException error) {
            statement.close();
            throw error;
        }
    }

    static int update(Connection db, String sql, Object... params) throws SQLException {
        try (PreparedStatement statement = prepare(db, sql, params)) {
            return statement.executeUpdate();
        }
    }

    static long insert(Connection db, String sql, Object... params) throws SQLException {
        Map<String, Object> row = one(db, sql.stripTrailing() + " RETURNING id", params);
        if (row == null) {
            throw new SQLException("Insert did not return its identifier");
        }
        return ((Number) row.get("id")).longValue();
    }

    static Map<String, Object> one(Connection db, String sql, Object... params) throws SQLException {
        try (PreparedStatement statement = prepare(db, sql, params);
             ResultSet result = statement.executeQuery()) {
            return result.next() ? mapRow(result, result.getMetaData()) : null;
        }
    }

    static List<Map<String, Object>> rows(Connection db, String sql, Object... params) throws SQLException {
        try (PreparedStatement statement = prepare(db, sql, params);
             ResultSet result = statement.executeQuery()) {
            ResultSetMetaData metadata = result.getMetaData();
            List<Map<String, Object>> resultRows = new ArrayList<>();
            while (result.next()) {
                resultRows.add(mapRow(result, metadata));
            }
            return resultRows;
        }
    }

    private static Map<String, Object> mapRow(ResultSet result, ResultSetMetaData metadata) throws SQLException {
        Map<String, Object> row = new LinkedHashMap<>();
        for (int index = 1; index <= metadata.getColumnCount(); index++) {
            row.put(metadata.getColumnLabel(index), result.getObject(index));
        }
        return row;
    }
}
