package qwork;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.List;
import java.util.Map;

import static qwork.Domain.error;
import static qwork.Domain.field;
import static qwork.Domain.number;

/** Company-scoped sites and immutable location snapshots for work orders. */
final class Places {
    static final String SQLITE_SCHEMA = """
        CREATE TABLE IF NOT EXISTS work_sites (
            id INTEGER PRIMARY KEY,
            company_id INTEGER NOT NULL REFERENCES companies(id),
            name TEXT NOT NULL,
            address TEXT NOT NULL,
            latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
            longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
            radius REAL NOT NULL CHECK (radius BETWEEN 1 AND 10000)
        );
        CREATE INDEX IF NOT EXISTS work_sites_by_company ON work_sites(company_id, name, id);
        """;

    record Selection(Long objectId, String name, String address, Map<String, Object> location) {}

    private Places() {}

    static Map<String, Object> list(Connection db, Map<String, Object> user) throws SQLException {
        Accounts.requireDispatcher(user);
        var rows = Db.rows(db, """
            SELECT id, name, address, latitude, longitude, radius
            FROM work_sites WHERE company_id = ? ORDER BY name, id
            """, number(user, "company_id"));
        return Map.of("objects", rows.stream().map(Places::json).toList());
    }

    static Map<String, Object> create(Connection db, Map<String, Object> user, Map<String, Object> payload)
            throws SQLException {
        Accounts.requireDispatcher(user);
        String name = field(payload, "name", "Название объекта", 160, false);
        String address = field(payload, "address", "Адрес", 240, true);
        var location = validatedLocation(payload.get("location"));
        long id = Db.insert(db, """
            INSERT INTO work_sites(company_id, name, address, latitude, longitude, radius)
            VALUES (?, ?, ?, ?, ?, ?)
            """, number(user, "company_id"), name, address, location.get("latitude"),
            location.get("longitude"), location.get("radius"));
        return Map.of("object", Map.of("id", Long.toString(id), "name", name, "address", address,
            "location", location));
    }

    static Selection resolve(Connection db, Map<String, Object> user, Map<String, Object> payload)
            throws SQLException {
        if (payload.get("objectId") != null) {
            long id = objectId(payload.get("objectId"));
            var row = Db.one(db, """
                SELECT id, name, address, latitude, longitude, radius
                FROM work_sites WHERE company_id = ? AND id = ?
                """, number(user, "company_id"), id);
            if (row == null) {
                throw error(404, "Объект не найден.");
            }
            return new Selection(id, (String) row.get("name"), (String) row.get("address"), rowLocation(row));
        }

        var location = validatedLocation(payload.get("location"));
        String name = field(payload, "object", "Объект", 160, true);
        String address = field(payload, "address", "Адрес", 240, true);
        return new Selection(null, name.isEmpty() ? "Точка на карте" : name, address, location);
    }

    private static long objectId(Object value) {
        if (value instanceof String id && id.matches("[1-9][0-9]{0,18}")) {
            try {
                return Long.parseLong(id);
            } catch (NumberFormatException ignored) {
                // Reject IDs outside the range shared by SQLite and PostgreSQL.
            }
        }
        throw error(400, "Выберите объект из справочника.");
    }

    private static Map<String, Object> validatedLocation(Object value) {
        if (!(value instanceof Map<?, ?> location)) {
            throw error(400, "Выберите объект из справочника или отметьте точку на карте.");
        }
        Object radius = location.get("radius");
        return Map.of(
            "latitude", measurement(location.get("latitude"), -90, 90, "Широта"),
            "longitude", measurement(location.get("longitude"), -180, 180, "Долгота"),
            "radius", measurement(radius == null ? 100 : radius, 1, 10_000, "Радиус объекта"));
    }

    private static double measurement(Object value, double min, double max, String label) {
        if (value instanceof Number number) {
            double result = number.doubleValue();
            if (Double.isFinite(result) && result >= min && result <= max) {
                return result;
            }
        }
        throw error(400, "Проверьте поле «" + label + "».");
    }

    private static Map<String, Object> json(Map<String, Object> row) {
        return Map.of("id", row.get("id").toString(), "name", row.get("name"),
            "address", row.get("address"), "location", rowLocation(row));
    }

    private static Map<String, Object> rowLocation(Map<String, Object> row) {
        return Map.of("latitude", row.get("latitude"), "longitude", row.get("longitude"),
            "radius", row.get("radius"));
    }
}
