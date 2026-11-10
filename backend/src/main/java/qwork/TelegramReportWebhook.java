package qwork;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectReader;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.SQLException;
import java.time.Instant;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

final class TelegramReportWebhook implements AutoCloseable {
    static final String UPDATE_PATH = "/telegram/webhook";
    private static final int MAX_UPDATE_BYTES = 1_048_576;
    private static final int BATCH_SIZE = 25;
    private static final int RETRY_LIMIT = 5;
    private static final int REMINDER_RETRY_SECONDS = 60;
    private static final String SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
    private static final ObjectReader UPDATE_JSON = Db.JSON.reader()
        .with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    private final HttpServer server;
    private final ThreadPoolExecutor requests = new ThreadPoolExecutor(
        4, 4, 0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(32));
    private final ScheduledThreadPoolExecutor worker = new ScheduledThreadPoolExecutor(1);
    private final byte[] secret;
    private final Stores stores;
    private final TelegramReportCatalog catalog;
    private final TelegramReportApi api;
    private final TelegramReportDeadlineMenu deadlineMenu;
    private final boolean remindersEnabled;
    private Thread commandMenuSetup;
    private ScheduledFuture<?> reminderWake;
    private long reminderWakeAt = Long.MAX_VALUE;
    private long reminderRetryAt;
    private boolean scheduled;
    private boolean requested;
    private boolean closed;
    private int failures;

    private TelegramReportWebhook(InetSocketAddress address, String secret, TelegramReportCatalog catalog,
                                  TelegramReportApi api, Stores stores) throws IOException {
        this.secret = validateSecret(secret).getBytes(StandardCharsets.UTF_8);
        this.catalog = catalog;
        this.api = api;
        this.deadlineMenu = new TelegramReportDeadlineMenu(catalog, api);
        this.stores = stores;
        remindersEnabled = catalog.assignments().values().stream().anyMatch(sites -> !sites.isEmpty());
        worker.setRemoveOnCancelPolicy(true);
        server = HttpServer.create(address, 32);
        server.createContext("/health", this::health);
        server.createContext(UPDATE_PATH, this::receive);
        server.setExecutor(requests);
    }

