package qwork;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

import static qwork.Domain.error;
import static qwork.Domain.field;
import static qwork.Domain.number;

final class FieldControl {
    private static final Set<String> ON_ASSIGNMENT = Set.of("assigned", "accepted", "travel", "arrived", "work", "rework", "paused");
    private static final Set<String> SUBMITTED = Set.of("review", "done");
    private static final Set<String> CLOSED_WITHOUT_REPORT = Set.of("cancelled", "repeated", "refused", "declined");
    private static final Set<String> ENDS_WORK = Set.of("review", "paused", "rework", "cancelled", "repeated",
        "done", "assigned", "unassigned", "accepted", "travel", "arrived", "refused", "declined", "reopened");
    private static final Duration DELAY_THRESHOLD = Duration.ofMinutes(5);

    private FieldControl() {}

    static Map<String, Object> setWorkMode(Connection db, Map<String, Object> user, Map<String, Object> body)
            throws SQLException {
        Trips.requireOffice(user);
        long employeeId = Trips.identifier(body.get("employeeId"), "Сотрудник");
        String mode = field(body, "workMode", "График работы", 10, false);
        if (!Set.of("stationary", "field").contains(mode)) throw error(400, "Выберите стационарный или выездной график.");
        Trips.lockEmployee(db, number(user, "company_id"), employeeId);
        Db.update(db, """
            INSERT INTO employee_work_modes(employee_id, work_mode) VALUES (?, ?)
            ON CONFLICT (employee_id) DO UPDATE SET work_mode = excluded.work_mode
            """, employeeId, mode);
        return Map.of("employeeId", Long.toString(employeeId), "workMode", mode);
    }

