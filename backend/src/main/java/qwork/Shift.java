package qwork;

import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static qwork.Domain.error;
import static qwork.Domain.field;
import static qwork.Domain.number;

final class Shift {
    static final String SQLITE_SCHEMA = """
        CREATE TABLE IF NOT EXISTS shift_calendar (
            company_id INTEGER NOT NULL REFERENCES companies(id),
            work_date TEXT NOT NULL,
            day_type TEXT NOT NULL CHECK (day_type IN ('holiday', 'working')),
            label TEXT NOT NULL,
            PRIMARY KEY (company_id, work_date)
        );
        CREATE TABLE IF NOT EXISTS shifts (
            id INTEGER PRIMARY KEY,
            company_id INTEGER NOT NULL REFERENCES companies(id),
            employee_id INTEGER NOT NULL REFERENCES users(id),
            work_date TEXT NOT NULL,
            starts_at TEXT NOT NULL,
            ends_at TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('normal', 'duty')),
            decision TEXT CHECK (decision IN ('continue', 'pause', 'transfer', 'finish')),
            decided_at TEXT,
            finished_at TEXT,
            transfer_task_id INTEGER REFERENCES tasks(id)
        );
        CREATE INDEX IF NOT EXISTS shifts_by_company_time ON shifts(company_id, starts_at);
        CREATE INDEX IF NOT EXISTS shifts_by_employee_time ON shifts(company_id, employee_id, starts_at, ends_at);
        CREATE TABLE IF NOT EXISTS shift_task_actions (
            shift_id INTEGER NOT NULL REFERENCES shifts(id),
            task_id INTEGER NOT NULL REFERENCES tasks(id),
            decision TEXT NOT NULL CHECK (decision IN ('pause', 'transfer')),
            requested_at TEXT NOT NULL,
            transferred_at TEXT,
            PRIMARY KEY (shift_id, task_id)
        );
        CREATE TABLE IF NOT EXISTS unavailable_employees (
            company_id INTEGER NOT NULL REFERENCES companies(id),
            employee_id INTEGER NOT NULL REFERENCES users(id),
            unavailable_since TEXT NOT NULL,
            PRIMARY KEY (company_id, employee_id)
        );
        """;

    private static final DateTimeFormatter TIMESTAMP = new DateTimeFormatterBuilder().appendInstant(3).toFormatter();
    private static final String SELECT = """
        SELECT s.*, u.name AS employee_name
        FROM shifts s JOIN users u ON u.id = s.employee_id
        WHERE s.company_id = ?
        """;
    private static final String UNFINISHED = """
        SELECT t.id, t.title, t.status
        FROM tasks t
        WHERE t.company_id = ? AND t.assignee_id = ?
          AND t.status IN ('assigned', 'accepted', 'travel', 'arrived', 'work', 'paused', 'rework')
          AND (t.status <> 'paused' OR NOT EXISTS (
              SELECT 1 FROM shift_task_actions a WHERE a.shift_id = ? AND a.task_id = t.id
          ))
        ORDER BY t.id
        """;

    private Shift() {}

