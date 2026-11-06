package qwork;

import com.fasterxml.jackson.core.type.TypeReference;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

import static qwork.Domain.error;
import static qwork.Domain.field;
import static qwork.Domain.number;

final class Tasks {
    private static final Map<String, String> TRANSITIONS = Map.of(
        "assigned", "accepted", "accepted", "travel", "travel", "arrived",
        "arrived", "work", "work", "review", "rework", "work", "paused", "work"
    );
    private static final Set<String> CLOSED = Set.of("done", "cancelled", "repeated");
    private static final Set<String> REPEATABLE = Set.of("done", "cancelled", "review", "rework", "paused");
    private static final String TASK_SELECT = """
        SELECT t.*, u.name AS assignee_name, u.role AS assignee_role, m.name AS manager_name, r.id AS repeat_task_id,
            r.repeat_reason AS next_repeat_reason, trip_link.trip_id, planned.scheduled_at
        FROM tasks AS t JOIN users AS u ON u.id = t.assignee_id
        LEFT JOIN users AS m ON m.id = t.manager_id AND m.company_id = t.company_id
        LEFT JOIN tasks AS r ON r.repeat_of = t.id AND r.company_id = t.company_id
        LEFT JOIN work_trip_tasks AS trip_link ON trip_link.task_id = t.id
        LEFT JOIN planned_jobs AS planned ON planned.task_id = t.id AND planned.company_id = t.company_id
        """;

    private Tasks() {}

    static Map<String, Object> listTasks(Connection db, Map<String, Object> user) throws Exception {
        String query = TASK_SELECT + " WHERE t.company_id = ?";
        long company = number(user, "company_id");
        List<Map<String, Object>> rows = "employee".equals(user.get("role"))
            ? Db.rows(db, query + " AND t.assignee_id = ? AND t.status <> 'unassigned' ORDER BY t.id DESC",
                company, number(user, "id"))
            : Db.rows(db, query + " ORDER BY t.id DESC", company);
        List<Map<String, Object>> tasks = new ArrayList<>(rows.size());
        for (var row : rows) {
            tasks.add(taskJson(db, row));
        }
        return Map.of("tasks", tasks);
    }

    static Map<String, Object> createTask(Connection db, Map<String, Object> user,
                                          Map<String, Object> payload) throws Exception {
        return taskResponse(db, user, insertTask(db, user, payload, false));
    }

