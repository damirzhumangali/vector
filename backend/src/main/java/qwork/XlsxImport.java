package qwork;

import com.fasterxml.jackson.core.type.TypeReference;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.net.URI;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.time.format.ResolverStyle;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.zip.ZipInputStream;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.parsers.ParserConfigurationException;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.xml.sax.SAXException;
import org.xml.sax.helpers.DefaultHandler;

final class XlsxImport {
    static final int MAX_BYTES = 2 * 1024 * 1024;
    static final String SQLITE_SCHEMA = """
        CREATE TABLE IF NOT EXISTS planning_imports (
            company_id INTEGER NOT NULL REFERENCES companies(id),
            fingerprint TEXT NOT NULL,
            PRIMARY KEY (company_id, fingerprint)
        );
        CREATE TABLE IF NOT EXISTS planning_import_runs (
            id INTEGER PRIMARY KEY,
            company_id INTEGER NOT NULL REFERENCES companies(id),
            actor_id INTEGER NOT NULL REFERENCES users(id),
            actor_name TEXT NOT NULL,
            file_name TEXT NOT NULL,
            mode TEXT NOT NULL CHECK (mode IN ('planning', 'tasks')),
            created_at TEXT NOT NULL,
            total_rows INTEGER NOT NULL,
            imported_rows INTEGER NOT NULL,
            duplicate_rows INTEGER NOT NULL,
            invalid_rows INTEGER NOT NULL,
            errors TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS planning_import_runs_by_company ON planning_import_runs(company_id, id DESC);
        """;
    private static final int MAX_EXPANDED_BYTES = 12 * 1024 * 1024;
    private static final int MAX_ROWS = 200;
    private static final List<String> REQUIRED = List.of("title", "startDate", "time");
    private static final DateTimeFormatter LOCAL_DATE = DateTimeFormatter.ofPattern("d.M.uuuu")
        .withResolverStyle(ResolverStyle.STRICT);
    private static final DateTimeFormatter LOCAL_TIME = DateTimeFormatter.ofPattern("H:mm")
        .withResolverStyle(ResolverStyle.STRICT);
    private static final Map<String, String> HEADERS = Map.ofEntries(
        Map.entry("title", "title"), Map.entry("название", "title"),
        Map.entry("название заявки", "title"),
        Map.entry("objectid", "objectId"), Map.entry("id объекта", "objectId"),
        Map.entry("object", "objectName"), Map.entry("объект", "objectName"),
        Map.entry("название объекта", "objectName"),
        Map.entry("assigneelogin", "assigneeLogin"), Map.entry("логин исполнителя", "assigneeLogin"),
        Map.entry("startdate", "startDate"), Map.entry("дата", "startDate"),
        Map.entry("time", "time"), Map.entry("время", "time"),
        Map.entry("description", "description"), Map.entry("описание", "description"),
        Map.entry("priority", "priority"), Map.entry("приоритет", "priority"),
        Map.entry("durationminutes", "durationMinutes"), Map.entry("длительность, мин", "durationMinutes")
    );

    record Cell(String text, boolean numeric, boolean formula) {}
    record SheetRow(int number, Map<String, Cell> cells) {}
    record Sheet(List<SheetRow> rows, boolean dates1904) {}

    private XlsxImport() {}

    static Map<String, Object> journal(Connection db, Map<String, Object> user) throws SQLException, IOException {
        Accounts.requireManager(user);
        var runs = Db.rows(db, """
            SELECT id, actor_name, file_name, mode, created_at, total_rows, imported_rows, duplicate_rows,
                invalid_rows, errors
            FROM planning_import_runs WHERE company_id = ? ORDER BY id DESC LIMIT 25
            """, Domain.number(user, "company_id"));
        var imports = new ArrayList<Map<String, Object>>(runs.size());
        for (var run : runs) {
            List<Map<String, Object>> errors = Db.JSON.readValue((String) run.get("errors"), new TypeReference<>() {});
            imports.add(Map.of("id", run.get("id").toString(), "actorName", run.get("actor_name"),
                "fileName", run.get("file_name"), "mode", run.get("mode"), "createdAt", run.get("created_at"),
                "total", run.get("total_rows"), "imported", run.get("imported_rows"),
                "duplicates", run.get("duplicate_rows"), "invalid", run.get("invalid_rows"), "errors", errors));
        }
        return Map.of("imports", imports);
    }