    static Map<String, Object> list(Connection db, Map<String, Object> user) throws SQLException {
        long company = number(user, "company_id");
        boolean employee = "employee".equals(user.get("role"));
        Instant now = Instant.now();
        String lower = stamp(now.minus(31, ChronoUnit.DAYS));
        String range = " AND (s.ends_at >= ? OR s.transfer_task_id IS NOT NULL OR (s.finished_at IS NULL AND s.decision = 'continue'))";
        var shifts = employee
            ? Db.rows(db, SELECT + range + " AND s.employee_id = ? ORDER BY s.starts_at, s.id",
                company, lower, number(user, "id"))
            : Db.rows(db, SELECT + range + " ORDER BY s.starts_at, s.id", company, lower);
        var calendar = Db.rows(db, """
            SELECT work_date, day_type, label FROM shift_calendar
            WHERE company_id = ? ORDER BY work_date
            """, company);
        var unavailable = employee
            ? Db.rows(db, "SELECT employee_id FROM unavailable_employees WHERE company_id = ? AND employee_id = ?",
                company, number(user, "id"))
            : Db.rows(db, "SELECT employee_id FROM unavailable_employees WHERE company_id = ?", company);
        var result = new ArrayList<Map<String, Object>>(shifts.size());
        var reminders = new ArrayList<Map<String, Object>>();
        var currentShiftEmployees = new HashSet<Long>();
        for (var row : shifts.reversed()) {
            result.add(shift(db, row, now));
            Instant start = Instant.parse((String) row.get("starts_at"));
            Instant end = Instant.parse((String) row.get("ends_at"));
            long employeeId = number(row, "employee_id");
            // One active reminder per worker, from their latest applicable shift.
            if (now.isBefore(start) || !currentShiftEmployees.add(employeeId) ||
                row.get("finished_at") != null || row.get("decision") != null ||
                now.isBefore(end.minus(30, ChronoUnit.MINUTES))) {
                continue;
            }
            var tasks = unfinished(db, company, employeeId, number(row, "id"));
            if (tasks.isEmpty()) {
                continue;
            }
            reminders.add(Map.of(
                "shiftId", row.get("id").toString(), "employeeId", Long.toString(employeeId),
                "employeeName", row.get("employee_name"), "endsAt", row.get("ends_at"),
                "kind", now.isBefore(end) ? "ending" : "needsAttention", "tasks", tasks
            ));
        }
        return Map.of(
            "shifts", result.reversed(),
            "days", calendar.stream().map(Shift::day).toList(),
            "reminders", reminders,
            "unavailableEmployeeIds", unavailable.stream().map(row -> row.get("employee_id").toString()).toList(),
            "serverTime", stamp(now)
        );
    }

    static Map<String, Object> create(Connection db, Map<String, Object> user, Map<String, Object> body)
            throws SQLException {
        Accounts.requireManager(user);
        long company = number(user, "company_id");
        long employee = identifier(body, "employeeId", "Сотрудник");
        OffsetDateTime starts = dateTime(body, "startsAt", "Начало смены");
        OffsetDateTime ends = dateTime(body, "endsAt", "Конец смены");
        Duration length = Duration.between(starts, ends);
        if (length.compareTo(Duration.ofMinutes(1)) < 0 || length.compareTo(Duration.ofHours(24)) > 0) {
            throw error(400, "Смена должна длиться от одной минуты до 24 часов.");
        }
        String kind = field(body, "kind", "Вид смены", 10, false);
        if (!Set.of("normal", "duty").contains(kind)) {
            throw error(400, "Выберите обычную или дежурную смену.");
        }
        LocalDate startDate = starts.toLocalDate();
        LocalDate workDate = body.containsKey("date") ? date(body, "date") : startDate;
        if (Math.abs(ChronoUnit.DAYS.between(startDate, workDate)) > 1) {
            throw error(400, "Дата смены должна соответствовать времени начала.");
        }
        lockCompany(db, company);
        lockEmployee(db, company, employee);
        var calendarDay = Db.one(db, "SELECT day_type FROM shift_calendar WHERE company_id = ? AND work_date = ?",
            company, workDate.toString());
        if (kind.equals("normal") && calendarDay != null && "holiday".equals(calendarDay.get("day_type"))) {
            throw error(409, "На выходной можно поставить только дежурную смену.");
        }

        String start = stamp(starts.toInstant());
        String end = stamp(ends.toInstant());
        var overlap = Db.one(db, """
            SELECT id FROM shifts WHERE company_id = ? AND employee_id = ?
              AND starts_at < ? AND ends_at > ?
            LIMIT 1
            """, company, employee, end, start);
        if (overlap != null) {
            throw error(409, "У сотрудника уже есть смена на это время.");
        }
        long id = Db.insert(db, """
            INSERT INTO shifts(company_id, employee_id, work_date, starts_at, ends_at, kind)
            VALUES (?, ?, ?, ?, ?, ?)
            """, company, employee, workDate.toString(), start, end, kind);
        return Map.of("shift", shift(db, find(db, company, id), Instant.now()));
    }

