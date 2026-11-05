package qwork;

import java.awt.Color;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.PDType0Font;

final class AnalyticsExport {
    private static final String TITLE = "qwork · Аналитика заявок";
    private static final String XML = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>";
    private static final String SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    private static final String REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
    private static final String REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
    private static final String CONTENT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";

    private record Field(String key, String label, int width) {
        Field(String key, String label) { this(key, label, 22); }
    }

    private record Table(String name, List<Field> fields, List<List<?>> rows) {}

    private static final List<Field> METRICS = List.of(
        new Field("total", "Всего заявок"), new Field("completed", "Выполнено"),
        new Field("overdue", "Просрочено"), new Field("slaMet", "В срок по SLA"),
        new Field("slaTotal", "Заявки в расчёте SLA"), new Field("slaPercent", "SLA, %"),
        new Field("active", "Активные заявки"), new Field("repeatTrips", "Повторные выезды"),
        new Field("firstVisitCompleted", "Принято с первого выезда"),
        new Field("firstVisitTotal", "Заявки в расчёте первого выезда"),
        new Field("firstVisitPercent", "Принято с первого выезда, %"),
        new Field("travelMinutes", "Время в пути, мин"), new Field("onSiteMinutes", "Время на объекте, мин"),
        new Field("unconfirmed", "Неподтверждённые работы"), new Field("rejectedPhotos", "Отклонённые фото")
    );
    private static final List<Field> WORKLOAD = List.of(
        new Field("id", "ID сотрудника", 15), new Field("name", "Сотрудник", 32),
        new Field("department", "Подразделение", 28), new Field("total", "Всего", 14),
        new Field("active", "Активные", 14), new Field("completed", "Выполнено", 14)
    );
    private static final List<Field> TASKS = List.of(
        new Field("id", "ID заявки", 14), new Field("title", "Заявка", 40), new Field("status", "Статус", 25),
        new Field("employeeId", "ID сотрудника", 15), new Field("employeeName", "Сотрудник", 28),
        new Field("objectId", "ID объекта", 14), new Field("objectName", "Объект", 28),
        new Field("department", "Подразделение", 24), new Field("createdAt", "Создана", 29),
        new Field("deadline", "Срок", 29), new Field("completedAt", "Выполнена", 29),
        new Field("overdue", "Просрочена", 15), new Field("repeatOf", "Повтор заявки №", 18),
        new Field("travelMinutes", "В пути, мин", 16), new Field("onSiteMinutes", "На объекте, мин", 18),
        new Field("rejectedPhotos", "Отклонено фото", 18)
    );
    private static final List<Field> PHOTOS = List.of(
        new Field("id", "ID фото", 14), new Field("taskId", "ID заявки", 14),
        new Field("taskTitle", "Заявка", 40), new Field("kind", "Тип фото", 18),
        new Field("reason", "Причина отклонения", 52), new Field("rejectedAt", "Отклонено", 29)
    );

    private AnalyticsExport() {}

    static byte[] xlsx(Map<String, Object> report) throws IOException {
        var tables = tables(report);
        var bytes = new ByteArrayOutputStream();
        try (var zip = new ZipOutputStream(bytes, StandardCharsets.UTF_8)) {
            StringBuilder content = new StringBuilder(XML).append("<Types xmlns=\"").append(CONTENT_NS)
                .append("\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>")
                .append("<Default Extension=\"xml\" ContentType=\"application/xml\"/>")
                .append("<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>")
                .append("<Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>");
            StringBuilder workbook = new StringBuilder(XML).append("<workbook xmlns=\"").append(SHEET_NS)
                .append("\" xmlns:r=\"").append(REL_TYPE, 0, REL_TYPE.length() - 1)
                .append("\"><bookViews><workbookView/></bookViews><sheets>");
            StringBuilder rels = new StringBuilder(XML).append("<Relationships xmlns=\"").append(REL_NS).append("\">");
            for (int i = 0; i < tables.size(); i++) {
                int number = i + 1;
                Table table = tables.get(i);
                String path = "worksheets/sheet" + number + ".xml";
                writeSheet(zip, "xl/" + path, table, number != 1);
                content.append("<Override PartName=\"/xl/").append(path)
                    .append("\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>");
                workbook.append("<sheet name=\"").append(xml(table.name())).append("\" sheetId=\"")
                    .append(number).append("\" r:id=\"rId").append(number).append("\"/>");
                rels.append(relationship("rId" + number, "worksheet", path));
            }
            rels.append(relationship("rId" + (tables.size() + 1), "styles", "styles.xml"));
            zipEntry(zip, "[Content_Types].xml", content.append("</Types>").toString());
            zipEntry(zip, "_rels/.rels", XML + "<Relationships xmlns=\"" + REL_NS + "\">"
                + relationship("rId1", "officeDocument", "xl/workbook.xml") + "</Relationships>");
            zipEntry(zip, "xl/_rels/workbook.xml.rels", rels.append("</Relationships>").toString());
            zipEntry(zip, "xl/workbook.xml", workbook.append("</sheets></workbook>").toString());
            zipEntry(zip, "xl/styles.xml", styles());
        }
        return bytes.toByteArray();
    }