    static Map<String, Object> process(Connection db, Map<String, Object> user, Map<String, Object> payload,
                                       boolean apply) throws Exception {
        Accounts.requireManager(user);
        Object mode = payload.getOrDefault("mode", "planning");
        if (!"planning".equals(mode) && !"tasks".equals(mode)) {
            throw Domain.error(400, "Выберите режим импорта Excel.");
        }
        boolean direct = "tasks".equals(mode);
        String name = fileName(payload);
        Sheet sheet = readPayload(payload);
        Map<String, String> columns = new LinkedHashMap<>();
        var known = new HashSet<String>();
        sheet.rows().getFirst().cells().forEach((column, cell) -> {
            String field = HEADERS.get(cell.text().strip().toLowerCase(Locale.ROOT));
            if (!direct && ("objectName".equals(field) || "assigneeLogin".equals(field))) return;
            if (field != null) {
                if (!known.add(field)) throw Domain.error(400, "Заголовок повторяется: " + field);
                columns.put(column, field);
            }
        });
        if (!known.containsAll(REQUIRED) || !(known.contains("objectId") || direct && known.contains("objectName"))) {
            throw Domain.error(400, direct
                ? "На первом листе нужны столбцы «Название», «Объект» или «ID объекта», «Дата» и «Время»."
                : "На первом листе нужны столбцы «Название», «ID объекта», «Дата» и «Время».");
        }

        long company = Domain.number(user, "company_id");
        if (apply) Planning.lockCompany(db, company);
        var results = new ArrayList<Map<String, Object>>();
        var tasks = new ArrayList<Object>();
        var seen = new HashSet<String>();
        int imported = 0;
        for (var row : sheet.rows().subList(1, sheet.rows().size())) {
            var result = new LinkedHashMap<String, Object>();
            result.put("row", row.number());
            result.put("error", null);
            result.put("duplicate", false);
            results.add(result);

            Map<String, Object> fields = new HashMap<>();
            fields.put("frequency", "once");
            fields.put("holidayRule", "run");
            try {
                for (var column : columns.entrySet()) {
                    Cell cell = row.cells().get(column.getKey());
                    if (cell == null) continue;
                    if (cell.formula()) throw Domain.error(400, "Замените формулы в этой строке значениями.");
                    if (!cell.text().isBlank()) {
                        String field = column.getValue();
                        Object value = convert(field, cell, sheet.dates1904(), direct);
                        fields.put(field, value);
                        result.put(field, value);
                    }
                }
            } catch (Domain.Failure error) {
                result.put("error", error.getMessage());
                continue;
            }

            Map<String, Object> normalized;
            String assigneeId = null;
            try {
                if (direct) resolveObject(db, user, fields, result);
                normalized = Planning.validate(db, user, fields);
                if (direct) assigneeId = resolveAssignee(db, company, fields, result, apply);
            } catch (Domain.Failure error) {
                result.put("error", error.getMessage());
                continue;
            }
            String fingerprint = fingerprint(normalized);
            boolean duplicate = !seen.add(fingerprint);
            if (!duplicate && apply) {
                duplicate = Db.update(db, """
                    INSERT INTO planning_imports(company_id, fingerprint) VALUES (?, ?)
                    ON CONFLICT (company_id, fingerprint) DO NOTHING
                    """, company, fingerprint) == 0;
                if (!duplicate) {
                    if (direct) {
                        var task = Planning.createImportedTask(db, user, normalized, assigneeId).get("task");
                        tasks.add(task);
                        result.put("taskId", ((Map<?, ?>) task).get("id"));
                    } else {
                        Planning.save(db, user, null, fields);
                    }
                    imported++;
                }
            } else if (!duplicate) {
                duplicate = Db.one(db, """
                    SELECT fingerprint FROM planning_imports WHERE company_id = ? AND fingerprint = ?
                    """, company, fingerprint) != null;
            }
            result.put("duplicate", duplicate);
        }
        if (apply) recordRun(db, user, name, (String) mode, results, imported);
        return direct ? Map.of("rows", results, "imported", imported, "mode", "tasks", "tasks", tasks)
            : Map.of("rows", results, "imported", imported);
    }