    static Map<String, Object> saveDay(Connection db, Map<String, Object> user, Map<String, Object> body)
            throws SQLException {
        Accounts.requireManager(user);
        long company = number(user, "company_id");
        LocalDate date = date(body, "date");
        String type = field(body, "type", "Тип дня", 12, false);
        if (!Set.of("holiday", "working").contains(type)) {
            throw error(400, "Выберите рабочий или выходной день.");
        }
        String label = field(body, "label", "Название дня", 120, true);
        lockCompany(db, company);
        if ("holiday".equals(type) && Db.one(db, """
            SELECT id FROM shifts WHERE company_id = ? AND work_date = ? AND kind = 'normal'
              AND finished_at IS NULL AND ends_at > ? LIMIT 1
            """, company, date.toString(), stamp(Instant.now())) != null) {
            throw error(409, "На эту дату уже запланированы обычные смены.");
        }
        Db.update(db, """
            INSERT INTO shift_calendar(company_id, work_date, day_type, label)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (company_id, work_date) DO UPDATE SET day_type = excluded.day_type, label = excluded.label
            """, company, date.toString(), type, label);
        return Map.of("day", Map.of("date", date.toString(), "type", type, "label", label));
    }

    static Map<String, Object> decide(Connection db, Map<String, Object> user, long id, Map<String, Object> body)
            throws Exception {
        if (!"employee".equals(user.get("role"))) {
            throw error(403, "Решение по окончанию смены принимает сотрудник.");
        }
        long company = number(user, "company_id");
        long employee = number(user, "id");
        lockEmployee(db, company, employee);
        lockShift(db, company, id);
        var shift = find(db, company, id);
        if (number(shift, "employee_id") != employee) {
            throw error(404, "Смена не найдена.");
        }
        String decision = field(body, "decision", "Решение", 12, false);
        if (!Set.of("continue", "pause", "transfer", "finish").contains(decision)) {
            throw error(400, "Выберите решение по смене.");
        }
        Instant now = Instant.now();
        if (shift.get("finished_at") != null) {
            if (decision.equals(shift.get("decision"))) {
                return Map.of("shift", shift(db, shift, now));
            }
            throw error(409, "Смена уже завершена.");
        }
        if (now.isBefore(Instant.parse((String) shift.get("starts_at")))) {
            throw error(409, "Смена ещё не началась.");
        }
        if (!decision.equals("finish")
            && now.isBefore(Instant.parse((String) shift.get("ends_at")).minus(30, ChronoUnit.MINUTES))) {
            throw error(409, "Решение доступно за 30 минут до конца смены.");
        }

        var tasks = unfinished(db, company, employee, id);
        if (decision.equals("finish") && !tasks.isEmpty()) {
            throw error(409, "Сначала завершите, приостановите или передайте незавершённые заявки.");
        }
        String shiftDecision = decision;
        String finished = decision.equals("continue") ? null : stamp(now);
        if (decision.equals("pause") || decision.equals("transfer")) {
            long taskId = identifier(body, "taskId", "Заявка");
            var task = tasks.stream().filter(row -> row.get("id").equals(Long.toString(taskId))).findFirst()
                .orElseThrow(() -> error(404, "Незавершённая заявка не найдена."));
            if (decision.equals("pause") && !Set.of("work", "rework", "paused").contains(task.get("status"))) {
                throw error(409, "Приостановить можно начатую работу. Для этой заявки выберите передачу.");
            }
            Incidents.markForHandoff(db, user, taskId,
                decision.equals("transfer") ? "Запрошена передача в конце смены" : "Работа приостановлена в конце смены");
            Db.update(db, """
                INSERT INTO shift_task_actions(shift_id, task_id, decision, requested_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT (shift_id, task_id) DO UPDATE SET decision = excluded.decision,
                    requested_at = excluded.requested_at, transferred_at = NULL
                """, id, taskId, decision, stamp(now));
            if (!unfinished(db, company, employee, id).isEmpty()) {
                shiftDecision = (String) shift.get("decision");
                finished = null;
            }
        }
        Db.update(db, """
            UPDATE shifts SET decision = ?, decided_at = ?, finished_at = ?, transfer_task_id = ?
            WHERE id = ? AND company_id = ?
            """, shiftDecision, stamp(now), finished, firstPending(db, id), id, company);
        return Map.of("shift", shift(db, find(db, company, id), now));
    }

