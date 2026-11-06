package qwork;

import java.sql.Connection;
import java.sql.SQLException;
import java.time.DateTimeException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.time.temporal.ChronoUnit;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static qwork.Domain.error;
import static qwork.Domain.field;
import static qwork.Domain.number;

/** Templates generate dated jobs. The assignment queue turns due jobs into employee tasks. */
final class Planning {
    static final String SQLITE_SCHEMA = """
        CREATE TABLE IF NOT EXISTS work_plans (
            id INTEGER PRIMARY KEY,
            company_id INTEGER NOT NULL REFERENCES companies(id),
            actor_id INTEGER NOT NULL REFERENCES users(id),
            object_id INTEGER NOT NULL REFERENCES work_sites(id),
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            start_date TEXT NOT NULL,
            start_time TEXT NOT NULL,
            zone TEXT NOT NULL,
            frequency TEXT NOT NULL CHECK (frequency IN ('once', 'daily', 'weekly', 'monthly')),
            repeat_interval INTEGER NOT NULL,
            horizon_days INTEGER NOT NULL,
            holiday_rule TEXT NOT NULL CHECK (holiday_rule IN ('skip', 'move', 'run')),
            priority INTEGER NOT NULL,
            duration_minutes INTEGER NOT NULL,
            enabled INTEGER NOT NULL,
            generated_through TEXT
        );

        CREATE INDEX IF NOT EXISTS work_plans_by_company ON work_plans(company_id, id);

        CREATE TABLE IF NOT EXISTS planned_jobs (
            id INTEGER PRIMARY KEY,
            company_id INTEGER NOT NULL REFERENCES companies(id),
            actor_id INTEGER NOT NULL REFERENCES users(id),
            object_id INTEGER NOT NULL REFERENCES work_sites(id),
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            scheduled_at TEXT NOT NULL,
            deadline TEXT NOT NULL,
            priority INTEGER NOT NULL,
            task_id INTEGER UNIQUE REFERENCES tasks(id),
            plan_id INTEGER REFERENCES work_plans(id),
            occurrence_date TEXT,
            UNIQUE (plan_id, occurrence_date)
        );

        CREATE INDEX IF NOT EXISTS planned_jobs_by_company ON planned_jobs(company_id, scheduled_at, id);
        CREATE INDEX IF NOT EXISTS planned_jobs_due ON planned_jobs(company_id, scheduled_at) WHERE task_id IS NULL;
        """;

    private static final String DEFAULT_ZONE = "Asia/Almaty";
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("HH:mm");
    private static final DateTimeFormatter STAMP = new DateTimeFormatterBuilder().appendInstant(3).toFormatter();

    private Planning() {}

    static Map<String, Object> list(Connection db, Map<String, Object> user) throws SQLException {
        Accounts.requireManager(user);
        var plans = Db.rows(db, "SELECT * FROM work_plans WHERE company_id = ? ORDER BY id DESC",
            number(user, "company_id"));
        return Map.of("templates", plans.stream().map(Planning::json).toList());
    }

