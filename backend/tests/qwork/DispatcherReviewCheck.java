package qwork;

import java.sql.Connection;
import java.time.Instant;
import java.util.Arrays;
import java.util.Map;

/** Exercises review permissions against a disposable SQLite database; never uses live accounts. */
public final class DispatcherReviewCheck {
    private static long company;
    private static Map<String, Object> dispatcher;
    private static Map<String, Object> manager;
    private static Map<String, Object> employee;
    private static Map<String, Object> outsider;
    private static final byte[] ORIGINAL = {1, 2, 3};

    @FunctionalInterface
    private interface Attempt { void run() throws Exception; }

    private static void expectFailure(int expected, Attempt action) throws Exception {
        try {
            action.run();
            throw new AssertionError("Expected HTTP " + expected);
        } catch (Domain.Failure error) {
            check(error.status == expected, "Expected " + expected + ", got " + error.status);
        }
    }

    private static void check(boolean condition, String description) {
        if (!condition) throw new AssertionError(description);
    }

    private static Map<String, Object> user(Connection db, long tenant, String role) throws Exception {
        long id = Db.insert(db, """
            INSERT INTO users(company_id, name, login, role, password_hash, password_salt)
            VALUES (?, ?, ?, ?, ?, ?)
            """, tenant, role, role + "-" + tenant, role, new byte[32], new byte[16]);
        return Map.of("id", id, "company_id", tenant, "role", role, "name", role);
    }

    private static long task(Connection db, String status) throws Exception {
        return Db.insert(db, """
            INSERT INTO tasks(company_id, assignee_id, title, object, address, description,
                status, checks, photo_before, photo_after, result)
            VALUES (?, ?, 'Review fixture', 'Site', '', '', ?, '[true,true,true,true,true]', 1, 1, 'Completed')
            """, company, Domain.number(employee, "id"), status);
    }

    private static long photo(Connection db, long task, String kind) throws Exception {
        String now = Instant.now().toString();
        return Db.insert(db, """
            INSERT INTO task_media(task_id, author_id, author_name, kind, caption, created_at, captured_at,
                sha256, width, height, original_image, display_image)
            VALUES (?, ?, 'employee', ?, '', ?, ?, 'fixture', 800, 600, ?, ?)
            """, task, Domain.number(employee, "id"), kind, now, now, ORIGINAL, new byte[] {4, 5, 6});
    }

    private static Map<String, Object> state(Connection db, long task) throws Exception {
        return Db.one(db, "SELECT * FROM tasks WHERE id = ?", task);
    }

    private static void assertEvent(Connection db, long task, String status, Map<String, Object> actor,
                                    String reason) throws Exception {
        var event = Db.one(db, "SELECT * FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 1", task);
        check(event != null && status.equals(event.get("status")), "History status");
        check(Domain.number(event, "actor_id") == Domain.number(actor, "id"), "History actor");
        check(reason.equals(event.get("reason")), "History reason");
        check(event.get("created_at") != null, "History time");
    }

    private static void accept(Connection db) throws Exception {
        long task = task(db, "review");
        Tasks.updateTask(db, dispatcher, task,
            Map.of("status", "done", "expectedRevision", 1, "result", "Office replacement"));
        var row = state(db, task);
        check("done".equals(row.get("status")), "Dispatcher accepts submitted report");
        check(Domain.number(row, "revision") == 2, "Acceptance increments revision");
        check("Completed".equals(row.get("result")), "Acceptance preserves employee result");
        check(Domain.number(row, "photo_before") == 1 && Domain.number(row, "photo_after") == 1,
            "Acceptance preserves report counters");
        assertEvent(db, task, "done", dispatcher, "");
        expectFailure(409, () -> Tasks.updateTask(db, dispatcher, task, Map.of("status", "done")));
    }

    private static void rework(Connection db) throws Exception {
        long task = task(db, "review");
        photo(db, task, "before");
        long after = photo(db, task, "after");
        expectFailure(400, () -> Tasks.updateTask(db, dispatcher, task,
            Map.of("status", "rework", "reworkReason", "  ")));
        check("review".equals(state(db, task).get("status")) && Media.hasAccepted(db, task, "after"),
            "Missing reason leaves report untouched");
        Tasks.updateTask(db, dispatcher, task,
            Map.of("status", "rework", "reworkReason", "Проверить крепление", "expectedRevision", 1));
        var row = state(db, task);
        check("rework".equals(row.get("status")), "Dispatcher returns report for rework");
        check("Проверить крепление".equals(row.get("rework_reason")), "Rework reason saved");
        check(Domain.number(row, "photo_after") == 0 && !Media.hasAccepted(db, task, "after"),
            "Rework invalidates previous after photo");
        check(Media.hasAccepted(db, task, "before"), "Rework preserves before photo");
        check(Arrays.equals(ORIGINAL, Media.read(db, dispatcher, task, after, true)),
            "Rejected photo original remains available");
        assertEvent(db, task, "rework", dispatcher, "Проверить крепление");
    }