    private static String relationship(String id, String type, String path) {
        return "<Relationship Id=\"" + id + "\" Type=\"" + REL_TYPE + type + "\" Target=\"" + path + "\"/>";
    }

    private static void writeSheet(ZipOutputStream zip, String path, Table table, boolean filter) throws IOException {
        StringBuilder opening = new StringBuilder(XML).append("<worksheet xmlns=\"").append(SHEET_NS).append("\">")
            .append("<sheetViews><sheetView workbookViewId=\"0\"><pane ySplit=\"1\" topLeftCell=\"A2\" activePane=\"bottomLeft\" state=\"frozen\"/></sheetView></sheetViews><cols>");
        for (int i = 0; i < table.fields().size(); i++) {
            int col = i + 1;
            opening.append("<col min=\"").append(col).append("\" max=\"").append(col).append("\" width=\"")
                .append(table.fields().get(i).width()).append("\" customWidth=\"1\"/>");
        }
        zip.putNextEntry(new ZipEntry(path));
        write(zip, opening.append("</cols><sheetData>").toString());
        write(zip, rowXml(1, table.fields().stream().map(Field::label).toList(), true));
        for (int i = 0; i < table.rows().size(); i++) {
            write(zip, rowXml(i + 2, table.rows().get(i), false));
        }
        write(zip, "</sheetData>");
        if (filter && !table.rows().isEmpty()) {
            write(zip, "<autoFilter ref=\"A1:" + column(table.fields().size() - 1) + (table.rows().size() + 1) + "\"/>");
        }
        write(zip, "</worksheet>");
        zip.closeEntry();
    }

    private static String rowXml(int number, List<?> values, boolean header) {
        StringBuilder xml = new StringBuilder("<row r=\"").append(number).append("\">");
        for (int i = 0; i < values.size(); i++) {
            Object value = values.get(i);
            if (value == null) continue;
            xml.append("<c r=\"").append(column(i)).append(number).append("\" s=\"").append(header ? 1 : 0).append("\"");
            if (value instanceof Number) {
                xml.append("><v>").append(value).append("</v></c>");
            } else {
                xml.append(" t=\"inlineStr\"><is><t xml:space=\"preserve\">")
                    .append(xml(value.toString().replaceAll("(?i)_x[0-9a-f]{4}_", "_x005F_$0")))
                    .append("</t></is></c>");
            }
        }
        return xml.append("</row>").toString();
    }

    private static char column(int index) {
        return (char) ('A' + index); // Reports have at most 16 columns.
    }

    private static String styles() {
        return XML + """
            <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
              <fonts count="2">
                <font><sz val="11"/><color rgb="FF14213A"/><name val="Calibri"/></font>
                <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
              </fonts>
              <fills count="3">
                <fill><patternFill patternType="none"/></fill>
                <fill><patternFill patternType="gray125"/></fill>
                <fill><patternFill patternType="solid"><fgColor rgb="FF245BE8"/><bgColor indexed="64"/></patternFill></fill>
              </fills>
              <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
              <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
              <cellXfs count="2">
                <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
                <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
              </cellXfs>
              <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
            </styleSheet>
            """;
    }

    private static void zipEntry(ZipOutputStream zip, String path, String contents) throws IOException {
        zip.putNextEntry(new ZipEntry(path));
        write(zip, contents);
        zip.closeEntry();
    }

    private static void write(ZipOutputStream zip, String text) throws IOException {
        zip.write(text.getBytes(StandardCharsets.UTF_8));
    }

    private static String xml(String value) {
        var output = new StringBuilder();
        value.codePoints().forEach(cp -> {
            switch (cp) {
                case '&' -> output.append("&amp;");
                case '<' -> output.append("&lt;");
                case '>' -> output.append("&gt;");
                case '"' -> output.append("&quot;");
                default -> {
                    if (cp == 9 || cp == 10 || cp == 13 || cp >= 32 && cp <= 0xD7FF
                            || cp >= 0xE000 && cp <= 0xFFFD || cp >= 0x10000 && cp <= 0x10FFFF) {
                        output.appendCodePoint(cp);
                    }
                }
            }
        });
        return output.toString();
    }