    static long insertTask(Connection db, Map<String, Object> user, Map<String, Object> payload,
                           boolean fromImport) throws Exception {
        Accounts.requireManager(user);
        String title = field(payload, "title", "Название", 160, false);
        var place = Places.resolve(db, user, payload);
        String description = field(payload, "description", "Описание", 2000, true);
        boolean unassigned = fromImport && !payload.containsKey("assigneeId");
        // The task keeps a user FK until an employee is assigned.
        long assignee = unassigned ? number(user, "id") : findAssignee(db, user, payload);
        String status = unassigned ? "unassigned" : "assigned";
        String deadline = timestamp(payload.get("deadline"), "Срок");
        String scheduledStart = timestamp(payload.get("scheduledAt"), "Начало выезда");
        if (scheduledStart != null && deadline != null
                && !Instant.parse(deadline).isAfter(Instant.parse(scheduledStart))) {
            throw error(400, "Срок выполнения должен быть позже начала выезда.");
        }
        long company = number(user, "company_id");
        Long manager = FieldWork.assignedManager(db, company, place.objectId(), unassigned ? 0 : assignee, payload);
        String purpose = field(payload, "purpose", "Цель выезда", 1000, true);
        int priority = FieldWork.priority(payload);
        String checklist = payload.containsKey("checklist") ? encode(FieldWork.newChecklist(payload.get("checklist"))) : null;
        String pairs = payload.containsKey("photoPairs") ? encode(FieldWork.newPhotoPairs(payload.get("photoPairs"))) : null;
        long id = Db.insert(db, """
            INSERT INTO tasks(company_id, assignee_id, title, object, address, description, location, deadline, object_id,
                purpose, priority, manager_id, checklist, photo_pairs, status, scheduled_start)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, company, assignee, title, place.name(), place.address(), description,
            encode(place.location()), deadline, place.objectId(), purpose, priority, manager, checklist, pairs,
            status, scheduledStart);
        recordEvent(db, id, user, status, fromImport ? "Импорт из Excel" : "", null);
        return id;
    }

    static Map<String, Object> repeatTask(Connection db, Map<String, Object> user, long id,
                                          Map<String, Object> payload) throws Exception {
        Accounts.requireManager(user);
        var original = getTask(db, user, id);
        var assignment = new LinkedHashMap<String, Object>();
        assignment.put("assigneeId", payload.getOrDefault("assigneeId", original.get("assignee_id").toString()));
        long assignee = findAssignee(db, user, assignment);
        Db.lockTask(db, number(user, "company_id"), id);
        var task = getTask(db, user, id);
        if (!payload.containsKey("assigneeId") && !original.get("assignee_id").equals(task.get("assignee_id"))) {
            throw error(409, "Исполнитель изменился. Обновите заявку.");
        }
        String status = (String) task.get("status");
        if (!REPEATABLE.contains(status)) {
            throw error(409, "Повторный выезд доступен после остановки или завершения работы.");
        }
        if (Db.one(db, "SELECT id FROM tasks WHERE repeat_of = ?", id) != null) {
            throw error(409, "Для этой заявки уже создан повторный выезд.");
        }
        String deadline = timestamp(payload.get("deadline"), "Срок");
        String reason = field(payload, "reason", "Причина повторного выезда", 1000, false);
        long company = number(user, "company_id");
        Object manager = payload.containsKey("managerId")
            ? FieldWork.manager(db, company, payload.get("managerId"))
            : task.get("manager_id");
        String checklist = task.get("checklist") == null ? null
            : encode(FieldWork.freshChecklist(FieldWork.checklist(task)));
        long repeat = Db.insert(db, """
            INSERT INTO tasks(company_id, assignee_id, title, object, address, description, location, deadline, repeat_of, object_id,
                purpose, priority, manager_id, checklist, photo_pairs, repeat_reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, company, assignee, task.get("title"), task.get("object"),
            task.get("address"), task.get("description"), task.get("location"), deadline, id, task.get("object_id"),
            task.get("purpose"), task.get("priority"), manager, checklist, task.get("photo_pairs"), reason);
        if (!CLOSED.contains(status)) {
            Db.update(db, "UPDATE tasks SET status = 'repeated', revision = revision + 1 WHERE id = ?", id);
            recordEvent(db, id, user, "repeated", reason, null);
        } else {
            Db.update(db, "UPDATE tasks SET revision = revision + 1 WHERE id = ?", id);
        }
        recordEvent(db, repeat, user, "assigned", reason, null);
        return Map.of("task", taskJson(db, getTask(db, user, repeat)),
                      "originalTask", taskJson(db, getTask(db, user, id)));
    }

    static Map<String, Object> updateTask(Connection db, Map<String, Object> user, long id,
                                          Map<String, Object> payload) throws Exception {
        return updateTask(db, user, id, payload, null);
    }

    static Map<String, Object> updateTask(Connection db, Map<String, Object> user, long id,
                                          Map<String, Object> payload, Instant occurredAt) throws Exception {
        Db.lockTask(db, number(user, "company_id"), id);
        var task = getTask(db, user, id);
        Object revision = payload.getOrDefault("expectedRevision", task.get("revision"));
        if (!isInteger(revision) || ((Number) revision).longValue() != number(task, "revision")) {
            throw error(409, "Заявка уже изменилась. Обновите данные.");
        }
        String role = (String) user.get("role");
        boolean employee = role.equals("employee");
        if (!employee) {
            Accounts.requireManager(user);
        }
        String oldStatus = (String) task.get("status");
        if (payload.containsKey("managerId")) {
            Accounts.requireManager(user);
            if (CLOSED.contains(oldStatus) || payload.containsKey("status")) {
                throw error(409, "Назначьте руководителя в открытой заявке отдельным действием.");
            }
            Long manager = FieldWork.manager(db, number(user, "company_id"), payload.get("managerId"));
            Db.update(db, "UPDATE tasks SET manager_id = ?, revision = revision + 1 WHERE id = ?", manager, id);
            return taskResponse(db, user, id);
        }
        if ("reopened".equals(payload.get("status"))) {
            return reopen(db, user, id, task, payload);
        }
        if (!employee && "cancelled".equals(payload.get("status"))) {
            if (CLOSED.contains(oldStatus)) {
                throw error(409, "Эта заявка уже закрыта.");
            }
            String reason = field(payload, "cancelReason", "Причина отмены", 1000, false);
            Db.update(db, """
                UPDATE tasks SET status = 'cancelled', cancel_reason = ?, revision = revision + 1 WHERE id = ?
                """, reason, id);
            recordEvent(db, id, user, "cancelled", reason, null);
            return taskResponse(db, user, id);
        }
        if (employee && !Shift.isAvailable(db, number(user, "company_id"), number(user, "id"))) {
            throw error(409, "Отметьте возвращение, прежде чем продолжить работу.");
        }
        boolean refusal = "refused".equals(payload.get("status"));
        if (refusal && !employee) {
            throw error(403, "Отказ может отправить назначенный сотрудник.");
        }
        if (employee && (refusal || "accepted".equals(payload.get("status")))
            && awaitingEmergency(db, user, id)) {
            throw error(409, "По заявке ожидается ответ на аварийное назначение.");
        }
        if (refusal) {
            if (!"assigned".equals(oldStatus)) {
                throw error(409, "Отказ доступен до принятия заявки.");
            }
            String reason = field(payload, "refusalReason", "Причина отказа", 1000, false);
            Db.update(db, "UPDATE tasks SET status = 'unassigned', revision = revision + 1 WHERE id = ?", id);
            recordEvent(db, id, user, "refused", reason, null, occurredAt);
            return Map.of("taskRemoved", true);
        }
        Changes changes = employee ? employeeChanges(db, id, task, payload) : reviewChanges(db, id, task, payload);
        String status = changes.status();
        if (!employee && status.equals("rework")) {
            Media.invalidateAfter(db, id, user);
        }
        var previousOutcome = FieldWork.outcome(task);
        var outcome = employee ? FieldWork.changeOutcome(previousOutcome, payload) : previousOutcome;
        if (!outcome.equals(previousOutcome) && !oldStatus.equals("work")) {
            throw error(409, "Результат можно заполнить в процессе работы.");
        }
        String result = (String) outcome.get("work");
        if (status.equals("review") && result.isBlank()) {
            throw error(400, "Заполните поле «Выполненные работы».");
        }
        boolean reworkTrip = oldStatus.equals("rework") && status.equals("travel");
        String arrival = reworkTrip ? null : (String) task.get("arrival");
        String eventReason = status.equals("rework") ? changes.reason() : "";
        Map<String, Object> position = null;
        if (employee) {
            if (!status.equals(oldStatus)) {
                if (status.equals("arrived")) {
                    var arrivalData = arrivalFrom(task, payload.get("arrival"));
                    if (arrivalData != null) {
                        arrival = encode(arrivalData);
                        eventReason = (String) arrivalData.getOrDefault("reason", "");
                        position = eventReason.isEmpty() ? arrivalData : null;
                    }
                } else if (payload.get("position") != null) {
                    position = positionFrom(payload.get("position"));
                }
            }
        }
        Db.update(db, """
            UPDATE tasks SET status = ?, checks = ?, checklist = ?, photo_before = ?, photo_after = ?,
                rework_reason = ?, arrival = ?, result = ?, outcome = ?, revision = revision + 1 WHERE id = ?
            """, status, encode(FieldWork.legacyChecks(changes.checklist())), encode(changes.checklist()),
            changes.before(), changes.after(), changes.reason(), arrival, result, encode(outcome), id);
        if (!status.equals(oldStatus)) {
            recordEvent(db, id, user, status, eventReason, position, occurredAt);
        }
        return taskResponse(db, user, id);
    }

    private static boolean awaitingEmergency(Connection db, Map<String, Object> user, long id) throws SQLException {
        return Db.one(db, """
            SELECT id FROM incidents WHERE company_id = ? AND task_id = ? AND kind = 'emergency' AND status = 'open'
            """, number(user, "company_id"), id) != null;
    }

    private static Map<String, Object> reopen(Connection db, Map<String, Object> user, long id,
                                              Map<String, Object> task, Map<String, Object> payload) throws Exception {
        Accounts.requireManager(user);
        String oldStatus = (String) task.get("status");
        if (!Set.of("done", "cancelled").contains(oldStatus)) {
            throw error(409, "Можно переоткрыть принятую или отменённую заявку.");
        }
        if (task.get("repeat_task_id") != null) {
            throw error(409, "По этой заявке уже назначен повторный выезд.");
        }
        if (awaitingEmergency(db, user, id)) {
            throw error(409, "Сначала завершите аварийное назначение по этой заявке.");
        }
        String reason = field(payload, "reopenReason", "Причина переоткрытия", 1000, false);
        boolean accepted = oldStatus.equals("done");
        Media.invalidateAfter(db, id, user);
        Db.update(db, """
            UPDATE tasks SET status = ?, rework_reason = ?, cancel_reason = '', arrival = ?, revision = revision + 1
            WHERE id = ?
            """, accepted ? "rework" : "unassigned", accepted ? reason : "",
            accepted ? task.get("arrival") : null, id);
        recordEvent(db, id, user, "reopened", reason, null);
        return taskResponse(db, user, id);
    }

    private record Changes(String status, List<Map<String, Object>> checklist, long before, long after, String reason) {}

    private static Changes employeeChanges(Connection db, long id, Map<String, Object> task, Map<String, Object> payload) throws Exception {
        String oldStatus = (String) task.get("status");
        Object requested = payload.getOrDefault("status", oldStatus);
        if (!(requested instanceof String status) ||
            !(status.equals(oldStatus) || status.equals(TRANSITIONS.get(oldStatus))
                || oldStatus.equals("rework") && status.equals("travel"))) {
            throw error(409, "Этот переход статуса недоступен.");
        }
        if (oldStatus.equals("review") || oldStatus.equals("unassigned") || CLOSED.contains(oldStatus)) {
            throw error(409, "Отправленный отчёт защищён от изменений.");
        }

        var originalChecklist = FieldWork.checklist(task);
        var checklist = FieldWork.changeChecklist(originalChecklist, payload);
        if (!checklist.equals(originalChecklist) && !oldStatus.equals("work")) {
            throw error(409, "Чек-лист доступен после начала работ.");
        }
        var proofs = Media.activeProofs(db, id);
        var main = proofs.getOrDefault(FieldWork.MAIN_PAIR, Set.of());
        var pairs = FieldWork.photoPairs(task);
        long before = main.contains("before") ? 1 : 0;
        long after = main.contains("after") ? 1 : 0;
        boolean allBefore = pairs.stream().allMatch(pair -> proofs.getOrDefault(pair.get("key"), Set.of()).contains("before"));
        if (status.equals("work") && !oldStatus.equals("work") && !allBefore) {
            throw error(409, "Перед началом работы добавьте фото «до».");
        }
        boolean allAfter = pairs.stream().allMatch(pair -> proofs.getOrDefault(pair.get("key"), Set.of()).contains("after"));
        if (status.equals("review") && (!allBefore || !allAfter
            || checklist.stream().anyMatch(item -> item.get("status") == null))) {
            throw error(409, "Перед отправкой заполните чек-лист и фотоотчёт.");
        }
        return new Changes(status, checklist, before, after, (String) task.get("rework_reason"));
    }

    private static Changes reviewChanges(Connection db, long id, Map<String, Object> task,
                                         Map<String, Object> payload) throws Exception {
        Object requested = payload.get("status");
        boolean ordinary = "review".equals(task.get("status")) && ("done".equals(requested) || "rework".equals(requested));
        boolean afterRemark = "done".equals(task.get("status")) && "rework".equals(requested)
            && RepresentativeReviews.hasCurrentRemark(db, id);
        if (!ordinary && !afterRemark) {
            throw error(409, "Решение доступно для заявки на проверке.");
        }
        String reason = "rework".equals(requested)
            ? field(payload, "reworkReason", "Причина доработки", 1000, false) : "";
        return new Changes((String) requested, FieldWork.checklist(task),
                           number(task, "photo_before"), "rework".equals(requested) ? 0 : number(task, "photo_after"), reason);
    }

    private static boolean isInteger(Object value) {
        return value instanceof Integer || value instanceof Long;
    }

    private static long findAssignee(Connection db, Map<String, Object> user, Map<String, Object> payload)
            throws SQLException {
        String raw = field(payload, "assigneeId", "Исполнитель", 20, false);
        long id;
        try {
            if (!raw.matches("[0-9]{1,19}")) {
                throw new NumberFormatException();
            }
            id = Long.parseLong(raw);
        } catch (NumberFormatException invalid) {
            throw error(400, "Выберите сотрудника вашей компании.");
        }
        var assignee = id > 0 ? Db.one(db, """
            SELECT id FROM users WHERE company_id = ? AND id = ? AND role = 'employee'
            """, number(user, "company_id"), id) : null;
        if (assignee == null) {
            throw error(400, "Выберите сотрудника вашей компании.");
        }
        Shift.requireAvailable(db, number(user, "company_id"), id);
        return number(assignee, "id");
    }

    static Map<String, Object> getTask(Connection db, Map<String, Object> user, long id) throws SQLException {
        var task = Db.one(db, TASK_SELECT + " WHERE t.company_id = ? AND t.id = ?", number(user, "company_id"), id);
        if (task == null || ("employee".equals(user.get("role"))
            && (number(task, "assignee_id") != number(user, "id") || "unassigned".equals(task.get("status"))))) {
            throw error(404, "Заявка не найдена.");
        }
        return task;
    }

    static Map<String, Object> taskResponse(Connection db, Map<String, Object> user, long id) throws Exception {
        return Map.of("task", taskJson(db, getTask(db, user, id)));
    }

    private static Map<String, Object> taskJson(Connection db, Map<String, Object> row) throws Exception {
        var events = Db.rows(db, "SELECT * FROM task_events WHERE task_id = ? ORDER BY id", row.get("id"));
        var history = new ArrayList<Map<String, Object>>(events.size());
        for (var event : events) {
            var item = new LinkedHashMap<String, Object>();
            item.put("id", event.get("id").toString());
            item.put("status", event.get("status"));
            item.put("actorId", event.get("actor_id").toString());
            item.put("actorName", event.get("actor_name"));
            item.put("createdAt", event.get("created_at"));
            item.put("receivedAt", Objects.toString(event.get("received_at"), (String) event.get("created_at")));
            item.put("reason", event.get("reason"));
            item.put("position", decode(event.get("position")));
            history.add(item);
        }

        String deadline = (String) row.get("deadline");
        var task = new LinkedHashMap<String, Object>();
        task.put("id", row.get("id").toString());
        for (String key : List.of("title", "object", "address", "description", "status", "revision", "result",
            "purpose", "priority")) {
            task.put(key, row.get(key));
        }
        task.put("checks", readChecks(row));
        task.put("checklist", FieldWork.checklist(row));
        task.put("outcome", FieldWork.outcome(row));
        String status = (String) row.get("status");
        boolean historical = status.equals("review") || CLOSED.contains(status);
        long taskId = number(row, "id");
        var proofs = Media.activeProofs(db, taskId);
        var main = proofs.getOrDefault(FieldWork.MAIN_PAIR, Set.of());
        task.put("photos", historical
            ? Map.of("before", row.get("photo_before"), "after", row.get("photo_after"))
            : Map.of("before", main.contains("before") ? 1 : 0, "after", main.contains("after") ? 1 : 0));
        task.put("photoPairs", FieldWork.photoPairs(row).stream().map(pair -> {
            var active = proofs.getOrDefault(pair.get("key"), Set.of());
            return Map.of("key", pair.get("key"), "label", pair.get("label"),
                "before", active.contains("before"), "after", active.contains("after"));
        }).toList());
        boolean assigned = !"unassigned".equals(status) && "employee".equals(row.get("assignee_role"));
        task.put("assigneeId", assigned ? row.get("assignee_id").toString() : null);
        task.put("assigneeName", assigned ? row.get("assignee_name") : null);
        task.put("tripId", Objects.toString(row.get("trip_id"), null));
        task.put("managerId", Objects.toString(row.get("manager_id"), null));
        task.put("managerName", row.get("manager_name"));
        task.put("reworkReason", row.get("rework_reason"));
        task.put("objectId", Objects.toString(row.get("object_id"), null));
        task.put("location", decode(row.get("location")));
        task.put("deadline", deadline);
        Object scheduledStart = row.get("scheduled_start");
        task.put("scheduledAt", scheduledStart == null ? row.get("scheduled_at") : scheduledStart);
        task.put("overdue", overdue(deadline, (String) row.get("status"), events));
        task.put("arrival", decode(row.get("arrival")));
        task.put("repeatOf", Objects.toString(row.get("repeat_of"), null));
        task.put("repeatTaskId", Objects.toString(row.get("repeat_task_id"), null));
        task.put("repeatReason", repeatReason(row, events));
        task.put("nextRepeatReason", row.get("next_repeat_reason"));
        task.put("cancelReason", row.get("cancel_reason"));
        task.put("representativeDecision", RepresentativeReviews.currentDecision(db, taskId));
        task.put("history", history);
        return task;
    }

    private static String repeatReason(Map<String, Object> row, List<Map<String, Object>> events) {
        if (row.get("repeat_of") == null) {
            return Objects.toString(row.get("next_repeat_reason"), "");
        }
        String reason = Objects.toString(row.get("repeat_reason"), "");
        if (!reason.isBlank()) return reason;
        return events.stream().filter(event -> "assigned".equals(event.get("status")))
            .findFirst().map(event -> Objects.toString(event.get("reason"), "")).orElse("");
    }

    private static boolean overdue(String deadline, String status, List<Map<String, Object>> events) {
        if (deadline == null || deadline.isEmpty() || Set.of("cancelled", "repeated").contains(status)) {
            return false;
        }
        Instant cutoff = OffsetDateTime.parse(deadline).toInstant();
        if (status.equals("review") || status.equals("done")) {
            for (var event : events.reversed()) {
                if ("review".equals(event.get("status"))) {
                    return OffsetDateTime.parse((String) event.get("created_at")).toInstant().isAfter(cutoff);
                }
            }
            return false;
        }
        return Instant.now().isAfter(cutoff);
    }

    private static void recordEvent(Connection db, long id, Map<String, Object> user, String status,
                                    String reason, Map<String, Object> position) throws Exception {
        recordEvent(db, id, user, status, reason, position, null);
    }

    private static void recordEvent(Connection db, long id, Map<String, Object> user, String status,
                                    String reason, Map<String, Object> position, Instant occurredAt) throws Exception {
        String receivedAt = Instant.now().toString();
        Db.update(db, """
            INSERT INTO task_events(task_id, status, actor_id, actor_name, created_at, reason, position, received_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, id, status, user.get("id"), user.get("name"),
            occurredAt == null ? receivedAt : occurredAt.toString(), reason, encode(position), receivedAt);
    }

    private static String timestamp(Object value, String label) {
        if (value == null) {
            return null;
        }
        if (value instanceof String date) {
            try {
                return OffsetDateTime.parse(date).toInstant().toString();
            } catch (DateTimeParseException ignored) {
                // Dates require an explicit time zone.
            }
        }
        throw error(400, "Проверьте поле «" + label + "».");
    }

    private static double measurement(Object value, double min, double max, String label) {
        if (value instanceof Number number) {
            double result = number.doubleValue();
            if (result >= min && result <= max) {
                return result;
            }
        }
        throw error(400, "Проверьте поле «" + label + "».");
    }

    private static Map<String, Object> coordinates(Object value) {
        if (!(value instanceof Map<?, ?> point)) {
            throw error(400, "Проверьте координаты.");
        }
        var position = new LinkedHashMap<String, Object>();
        position.put("latitude", measurement(point.get("latitude"), -90, 90, "Широта"));
        position.put("longitude", measurement(point.get("longitude"), -180, 180, "Долгота"));
        return position;
    }

    private static Map<String, Object> positionFrom(Object value) {
        var position = coordinates(value);
        Map<?, ?> raw = (Map<?, ?>) value;
        if (raw.get("accuracy") != null) {
            position.put("accuracy", measurement(raw.get("accuracy"), 0, 100_000, "Точность GPS"));
        }
        if (raw.get("capturedAt") != null) {
            position.put("capturedAt", timestamp(raw.get("capturedAt"), "Время отметки"));
        }
        return position;
    }

    private static Map<String, Object> arrivalFrom(Map<String, Object> task, Object value) throws Exception {
        Object savedLocation = task.get("location");
        if (value == null) {
            if (savedLocation != null) {
                throw error(400, "Укажите геопозицию или причину ручной отметки.");
            }
            return null;
        }
        if (!(value instanceof Map<?, ?> raw)) {
            throw error(400, "Проверьте отметку прибытия.");
        }
        if (!raw.containsKey("latitude") && !raw.containsKey("longitude")) {
            var reason = new LinkedHashMap<String, Object>();
            reason.put("reason", raw.get("reason"));
            return Map.of("reason", field(reason, "reason", "Причина ручной отметки", 1000, false));
        }
        var position = positionFrom(value);
        if (savedLocation != null) {
            Map<String, Object> location = Db.JSON.readValue(savedLocation.toString(), new TypeReference<>() {});
            double distance = FieldWork.distance(((Number) location.get("latitude")).doubleValue(),
                ((Number) location.get("longitude")).doubleValue(), ((Number) position.get("latitude")).doubleValue(),
                ((Number) position.get("longitude")).doubleValue());
            if (distance > ((Number) location.get("radius")).doubleValue()) {
                throw error(409, "Вы вне радиуса объекта.");
            }
            position.put("distance", Math.round(distance));
        }
        return position;
    }

    private static List<?> readChecks(Map<String, Object> row) throws Exception {
        return Db.JSON.readValue((String) row.get("checks"), List.class);
    }

    private static String encode(Object value) throws Exception {
        return value == null ? null : Db.JSON.writeValueAsString(value);
    }

    private static Object decode(Object value) throws Exception {
        return value == null || value.toString().isEmpty() ? null : Db.JSON.readValue(value.toString(), Object.class);
    }
}