    static Map<String, Object> transfer(Connection db, Map<String, Object> user, long id, Map<String, Object> body)
            throws Exception {
        Accounts.requireManager(user);
        long company = number(user, "company_id");
        long assignee = identifier(body, "assigneeId", "Новый исполнитель");
        lockShift(db, company, id);
        var row = find(db, company, id);
        Long first = firstPending(db, id);
        if (first == null) {
            throw error(409, "У смены нет заявки, ожидающей передачи.");
        }
        if (number(row, "employee_id") == assignee) {
            throw error(400, "Выберите другого сотрудника.");
        }
        long taskId = body.containsKey("taskId") ? identifier(body, "taskId", "Заявка") : first;
        if (Db.one(db, """
            SELECT a.task_id FROM shift_task_actions a JOIN tasks t ON t.id = a.task_id
            WHERE a.shift_id = ? AND a.task_id = ? AND a.decision = 'transfer' AND a.transferred_at IS NULL
              AND t.assignee_id = ? AND t.status IN ('paused', 'unassigned')
            """, id, taskId, number(row, "employee_id")) == null) {
            throw error(404, "Заявка не ожидает передачи в этой смене.");
        }
        var result = new LinkedHashMap<>(Incidents.reassign(db, user, taskId, assignee));
        Db.update(db, "UPDATE shift_task_actions SET transferred_at = ? WHERE shift_id = ? AND task_id = ?",
            stamp(Instant.now()), id, taskId);
        Db.update(db, "UPDATE shifts SET transfer_task_id = ? WHERE id = ? AND company_id = ?", firstPending(db, id), id, company);
        result.put("shift", shift(db, find(db, company, id), Instant.now()));
        return result;
    }

    static void requireAvailable(Connection db, long company, long employee) throws SQLException {
        lockEmployee(db, company, employee);
        if (!isAvailable(db, company, employee)) {
            throw error(409, "Сотрудник недоступен для новых назначений.");
        }
    }

    static boolean isAvailable(Connection db, long company, long employee) throws SQLException {
        return Db.one(db, "SELECT employee_id FROM unavailable_employees WHERE company_id = ? AND employee_id = ?",
            company, employee) == null;
    }

    static void setAvailable(Connection db, long company, long employee, boolean available) throws SQLException {
        lockEmployee(db, company, employee);
        if (available) {
            Db.update(db, "DELETE FROM unavailable_employees WHERE company_id = ? AND employee_id = ?", company, employee);
        } else {
            Db.update(db, """
                INSERT INTO unavailable_employees(company_id, employee_id, unavailable_since)
                VALUES (?, ?, ?) ON CONFLICT (company_id, employee_id) DO NOTHING
                """, company, employee, stamp(Instant.now()));
        }
    }

    private static void lockCompany(Connection db, long company) throws SQLException {
        if (Db.postgres()) {
            Db.one(db, "SELECT id FROM companies WHERE id = ? FOR NO KEY UPDATE", company);
        }
    }

    private static void lockEmployee(Connection db, long company, long employee) throws SQLException {
        String sql = "SELECT id FROM users WHERE company_id = ? AND id = ? AND role = 'employee'";
        if (Db.one(db, sql + (Db.postgres() ? " FOR NO KEY UPDATE" : ""), company, employee) == null) {
            throw error(404, "Сотрудник не найден.");
        }
    }

    private static void lockShift(Connection db, long company, long id) throws SQLException {
        if (Db.postgres()) {
            Db.one(db, "SELECT id FROM shifts WHERE company_id = ? AND id = ? FOR UPDATE", company, id);
        }
    }

    private static Map<String, Object> find(Connection db, long company, long id) throws SQLException {
        var row = Db.one(db, SELECT + " AND s.id = ?", company, id);
        if (row == null) throw error(404, "Смена не найдена.");
        return row;
    }

    private static List<Map<String, Object>> unfinished(Connection db, long company, long employee, long shift)
            throws SQLException {
        return Db.rows(db, UNFINISHED, company, employee, shift).stream().map(row -> Map.<String, Object>of(
            "id", row.get("id").toString(), "title", row.get("title"), "status", row.get("status")
        )).toList();
    }

