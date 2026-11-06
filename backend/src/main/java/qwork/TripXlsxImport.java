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
    private static final String LOGIN_EXAMPLE = "Например, a.sadykova";
    private static final Map<String, String> HEADERS = Map.of(
        "логин сотрудника", "login", "логин", "login", "город", "city",
        "организации", "organizations", "организация", "organizations",
        "задание", "purpose", "комментарий", "comment"
    );
    private static final Pattern SEPARATOR = Pattern.compile(";|\\R");
    private static final Pattern SPACES = Pattern.compile("\\s+", Pattern.UNICODE_CHARACTER_CLASS);

    private record Place(List<String> destinations, boolean scheduleVisits) {}

    private TripXlsxImport() {}

    static Map<String, Object> template(Map<String, Object> user) throws IOException {
        requireApplicant(user);
        try (var input = TripXlsxImport.class.getResourceAsStream("/trip-import.xlsx")) {
            if (input == null) throw new IOException("Missing trip-import.xlsx");
            return Map.of("base64", Base64.getEncoder().encodeToString(input.readAllBytes()),
                "filename", "qwork-trip-import.xlsx",
                "mimeType", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        }
    }

    static Map<String, Object> process(Connection db, Map<String, Object> user, Map<String, Object> payload)
            throws SQLException, IOException {
        requireApplicant(user);
        var sheet = XlsxImport.readPayload(payload);
        var columns = columns(sheet.rows().getFirst());
        long company = number(user, "company_id");
        long employee = number(user, "id");
        // Keep the duplicate check and draft creation in one serialized company transaction.
        Planning.lockCompany(db, company);
        var rows = new ArrayList<Map<String, Object>>();
        int created = 0;
        int duplicates = 0;
        int errors = 0;
        for (var row : sheet.rows().subList(1, sheet.rows().size())) {
            try {
                var loginCell = row.cells().get("A");
                if (row.number() == 2 && "login".equals(columns.get("A")) && loginCell != null && !loginCell.formula()
                        && LOGIN_EXAMPLE.equals(loginCell.text())) {
                    // The XLSX reader omits blank cells and retains formulas.
                    if (columns.keySet().stream().noneMatch(column -> !"A".equals(column) && row.cells().containsKey(column))) {
                        continue;
                    }
                    throw error(400, "Замените пример логином сотрудника из qwork.");
                }
                var fields = rowFields(row, columns);
                String login = field(fields, "login", "Логин сотрудника", 40, false).toLowerCase(Locale.ROOT);
                if (!login.equals(user.get("login"))) {
                    throw error(400, "Укажите свой логин qwork. Импорт создаёт только ваши черновики.");
                }
                String purpose = field(fields, "purpose", "Задание", 1000, false);
                String comment = field(fields, "comment", "Комментарий", 1000, true);
                var place = place(fields);
                var assignment = new LinkedHashMap<String, Object>();
                assignment.put("purpose", purpose);
                assignment.put("comment", comment);
                if (place.scheduleVisits()) {
                    assignment.put("destinations", place.destinations());
                    TripRoutes.destinations(assignment);
                } else {
                    assignment.put("destination", place.destinations().getFirst());
                }
                String requestId = requestId(employee, place.destinations(), purpose, comment);
                var existing = Db.one(db, """
                    SELECT id FROM work_trip_offers
                    WHERE company_id = ? AND created_by = ? AND request_id = ? AND self_requested = 1
                    """, company, employee, requestId);
                if (existing != null) {
                    duplicates++;
                    rows.add(Map.of("row", row.number(), "status", "duplicate", "offerId", existing.get("id").toString()));
                    continue;
                }
                assignment.put("requestId", requestId);
                long id = TripOffers.createDraft(db, user, assignment);
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

    private static void requireApplicant(Map<String, Object> user) {
        if (!Trips.isEmployee(user)) throw error(403, "Сотрудник импортирует свои черновики командировок.");
    }

    private static Place place(Map<String, Object> fields) {
        String city = tidy(field(fields, "city", "Город", 300, true));
        String organizations = field(fields, "organizations", "Организации", 10_000, true);
        var names = new ArrayList<String>();
        for (var raw : SEPARATOR.split(organizations)) {
            String name = tidy(raw);
            if (name.isEmpty()) continue;
            String location = city.isEmpty() ? name : city + " · " + name;
            names.add(field(Map.of("location", location), "location", "Место назначения", 300, false));
        }
        if (!names.isEmpty()) return new Place(names, true);
        if (city.isEmpty()) throw error(400, "Укажите город или организацию.");
        return new Place(List.of(city), false);
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