    static Map<String, Object> validate(Connection db, Map<String, Object> user, Map<String, Object> body)
            throws SQLException {
        Accounts.requireManager(user);
        if (!(body.get("objectId") instanceof String)) {
            throw error(400, "Выберите объект из справочника.");
        }
        long objectId = Places.resolve(db, user, Map.of("objectId", body.get("objectId"))).objectId();
        String startDate = field(body, "startDate", "Дата начала", 10, false);
        String time = field(body, "time", "Время начала", 5, false);
        String zone = body.containsKey("zone") ? field(body, "zone", "Часовой пояс", 80, false) : DEFAULT_ZONE;
        try {
            LocalDate date = LocalDate.parse(startDate);
            if (date.getYear() < 2000 || date.getYear() > 9998) {
                throw new DateTimeException("Unsupported year");
            }
        } catch (DateTimeException invalid) {
            throw error(400, "Укажите дату в формате ГГГГ-ММ-ДД.");
        }
        if (!time.matches("(?:[01][0-9]|2[0-3]):[0-5][0-9]")) {
            throw error(400, "Укажите время в формате ЧЧ:ММ.");
        }
        try {
            ZoneId.of(zone);
        } catch (DateTimeException invalid) {
            throw error(400, "Укажите часовой пояс, например Asia/Almaty.");
        }
        String frequency = field(body, "frequency", "Повтор", 10, false);
        if (!Set.of("once", "daily", "weekly", "monthly").contains(frequency)) {
            throw error(400, "Выберите период повтора.");
        }
        String holiday = field(body, "holidayRule", "Правило на выходные", 10, false);
        if (!Set.of("skip", "move", "run").contains(holiday)) {
            throw error(400, "Выберите правило на выходные.");
        }
        Object enabled = body.getOrDefault("enabled", true);
        if (!(enabled instanceof Boolean)) {
            throw error(400, "Проверьте, включён ли шаблон.");
        }
        return Map.ofEntries(
            Map.entry("objectId", Long.toString(objectId)),
            Map.entry("title", field(body, "title", "Название", 160, false)),
            Map.entry("description", field(body, "description", "Описание", 2000, true)),
            Map.entry("startDate", startDate), Map.entry("time", time), Map.entry("zone", zone),
            Map.entry("frequency", frequency), Map.entry("holidayRule", holiday),
            Map.entry("interval", integer(body, "interval", 1, 1, 30, "Интервал")),
            Map.entry("horizonDays", integer(body, "horizonDays", 7, 0, 90, "Дней вперёд")),
            Map.entry("priority", integer(body, "priority", 3, 1, 5, "Приоритет")),
            Map.entry("durationMinutes", integer(body, "durationMinutes", 120, 1, 10080, "Минут на выполнение")),
            Map.entry("enabled", enabled));
    }