    private static final String PENDING = """
        SELECT a.task_id FROM shift_task_actions a
        JOIN shifts s ON s.id = a.shift_id JOIN tasks t ON t.id = a.task_id
        WHERE a.shift_id = ? AND a.decision = 'transfer' AND a.transferred_at IS NULL
          AND t.assignee_id = s.employee_id AND t.status IN ('paused', 'unassigned')
        ORDER BY a.requested_at, a.task_id
        """;

    private static Long firstPending(Connection db, long shiftId) throws SQLException {
        var row = Db.one(db, PENDING + " LIMIT 1", shiftId);
        return row == null ? null : number(row, "task_id");
    }

    private static Map<String, Object> shift(Connection db, Map<String, Object> row, Instant now) throws SQLException {
        var result = new LinkedHashMap<String, Object>();
        result.put("id", row.get("id").toString());
        result.put("employeeId", row.get("employee_id").toString());
        result.put("employeeName", row.get("employee_name"));
        result.put("date", row.get("work_date"));
        result.put("startsAt", row.get("starts_at"));
        result.put("endsAt", row.get("ends_at"));
        result.put("kind", row.get("kind"));
        result.put("decision", row.get("decision"));
        result.put("decidedAt", row.get("decided_at"));
        result.put("finishedAt", row.get("finished_at"));
        var actions = row.get("decided_at") == null ? List.<Map<String, Object>>of() : Db.rows(db, """
            SELECT a.task_id, a.decision, a.transferred_at, t.status, t.assignee_id
            FROM shift_task_actions a JOIN tasks t ON t.id = a.task_id
            WHERE a.shift_id = ? ORDER BY a.requested_at, a.task_id
            """, number(row, "id"));
        result.put("handledTaskIds", actions.stream()
            .filter(action -> Set.of("paused", "unassigned").contains(action.get("status")))
            .map(action -> action.get("task_id").toString()).toList());
        var transfers = actions.stream().filter(action -> "transfer".equals(action.get("decision"))
            && action.get("transferred_at") == null && number(action, "assignee_id") == number(row, "employee_id")
            && Set.of("paused", "unassigned").contains(action.get("status")))
            .map(action -> action.get("task_id").toString()).toList();
        result.put("transferTaskId", transfers.isEmpty() ? null : transfers.getFirst());
        result.put("transferTaskIds", transfers);
        var finish = row.get("finished_at");
        Instant stop = finish != null ? Instant.parse((String) finish)
            : "continue".equals(row.get("decision")) ? now : null;
        result.put("overtimeMinutes", stop == null ? 0
            : Math.max(0, Duration.between(Instant.parse((String) row.get("ends_at")), stop).toMinutes()));
        return result;
    }

    private static Map<String, Object> day(Map<String, Object> row) {
        return Map.of("date", row.get("work_date"), "type", row.get("day_type"), "label", row.get("label"));
    }

    private static String stamp(Instant value) {
        return TIMESTAMP.format(value);
    }

    private static long identifier(Map<String, Object> body, String key, String label) {
        String value = field(body, key, label, 19, false);
        try {
            long parsed = Long.parseLong(value);
            if (parsed > 0) return parsed;
        } catch (NumberFormatException ignored) {
            // Invalid value is reported below.
        }
        throw error(400, "Проверьте поле «" + label + "».");
    }

    private static LocalDate date(Map<String, Object> body, String key) {
        String value = field(body, key, "Дата", 10, false);
        try {
            if (value.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}")) return LocalDate.parse(value);
        } catch (DateTimeParseException ignored) {
            // Invalid value is reported below.
        }
        throw error(400, "Укажите дату в формате ГГГГ-ММ-ДД.");
    }

    private static OffsetDateTime dateTime(Map<String, Object> body, String key, String label) {
        try {
            return OffsetDateTime.parse(field(body, key, label, 40, false));
        } catch (DateTimeParseException invalid) {
            throw error(400, "Укажите дату и время с часовым поясом.");
        }
    }
}
