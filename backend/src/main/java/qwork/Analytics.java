package qwork;

import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

import static qwork.Domain.error;
import static qwork.Domain.number;

final class Analytics {
    private static final ZoneId REPORT_ZONE = ZoneId.of("Asia/Almaty");
    private static final Set<String> EXCLUDED_FROM_SLA = Set.of("cancelled", "repeated");
    private static final Set<String> ACTIVE = Set.of("assigned", "accepted", "travel", "arrived", "work", "rework", "paused");
    private static final String MATCH = """
        FROM tasks t JOIN users u ON u.company_id = t.company_id AND u.id = t.assignee_id
        WHERE t.company_id = ?
        """;

    private Analytics() {}

    static Map<String, Object> report(Connection db, Map<String, Object> user, Map<String, String> input)
            throws SQLException {
        if (!Set.of("dispatcher", "manager").contains(user.get("role"))) {
            throw error(403, "Аналитика доступна диспетчеру и руководителю.");
        }
        long company = number(user, "company_id");
        var filters = Filters.read(input);
        var criteria = new StringBuilder(MATCH);
        var arguments = new ArrayList<Object>();
        arguments.add(company);
        if (filters.employee() != null || !filters.department().isEmpty()) {
            criteria.append(" AND t.status <> 'unassigned'");
        }
        if (filters.employee() != null) {
            criteria.append(" AND u.id = ?");
            arguments.add(filters.employee());
        }
        if (filters.object() != null) {
            criteria.append(" AND t.object_id = ?");
            arguments.add(filters.object());
        }
        if (!filters.department().isEmpty()) {
            criteria.append(" AND u.department = ?");
            arguments.add(filters.department());
        }
        Object[] params = arguments.toArray();
        var tasks = Db.rows(db, """
            SELECT t.id, t.title, t.status, t.object_id, t.object, t.deadline, t.repeat_of,
                u.id AS employee_id, u.name AS employee_name, u.department
            """ + criteria + " ORDER BY t.id DESC", params);
        var histories = histories(db, criteria.toString(), params);
        var photos = Db.rows(db, """
            SELECT m.id, m.task_id, m.kind, m.rejected_reason, m.rejected_at
            FROM task_media m WHERE m.rejected_at IS NOT NULL AND m.task_id IN (SELECT t.id
            """ + criteria + ") ORDER BY m.id DESC", params);
        var photoCounts = new HashMap<Long, Long>();
        for (var photo : photos) photoCounts.merge(number(photo, "task_id"), 1L, Long::sum);

        var repeatLinks = Db.rows(db, """
            SELECT id, repeat_of FROM tasks WHERE company_id = ? AND repeat_of IS NOT NULL ORDER BY id
            """, company);
        var roots = new HashMap<Long, Long>();
        var repeated = new HashSet<Long>();
        for (var link : repeatLinks) {
            long parent = number(link, "repeat_of");
            long root = roots.getOrDefault(parent, parent);
            roots.put(number(link, "id"), root);
            repeated.add(root);
        }

        var aggregate = new Totals();
        var detail = new ArrayList<Map<String, Object>>();
        var titleById = new HashMap<Long, String>();
        var workloads = new LinkedHashMap<Long, Workload>();
        Instant now = Instant.now();
        for (var task : tasks) {
            long taskId = number(task, "id");
            var history = histories.get(taskId);
            if (history == null) history = new History();
            if (!filters.includes(history.created)) continue;

            String title = (String) task.get("title");
            titleById.put(taskId, title);
            String status = (String) task.get("status");
            Instant deadline = instant(task.get("deadline"));
            Boolean slaMet = sla(status, deadline, history.submitted, now);
            boolean overdue = Boolean.FALSE.equals(slaMet);
            long rejected = photoCounts.getOrDefault(taskId, 0L);
            boolean completed = "done".equals(status);
            boolean assigned = !"unassigned".equals(status);
            boolean active = ACTIVE.contains(status);
            aggregate.add(taskId, history, status, overdue, slaMet, rejected, roots, repeated);
            if (assigned) {
                long employeeId = number(task, "employee_id");
                workloads.computeIfAbsent(employeeId, id -> new Workload(task)).add(active, completed);
            }

            var row = new LinkedHashMap<String, Object>();
            row.put("id", Long.toString(taskId));
            row.put("title", title);
            row.put("status", status);
            row.put("employeeId", assigned ? identifier(task, "employee_id") : null);
            row.put("employeeName", assigned ? task.get("employee_name") : null);
            row.put("objectId", identifier(task, "object_id"));
            row.put("objectName", task.get("object"));
            row.put("department", assigned ? task.get("department") : "");
            row.put("createdAt", stamp(history.created));
            row.put("deadline", stamp(deadline));
            row.put("completedAt", completed ? stamp(history.completed) : null);
            row.put("submittedAt", stamp(history.submitted));
            row.put("overdue", overdue);
            row.put("slaMet", slaMet);
            row.put("repeatOf", identifier(task, "repeat_of"));
            row.put("travelMinutes", minutes(history.travelMillis));
            row.put("onSiteMinutes", minutes(history.onSiteMillis));
            row.put("rejectedPhotos", rejected);
            detail.add(row);
        }

        var rejectedPhotos = new ArrayList<Map<String, Object>>();
        for (var photo : photos) {
            long taskId = number(photo, "task_id");
            if (!titleById.containsKey(taskId)) continue;
            var row = new LinkedHashMap<String, Object>();
            row.put("id", identifier(photo, "id"));
            row.put("taskId", Long.toString(taskId));
            row.put("taskTitle", titleById.get(taskId));
            row.put("kind", photo.get("kind"));
            row.put("reason", photo.get("rejected_reason"));
            row.put("rejectedAt", photo.get("rejected_at"));
            rejectedPhotos.add(row);
        }
        return Map.of("filters", filters.json(), "options", options(db, company), "metrics", aggregate.json(),
            "workload", workloads.values().stream().map(Workload::json).toList(),
            "tasks", detail, "rejectedPhotos", rejectedPhotos);
    }