    static Map<String, Object> dashboard(Connection db, Map<String, Object> user) throws SQLException {
        Trips.requireOffice(user);
        long company = number(user, "company_id");
        Instant now = Instant.now();
        var employees = Db.rows(db, """
            SELECT u.id, u.name, u.department, u.last_login_at,
                   COALESCE(mode.work_mode, 'stationary') AS work_mode
            FROM users u LEFT JOIN employee_work_modes mode ON mode.employee_id = u.id
            WHERE u.company_id = ? AND u.role = 'employee' ORDER BY u.name, u.id
            """, company);
        var trips = new HashMap<Long, Map<String, Object>>();
        for (var row : Db.rows(db, """
            SELECT id, employee_id, destination, planned_start, planned_end, started_at, finished_at
            FROM work_trips WHERE company_id = ? AND finished_at IS NULL
            ORDER BY CASE WHEN started_at IS NULL THEN 1 ELSE 0 END, planned_start, id
            """, company)) {
            trips.putIfAbsent(number(row, "employee_id"), row);
        }
        var people = new HashMap<Long, Person>();
        for (var employee : employees) people.put(number(employee, "id"), new Person(employee, trips.get(number(employee, "id")), now));

        var histories = new HashMap<Long, History>();
        for (var event : Db.rows(db, """
            SELECT e.id, e.task_id, e.actor_id, e.status, e.created_at, e.received_at, t.title
            FROM task_events e JOIN tasks t ON t.id = e.task_id
            WHERE t.company_id = ? ORDER BY e.task_id, e.id
            """, company)) {
            var entry = new Event(event);
            histories.computeIfAbsent(number(event, "task_id"), ignored -> new History()).add(entry);
            var person = people.get(number(event, "actor_id"));
            if (person != null) person.seen(entry);
        }

        var decisions = new HashMap<Long, String>();
        for (var decision : Db.rows(db, """
            SELECT rr.report_event_id, rr.decision
            FROM task_representative_reviews rr JOIN tasks t ON t.id = rr.task_id
            WHERE t.company_id = ? AND rr.decision IS NOT NULL
            """, company)) {
            decisions.put(number(decision, "report_event_id"), (String) decision.get("decision"));
        }
        var photos = new HashMap<Long, List<Map<String, Object>>>();
        for (var photo : Db.rows(db, """
            SELECT m.task_id, m.kind, m.pair_key, m.latitude, m.longitude, m.accuracy
            FROM task_media m JOIN tasks t ON t.id = m.task_id
            WHERE t.company_id = ? AND m.rejected_at IS NULL AND m.kind IN ('before', 'after', 'checklist')
            """, company)) {
            photos.computeIfAbsent(number(photo, "task_id"), ignored -> new ArrayList<>()).add(photo);
        }

        var tasks = Db.rows(db, """
            SELECT t.id, t.title, t.status, t.assignee_id, t.object, t.deadline, t.repeat_of, t.location,
                   t.arrival, t.checklist, t.checks, t.photo_pairs, link.trip_id
            FROM tasks t LEFT JOIN work_trip_tasks link ON link.task_id = t.id
            WHERE t.company_id = ? ORDER BY t.id DESC
            """, company);
        var repeated = new HashSet<Long>();
        for (var task : tasks) {
            if (task.get("repeat_of") instanceof Number parent) repeated.add(parent.longValue());
        }
        var board = new ArrayList<Map<String, Object>>();
        var metrics = new Metrics();
        for (var task : tasks) {
            long id = number(task, "id");
            String status = (String) task.get("status");
            var history = histories.getOrDefault(id, new History());
            String decision = history.report == null ? null : decisions.get(history.report.id);
            boolean pending = SUBMITTED.contains(status) && decision == null;
            boolean overdue = overdue(status, instant(task.get("deadline")), history, now);
            var alerts = new LinkedHashSet<String>();
            if (overdue) alerts.add(ON_ASSIGNMENT.contains(status) || "unassigned".equals(status) ? "unfinished" : "overdue");
            if (pending) alerts.add("representativePending");
            if ("remark".equals(decision) && !CLOSED_WITHOUT_REPORT.contains(status)) alerts.add("representativeRemark");
            var taskPhotos = photos.getOrDefault(id, List.of());
            if (!CLOSED_WITHOUT_REPORT.contains(status)) photoAlerts(task, taskPhotos, alerts, overdue);
            long problems = FieldWork.checklist(task).stream().filter(item -> "problem".equals(item.get("status"))).count();
            if (problems > 0 && !CLOSED_WITHOUT_REPORT.contains(status)) alerts.add("checklistProblem");
            if (history.last != null && history.last.delay() >= DELAY_THRESHOLD.toSeconds()) alerts.add("syncDelay");

            metrics.add(task, history, pending, overdue, problems, repeated.contains(id));
            var person = people.get(number(task, "assignee_id"));
            if (person != null && ON_ASSIGNMENT.contains(status)) person.assigned(task, history.last);
            var row = new LinkedHashMap<String, Object>();
            row.put("id", Long.toString(id));
            row.put("title", task.get("title"));
            row.put("object", task.get("object"));
            row.put("status", status);
            row.put("assigneeId", "unassigned".equals(status) ? null : Objects.toString(task.get("assignee_id")));
            row.put("assigneeName", person == null || "unassigned".equals(status) ? null : person.row.get("name"));
            row.put("deadline", task.get("deadline"));
            row.put("tripId", Objects.toString(task.get("trip_id"), null));
            row.put("lastEvent", history.last == null ? null : history.last.json());
            row.put("representativeStatus", pending ? "pending" : decision);
            row.put("alerts", List.copyOf(alerts));
            board.add(row);
        }
        return Map.of("employees", employees.stream().map(row -> people.get(number(row, "id")).json()).toList(),
            "tasks", board, "metrics", metrics.json(), "serverTime", now.toString());
    }

