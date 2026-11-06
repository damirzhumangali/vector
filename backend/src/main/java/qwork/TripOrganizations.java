package qwork;

import java.sql.Connection;
import java.sql.SQLException;
import java.text.Normalizer;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

import static qwork.Domain.error;
import static qwork.Domain.field;
import static qwork.Domain.number;

final class TripOrganizations {
    static final String SQLITE_SCHEMA = """
        CREATE TABLE IF NOT EXISTS trip_organizations (
            company_id INTEGER NOT NULL REFERENCES companies(id),
            name_key TEXT NOT NULL,
            name TEXT NOT NULL,
            PRIMARY KEY (company_id, name_key)
        );
        """;

    private static final Pattern SPACES = Pattern.compile("\\s+", Pattern.UNICODE_CHARACTER_CLASS);

    private TripOrganizations() {}

    static List<Map<String, Object>> list(Connection db, Map<String, Object> user) throws SQLException {
        return Db.rows(db, "SELECT name FROM trip_organizations WHERE company_id = ? ORDER BY name_key",
            number(user, "company_id"));
    }

    static Map<String, Object> save(Connection db, Map<String, Object> user, Map<String, Object> body) throws SQLException {
        if (!Trips.isEmployee(user) && !Accounts.isManager(user)) {
            throw error(403, "Список организаций доступен участникам компании.");
        }
        String raw = field(body, "name", "Название организации", 300, false);
        String name = Normalizer.normalize(SPACES.matcher(raw).replaceAll(" ").strip(), Normalizer.Form.NFC);
        if (name.isEmpty()) throw error(400, "Введите название организации.");
        var row = Db.one(db, """
            INSERT INTO trip_organizations(company_id, name_key, name) VALUES (?, ?, ?)
            ON CONFLICT (company_id, name_key) DO UPDATE SET name = trip_organizations.name
            RETURNING name
            """, number(user, "company_id"), name.toLowerCase(Locale.ROOT), name);
        return Map.of("organization", row);
    }
}