    static Map<String, Object> save(Connection db, Map<String, Object> user, Long id, Map<String, Object> body)
            throws SQLException {
        Accounts.requireManager(user);
        long company = number(user, "company_id");
        lockCompany(db, company);
        Instant now = Instant.now();
        LocalDate rebuildFrom = null;
        if (id != null) {
            var existing = find(db, company, id);
            if (existing == null) {
                throw error(404, "Шаблон не найден.");
            }
            var merged = new LinkedHashMap<>(json(existing));
            merged.putAll(body);
            body = merged;
        }
        var fields = validate(db, user, body);
        Object[] values = {
            number(user, "id"), Long.parseLong((String) fields.get("objectId")), fields.get("title"),
            fields.get("description"), fields.get("startDate"), fields.get("time"), fields.get("zone"),
            fields.get("frequency"), fields.get("interval"), fields.get("horizonDays"), fields.get("holidayRule"),
            fields.get("priority"), fields.get("durationMinutes"), Boolean.TRUE.equals(fields.get("enabled")) ? 1 : 0
        };
        if (id == null) {
            id = Db.insert(db, """
                INSERT INTO work_plans(actor_id, object_id, title, description, start_date, start_time,
                    zone, frequency, repeat_interval, horizon_days, holiday_rule, priority,
                    duration_minutes, enabled, company_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, with(values, company));
        } else {
            rebuildFrom = discardFuture(db, id, now,
                now.atZone(ZoneId.of((String) fields.get("zone"))).toLocalDate());
            Db.update(db, """
                UPDATE work_plans SET actor_id = ?, object_id = ?, title = ?, description = ?, start_date = ?,
                    start_time = ?, zone = ?, frequency = ?, repeat_interval = ?, horizon_days = ?,
                    holiday_rule = ?, priority = ?, duration_minutes = ?, enabled = ?, generated_through = NULL
                WHERE company_id = ? AND id = ?
                """, with(values, company, id));
        }
        var plan = find(db, company, id);
        int generated = number(plan, "enabled") == 0 ? 0 : generatePlan(db, plan, now, rebuildFrom);
        return Map.of("template", json(plan), "generated", generated);
    }

    static Map<String, Object> generate(Connection db, Map<String, Object> user) throws SQLException {
        Accounts.requireManager(user);
        return Map.of("generated", generateCompany(db, number(user, "company_id"), Instant.now()));
    }

    static void tick(Connection db) throws SQLException {
        Instant now = Instant.now();
        for (var company : Db.rows(db, "SELECT DISTINCT company_id FROM work_plans WHERE enabled = 1 ORDER BY company_id")) {
            generateCompany(db, number(company, "company_id"), now);
        }
    }

    static void calendarChanged(Connection db, long company) throws SQLException {
        Instant now = Instant.now();
        lockCompany(db, company);
        for (var plan : activePlans(db, company)) {
            if ("run".equals(plan.get("holiday_rule"))) continue;
            long id = number(plan, "id");
            LocalDate today = now.atZone(ZoneId.of((String) plan.get("zone"))).toLocalDate();
            LocalDate from = discardFuture(db, id, now, today);
            Db.update(db, "UPDATE work_plans SET generated_through = NULL WHERE id = ?", id);
            plan.put("generated_through", null);
            generatePlan(db, plan, now, from);
        }
    }

    static void lockCompany(Connection db, long company) throws SQLException {
        if (Db.postgres()) {
            Db.one(db, "SELECT id FROM companies WHERE id = ? FOR NO KEY UPDATE", company);
        }
    }

    static Map<String, Object> createImportedTask(Connection db, Map<String, Object> user,
                                                  Map<String, Object> plan, String assigneeId) throws Exception {
        Instant start = LocalDate.parse((String) plan.get("startDate"))
            .atTime(LocalTime.parse((String) plan.get("time"), TIME))
            .atZone(ZoneId.of((String) plan.get("zone"))).toInstant();
        String deadline = STAMP.format(start.plus(number(plan, "durationMinutes"), ChronoUnit.MINUTES));
        long priority = number(plan, "priority");
        var task = new LinkedHashMap<String, Object>();
        for (String field : List.of("title", "objectId", "description")) task.put(field, plan.get(field));
        task.put("deadline", deadline);
        task.put("priority", taskPriority(priority));
        if (assigneeId != null) task.put("assigneeId", assigneeId);
        long id = Tasks.insertTask(db, user, task, true);
        Db.update(db, """
            INSERT INTO planned_jobs(company_id, actor_id, object_id, title, description, scheduled_at, deadline,
                priority, task_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, number(user, "company_id"), number(user, "id"), Long.parseLong((String) plan.get("objectId")),
            plan.get("title"), plan.get("description"), STAMP.format(start), deadline, priority, id);
        return Tasks.taskResponse(db, user, id);
    }

    static int taskPriority(long priority) {
        return priority < 3 ? 1 : priority == 3 ? 2 : 3;
    }

    private static int generateCompany(Connection db, long company, Instant now) throws SQLException {
        lockCompany(db, company);
        int generated = 0;
        for (var plan : activePlans(db, company)) {
            generated += generatePlan(db, plan, now, null);
        }
        return generated;
    }

    private static List<Map<String, Object>> activePlans(Connection db, long company) throws SQLException {
        return Db.rows(db, "SELECT * FROM work_plans WHERE company_id = ? AND enabled = 1 ORDER BY id", company);
    }

    private static LocalDate discardFuture(Connection db, long planId, Instant now, LocalDate today)
            throws SQLException {
        var first = Db.one(db, """
            SELECT occurrence_date FROM planned_jobs
            WHERE plan_id = ? AND task_id IS NULL AND scheduled_at > ?
            ORDER BY occurrence_date LIMIT 1
            """, planId, STAMP.format(now));
        Db.update(db, "DELETE FROM planned_jobs WHERE plan_id = ? AND task_id IS NULL AND scheduled_at > ?",
            planId, STAMP.format(now));
        if (first != null) {
            LocalDate date = LocalDate.parse((String) first.get("occurrence_date"));
            if (date.isBefore(today)) return date;
        }
        return today;
    }

    private static int generatePlan(Connection db, Map<String, Object> plan, Instant now, LocalDate rebuildFrom)
            throws SQLException {
        ZoneId zone = ZoneId.of((String) plan.get("zone"));
        LocalDate today = now.atZone(zone).toLocalDate();
        LocalDate start = LocalDate.parse((String) plan.get("start_date"));
        LocalDate end = today.plusDays(number(plan, "horizon_days"));
        String frequency = (String) plan.get("frequency");
        boolean once = "once".equals(frequency);
        LocalDate from = start;
        if (rebuildFrom != null && rebuildFrom.isAfter(from)) from = rebuildFrom;
        if (plan.get("generated_through") instanceof String cursor) {
            LocalDate next = LocalDate.parse(cursor).plusDays(1);
            if (next.isAfter(from)) from = next;
        } else if (rebuildFrom == null && !once && today.isAfter(from)) {
            // Keep the recurrence anchor but do not backfill dates before the template was created.
            from = today;
        }
        if (once && start.isBefore(end)) end = start;
        if (from.isAfter(end)) return 0;

        long company = number(plan, "company_id");
        var holidays = Db.rows(db, """
            SELECT work_date FROM shift_calendar
            WHERE company_id = ? AND day_type = 'holiday' AND work_date BETWEEN ? AND ?
            """, company, from.toString(), end.plusDays(366).toString());
        Set<String> datesOff = new HashSet<>();
        for (var holiday : holidays) datesOff.add((String) holiday.get("work_date"));

        String holidayRule = (String) plan.get("holiday_rule");
        long interval = number(plan, "repeat_interval");
        LocalTime time = LocalTime.parse((String) plan.get("start_time"), TIME);
        int generated = 0;
        for (LocalDate occurrence = from; !occurrence.isAfter(end); occurrence = occurrence.plusDays(1)) {
            if (!matches(start, occurrence, frequency, interval)) continue;
            LocalDate scheduled = occurrence;
            if (datesOff.contains(scheduled.toString())) {
                if ("skip".equals(holidayRule)) continue;
                if ("move".equals(holidayRule)) {
                    while (datesOff.contains(scheduled.toString())) scheduled = scheduled.plusDays(1);
                    if (scheduled.isAfter(end.plusDays(366))) {
                        throw error(409, "Нет рабочего дня для переноса заявки.");
                    }
                }
            }
            Instant begins = scheduled.atTime(time).atZone(zone).toInstant();
            if (rebuildFrom != null && !begins.isAfter(now)) continue;
            generated += Db.update(db, """
                INSERT INTO planned_jobs(company_id, actor_id, object_id, title, description, scheduled_at,
                    deadline, priority, plan_id, occurrence_date)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (plan_id, occurrence_date) DO NOTHING
                """, company, number(plan, "actor_id"), number(plan, "object_id"), plan.get("title"),
                plan.get("description"), STAMP.format(begins),
                STAMP.format(begins.plus(number(plan, "duration_minutes"), ChronoUnit.MINUTES)),
                number(plan, "priority"), number(plan, "id"), occurrence.toString());
        }
        Db.update(db, "UPDATE work_plans SET generated_through = ? WHERE id = ?", end.toString(), number(plan, "id"));
        return generated;
    }

    private static boolean matches(LocalDate start, LocalDate occurrence, String frequency, long interval) {
        long days = ChronoUnit.DAYS.between(start, occurrence);
        return switch (frequency) {
            case "once" -> days == 0;
            case "daily" -> days % interval == 0;
            case "weekly" -> days % (7 * interval) == 0;
            case "monthly" -> ChronoUnit.MONTHS.between(start.withDayOfMonth(1), occurrence.withDayOfMonth(1)) % interval == 0
                && occurrence.getDayOfMonth() == Math.min(start.getDayOfMonth(), occurrence.lengthOfMonth());
            default -> false;
        };
    }

    private static Map<String, Object> find(Connection db, long company, long id) throws SQLException {
        return Db.one(db, "SELECT * FROM work_plans WHERE company_id = ? AND id = ?", company, id);
    }

    private static Object[] with(Object[] initial, Object... additional) {
        Object[] result = Arrays.copyOf(initial, initial.length + additional.length);
        System.arraycopy(additional, 0, result, initial.length, additional.length);
        return result;
    }

    private static int integer(Map<String, Object> body, String key, int fallback, int min, int max, String label) {
        Object value = body.getOrDefault(key, fallback);
        if (value instanceof Number n && n.doubleValue() == n.intValue()
                && n.intValue() >= min && n.intValue() <= max) {
            return n.intValue();
        }
        throw error(400, "Поле «" + label + "» должно быть целым числом от " + min + " до " + max + ".");
    }

    private static Map<String, Object> json(Map<String, Object> row) {
        return Map.ofEntries(
            Map.entry("id", Long.toString(number(row, "id"))),
            Map.entry("objectId", Long.toString(number(row, "object_id"))),
            Map.entry("title", row.get("title")), Map.entry("description", row.get("description")),
            Map.entry("startDate", row.get("start_date")), Map.entry("time", row.get("start_time")),
            Map.entry("zone", row.get("zone")), Map.entry("frequency", row.get("frequency")),
            Map.entry("interval", row.get("repeat_interval")), Map.entry("horizonDays", row.get("horizon_days")),
            Map.entry("holidayRule", row.get("holiday_rule")), Map.entry("priority", row.get("priority")),
            Map.entry("durationMinutes", row.get("duration_minutes")), Map.entry("enabled", number(row, "enabled") != 0)
        );
    }
}