    private static void photoAlerts(Map<String, Object> task, List<Map<String, Object>> photos, Set<String> alerts,
                                    boolean overdue) throws SQLException {
        String status = (String) task.get("status");
        var before = new HashSet<String>();
        var after = new HashSet<String>();
        for (var photo : photos) {
            String key = Objects.toString(photo.get("pair_key"), "main");
            if ("before".equals(photo.get("kind"))) before.add(key);
            if ("after".equals(photo.get("kind"))) after.add(key);
            addGeoAlert(FieldWork.photoGeofence(task.get("location"), photo), alerts, "photoNoGps");
        }
        var pairs = FieldWork.photoPairs(task);
        if ((Set.of("work", "review", "done").contains(status) || overdue)
                && pairs.stream().anyMatch(pair -> !before.contains(pair.get("key")))) alerts.add("missingBefore");
        if ((SUBMITTED.contains(status) || overdue)
                && pairs.stream().anyMatch(pair -> !after.contains(pair.get("key")))) alerts.add("missingAfter");
        if (task.get("arrival") instanceof String encoded) {
            try {
                Map<String, Object> arrival = Db.JSON.readValue(encoded, new TypeReference<>() {});
                if (arrival != null) addGeoAlert(FieldWork.photoGeofence(task.get("location"), arrival), alerts, "arrivalNoGps");
            } catch (JsonProcessingException invalid) {
                throw new SQLException("Unreadable arrival data", invalid);
            }
        }
    }

    private static void addGeoAlert(Map<String, Object> point, Set<String> alerts, String noGps) {
        String status = Objects.toString(point.get("geofenceStatus"), "");
        switch (status) {
            case "outside" -> alerts.add("outsideGeofence");
            case "uncertain" -> alerts.add("uncertainGeofence");
            case "unavailable" -> alerts.add(noGps);
            default -> { }
        }
    }

    private static boolean overdue(String status, Instant deadline, History history, Instant now) {
        if (deadline == null || CLOSED_WITHOUT_REPORT.contains(status)) return false;
        Instant actual = SUBMITTED.contains(status) ? history.report == null ? null : history.report.occurred : now;
        return actual != null && actual.isAfter(deadline);
    }

    private static Instant instant(Object value) {
        if (value instanceof String date) {
            try {
                return OffsetDateTime.parse(date).toInstant();
            } catch (DateTimeParseException ignored) { }
        }
        return null;
    }

    private static String stamp(Instant value) {
        return value == null ? null : value.toString();
    }

    private static boolean later(Instant candidate, Instant current) {
        return candidate != null && (current == null || candidate.isAfter(current));
    }

    private record Event(long id, String taskId, String taskTitle, String status, Instant occurred, Instant received) {
        Event(Map<String, Object> row) {
            this(number(row, "id"), Objects.toString(row.get("task_id")), (String) row.get("title"),
                (String) row.get("status"), instant(row.get("created_at")),
                instant(Objects.requireNonNullElse(row.get("received_at"), row.get("created_at"))));
        }

        long delay() {
            return occurred == null || received == null ? 0 : Math.max(0, Duration.between(occurred, received).toSeconds());
        }

        Map<String, Object> json() {
            var out = new LinkedHashMap<String, Object>();
            out.put("taskId", taskId);
            out.put("taskTitle", taskTitle);
            out.put("status", status);
            out.put("occurredAt", stamp(occurred));
            out.put("receivedAt", stamp(received));
            out.put("delaySeconds", delay());
            return out;
        }
    }

    private static final class History {
        Event last;
        Event report;
        Instant started;
        int arrivals;
        boolean reworked;
        int workSegments;
        long workMillis;

        void add(Event entry) {
            last = entry;
            if ("review".equals(entry.status)) report = entry;
            if ("reopened".equals(entry.status)) {
                reworked |= report != null;
                report = null;
            }
            if ("arrived".equals(entry.status)) arrivals++;
            if ("rework".equals(entry.status)) reworked = true;
            if ("work".equals(entry.status) && started == null) {
                started = entry.occurred;
            } else if (ENDS_WORK.contains(entry.status)) {
                if (started != null && entry.occurred != null && !entry.occurred.isBefore(started)) {
                    workMillis += Duration.between(started, entry.occurred).toMillis();
                    workSegments++;
                }
                started = null;
            }
        }
    }