    static Sheet readPayload(Map<String, Object> payload) {
        if (!(payload.get("base64") instanceof String encoded) || encoded.length() > ((MAX_BYTES + 2) / 3) * 4) {
            throw Domain.error(400, "Прикрепите файл Excel .xlsx размером до 2 МБ.");
        }
        Sheet sheet;
        try {
            byte[] bytes = Base64.getDecoder().decode(encoded);
            if (bytes.length > MAX_BYTES) throw new IOException();
            sheet = read(bytes);
        } catch (IOException | IllegalArgumentException | SAXException | ParserConfigurationException ex) {
            throw Domain.error(400, "Не удалось прочитать файл Excel. Сохраните его в формате .xlsx и попробуйте снова.");
        }
        if (sheet.rows().isEmpty()) throw Domain.error(400, "Первый лист Excel пуст.");
        return sheet;
    }

    private static String fileName(Map<String, Object> payload) {
        String path = Domain.field(payload, "fileName", "Имя файла", 255, true).replace('\\', '/');
        String name = path.substring(path.lastIndexOf('/') + 1).strip();
        if (name.codePoints().anyMatch(Character::isISOControl)) {
            throw Domain.error(400, "Проверьте имя файла Excel.");
        }
        return name.isEmpty() ? "Файл Excel" : name;
    }