    static byte[] pdf(Map<String, Object> report) throws IOException {
        try (var doc = new PDDocument()) {
            doc.getDocumentInformation().setTitle(TITLE);
            PDType0Font font = pdfFont(doc);
            try (var pages = new PdfPages(doc, font)) {
                for (Table table : tables(report)) {
                    pages.heading(table.name());
                    if (table.rows().isEmpty()) pages.text("Нет данных за выбранный период.", 10);
                    for (List<?> row : table.rows()) {
                        if ("Сводка".equals(table.name())) {
                            pages.text(row.get(0) + " · " + display(row.get(1)), 10);
                        } else {
                            var labels = new ArrayList<String>();
                            for (int i = 0; i < row.size(); i++) {
                                Object value = row.get(i);
                                if (value != null && !value.toString().isBlank()) {
                                    labels.add(table.fields().get(i).label() + " · " + display(value));
                                }
                            }
                            pages.detail(labels);
                        }
                    }
                }
            }
            var bytes = new ByteArrayOutputStream();
            doc.save(bytes);
            return bytes.toByteArray();
        }
    }

    private static PDType0Font pdfFont(PDDocument doc) throws IOException {
        // The production image installs fonts-dejavu-core. Use the host's equivalent when running locally.
        var candidates = new ArrayList<String>();
        String configured = System.getenv("QWORK_PDF_FONT");
        if (configured != null && !configured.isBlank()) candidates.add(configured);
        candidates.addAll(List.of(
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf",
            "/usr/share/fonts/TTF/DejaVuSans.ttf",
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "C:/Windows/Fonts/arial.ttf"
        ));
        for (String candidate : candidates) {
            Path path = Path.of(candidate);
            if (Files.isRegularFile(path)) {
                return PDType0Font.load(doc, path.toFile());
            }
        }
        throw new IOException("Cyrillic TrueType font not found. Install DejaVu Sans or set QWORK_PDF_FONT.");
    }

    private static final class PdfPages implements AutoCloseable {
        private static final float MARGIN = 44;
        private static final float LINE = 14;
        private static final Color ACCENT = new Color(36, 91, 232);
        private static final Color INK = new Color(20, 33, 58);
        private final PDDocument document;
        private final PDType0Font font;
        private final Map<Integer, Boolean> glyphs = new java.util.HashMap<>();
        private PDPageContentStream stream;
        private int number;
        private float y;

        PdfPages(PDDocument document, PDType0Font font) throws IOException {
            this.document = document;
            this.font = font;
            next();
        }

        void heading(String text) throws IOException {
            ensure(50);
            y -= 12;
            line(text, 14, MARGIN, y, true);
            y -= 22;
        }

        void text(String text, float size) throws IOException {
            for (String line : wrap(text, size)) {
                ensure(LINE);
                line(line, size, MARGIN, y, false);
                y -= LINE;
            }
        }

        void detail(List<String> labels) throws IOException {
            if (labels.isEmpty()) return;
            var lines = wrap(String.join("    |    ", labels), 9);
            ensure(Math.min(lines.size(), 4) * LINE + 8);
            for (String line : lines) {
                ensure(LINE);
                line(line, 9, MARGIN, y, false);
                y -= LINE;
            }
            y -= 6;
        }

        private List<String> wrap(String input, float size) throws IOException {
            StringBuilder safe = new StringBuilder();
            for (int offset = 0; offset < input.length();) {
                int cp = input.codePointAt(offset);
                offset += Character.charCount(cp);
                if (Character.isISOControl(cp)) cp = ' ';
                Boolean present = glyphs.get(cp);
                if (present == null) {
                    try {
                        font.encode(Character.toString(cp));
                        present = true;
                    } catch (IllegalArgumentException missing) {
                        present = false;
                    }
                    glyphs.put(cp, present);
                }
                safe.appendCodePoint(present ? cp : '?');
            }
            float available = PDRectangle.A4.getWidth() - 2 * MARGIN;
            var lines = new ArrayList<String>();
            StringBuilder current = new StringBuilder();
            float currentWidth = 0;
            for (String word : safe.toString().strip().split(" +")) {
                float wordWidth = width(word, size);
                float gap = current.isEmpty() ? 0 : width(" ", size);
                if (!current.isEmpty() && currentWidth + gap + wordWidth > available) {
                    lines.add(current.toString());
                    current.setLength(0);
                    currentWidth = 0;
                    gap = 0;
                }
                if (wordWidth <= available) {
                    if (gap > 0) current.append(' ');
                    current.append(word);
                    currentWidth += gap + wordWidth;
                    continue;
                }
                // IDs or descriptions may contain a very long word. Split at code point boundaries.
                for (int offset = 0; offset < word.length();) {
                    int cp = word.codePointAt(offset);
                    offset += Character.charCount(cp);
                    float charWidth = width(Character.toString(cp), size);
                    if (currentWidth + charWidth > available) {
                        lines.add(current.toString());
                        current.setLength(0);
                        currentWidth = 0;
                    }
                    current.appendCodePoint(cp);
                    currentWidth += charWidth;
                }
            }
            if (!current.isEmpty()) lines.add(current.toString());
            return lines;
        }