    private static final class Person {
        final Map<String, Object> row;
        final Map<String, Object> trip;
        final Instant now;
        Event lastEvent;
        Instant lastReceived;
        Instant currentUpdated;
        Map<String, Object> currentTask;
        int activeAssignments;

        Person(Map<String, Object> row, Map<String, Object> trip, Instant now) {
            this.row = row;
            this.trip = trip;
            this.now = now;
        }

        void seen(Event entry) {
            if (lastEvent == null || later(entry.occurred, lastEvent.occurred)) lastEvent = entry;
            if (later(entry.received, lastReceived)) lastReceived = entry.received;
        }

        void assigned(Map<String, Object> task, Event event) {
            activeAssignments++;
            Instant updated = event == null ? null : event.occurred;
            boolean underway = !Set.of("assigned", "accepted").contains(task.get("status"));
            boolean currentUnderway = currentTask != null && !Set.of("assigned", "accepted").contains(currentTask.get("status"));
            if (currentTask == null || (underway && !currentUnderway) || (underway == currentUnderway && later(updated, currentUpdated))) {
                currentTask = Map.of("id", Objects.toString(task.get("id")), "title", task.get("title"),
                    "status", task.get("status"), "object", task.get("object"));
                currentUpdated = updated;
            }
        }

        Map<String, Object> json() {
            var result = new LinkedHashMap<String, Object>();
            result.put("id", Objects.toString(row.get("id")));
            result.put("name", row.get("name"));
            result.put("department", row.get("department"));
            result.put("workMode", row.get("work_mode"));
            result.put("lastLoginAt", row.get("last_login_at"));
            result.put("lastEvent", lastEvent == null ? null : lastEvent.json());
            result.put("lastReceivedAt", stamp(lastReceived));
            result.put("currentTask", currentTask);
            result.put("activeAssignments", activeAssignments);
            if (trip != null) {
                var end = instant(trip.get("planned_end"));
                result.put("trip", Map.of("id", Objects.toString(trip.get("id")), "status", Trips.status(trip),
                    "destination", trip.get("destination"), "plannedEnd", trip.get("planned_end"),
                    "overdue", end != null && now.isAfter(end)));
            }
            return result;
        }
    }

    private static final class Metrics {
        long assigned;
        long completed;
        long firstVisitCompleted;
        long repeatTrips;
        long problems;
        long pendingRepresentative;
        long overdue;
        long workMillis;
        long timedTasks;

        void add(Map<String, Object> task, History history, boolean pending, boolean late, long issueCount, boolean repeated) {
            String status = (String) task.get("status");
            if (!"unassigned".equals(status)) assigned++;
            if ("done".equals(status)) {
                completed++;
                if (task.get("repeat_of") == null && !repeated && history.arrivals == 1 && !history.reworked) firstVisitCompleted++;
            }
            if (task.get("repeat_of") != null) repeatTrips++;
            problems += issueCount;
            if (pending) pendingRepresentative++;
            if (late) overdue++;
            if (SUBMITTED.contains(status) && history.workSegments > 0) {
                workMillis += history.workMillis;
                timedTasks++;
            }
        }

        Map<String, Object> json() {
            var out = new LinkedHashMap<String, Object>();
            out.put("assigned", assigned);
            out.put("completed", completed);
            out.put("firstVisitCompleted", firstVisitCompleted);
            out.put("repeatTrips", repeatTrips);
            out.put("problems", problems);
            out.put("pendingRepresentative", pendingRepresentative);
            out.put("overdue", overdue);
            out.put("averageWorkMinutes", timedTasks == 0 ? null : Math.round(workMillis / (6000.0 * timedTasks)) / 10.0);
            return out;
        }
    }
}