    private static Map<Long, History> histories(Connection db, String criteria, Object[] params) throws SQLException {
        var histories = new HashMap<Long, History>();
        var rows = Db.rows(db, """
            SELECT e.task_id, e.status, e.created_at FROM task_events e
            WHERE e.task_id IN (SELECT t.id
            """ + criteria + ") ORDER BY e.task_id, e.id", params);
        for (var row : rows) {
            // created_at is the actual occurrence time for accepted offline events.
            histories.computeIfAbsent(number(row, "task_id"), id -> new History())
                .add((String) row.get("status"), instant(row.get("created_at")));
        }
        return histories;
    }

    private static Map<String, Object> options(Connection db, long company) throws SQLException {
        var employees = Db.rows(db, """
            SELECT id, name, department FROM users
            WHERE company_id = ? AND role = 'employee' ORDER BY name, id
            """, company);
        var objects = Db.rows(db, "SELECT id, name FROM work_sites WHERE company_id = ? ORDER BY name, id", company);
        var people = employees.stream().map(row -> Map.of(
            "id", identifier(row, "id"), "name", row.get("name"), "department", row.get("department"))).toList();
        var sites = objects.stream().map(row -> Map.of("id", identifier(row, "id"), "name", row.get("name"))).toList();
        var departments = employees.stream().map(row -> (String) row.get("department"))
            .filter(value -> !value.isBlank()).distinct().sorted().toList();
        return Map.of("employees", people, "objects", sites, "departments", departments);
    }

    private static Boolean sla(String status, Instant deadline, Instant submitted, Instant now) {
        if (deadline == null || EXCLUDED_FROM_SLA.contains(status)) return null;
        if ("done".equals(status) || "review".equals(status)) {
            return submitted == null ? null : !submitted.isAfter(deadline);
        }
        return now.isAfter(deadline) ? Boolean.FALSE : null;
    }

    private static Instant instant(Object value) {
        if (!(value instanceof String text) || text.isBlank()) return null;
        try {
            return OffsetDateTime.parse(text).toInstant();
        } catch (DateTimeParseException invalidHistoricalDate) {
            return null;
        }
    }

    private static String identifier(Map<String, Object> row, String key) {
        return Objects.toString(row.get(key), null);
    }

    private static String stamp(Instant value) {
        return value == null ? null : value.toString();
    }

    private static double minutes(long milliseconds) {
        return Math.round(milliseconds / 6000.0) / 10.0;
    }

    private static Double percent(long met, long total) {
        return total == 0 ? null : Math.round(1000.0 * met / total) / 10.0;
    }

    private static long elapsed(Instant start, Instant end) {
        if (start == null || end == null || end.isBefore(start)) return 0;
        return Duration.between(start, end).toMillis();
    }

    private record Filters(Long employee, Long object, String department, LocalDate from, LocalDate to,
                           Instant start, Instant end) {
        static Filters read(Map<String, String> input) {
            Long employee = filterId(input.get("employeeId"), "Сотрудник");
            Long object = filterId(input.get("objectId"), "Объект");
            String department = Domain.field(new HashMap<>(input), "department", "Подразделение", 120, true);
            LocalDate from = date(input.get("from"));
            LocalDate to = date(input.get("to"));
            if (from != null && to != null && from.isAfter(to)) {
                throw error(400, "Дата окончания периода раньше даты начала.");
            }
            return new Filters(employee, object, department, from, to,
                from == null ? null : from.atStartOfDay(REPORT_ZONE).toInstant(),
                to == null ? null : to.plusDays(1).atStartOfDay(REPORT_ZONE).toInstant());
        }

        private static Long filterId(String raw, String label) {
            if (raw == null || raw.isBlank()) return null;
            try {
                if (raw.matches("[0-9]{1,19}")) {
                    long parsed = Long.parseLong(raw);
                    if (parsed > 0) return parsed;
                }
            } catch (NumberFormatException ignored) {
                // Return the same validation error for overflow and malformed IDs.
            }
            throw error(400, "Проверьте фильтр «" + label + "».");
        }

        private static LocalDate date(String raw) {
            if (raw == null || raw.isBlank()) return null;
            try {
                if (raw.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}")) return LocalDate.parse(raw);
            } catch (DateTimeParseException ignored) {
                // Use the same validation message for impossible and malformed dates.
            }
            throw error(400, "Укажите дату в формате ГГГГ-ММ-ДД.");
        }

        boolean includes(Instant created) {
            if (start == null && end == null) return true;
            return created != null && (start == null || !created.isBefore(start)) && (end == null || created.isBefore(end));
        }

        Map<String, String> json() {
            return Map.of("employeeId", Objects.toString(employee, ""), "objectId", Objects.toString(object, ""),
                "department", department, "from", Objects.toString(from, ""), "to", Objects.toString(to, ""));
        }
    }