    public static void main(String[] args) {
        try {
            int port = port(System.getenv().getOrDefault("PORT", "10000"));
            String secret = validateSecret(System.getenv("QWORK_TELEGRAM_WEBHOOK_SECRET"));
            String databaseUrl = System.getenv(TelegramReportStore.POSTGRES_ENV);
            if (databaseUrl == null || databaseUrl.isBlank()) {
                throw new IllegalArgumentException("Укажите QWORK_TELEGRAM_DATABASE_URL для webhook.");
            }
            String configJson = System.getenv("QWORK_TELEGRAM_CONFIG_JSON");
            var catalog = configJson == null ? TelegramReportCatalog.load(Path.of(System.getenv().getOrDefault(
                "QWORK_TELEGRAM_CONFIG", "data/telegram-reports.json"))) : TelegramReportCatalog.parse(configJson);
            TelegramReportStore.initializePostgres(databaseUrl);
            var api = new TelegramReportApi(System.getenv("QWORK_TELEGRAM_BOT_TOKEN"));
            var app = start(new InetSocketAddress("0.0.0.0", port), secret, catalog, api,
                () -> new TelegramReportStore(databaseUrl));
            Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                app.close();
                api.close();
            }));
            System.out.println("TMS Report: webhook готов к приёму сообщений.");
        } catch (IllegalArgumentException configuration) {
            System.err.println(configuration.getMessage());
            System.exit(1);
        } catch (Exception failure) {
            System.err.println("TMS Report: не удалось запустить webhook (" + failure.getClass().getSimpleName() + ").");
            System.exit(1);
        }
    }

    static TelegramReportWebhook start(InetSocketAddress address, String secret, TelegramReportCatalog catalog,
                                       TelegramReportApi api, Stores stores) throws IOException {
        var app = new TelegramReportWebhook(address, secret, catalog, api, stores);
        app.server.start();
        if (app.remindersEnabled) app.armReminder(Instant.now().getEpochSecond() + REMINDER_RETRY_SECONDS);
        app.wake();
        app.commandMenuSetup = TelegramReports.startCommandMenuSetup(catalog, api);
        return app;
    }

    int port() {
        return server.getAddress().getPort();
    }

    @FunctionalInterface
    interface Stores {
        TelegramReportStore open() throws IOException, SQLException;
    }

    private void health(HttpExchange exchange) throws IOException {
        try (exchange) {
            if (matches(exchange, "/health", "GET")) exchange.sendResponseHeaders(200, -1);
        }
    }

    private void receive(HttpExchange exchange) throws IOException {
        try (exchange) {
            if (!matches(exchange, UPDATE_PATH, "POST")) return;
            var headers = exchange.getRequestHeaders().get(SECRET_HEADER);
            if (headers == null || headers.size() != 1
                    || !MessageDigest.isEqual(secret, headers.getFirst().getBytes(StandardCharsets.UTF_8))) {
                exchange.sendResponseHeaders(403, -1);
                return;
            }
            byte[] body = exchange.getRequestBody().readNBytes(MAX_UPDATE_BYTES + 1);
            if (body.length > MAX_UPDATE_BYTES) {
                exchange.sendResponseHeaders(413, -1);
                return;
            }
            JsonNode update;
            try {
                update = UPDATE_JSON.readTree(body);
            } catch (IOException invalid) {
                exchange.sendResponseHeaders(400, -1);
                return;
            }
            if (update == null || !update.isObject() || !update.path("update_id").isIntegralNumber()
                    || !update.path("update_id").canConvertToLong() || update.path("update_id").longValue() <= 0) {
                exchange.sendResponseHeaders(400, -1);
                return;
            }
            try (var store = stores.open()) {
                store.enqueueWebhookUpdate(update.path("update_id").longValue(), update.toString());
            } catch (SQLException | IOException failure) {
                System.err.println("TMS Report: не удалось сохранить обновление webhook.");
                exchange.sendResponseHeaders(503, -1);
                return;
            }
            wake();
            exchange.sendResponseHeaders(204, -1);
        }
    }

    private static boolean matches(HttpExchange exchange, String path, String method) throws IOException {
        if (!path.equals(exchange.getRequestURI().getRawPath())) {
            exchange.sendResponseHeaders(404, -1);
            return false;
        }
        if (!method.equals(exchange.getRequestMethod())) {
            exchange.getResponseHeaders().set("Allow", method);
            exchange.sendResponseHeaders(405, -1);
            return false;
        }
        return true;
    }

    private synchronized void wake() {
        if (closed) return;
        requested = true;
        if (!scheduled) {
            failures = 0;
            schedule(0);
        }
    }

    private void drain() {
        synchronized (this) {
            if (closed) return;
            requested = false;
        }
        try {
            finish(drainBatch(), false, 0);
        } catch (InterruptedException stopping) {
            Thread.currentThread().interrupt();
        } catch (TelegramReportApi.ApiFailure failure) {
            System.err.println("TMS Report: обработка webhook отложена (Telegram " + failure.status() + ").");
            finish(false, true, failure.retryAfterSeconds());
        } catch (Exception failure) {
            System.err.println("TMS Report: обработка webhook отложена (" + failure.getClass().getSimpleName() + ").");
            finish(false, true, 0);
        }
    }

    private boolean drainBatch() throws Exception {
        try (var store = stores.open()) {
            if (!store.acquireWebhookWorker()) throw new IOException("Другой экземпляр обрабатывает очередь.");
            var bot = new TelegramReports(catalog, store, api, deadlineMenu);
            int count = 0;
            while (count < BATCH_SIZE) {
                var pending = store.pendingWebhookUpdate();
                if (pending == null) break;
                try {
                    bot.handle(UPDATE_JSON.readTree(pending.payload()));
                } catch (TelegramReportApi.ApiFailure failure) {
                    if (!TelegramReports.rejected(failure)) throw failure;
                }
                store.completeWebhookUpdate(pending.id());
                count++;
            }
            if (count < BATCH_SIZE && remindersEnabled) checkReminders(bot);
            bot.deliver();
            return count == BATCH_SIZE;
        }
    }

    private void checkReminders(TelegramReports bot) throws InterruptedException {
        long now = Instant.now().getEpochSecond();
        if (now < reminderRetryAt) return;
        try {
            long next = bot.nextReminderAt();
            if (next <= now) {
                bot.sendDueReminders(now);
                next = bot.nextReminderAt();
            }
            armReminder(next);
        } catch (InterruptedException stopping) {
            throw stopping;
        } catch (TelegramReportApi.ApiFailure failure) {
            System.err.println("TMS Report: напоминания отложены (Telegram " + failure.status() + ").");
            postponeReminders(failure.status() == 429
                ? Math.max(2, failure.retryAfterSeconds()) : REMINDER_RETRY_SECONDS);
        } catch (Exception failure) {
            System.err.println("TMS Report: напоминания отложены (" + failure.getClass().getSimpleName() + ").");
            postponeReminders(REMINDER_RETRY_SECONDS);
        }
    }

    private void postponeReminders(int seconds) {
        reminderRetryAt = Instant.now().getEpochSecond() + seconds;
        armReminder(reminderRetryAt);
    }

    private synchronized void armReminder(long at) {
        if (closed || at == reminderWakeAt) return;
        if (reminderWake != null) reminderWake.cancel(false);
        reminderWakeAt = at;
        reminderWake = at == Long.MAX_VALUE ? null : worker.schedule(this::wakeForReminders,
            Math.max(1, at - Instant.now().getEpochSecond()), TimeUnit.SECONDS);
    }

    private synchronized void wakeForReminders() {
        reminderWake = null;
        reminderWakeAt = Long.MAX_VALUE;
        // Preserve a wake if draining fails before the next deadline can be loaded.
        armReminder(Instant.now().getEpochSecond() + REMINDER_RETRY_SECONDS);
        wake();
    }

    private synchronized void finish(boolean more, boolean failed, int retryAfter) {
        if (closed) return;
        if (failed) {
            failures++;
            if (failures <= RETRY_LIMIT) {
                schedule(Math.max(1L << failures, retryAfter));
                return;
            }
            if (requested) {
                failures = 0;
                schedule(Math.max(2, retryAfter));
                return;
            }
        } else {
            failures = 0;
            if (more || requested) {
                schedule(0);
                return;
            }
        }
        scheduled = false;
    }

    private void schedule(long seconds) {
        scheduled = true;
        worker.schedule(this::drain, seconds, TimeUnit.SECONDS);
    }

    private static String validateSecret(String secret) {
        if (secret == null || !secret.matches("[A-Za-z0-9_-]{1,256}")) {
            throw new IllegalArgumentException("Укажите корректный QWORK_TELEGRAM_WEBHOOK_SECRET.");
        }
        return secret;
    }

    private static int port(String configured) {
        try {
            int value = Integer.parseInt(configured);
            if (value > 0 && value <= 65_535) return value;
        } catch (NumberFormatException ignored) {
            // Report the setting name rather than its contents.
        }
        throw new IllegalArgumentException("Проверьте PORT для webhook.");
    }

    @Override
    public void close() {
        synchronized (this) {
            closed = true;
        }
        server.stop(1);
        commandMenuSetup.interrupt();
        requests.shutdownNow();
        worker.shutdownNow();
    }
}
