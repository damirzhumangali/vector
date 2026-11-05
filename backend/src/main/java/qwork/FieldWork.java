package qwork;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

import static qwork.Domain.error;
import static qwork.Domain.field;
import static qwork.Domain.number;

final class FieldWork {
    static final String MAIN_PAIR = "main";
    private static final List<Map<String, Object>> MAIN_PHOTOS = List.of(
        Map.of("key", MAIN_PAIR, "label", "Основная пара"));
    private static final List<String> LEGACY_TITLES = List.of(
        "Подтвердить безопасный доступ", "Осмотреть оборудование", "Выполнить работы по заданию",
        "Проверить результат", "Убрать рабочее место");
    private static final Set<String> OUTCOMES = Set.of("done", "not_done", "problem", "follow_up");
    private static final TypeReference<List<Map<String, Object>>> LIST = new TypeReference<>() {};
    private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() {};

    private FieldWork() {}

    static void initSqlite(Connection db) throws SQLException {
        var taskColumns = Db.rows(db, "PRAGMA table_info(tasks)").stream().map(row -> row.get("name")).toList();
        for (var column : Map.of(
            "purpose", "TEXT NOT NULL DEFAULT ''", "priority", "INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3)",
            "manager_id", "INTEGER REFERENCES users(id)", "checklist", "TEXT", "outcome", "TEXT",
            "photo_pairs", "TEXT", "repeat_reason", "TEXT NOT NULL DEFAULT ''"
        ).entrySet()) {
            if (!taskColumns.contains(column.getKey())) {
                Db.update(db, "ALTER TABLE tasks ADD COLUMN " + column.getKey() + " " + column.getValue());
            }
        }
        Db.update(db, """
            CREATE TABLE IF NOT EXISTS field_work_defaults (
                company_id INTEGER NOT NULL REFERENCES companies(id),
                scope TEXT NOT NULL CHECK (scope IN ('object', 'department')),
                scope_key TEXT NOT NULL,
                manager_id INTEGER NOT NULL REFERENCES users(id),
                PRIMARY KEY (company_id, scope, scope_key)
            )
            """);
        Media.upgradeSqlite(db);
    }

    static Map<String, Object> defaults(Connection db, Map<String, Object> user) throws SQLException {
        Accounts.requireDispatcher(user);
        long company = number(user, "company_id");
        var rules = Db.rows(db, """
            SELECT d.scope, d.scope_key, d.manager_id, u.name
            FROM field_work_defaults d JOIN users u ON u.id = d.manager_id AND u.company_id = d.company_id
            WHERE d.company_id = ? ORDER BY d.scope, d.scope_key
            """, company).stream().map(row -> Map.of(
                "object".equals(row.get("scope")) ? "objectId" : "department", row.get("scope_key"),
                "managerId", row.get("manager_id").toString(), "managerName", row.get("name")
            )).toList();
        var managers = Db.rows(db, """
            SELECT id, name FROM users WHERE company_id = ? AND role = 'manager' ORDER BY name, id
            """, company).stream().map(row -> Map.of("id", row.get("id").toString(), "name", row.get("name"))).toList();
        return Map.of("defaults", rules, "managers", managers);
    }

    static Map<String, Object> saveDefault(Connection db, Map<String, Object> user, Map<String, Object> payload)
            throws SQLException {
        Accounts.requireDispatcher(user);
        long company = number(user, "company_id");
        boolean object = payload.get("objectId") != null;
        boolean department = payload.get("department") != null;
        if (object == department || !payload.containsKey("managerId")) {
            throw error(400, "Укажите объект или подразделение и ответственного руководителя.");
        }
        String scope = object ? "object" : "department";
        String key;
        if (object) {
            long id = positiveId(payload.get("objectId"), "Выберите объект вашей компании.");
            if (Db.one(db, "SELECT id FROM work_sites WHERE company_id = ? AND id = ?", company, id) == null) {
                throw error(400, "Выберите объект вашей компании.");
            }
            key = Long.toString(id);
        } else {
            key = field(payload, "department", "Подразделение", 120, false);
        }
        Long manager = manager(db, company, payload.get("managerId"));
        if (manager == null) {
            Db.update(db, "DELETE FROM field_work_defaults WHERE company_id = ? AND scope = ? AND scope_key = ?",
                company, scope, key);
        } else {
            Db.update(db, """
                INSERT INTO field_work_defaults(company_id, scope, scope_key, manager_id) VALUES (?, ?, ?, ?)
                ON CONFLICT (company_id, scope, scope_key) DO UPDATE SET manager_id = excluded.manager_id
                """, company, scope, key, manager);
        }
        return defaults(db, user);
    }