    private static final class History {
        Instant created;
        Instant submitted;
        Instant completed;
        Instant travelStarted;
        Instant onSiteStarted;
        long travelMillis;
        long onSiteMillis;
        int arrivals;
        boolean reworked;

        void add(String status, Instant time) {
            if (created == null) created = time;
            switch (status) {
                case "travel" -> {
                    if (travelStarted == null) travelStarted = time;
                    endSite(time);
                }
                case "arrived" -> {
                    arrivals++;
                    travelMillis += elapsed(travelStarted, time);
                    travelStarted = null;
                    if (onSiteStarted == null) onSiteStarted = time;
                }
                case "work" -> {
                    if (onSiteStarted == null) onSiteStarted = time;
                    travelStarted = null;
                }
                case "review" -> {
                    submitted = time;
                    travelStarted = null;
                    endSite(time);
                }
                case "done" -> completed = time;
                case "rework" -> reworked = true;
                case "paused", "cancelled", "repeated", "unassigned", "assigned", "accepted" -> {
                    travelStarted = null;
                    endSite(time);
                }
                default -> { }
            }
        }

        private void endSite(Instant time) {
            onSiteMillis += elapsed(onSiteStarted, time);
            onSiteStarted = null;
        }
    }

    private static final class Workload {
        final Map<String, Object> employee;
        long total;
        long active;
        long completed;

        Workload(Map<String, Object> employee) {
            this.employee = employee;
        }

        void add(boolean activeTask, boolean completedTask) {
            total++;
            if (activeTask) active++;
            if (completedTask) completed++;
        }

        Map<String, Object> json() {
            return Map.of("id", identifier(employee, "employee_id"), "name", employee.get("employee_name"),
                "department", employee.get("department"), "total", total, "active", active, "completed", completed);
        }
    }

    private static final class Totals {
        long total;
        long completed;
        long overdue;
        long slaMet;
        long slaTotal;
        long active;
        long repeatTrips;
        long travelMillis;
        long onSiteMillis;
        long unconfirmed;
        long rejectedPhotos;
        final Set<Long> completedRoots = new HashSet<>();
        final Set<Long> firstVisit = new HashSet<>();

        void add(long task, History history, String status, boolean late, Boolean withinSla, long rejected,
                 Map<Long, Long> roots, Set<Long> repeated) {
            total++;
            if (late) overdue++;
            if (withinSla != null) {
                slaTotal++;
                if (withinSla) slaMet++;
            }
            if (ACTIVE.contains(status)) active++;
            if (roots.containsKey(task)) repeatTrips++;
            if ("review".equals(status)) unconfirmed++;
            rejectedPhotos += rejected;
            travelMillis += history.travelMillis;
            onSiteMillis += history.onSiteMillis;
            if ("done".equals(status)) {
                completed++;
                long root = roots.getOrDefault(task, task);
                completedRoots.add(root);
                if (task == root && !repeated.contains(root) && history.arrivals == 1 && !history.reworked) {
                    firstVisit.add(root);
                }
            }
        }

        Map<String, Object> json() {
            var metrics = new LinkedHashMap<String, Object>();
            metrics.put("total", total);
            metrics.put("completed", completed);
            metrics.put("overdue", overdue);
            metrics.put("slaMet", slaMet);
            metrics.put("slaTotal", slaTotal);
            metrics.put("slaPercent", percent(slaMet, slaTotal));
            metrics.put("active", active);
            metrics.put("repeatTrips", repeatTrips);
            metrics.put("firstVisitCompleted", firstVisit.size());
            metrics.put("firstVisitTotal", completedRoots.size());
            metrics.put("firstVisitPercent", percent(firstVisit.size(), completedRoots.size()));
            metrics.put("travelMinutes", minutes(travelMillis));
            metrics.put("onSiteMinutes", minutes(onSiteMillis));
            metrics.put("unconfirmed", unconfirmed);
            metrics.put("rejectedPhotos", rejectedPhotos);
            return metrics;
        }
    }
}
