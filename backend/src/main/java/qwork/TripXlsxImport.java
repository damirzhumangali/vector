package qwork;

import java.io.IOException;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

import static qwork.Domain.error;
import static qwork.Domain.field;
import static qwork.Domain.number;

final class TripXlsxImport {
    private static final Map<String, String> HEADERS = Map.of(
        "логин сотрудника", "login", "логин", "login", "город", "city",
        "организации", "organizations", "организация", "organizations",
        "задание", "purpose", "комментарий", "comment"
    );
    private static final Pattern SEPARATOR = Pattern.compile(";|\\R");
    private static final Pattern SPACES = Pattern.compile("\\s+", Pattern.UNICODE_CHARACTER_CLASS);

    private TripXlsxImport() {}

    static Map<String, Object> template(Map<String, Object> user) throws IOException {
        Accounts.requireDispatcher(user);
        try (var input = TripXlsxImport.class.getResourceAsStream("/trip-import.xlsx")) {
            if (input == null) throw new IOException("Missing trip-import.xlsx");
            return Map.of("base64", Base64.getEncoder().encodeToString(input.readAllBytes()),
                "filename", "qwork-trip-import.xlsx",
                "mimeType", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        }
    }

    static Map<String, Object> process(Connection db, Map<String, Object> user, Map<String, Object> payload)
            throws SQLException, IOException {
        Accounts.requireDispatcher(user);
        var sheet = XlsxImport.readPayload(payload);
        var columns = columns(sheet.rows().getFirst());
        long company = number(user, "company_id");
        // Serialize imports per company, including when different dispatchers upload the same file.
        Planning.lockCompany(db, company);
        var rows = new ArrayList<Map<String, Object>>();
        int created = 0;
        int duplicates = 0;
        int errors = 0;
        for (var row : sheet.rows().subList(1, sheet.rows().size())) {
            try {
                var fields = rowFields(row, columns);
                long employee = employee(db, company, fields);
                String purpose = field(fields, "purpose", "Задание", 1000, false);
                String comment = field(fields, "comment", "Комментарий", 1000, true);
                var destinations = destinations(fields);
                var assignment = new LinkedHashMap<String, Object>();
                assignment.put("employeeId", employee);
                assignment.put("purpose", purpose);
                assignment.put("comment", comment);
                if (destinations.size() == 1) {
                    assignment.put("destination", destinations.getFirst());
                } else {
                    assignment.put("destinations", destinations);
                    TripRoutes.destinations(assignment);
                }
                String requestId = requestId(employee, destinations, purpose, comment);
                var existing = Db.one(db, """
                    SELECT id FROM work_trip_offers WHERE company_id = ? AND request_id = ? ORDER BY id LIMIT 1
                    """, company, requestId);
                if (existing != null) {
                    duplicates++;
                    rows.add(Map.of("row", row.number(), "status", "duplicate", "offerId", existing.get("id").toString()));
                    continue;
                }
                assignment.put("requestId", requestId);
                long id = TripOffers.createId(db, user, assignment);
                created++;
                rows.add(Map.of("row", row.number(), "status", "created", "offerId", Long.toString(id)));
            } catch (Domain.Failure failure) {
                errors++;
                rows.add(Map.of("row", row.number(), "status", "error", "message", failure.getMessage()));
            }
        }
        return Map.of("createdCount", created, "duplicateCount", duplicates, "errorCount", errors, "rows", rows);
    }

    private static Map<String, String> columns(XlsxImport.SheetRow header) {
        var columns = new LinkedHashMap<String, String>();
        var seen = new HashSet<String>();
        for (var entry : header.cells().entrySet()) {
            var cell = entry.getValue();
            String key = HEADERS.get(normalize(cell.text()));
            if (key == null) continue;
            if (cell.formula()) throw error(400, "Замените формулы в заголовках обычным текстом.");
            if (!seen.add(key)) throw error(400, "Заголовок повторяется: «" + cell.text().strip() + "».");
            columns.put(entry.getKey(), key);
        }
        if (!(seen.contains("login") && seen.contains("purpose")
                && (seen.contains("city") || seen.contains("organizations")))) {
            throw error(400, "На первом листе нужны столбцы «Логин сотрудника», «Город» или «Организации» и «Задание».");
        }
        return columns;
    }

    private static Map<String, Object> rowFields(XlsxImport.SheetRow row, Map<String, String> columns) {
        var fields = new LinkedHashMap<String, Object>();
        for (var entry : columns.entrySet()) {
            var cell = row.cells().get(entry.getKey());
            if (cell == null) continue;
            if (cell.formula()) throw error(400, "Замените формулы в этой строке значениями.");
            fields.put(entry.getValue(), cell.text().strip());
        }
        return fields;
    }

    private static long employee(Connection db, long company, Map<String, Object> fields) throws SQLException {
        String login = field(fields, "login", "Логин сотрудника", 40, false).toLowerCase(Locale.ROOT);
        var row = Db.one(db, "SELECT id FROM users WHERE company_id = ? AND role = 'employee' AND login = ?", company, login);
        if (row == null) throw error(400, "Сотрудник с таким логином не найден в компании.");
        return number(row, "id");
    }

    private static List<String> destinations(Map<String, Object> fields) {
        String city = tidy(field(fields, "city", "Город", 300, true));
        String organizations = field(fields, "organizations", "Организации", 10_000, true);
        var names = new ArrayList<String>();
        for (var raw : SEPARATOR.split(organizations)) {
            String name = tidy(raw);
            if (name.isEmpty()) continue;
            String location = city.isEmpty() ? name : city + " · " + name;
            names.add(field(Map.of("location", location), "location", "Место назначения", 300, false));
        }
        if (!names.isEmpty()) return names;
        if (city.isEmpty()) throw error(400, "Укажите город или организацию.");
        return List.of(city);
    }

    private static String requestId(long employee, List<String> destinations, String purpose, String comment) throws IOException {
        byte[] content = Db.JSON.writeValueAsBytes(List.of("trip-offer-import-v1", employee,
            destinations.stream().map(TripXlsxImport::normalize).toList(), normalize(purpose), normalize(comment)));
        return UUID.nameUUIDFromBytes(content).toString();
    }

    private static String normalize(String value) {
        return tidy(value).toLowerCase(Locale.ROOT);
    }

    private static String tidy(String value) {
        return SPACES.matcher(value).replaceAll(" ").strip();
    }
}