    static Long assignedManager(Connection db, long company, Long objectId, long assignee, Map<String, Object> fields)
            throws SQLException {
        if (fields.containsKey("managerId")) {
            return manager(db, company, fields.get("managerId"));
        }
        if (objectId != null) {
            var rule = Db.one(db, """
                SELECT manager_id FROM field_work_defaults WHERE company_id = ? AND scope = 'object' AND scope_key = ?
                """, company, objectId.toString());
            if (rule != null) return number(rule, "manager_id");
        }
        var employee = Db.one(db, "SELECT department FROM users WHERE company_id = ? AND id = ?", company, assignee);
        String department = employee == null ? "" : Objects.toString(employee.get("department"), "");
        if (department.isBlank()) return null;
        var rule = Db.one(db, """
            SELECT manager_id FROM field_work_defaults WHERE company_id = ? AND scope = 'department' AND scope_key = ?
            """, company, department);
        return rule == null ? null : number(rule, "manager_id");
    }

    static Long manager(Connection db, long company, Object value) throws SQLException {
        if (value == null) return null;
        long id = positiveId(value, "Выберите руководителя вашей компании.");
        if (Db.one(db, "SELECT id FROM users WHERE company_id = ? AND id = ? AND role = 'manager'", company, id) == null) {
            throw error(400, "Выберите руководителя вашей компании.");
        }
        return id;
    }

    private static long positiveId(Object value, String message) {
        String text = value instanceof String || value instanceof Integer || value instanceof Long ? value.toString() : "";
        if (text.matches("[0-9]{1,19}")) {
            try {
                long id = Long.parseLong(text);
                if (id > 0) return id;
            } catch (NumberFormatException ignored) {
                // The identifier does not fit in the database key.
            }
        }
        throw error(400, message);
    }

    static int priority(Map<String, Object> fields) {
        Object value = fields.getOrDefault("priority", 2);
        if ((value instanceof Integer || value instanceof Long)
            && ((Number) value).longValue() >= 1 && ((Number) value).longValue() <= 3) {
            return ((Number) value).intValue();
        }
        throw error(400, "Приоритет должен быть от 1 до 3.");
    }

    static List<Map<String, Object>> newChecklist(Object input) {
        if (!(input instanceof List<?> list) || list.isEmpty() || list.size() > 20) {
            throw error(400, "В чек-листе должно быть от 1 до 20 пунктов.");
        }
        var items = new ArrayList<Map<String, Object>>(list.size());
        var ids = new HashSet<String>();
        for (Object raw : list) {
            var item = object(raw, "Проверьте пункт чек-листа.");
            String id = key(item.get("id"), "Проверьте идентификатор пункта чек-листа.");
            if (!ids.add(id)) throw error(400, "Идентификаторы пунктов чек-листа должны быть уникальны.");
            items.add(checklistItem(id, field(item, "title", "Пункт чек-листа", 160, false), null, ""));
        }
        return items;
    }

    static List<Map<String, Object>> checklist(Map<String, Object> task) throws SQLException {
        if (task.get("checklist") instanceof String value) return parse(value, LIST);
        var checks = parse((String) task.get("checks"), new TypeReference<List<Boolean>>() {});
        var items = new ArrayList<Map<String, Object>>(LEGACY_TITLES.size());
        for (int i = 0; i < LEGACY_TITLES.size(); i++) {
            items.add(checklistItem("item-" + (i + 1), LEGACY_TITLES.get(i),
                i < checks.size() && Boolean.TRUE.equals(checks.get(i)) ? "done" : null, ""));
        }
        return items;
    }