    private static void rejectPhotos(Connection db) throws Exception {
        long task = task(db, "review");
        long before = photo(db, task, "before");
        photo(db, task, "after");
        expectFailure(400, () -> Media.reject(db, dispatcher, task, before, Map.of("reason", "")));
        check(Media.hasAccepted(db, task, "before"), "Photo rejection requires reason");
        Media.reject(db, dispatcher, task, before, Map.of("reason", "Размытый снимок"));
        var rejected = Db.one(db, "SELECT * FROM task_media WHERE id = ?", before);
        check(Domain.number(rejected, "rejected_by") == Domain.number(dispatcher, "id"), "Photo reviewer saved");
        check("Размытый снимок".equals(rejected.get("rejected_reason")), "Photo rejection reason saved");
        check("rework".equals(state(db, task).get("status")), "Photo rejection returns task for rework");
        check(!Media.hasAccepted(db, task, "before") && !Media.hasAccepted(db, task, "after"),
            "Rejecting before photo invalidates both proof photos");
        assertEvent(db, task, "rework", dispatcher, "Фото «до»: Размытый снимок");
        expectFailure(409, () -> Media.reject(db, dispatcher, task, before, Map.of("reason", "Again")));

        long afterTask = task(db, "review");
        photo(db, afterTask, "before");
        long after = photo(db, afterTask, "after");
        Media.reject(db, dispatcher, afterTask, after, Map.of("reason", "Переснять результат"));
        check(Media.hasAccepted(db, afterTask, "before") && !Media.hasAccepted(db, afterTask, "after"),
            "Rejecting after photo preserves before photo");
    }

    private static void permissionsAndStates(Connection db) throws Exception {
        long task = task(db, "review");
        long proof = photo(db, task, "before");
        expectFailure(409, () -> Tasks.updateTask(db, employee, task, Map.of("status", "done")));
        expectFailure(403, () -> Media.reject(db, employee, task, proof, Map.of("reason", "No")));
        expectFailure(404, () -> Tasks.updateTask(db, outsider, task, Map.of("status", "done")));
        expectFailure(404, () -> Media.reject(db, outsider, task, proof, Map.of("reason", "No")));
        expectFailure(409, () -> Tasks.updateTask(db, dispatcher, task,
            Map.of("status", "done", "expectedRevision", 99)));
        check("review".equals(state(db, task).get("status")), "Denied decisions preserve report");

        long otherTask = task(db, "review");
        long otherProof = photo(db, otherTask, "before");
        expectFailure(404, () -> Media.reject(db, dispatcher, task, otherProof, Map.of("reason", "No")));
        long material = photo(db, task, "material");
        expectFailure(409, () -> Media.reject(db, dispatcher, task, material, Map.of("reason", "No")));
        expectFailure(409, () -> Tasks.updateTask(db, dispatcher, task, Map.of("status", "work")));
        for (String status : new String[] {"assigned", "work", "done", "cancelled", "repeated"}) {
            long unfinished = task(db, status);
            expectFailure(409, () -> Tasks.updateTask(db, dispatcher, unfinished, Map.of("status", "done")));
            if (status.equals("work")) {
                expectFailure(409, () -> Tasks.updateTask(db, dispatcher, unfinished, Map.of("status", "review")));
                long unfinishedPhoto = photo(db, unfinished, "before");
                expectFailure(409, () -> Media.reject(db, dispatcher, unfinished, unfinishedPhoto,
                    Map.of("reason", "Report not submitted")));
            }
            check(status.equals(state(db, unfinished).get("status")), "Cannot accept " + status);
        }

        long managerTask = task(db, "review");
        Tasks.updateTask(db, manager, managerTask, Map.of("status", "done"));
        assertEvent(db, managerTask, "done", manager, "");
        long managerPhotoTask = task(db, "review");
        long managerPhoto = photo(db, managerPhotoTask, "after");
        Media.reject(db, manager, managerPhotoTask, managerPhoto, Map.of("reason", "Manager review"));
        check("rework".equals(state(db, managerPhotoTask).get("status")), "Manager review rights retained");
    }

    private static void cancelAndRepeat(Connection db) throws Exception {
        long cancelled = task(db, "assigned");
        Tasks.updateTask(db, dispatcher, cancelled,
            Map.of("status", "cancelled", "cancelReason", "Ошибка в заявке"));
        assertEvent(db, cancelled, "cancelled", dispatcher, "Ошибка в заявке");
        long original = task(db, "done");
        var repeat = Tasks.repeatTask(db, dispatcher, original, Map.of("reason", "Новый выезд"));
        check(repeat.containsKey("task"), "Dispatcher can create linked repeat");
        check("done".equals(state(db, original).get("status")), "Repeat preserves accepted original");
        expectFailure(409, () -> Tasks.repeatTask(db, dispatcher, original, Map.of()));
        long managerRepeat = task(db, "done");
        expectFailure(403, () -> Tasks.repeatTask(db, manager, managerRepeat, Map.of()));
    }

    public static void main(String[] args) throws Exception {
        if (System.getenv("QWORK_DB") == null || !System.getenv().getOrDefault("QWORK_DATABASE_URL", "").isEmpty()) {
            throw new IllegalStateException("Run through test-dispatcher-review.sh using its disposable database.");
        }
        Db.initialize();
        try (var db = Db.connect(true)) {
            company = Db.insert(db, "INSERT INTO companies(code, name) VALUES ('review-test', 'Review test')");
            long other = Db.insert(db, "INSERT INTO companies(code, name) VALUES ('other-review-test', 'Other')");
            dispatcher = user(db, company, "dispatcher");
            manager = user(db, company, "manager");
            employee = user(db, company, "employee");
            outsider = user(db, other, "dispatcher");
            accept(db);
            rework(db);
            rejectPhotos(db);
            permissionsAndStates(db);
            cancelAndRepeat(db);
            db.commit();
        }
        System.out.println("PASS dispatcher acceptance, rework, photo rejection, history, tenant isolation, "
            + "employee restrictions, manager review, revision checks, cancellation and linked repeat");
    }
}
