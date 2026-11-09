package qwork;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;

final class TelegramReportPostgresCheck {
    private static final long ENGINEER = 4_100_000_001L;
    private static final long REVIEW_CHAT = -1_004_000_000_001L;
    private static final long REVIEWER = 4_100_000_002L;
    private static final long FIRST_UPDATE = 4_500_000_001L;
    private static final String SENT = "06.11.2026 15:00 +05:00";
    private static final TelegramReportStore.Draft DRAFT =
        new TelegramReportStore.Draft(ENGINEER, "north", 10L, 11L, "Проверили вход", List.of(12L));

    public static void main(String[] args) throws Exception {
        String url = System.getenv("QWORK_TEST_TELEGRAM_POSTGRES_URL");
        if (url == null || url.isBlank()) throw new IllegalArgumentException("Set QWORK_TEST_TELEGRAM_POSTGRES_URL");
        String schema = "qwork_bot_test_" + UUID.randomUUID().toString().replace("-", "");
        String isolatedUrl = url + (url.contains("?") ? "&" : "?") + "currentSchema=" + schema;
        Path snapshot = Path.of(args[0]).resolve("telegram-snapshot.sqlite3");
        try (var admin = Db.openPostgres(url, "QWORK_TEST_TELEGRAM_POSTGRES_URL")) {
            Db.update(admin, "CREATE SCHEMA " + schema);
            try {
                seed(snapshot);
                byte[] original = Files.readAllBytes(snapshot);
                check(TelegramReportMigration.migrate(snapshot, isolatedUrl) == 1, "Report was not migrated");
                check(Arrays.equals(original, Files.readAllBytes(snapshot)), "Migration changed the SQLite snapshot");
                checkTarget(isolatedUrl);
                try {
                    TelegramReportMigration.migrate(snapshot, isolatedUrl);
                    throw new AssertionError("A second migration modified a populated target");
                } catch (IllegalStateException expected) {
                    // Refuse to overwrite an already-migrated database.
                }
            } finally {
                Db.update(admin, "DROP SCHEMA " + schema + " CASCADE");
            }
        }
        System.out.println("Telegram PostgreSQL migration, delivery and webhook inbox passed.");
    }

    private static void seed(Path snapshot) throws Exception {
        try (var source = new TelegramReportStore(snapshot)) {
            source.save(DRAFT);
            check(source.queue(DRAFT, REVIEW_CHAT, "Тестовый объект", SENT, FIRST_UPDATE).id() == 1,
                "Unexpected report number in fixture");
            for (int step = 1; step <= 4; step++) source.delivered(1, step, step == 4 ? 4_600_000_001L : null);
            var review = source.review(1);
            check(source.decide(review, REVIEWER, "Руководитель", SENT, "Добавьте подробности"),
                "Fixture decision was not saved");
            source.advanceNotice(1, 1);
            source.startRevision(source.review(1), false);
            source.enqueueWebhookUpdate(FIRST_UPDATE + 1, "{}");
        }
    }

    private static void checkTarget(String url) throws Exception {
        try (var worker = new TelegramReportStore(url); var ingress = new TelegramReportStore(url)) {
            check(worker.offset() == FIRST_UPDATE + 1, "Offset was not preserved");
            check(worker.draft(ENGINEER).documents().equals(DRAFT.documents()) && worker.revisionSource(ENGINEER) == 1L,
                "Draft and related report were not preserved");
            var review = worker.pendingNotice();
            check(review.chatId() == REVIEW_CHAT && review.noticeStep() == 1 && review.summaryMessage() == 4_600_000_001L
                    && "Добавьте подробности".equals(review.reason()), "Review decision was not preserved");
            check(worker.acquireWebhookWorker() && !ingress.acquireWebhookWorker(), "Two workers can process the same queue");
            check(ingress.enqueueWebhookUpdate(FIRST_UPDATE + 2, "{}"), "Ingress is blocked by the worker lock");
            check(worker.pendingWebhookUpdate().id() == FIRST_UPDATE + 1, "Queued updates are out of order");
            worker.completeWebhookUpdate(FIRST_UPDATE + 1);
            check(!ingress.enqueueWebhookUpdate(FIRST_UPDATE + 1, "{}"), "Processed update was accepted again");
            check(worker.pendingWebhookUpdate().id() == FIRST_UPDATE + 2, "Next update was lost");

            var updated = new TelegramReportStore.Draft(ENGINEER, "north", 10L, 11L, "Уточнили результат", List.of(12L));
            worker.save(updated);
            var revised = worker.queue(updated, REVIEW_CHAT, "Тестовый объект", SENT, FIRST_UPDATE + 2);
            check(revised.id() == 1 && revised.revision() == 2 && worker.pending().id() == 2,
                "Migration changed report numbering or identity continuation");
            worker.delivered(2, 1, null);
        }
        try (var restarted = new TelegramReportStore(url)) {
            check(restarted.acquireWebhookWorker() && restarted.pending().nextIndex() == 1,
                "Lock or delivery checkpoint did not survive reconnect correctly");
        }
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