        private float width(String text, float size) throws IOException {
            return font.getStringWidth(text) * size / 1000;
        }

        private void ensure(float height) throws IOException {
            if (y - height < 54) next();
        }

        private void next() throws IOException {
            close();
            PDPage page = new PDPage(PDRectangle.A4);
            document.addPage(page);
            stream = new PDPageContentStream(document, page);
            number++;
            float top = page.getMediaBox().getHeight() - MARGIN;
            line(TITLE, 18, MARGIN, top, true);
            stream.setStrokingColor(ACCENT);
            stream.moveTo(MARGIN, top - 12);
            stream.lineTo(page.getMediaBox().getWidth() - MARGIN, top - 12);
            stream.stroke();
            line("Страница " + number, 8, MARGIN, 28, false);
            y = top - 30;
        }

        private void line(String text, float size, float x, float y, boolean accent) throws IOException {
            stream.setNonStrokingColor(accent ? ACCENT : INK);
            stream.beginText();
            stream.setFont(font, size);
            stream.newLineAtOffset(x, y);
            stream.showText(text);
            stream.endText();
        }

        @Override
        public void close() throws IOException {
            if (stream != null) {
                stream.close();
                stream = null;
            }
        }
    }

    private static List<Table> tables(Map<String, Object> report) {
        var filters = map(report.get("filters"));
        var options = map(report.get("options"));
        var metrics = map(report.get("metrics"));
        var summary = new ArrayList<List<?>>();
        summary.add(List.of("Период с", display(filters.get("from"))));
        summary.add(List.of("Период по", display(filters.get("to"))));
        summary.add(List.of("Часовой пояс периода", "Asia/Almaty"));
        summary.add(List.of("Сотрудник", filterName(filters.get("employeeId"), options.get("employees"))));
        summary.add(List.of("Объект", filterName(filters.get("objectId"), options.get("objects"))));
        summary.add(List.of("Подразделение", filterName(filters.get("department"), null)));
        for (Field field : METRICS) {
            Object value = metrics.get(field.key());
            summary.add(List.of(field.label(), value == null ? "—" : value));
        }
        return List.of(
            new Table("Сводка", List.of(new Field("label", "Параметр", 42), new Field("value", "Значение", 38)), summary),
            table("Нагрузка", WORKLOAD, report.get("workload")),
            table("Заявки", TASKS, report.get("tasks")),
            table("Отклонённые фото", PHOTOS, report.get("rejectedPhotos"))
        );
    }

    private static Table table(String name, List<Field> fields, Object data) {
        var rows = new ArrayList<List<?>>();
        if (data instanceof List<?> records) {
            for (Object record : records) {
                var source = map(record);
                rows.add(fields.stream().map(field -> value(field.key(), source.get(field.key()))).toList());
            }
        }
        return new Table(name, fields, rows);
    }

    private static Object value(String key, Object value) {
        if (value == null) return null;
        if (value instanceof Boolean flag) return flag ? "Да" : "Нет";
        if ("kind".equals(key)) return switch (value.toString()) {
            case "before" -> "До";
            case "after" -> "После";
            case "dispatcher" -> "Диспетчер";
            default -> value;
        };
        if ("status".equals(key)) return switch (value.toString()) {
            case "assigned" -> "Назначена";
            case "accepted" -> "Принята сотрудником";
            case "travel" -> "В пути";
            case "arrived" -> "На объекте";
            case "work" -> "В работе";
            case "review" -> "На приёмке";
            case "rework" -> "На доработке";
            case "done" -> "Выполнена";
            case "cancelled" -> "Отменена";
            case "repeated" -> "Назначен повторный выезд";
            case "paused" -> "Приостановлена";
            case "unassigned" -> "Без исполнителя";
            default -> value;
        };
        return value;
    }

    private static String filterName(Object id, Object options) {
        if (id == null || id.toString().isBlank()) return "Все";
        if (options instanceof List<?> records) {
            for (Object record : records) {
                var option = map(record);
                if (id.toString().equals(String.valueOf(option.get("id")))) {
                    return display(option.get("name")) + " (№" + id + ")";
                }
            }
        }
        return id.toString();
    }

    private static String display(Object value) {
        return value == null || value.toString().isBlank() ? "—" : value.toString();
    }

    private static Map<?, ?> map(Object value) {
        return value instanceof Map<?, ?> entry ? entry : Map.of();
    }
}