    private static void recordRun(Connection db, Map<String, Object> user, String fileName, String mode,
                                  List<Map<String, Object>> rows, int imported) throws SQLException, IOException {
        var errors = rows.stream().filter(row -> row.get("error") != null)
            .map(row -> Map.of("row", row.get("row"), "message", row.get("error"))).toList();
        Db.update(db, """
            INSERT INTO planning_import_runs(company_id, actor_id, actor_name, file_name, mode, created_at,
                total_rows, imported_rows, duplicate_rows, invalid_rows, errors)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, Domain.number(user, "company_id"), Domain.number(user, "id"), user.get("name"), fileName, mode,
            Instant.now().toString(), rows.size(), imported, rows.size() - imported - errors.size(), errors.size(),
            Db.JSON.writeValueAsString(errors));
    }

    private static void resolveObject(Connection db, Map<String, Object> user, Map<String, Object> fields,
                                      Map<String, Object> result) throws SQLException {
        String name = Domain.field(fields, "objectName", "Название объекта", 160, true);
        if (!fields.containsKey("objectId")) {
            if (name.isEmpty()) throw Domain.error(400, "Укажите объект из справочника или его ID.");
            var matches = Db.rows(db, """
                SELECT id FROM work_sites WHERE company_id = ? AND name = ? ORDER BY id LIMIT 2
                """, Domain.number(user, "company_id"), name);
            if (matches.isEmpty()) throw Domain.error(400, "Объект с таким названием не найден в справочнике.");
            if (matches.size() > 1) throw Domain.error(400, "В справочнике несколько таких объектов. Укажите ID объекта.");
            fields.put("objectId", matches.getFirst().get("id").toString());
        }
        var object = Places.resolve(db, user, fields);
        if (!name.isEmpty() && !name.equals(object.name())) {
            throw Domain.error(400, "Название объекта не соответствует указанному ID.");
        }
        result.put("objectId", object.objectId().toString());
        result.put("objectName", object.name());
    }

    private static String resolveAssignee(Connection db, long company, Map<String, Object> fields,
                                          Map<String, Object> result, boolean apply) throws SQLException {
        String login = Domain.field(fields, "assigneeLogin", "Логин исполнителя", 40, true).toLowerCase(Locale.ROOT);
        if (login.isEmpty()) return null;
        var worker = Db.one(db, """
            SELECT id, name FROM users WHERE company_id = ? AND role = 'employee' AND login = ?
            """, company, login);
        if (worker == null) throw Domain.error(400, "Сотрудник с таким логином не найден в компании.");
        long id = Domain.number(worker, "id");
        if (apply) {
            Shift.requireAvailable(db, company, id);
        } else if (!Shift.isAvailable(db, company, id)) {
            throw Domain.error(409, "Сотрудник недоступен для новых назначений.");
        }
        result.put("assigneeLogin", login);
        result.put("assigneeName", worker.get("name"));
        return Long.toString(id);
    }

    private static Object convert(String field, Cell cell, boolean dates1904, boolean direct) {
        String value = cell.text().strip();
        try {
            return switch (field) {
                case "startDate" -> cell.numeric()
                    ? excelDate(decimal(value).longValueExact(), dates1904).toString()
                    : direct && value.contains(".") ? LocalDate.parse(value, LOCAL_DATE).toString() : value;
                case "time" -> cell.numeric() ? excelTime(decimal(value))
                    : direct ? LocalTime.parse(value, LOCAL_TIME).toString() : value;
                case "objectId" -> Long.toString(decimal(value).longValueExact());
                case "priority", "durationMinutes" -> decimal(value).intValueExact();
                default -> value;
            };
        } catch (RuntimeException error) {
            throw Domain.error(400, switch (field) {
                case "startDate" -> direct ? "Укажите дату в формате ДД.ММ.ГГГГ или ГГГГ-ММ-ДД."
                    : "Укажите дату в формате ГГГГ-ММ-ДД.";
                case "time" -> "Укажите время в формате ЧЧ:ММ.";
                case "objectId" -> "Укажите числовой ID объекта.";
                case "priority" -> "Приоритет должен быть целым числом.";
                default -> "Длительность в минутах должна быть целым числом.";
            });
        }
    }

    private static BigDecimal decimal(String text) {
        if (text.length() > 64) throw new IllegalArgumentException();
        var number = new BigDecimal(text);
        if (number.scale() < -64 || number.scale() > 64) throw new IllegalArgumentException();
        return number;
    }

    private static LocalDate excelDate(long days, boolean dates1904) {
        if (days < 0 || days > 2_958_465 || (!dates1904 && days == 60)) throw new IllegalArgumentException();
        LocalDate epoch = dates1904 ? LocalDate.of(1904, 1, 1) : LocalDate.of(1899, 12, 31);
        return epoch.plusDays(!dates1904 && days > 60 ? days - 1 : days);
    }

    private static String excelTime(BigDecimal fraction) {
        if (fraction.signum() < 0 || fraction.compareTo(BigDecimal.ONE) >= 0) throw new IllegalArgumentException();
        int minutes = fraction.multiply(BigDecimal.valueOf(1440)).setScale(0, RoundingMode.HALF_UP).intValueExact();
        return LocalTime.of(minutes / 60, minutes % 60).toString();
    }

    private static String fingerprint(Map<String, Object> values) {
        try {
            byte[] input = Db.JSON.writeValueAsBytes(new TreeMap<>(values));
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(input));
        } catch (IOException | NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private static Sheet read(byte[] bytes) throws IOException, ParserConfigurationException, SAXException {
        var parts = new HashMap<String, byte[]>();
        try (var zip = new ZipInputStream(new ByteArrayInputStream(bytes))) {
            int remaining = MAX_EXPANDED_BYTES;
            for (var entry = zip.getNextEntry(); entry != null; entry = zip.getNextEntry()) {
                if (parts.size() >= 250) throw new IOException();
                byte[] part = zip.readNBytes(remaining + 1);
                remaining -= part.length;
                if (remaining < 0 || parts.putIfAbsent(entry.getName(), part) != null) throw new IOException();
            }
        }
        Document workbook = xml(parts.get("xl/workbook.xml"));
        Element first = (Element) workbook.getElementsByTagNameNS("*", "sheet").item(0);
        if (first == null) throw new IOException();
        String relId = first.getAttributeNS(
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
        String firstPath = null;
        var relationships = xml(parts.get("xl/_rels/workbook.xml.rels")).getElementsByTagNameNS("*", "Relationship");
        for (int i = 0; i < relationships.getLength(); i++) {
            Element relationship = (Element) relationships.item(i);
            if (relId.equals(relationship.getAttribute("Id")) && !relId.isBlank()
                    && relationship.getAttribute("Type").endsWith("/worksheet")
                    && !"External".equals(relationship.getAttribute("TargetMode"))) {
                URI target = URI.create("/xl/workbook.xml").resolve(relationship.getAttribute("Target")).normalize();
                if (target.getScheme() != null || target.getAuthority() != null || target.getPath() == null
                        || !target.getPath().startsWith("/xl/")) throw new IOException();
                firstPath = target.getPath().substring(1);
                break;
            }
        }
        var shared = new ArrayList<String>();
        if (parts.containsKey("xl/sharedStrings.xml")) {
            var strings = xml(parts.get("xl/sharedStrings.xml")).getElementsByTagNameNS("*", "si");
            for (int i = 0; i < strings.getLength(); i++) shared.add(textRuns((Element) strings.item(i)));
        }

        Element settings = (Element) workbook.getElementsByTagNameNS("*", "workbookPr").item(0);
        boolean dates1904 = settings != null && List.of("1", "true").contains(settings.getAttribute("date1904"));
        var rows = new ArrayList<SheetRow>();
        var nodes = xml(parts.get(firstPath)).getElementsByTagNameNS("*", "row");
        for (int i = 0; i < nodes.getLength(); i++) {
            Element row = (Element) nodes.item(i);
            int number = row.hasAttribute("r") ? Integer.parseInt(row.getAttribute("r")) : i + 1;
            var cells = new LinkedHashMap<String, Cell>();
            for (Node child = row.getFirstChild(); child != null; child = child.getNextSibling()) {
                if (!(child instanceof Element cell) || !"c".equals(cell.getLocalName())) continue;
                String type = cell.getAttribute("t");
                String text = firstText(cell, "v");
                if ("s".equals(type)) {
                    int index = Integer.parseInt(text);
                    if (index < 0 || index >= shared.size()) throw new IOException();
                    text = shared.get(index);
                } else if ("inlineStr".equals(type)) {
                    text = textRuns(cell);
                }
                boolean formula = cell.getElementsByTagNameNS("*", "f").getLength() > 0;
                if (!text.isBlank() || formula) {
                    String reference = cell.getAttribute("r");
                    if (!reference.matches("[A-Z]{1,3}[1-9][0-9]{0,6}")) throw new IOException();
                    String column = reference.replaceFirst("[0-9]+$", "");
                    cells.put(column, new Cell(text, type.isEmpty() || "n".equals(type), formula));
                }
            }
            if (!cells.isEmpty()) {
                rows.add(new SheetRow(number, cells));
                if (rows.size() > MAX_ROWS + 1) throw Domain.error(400, "В одном файле можно импортировать до 200 строк.");
            }
        }
        return new Sheet(rows, dates1904);
    }

    private static Document xml(byte[] bytes) throws IOException, ParserConfigurationException, SAXException {
        if (bytes == null) throw new IOException();
        var factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
        var builder = factory.newDocumentBuilder();
        builder.setErrorHandler(new DefaultHandler());
        return builder.parse(new ByteArrayInputStream(bytes));
    }

    private static String firstText(Element element, String tag) {
        Node node = element.getElementsByTagNameNS("*", tag).item(0);
        return node == null ? "" : node.getTextContent();
    }

    private static String textRuns(Element element) {
        var result = new StringBuilder();
        var runs = element.getElementsByTagNameNS("*", "t");
        for (int i = 0; i < runs.getLength(); i++) {
            Node node = runs.item(i);
            if (!"rPh".equals(node.getParentNode().getLocalName())) result.append(node.getTextContent());
        }
        return result.toString();
    }
}