    static List<Map<String, Object>> changeChecklist(List<Map<String, Object>> current, Map<String, Object> fields) {
        if (fields.containsKey("checklist")) {
            if (!(fields.get("checklist") instanceof List<?> changes) || changes.size() > current.size()) {
                throw error(400, "Проверьте пункты чек-листа.");
            }
            var byId = new LinkedHashMap<String, Map<String, Object>>();
            for (var item : current) byId.put((String) item.get("id"), item);
            var changedIds = new HashSet<String>();
            for (Object raw : changes) {
                var change = object(raw, "Проверьте пункт чек-листа.");
                String id = key(change.get("id"), "Проверьте идентификатор пункта чек-листа.");
                var old = byId.get(id);
                if (old == null || !changedIds.add(id)) throw error(400, "Неизвестный или повторяющийся пункт чек-листа.");
                Object status = change.getOrDefault("status", old.get("status"));
                if (status != null && (!(status instanceof String value) || !OUTCOMES.contains(value))) {
                    throw error(400, "Выберите исход пункта чек-листа.");
                }
                String comment = change.containsKey("comment")
                    ? field(change, "comment", "Комментарий к пункту", 1000, true)
                    : (String) old.get("comment");
                byId.put(id, checklistItem(id, (String) old.get("title"), (String) status, comment));
            }
            return new ArrayList<>(byId.values());
        }
        if (!fields.containsKey("checks")) return current;
        if (!(fields.get("checks") instanceof List<?> flags) || flags.size() != LEGACY_TITLES.size()
            || !flags.stream().allMatch(Boolean.class::isInstance)) {
            throw error(400, "Чек-лист должен содержать пять отметок.");
        }
        var previous = legacyChecks(current);
        if (flags.equals(previous)) return current;
        if (!current.stream().map(item -> item.get("title")).toList().equals(LEGACY_TITLES)) {
            throw error(409, "Обновите приложение, чтобы заполнить чек-лист задания.");
        }
        var updated = new ArrayList<Map<String, Object>>(current.size());
        for (int i = 0; i < current.size(); i++) {
            var item = current.get(i);
            updated.add(flags.get(i).equals(previous.get(i)) ? item : checklistItem(
                (String) item.get("id"), (String) item.get("title"),
                Boolean.TRUE.equals(flags.get(i)) ? "done" : null, (String) item.get("comment")));
        }
        return updated;
    }

    static List<Boolean> legacyChecks(List<Map<String, Object>> items) {
        var values = new ArrayList<Boolean>(LEGACY_TITLES.size());
        for (int i = 0; i < LEGACY_TITLES.size(); i++) {
            values.add(i < items.size() && "done".equals(items.get(i).get("status")));
        }
        return values;
    }

    static List<Map<String, Object>> freshChecklist(List<Map<String, Object>> items) {
        return items.stream().map(item -> checklistItem((String) item.get("id"), (String) item.get("title"), null, ""))
            .toList();
    }

    private static Map<String, Object> checklistItem(String id, String title, String status, String comment) {
        var item = new LinkedHashMap<String, Object>();
        item.put("id", id);
        item.put("title", title);
        item.put("status", status);
        item.put("comment", comment);
        return item;
    }

    static List<Map<String, Object>> newPhotoPairs(Object input) {
        if (!(input instanceof List<?> list) || list.size() > 8) {
            throw error(400, "Можно указать до восьми пар фотографий.");
        }
        var pairs = new LinkedHashMap<String, Map<String, Object>>();
        pairs.put(MAIN_PAIR, MAIN_PHOTOS.getFirst());
        var keys = new HashSet<String>();
        for (Object raw : list) {
            var pair = object(raw, "Проверьте пару фотографий.");
            String key = key(pair.get("key"), "Проверьте идентификатор пары фотографий.");
            if (!keys.add(key)) throw error(400, "Идентификаторы пар фотографий должны быть уникальны.");
            pairs.put(key, Map.of("key", key, "label", field(pair, "label", "Название пары", 100, false)));
        }
        if (pairs.size() > 8) throw error(400, "Можно указать до восьми пар фотографий вместе с основной.");
        return new ArrayList<>(pairs.values());
    }

    static List<Map<String, Object>> photoPairs(Map<String, Object> task) throws SQLException {
        return task.get("photo_pairs") instanceof String value ? parse(value, LIST) : MAIN_PHOTOS;
    }

    static Map<String, Object> outcome(Map<String, Object> task) throws SQLException {
        if (task.get("outcome") instanceof String value) return parse(value, MAP);
        return Map.of("work", Objects.toString(task.get("result"), ""), "findings", "", "measures", "", "materials", "");
    }

    static Map<String, Object> changeOutcome(Map<String, Object> current, Map<String, Object> fields) {
        var outcome = new LinkedHashMap<>(current);
        if (fields.containsKey("outcome")) {
            var changes = object(fields.get("outcome"), "Проверьте результат работы.");
            for (var key : List.of("work", "findings", "measures", "materials")) {
                if (changes.containsKey(key)) {
                    outcome.put(key, field(changes, key, switch (key) {
                        case "work" -> "Выполненные работы";
                        case "findings" -> "Выявленные проблемы";
                        case "measures" -> "Принятые меры";
                        default -> "Использованные материалы и оборудование";
                    }, key.equals("materials") ? 1000 : 2000, true));
                }
            }
        } else if (fields.containsKey("result")) {
            outcome.put("work", field(fields, "result", "Результат работы", 2000, true));
        }
        return outcome;
    }

    static String key(Object value, String message) {
        if (value instanceof String text && text.matches("[A-Za-z0-9_-]{1,40}")) return text;
        throw error(400, message);
    }

    private static Map<String, Object> object(Object value, String message) {
        if (!(value instanceof Map<?, ?> source)) throw error(400, message);
        var result = new LinkedHashMap<String, Object>();
        for (var entry : source.entrySet()) {
            if (!(entry.getKey() instanceof String key)) throw error(400, message);
            result.put(key, entry.getValue());
        }
        return result;
    }

    static Map<String, Object> photoGeofence(Object location, Map<String, Object> photo) throws SQLException {
        Object point = location instanceof String value ? parse(value, MAP) : location;
        var result = new LinkedHashMap<String, Object>();
        result.put("distanceToObject", null);
        result.put("geofenceStatus", "unavailable");
        if (!(point instanceof Map<?, ?> target) || !(photo.get("latitude") instanceof Number lat)
            || !(photo.get("longitude") instanceof Number lon)) return result;
        double distance = distance(lat.doubleValue(), lon.doubleValue(),
            ((Number) target.get("latitude")).doubleValue(), ((Number) target.get("longitude")).doubleValue());
        result.put("distanceToObject", Math.round(distance));
        double radius = ((Number) target.get("radius")).doubleValue();
        String state = "uncertain";
        if (photo.get("accuracy") instanceof Number accuracy) {
            double margin = accuracy.doubleValue();
            if (distance - margin > radius) state = "outside";
            else if (distance + margin <= radius) state = "inside";
        }
        result.put("geofenceStatus", state);
        return result;
    }

    static double distance(double latitude, double longitude, double targetLat, double targetLon) {
        double lat1 = Math.toRadians(latitude);
        double lat2 = Math.toRadians(targetLat);
        double lon = Math.toRadians(targetLon - longitude);
        double a = Math.pow(Math.sin((lat2 - lat1) / 2), 2)
            + Math.cos(lat1) * Math.cos(lat2) * Math.pow(Math.sin(lon / 2), 2);
        return 2 * 6_371_000 * Math.asin(Math.sqrt(Math.min(1, a)));
    }

    private static <T> T parse(String value, TypeReference<T> type) throws SQLException {
        try {
            return Db.JSON.readValue(value, type);
        } catch (JsonProcessingException invalid) {
            throw new SQLException("Не удалось прочитать данные выездного задания.", invalid);
        }
    }
}
