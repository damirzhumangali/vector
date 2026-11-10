package qwork;

import com.fasterxml.jackson.databind.JsonNode;

import java.io.IOException;
import java.nio.file.Path;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

final class TelegramReports {
    private static final int MAX_DOCUMENTS = 5;
    private static final int MAX_RESULT_LENGTH = 1_500;
    private static final int MAX_REASON_LENGTH = 500;
    private static final int SITE_CHOICES = 8;
    private static final ZoneId ZONE = ZoneId.of("Asia/Almaty");
    private static final DateTimeFormatter DATE = DateTimeFormatter.ofPattern("dd.MM.uuuu HH:mm XXX");
    private static final List<List<Map<String, String>>> MENU = List.of(List.of(button("Добавить отчёт", "new")));

    private final TelegramReportCatalog catalog;
    private final TelegramReportStore store;
    private final TelegramReportApi api;

    TelegramReports(TelegramReportCatalog catalog, TelegramReportStore store, TelegramReportApi api) {
        this.catalog = catalog;
        this.store = store;
        this.api = api;
    }

    public static void main(String[] args) {
        try {
            if (args.length == 1 && args[0].equals("--ids")) {
                try (var api = new TelegramReportApi(System.getenv("QWORK_TELEGRAM_BOT_TOKEN"))) {
                    printSetupIds(api.updates(0));
                }
                return;
            }
            if (args.length != 0) throw new IllegalArgumentException("Допустимый параметр: --ids.");
            var config = TelegramReportCatalog.load(Path.of(System.getenv().getOrDefault(
                "QWORK_TELEGRAM_CONFIG", "data/telegram-reports.json")));
            try (var api = new TelegramReportApi(System.getenv("QWORK_TELEGRAM_BOT_TOKEN"));
                 var store = new TelegramReportStore(Path.of(System.getenv().getOrDefault(
                     "QWORK_TELEGRAM_DB", "data/telegram-reports.sqlite3")))) {
                System.out.println("TMS Report: ожидание сообщений Telegram.");
                new TelegramReports(config, store, api).run();
            }
        } catch (InterruptedException stop) {
            Thread.currentThread().interrupt();
        } catch (IllegalArgumentException configuration) {
            System.err.println(configuration.getMessage());
            System.exit(1);
        } catch (TelegramReportApi.ApiFailure error) {
            System.err.println(error.getMessage());
            System.exit(1);
        } catch (Exception error) {
            System.err.println("TMS Report не запущен или остановился: " + error.getClass().getSimpleName());
            System.exit(1);
        }
    }

    private static void printSetupIds(List<JsonNode> updates) {
        boolean found = false;
        for (var update : updates) {
            var message = update.path("message");
            if (!message.path("text").asText().matches("/id(@[A-Za-z0-9_]+)?")) continue;
            long id = message.path("chat").path("id").asLong();
            if (id == 0) continue;
            System.out.println((id < 0 ? "Чат проверки: " : "Telegram ID инженера: ") + id);
            found = true;
        }
        if (!found) System.out.println("Запросов /id пока нет. Отправьте команду в личном чате с ботом или /id@имя_бота в группе.");
    }

    private void run() throws Exception {
        while (!Thread.currentThread().isInterrupted()) {
            try {
                deliver();
                var updates = new ArrayList<>(api.updates(store.offset()));
                if (updates.isEmpty()) {
                    // Telegram has acknowledged the offset and may restart numbering after a week of inactivity.
                    if (store.offset() != 0) store.resetOffset();
                    continue;
                }
                updates.sort(Comparator.comparingLong(update -> update.path("update_id").asLong()));
                for (var update : updates) {
                    long id = update.path("update_id").asLong(-1);
                    if (id < store.offset()) continue;
                    try {
                        handle(update);
                    } catch (TelegramReportApi.ApiFailure error) {
                        // A user can delete a message or block the bot before it replies.
                        if (!rejected(error)) throw error;
                    }
                    store.advance(id + 1);
                    deliver();
                }
            } catch (TelegramReportApi.ApiFailure error) {
                if (error.status() == 401 || error.status() == 409) {
                    throw new IllegalArgumentException(error.status() == 401
                        ? "Telegram отклонил токен бота. Проверьте QWORK_TELEGRAM_BOT_TOKEN."
                        : "Этот бот уже получает обновления в другом процессе или через вебхук.");
                }
                System.err.println(error.getMessage());
                Thread.sleep(Math.max(2L, error.retryAfterSeconds()) * 1_000L);
            } catch (IOException error) {
                System.err.println("TMS Report: повтор подключения к Telegram.");
                Thread.sleep(3_000L);
            }
        }
    }

    void handle(JsonNode update) throws Exception {
        var callback = update.path("callback_query");
        var message = callback.isObject() ? callback.path("message") : update.path("message");
        var chat = message.path("chat");
        long engineer = (callback.isObject() ? callback : message).path("from").path("id").asLong();
        if (engineer <= 0) return;
        long chatId = chat.path("id").asLong();
        String chatType = chat.path("type").asText();
        if (chatId == catalog.reviewChatId() && ("group".equals(chatType) || "supergroup".equals(chatType))) {
            handleReview(engineer, callback, message);
            return;
        }
        if (!"private".equals(chatType) || chatId != engineer) return;

        String text = message.path("text").asText("").strip();
        if ("/id".equals(text) && !callback.isObject()) {
            reply(engineer, "Ваш Telegram ID: " + engineer + ". Его можно передать администратору для доступа.");
            return;
        }
        if (!catalog.engineers().containsKey(engineer)) {
            if ("/start".equals(text) || "/help".equals(text)) {
                if (catalog.reviewers().containsKey(engineer)) {
                    reply(engineer, "Проверяйте отчёты в группе проверки. Нажмите «Принять» или «На доработку». "
                        + "Для доработки ответьте на сообщение бота с просьбой указать причину.");
                } else if ("/start".equals(text)) {
                    reply(engineer, "Попросите администратора добавить вас в список инженеров. Узнать свой ID: /id.");
                }
            }
            return;
        }

        var draft = store.draft(engineer);
        if (callback.isObject()) {
            answer(callback, null);
            String action = callback.path("data").asText();
            if (action.equals("new")) start(engineer, draft);
            else if (draft != null && draft.after() != null && action.equals(sendAction(draft))) {
                submit(engineer, draft, update.path("update_id").asLong());
            } else if (action.startsWith("site:")) {
                choose(engineer, draft, action.substring(5));
            } else if (action.startsWith("sites:") && draft != null && draft.siteId() == null) {
                showSites(engineer, "", positiveId(action.substring(6)));
            } else if (action.startsWith("revise:")) {
                revise(engineer, draft, action.substring(7));
            }
            return;
        }

        switch (text) {
            case "/start", "/new" -> start(engineer, draft);
            case "/help" -> {
                if (draft == null) api.send(engineer, "TMS Report — отчёты по обслуживанию СКУД. Выберите объект, "
                    + "отправьте видео после работ и опишите результат.\n\n"
                    + "К незавершённому отчёту можно вернуться командой /start.", MENU);
                else prompt(draft);
            }
            case "/cancel" -> {
                if (draft != null) store.clear(engineer);
                api.send(engineer, draft == null ? "У вас нет черновика." : "Черновик отменён.", MENU);
            }
            case "/send" -> submit(engineer, draft, update.path("update_id").asLong());
            case "/sites" -> {
                if (draft == null || draft.siteId() == null) start(engineer, draft);
                else prompt(draft);
            }
            default -> {
                if (text.startsWith("/")) reply(engineer, "Доступные команды: /start, /new, /cancel, /id.");
                else if (draft == null) api.send(engineer, "Нажмите «Добавить отчёт», чтобы начать.", MENU);
                else accept(draft, message, text);
            }
        }
    }

    private void handleReview(long reviewerId, JsonNode callback, JsonNode message) throws Exception {
        String reviewer = catalog.reviewers().get(reviewerId);
        if (callback.isObject()) {
            String[] action = callback.path("data").asText().split(":", -1);
            if (action.length != 3 || !"review".equals(action[0])
                    || (!"a".equals(action[1]) && !"r".equals(action[1]))) return;
            if (reviewer == null) {
                answer(callback, "Проверять отчёты могут назначенные руководители.");
                return;
            }
            var review = store.review(positiveId(action[2]));
            long messageId = message.path("message_id").asLong();
            if (review == null || !review.open() || review.chatId() != catalog.reviewChatId()
                    || review.summaryMessage() != messageId) {
                answer(callback, "Эта версия отчёта уже закрыта или недоступна.");
                return;
            }
            if ("a".equals(action[1])) {
                store.decide(review, reviewerId, reviewer, currentTime(), null);
                answer(callback, "Отчёт принят.");
            } else {
                answer(callback, null);
                long prompt = api.requestReply(review.chatId(), review.number().label() + "\n" + reviewer
                    + ", ответьте на это сообщение и напишите, что нужно исправить.");
                store.saveReviewPrompt(review.deliveryId(), reviewerId, prompt);
            }
            return;
        }

        if (reviewer == null || !message.path("reply_to_message").isObject()) return;
        long replyTo = message.path("reply_to_message").path("message_id").asLong();
        var review = store.reviewForReply(catalog.reviewChatId(), reviewerId, replyTo);
        if (review == null || !review.open()) return;
        String reason = message.path("text").asText("").strip();
        if (reason.isEmpty() || reason.startsWith("/") || reason.length() > MAX_REASON_LENGTH) {
            reply(review.chatId(), "Ответьте на исходное сообщение бота и укажите причину доработки текстом до "
                + MAX_REASON_LENGTH + " символов.");
            return;
        }
        store.decide(review, reviewerId, reviewer, currentTime(), reason);
    }

    private void revise(long engineer, TelegramReportStore.Draft draft, String action) throws Exception {
        String[] parts = action.split(":", -1);
        boolean replaceMaterials = parts.length == 2 && "materials".equals(parts[1]);
        if (parts.length != 1 && !replaceMaterials) return;
        long deliveryId = positiveId(parts[0]);
        var review = store.review(deliveryId);
        if (review == null || review.engineerId() != engineer || !review.current() || !"rework".equals(review.decision())
                || catalog.site(engineer, review.siteId()) == null) {
            reply(engineer, "Эта версия отчёта уже закрыта или недоступна.");
            return;
        }
        if (draft != null) {
            if (Long.valueOf(deliveryId).equals(store.revisionSource(engineer))) prompt(draft);
            else reply(engineer, "Сначала завершите текущий черновик или отмените его командой /cancel.");
            return;
        }
        prompt(store.startRevision(review, replaceMaterials));
    }

    private void answer(JsonNode callback, String text) throws IOException, InterruptedException {
        String id = callback.path("id").asText();
        try {
            if (text == null) api.answer(id);
            else api.answer(id, text);
        } catch (TelegramReportApi.ApiFailure error) {
            if (!rejected(error)) throw error;
        }
    }

    private static long positiveId(String value) {
        try {
            return Math.max(0, Long.parseLong(value));
        } catch (NumberFormatException invalid) {
            return 0;
        }
    }

    private void start(long engineer, TelegramReportStore.Draft draft) throws Exception {
        if (draft == null) {
            if (catalog.search(engineer, "").isEmpty()) {
                showSites(engineer, "", 0);
                return;
            }
            draft = new TelegramReportStore.Draft(engineer, null, null, null, null, List.of());
            store.save(draft);
        }
        prompt(draft);
    }

    private void showSites(long engineer, String query, long page) throws Exception {
        String heading = "1 из 4 · Выберите свой объект";
        var sites = catalog.search(engineer, query);
        if (sites.isEmpty()) {
            reply(engineer, query.isBlank() || catalog.search(engineer, "").isEmpty()
                ? "Вам пока не назначили объекты. Обратитесь к администратору."
                : heading + "\nСреди ваших объектов совпадений нет. Введите часть названия или региона. "
                    + "Команда /sites снова откроет ваш список.");
            return;
        }
        int lastPage = (sites.size() - 1) / SITE_CHOICES;
        int currentPage = (int) Math.min(page, lastPage);
        int firstSite = currentPage * SITE_CHOICES;
        var keys = new ArrayList<List<Map<String, String>>>();
        sites.stream().skip(firstSite).limit(SITE_CHOICES)
            .forEach(site -> keys.add(List.of(button(site.label(), "site:" + site.id()))));
        if (lastPage > 0) {
            heading += "\nВведите часть названия или региона, чтобы сузить список.";
            if (query.isBlank()) {
                var navigation = new ArrayList<Map<String, String>>();
                if (currentPage > 0) navigation.add(button("‹ Назад", "sites:" + (currentPage - 1)));
                if (currentPage < lastPage) navigation.add(button("Далее ›", "sites:" + (currentPage + 1)));
                keys.add(navigation);
                heading += "\nСтраница " + (currentPage + 1) + " из " + (lastPage + 1) + ".";
            }
        }
        api.send(engineer, heading, keys);
    }

    private void choose(long engineer, TelegramReportStore.Draft draft, String siteId) throws Exception {
        if (draft == null || draft.siteId() != null) return;
        var site = catalog.site(engineer, siteId);
        if (site == null) {
            showSites(engineer, "", 0);
            return;
        }
        var selected = new TelegramReportStore.Draft(engineer, site.id(), null, null, null, List.of());
        store.save(selected);
        prompt(selected);
    }

    private void prompt(TelegramReportStore.Draft draft) throws Exception {
        if (!assigned(draft)) return;
        if (draft.siteId() == null) showSites(draft.engineerId(), "", 0);
        else if (draft.after() == null) promptVideo(draft, "");
        else if (draft.result() == null) reply(draft.engineerId(), "3 из 4 · Опишите результат\n"
            + "Видео после работ получено. Напишите, что сделали и что проверили.\n\n"
            + "Например: «Заменили считыватель. Проверили проход по карте».");
        else preview(draft);
    }

    private void promptVideo(TelegramReportStore.Draft draft, String feedback) throws Exception {
        reply(draft.engineerId(), "2 из 4 · Видео после работ\nОбъект: " + siteLabel(draft.siteId()) + "\n" + feedback
            + "Пришлите одно видео после работ. Покажите, как работает система после обслуживания.");
    }

    private void accept(TelegramReportStore.Draft draft, JsonNode message, String text) throws Exception {
        long engineer = draft.engineerId();
        if (!assigned(draft)) return;
        if (draft.siteId() == null) {
            showSites(engineer, text, 0);
            return;
        }
        long messageId = message.path("message_id").asLong();
        if (messageId <= 0 || Long.valueOf(messageId).equals(draft.before())
            || Long.valueOf(messageId).equals(draft.after()) || draft.documents().contains(messageId)) return;

        boolean video = message.path("video").isObject()
            || message.path("document").path("mime_type").asText().startsWith("video/");
        if (draft.after() == null) {
            if (message.hasNonNull("media_group_id")) {
                promptVideo(draft, "Отправьте видео отдельным сообщением.\n");
                return;
            }
            if (!video) {
                promptVideo(draft, "На этом шаге нужен видеоролик.\n");
                return;
            }
            draft = new TelegramReportStore.Draft(engineer, draft.siteId(), draft.before(), messageId, null, draft.documents());
            store.save(draft);
        } else if (draft.result() == null) {
            if (text.length() > MAX_RESULT_LENGTH) {
                reply(engineer, "Сократите результат до " + MAX_RESULT_LENGTH + " символов.");
                return;
            }
            if (!text.isEmpty()) {
                draft = new TelegramReportStore.Draft(engineer, draft.siteId(), draft.before(), draft.after(), text, draft.documents());
                store.save(draft);
            }
        } else if (video) {
            reply(engineer, "Видео после работ уже сохранено. К отчёту можно добавить фото или документы.");
            return;
        } else if (message.path("document").isObject() || message.path("photo").isArray()) {
            if (draft.documents().size() >= MAX_DOCUMENTS) {
                reply(engineer, "Достигнут предел дополнительных вложений: " + MAX_DOCUMENTS + ".");
            } else {
                var docs = new ArrayList<>(draft.documents());
                docs.add(messageId);
                draft = new TelegramReportStore.Draft(engineer, draft.siteId(), draft.before(), draft.after(), draft.result(), docs);
                store.save(draft);
            }
        }
        prompt(draft);
    }

    private void preview(TelegramReportStore.Draft draft) throws Exception {
        String savedBefore = draft.before() == null ? "" : "✓ Видео до работ (сохранено ранее)\n";
        api.send(draft.engineerId(), "4 из 4 · Проверьте отчёт\n\n" + summary(draft)
            + "\n\n" + savedBefore + "✓ Видео после работ\nДополнительных вложений: "
            + draft.documents().size() + " из " + MAX_DOCUMENTS
            + "\n\nМожно добавить фото или документы. Кнопка «Отправить отчёт» передаст материалы в чат проверки.",
            List.of(List.of(button("Отправить отчёт", sendAction(draft)))));
    }

    private String sendAction(TelegramReportStore.Draft draft) throws Exception {
        Long source = store.revisionSource(draft.engineerId());
        return "send:" + (source == null ? "" : source + ":") + draft.after();
    }

    private String summary(TelegramReportStore.Draft draft) {
        return "Объект: " + siteLabel(draft.siteId())
            + "\nИнженер: " + catalog.engineers().get(draft.engineerId())
            + "\n\nРезультат: " + draft.result();
    }

    private String siteLabel(String siteId) {
        var site = catalog.site(siteId);
        return site == null ? siteId : site.label();
    }

    private boolean assigned(TelegramReportStore.Draft draft) throws Exception {
        if (draft.siteId() == null || catalog.site(draft.engineerId(), draft.siteId()) != null) return true;
        reply(draft.engineerId(), "Объект этого черновика больше не назначен вам. Обратитесь к администратору "
            + "или отмените черновик командой /cancel, чтобы выбрать другой объект.");
        return false;
    }

    private void submit(long engineer, TelegramReportStore.Draft draft, long updateId) throws Exception {
        if (draft == null) {
            api.send(engineer, "У вас нет открытого черновика.", MENU);
            return;
        }
        if (!assigned(draft)) return;
        if (draft.siteId() == null || draft.after() == null || draft.result() == null) {
            prompt(draft);
            return;
        }
        String created = currentTime();
        var number = store.queue(draft, catalog.reviewChatId(), summary(draft) + "\n\nОтправлено: " + created, created, updateId);
        reply(engineer, number.label() + " принят к отправке. Бот сообщит, когда материалы появятся в чате проверки.");
    }

    private static String currentTime() {
        return DATE.format(ZonedDateTime.now(ZONE));
    }

    void deliver() throws Exception {
        TelegramReportStore.Report report;
        while ((report = store.pending()) != null) {
            int index = report.nextIndex();
            int afterIndex = report.before() == null ? 0 : 1;
            int last = report.documents().size() + afterIndex + 1;
            String label = report.number().label();
            Long summaryMessage = null;
            try {
                if (index == last) {
                    boolean reviewEnabled = !catalog.reviewers().isEmpty() && report.archiveChatId() == catalog.reviewChatId()
                        && store.review(report.id()) != null;
                    var actions = reviewEnabled ? List.of(List.of(button("Принять", "review:a:" + report.id()),
                        button("На доработку", "review:r:" + report.id()))) : List.<List<Map<String, String>>>of();
                    long messageId = api.send(report.archiveChatId(), label + "\n" + report.header(), actions);
                    if (reviewEnabled) {
                        if (messageId <= 0) throw new IOException("Telegram не вернул номер отчёта для проверки.");
                        summaryMessage = messageId;
                    }
                } else {
                    long messageId;
                    String caption;
                    if (index < afterIndex) {
                        messageId = report.before();
                        caption = "Видео до";
                    } else if (index == afterIndex) {
                        messageId = report.after();
                        caption = "Видео после";
                    } else {
                        messageId = report.documents().get(index - afterIndex - 1);
                        caption = "Вложение " + (index - afterIndex);
                    }
                    api.copy(report.archiveChatId(), report.engineerId(), messageId, label + " · " + caption);
                }
            } catch (TelegramReportApi.ApiFailure error) {
                if (!rejected(error)) throw error;
                store.fail(report.id());
                deliveryNotice(report.engineerId(), label + " не удалось доставить в чат проверки. Сообщите администратору номер отчёта.");
                continue;
            }
            store.delivered(report.id(), index + 1, summaryMessage);
            if (index == last) deliveryNotice(report.engineerId(), label + " и его материалы доставлены в чат проверки.");
        }
        deliverReviewNotices();
    }

    private void deliverReviewNotices() throws Exception {
        TelegramReportStore.Review review;
        while ((review = store.pendingNotice()) != null) {
            boolean accepted = "accepted".equals(review.decision());
            String decision = (accepted ? "Принято" : "На доработку") + " · " + review.reviewer() + " · "
                + review.decidedAt() + (accepted ? "" : "\nПричина: " + review.reason());
            try {
                if (review.noticeStep() == 0) {
                    api.edit(review.chatId(), review.summaryMessage(), review.number().label() + "\n"
                        + review.header() + "\n\n" + decision);
                } else {
                    var actions = accepted ? MENU : List.of(
                        List.of(button("Исправить текст", "revise:" + review.deliveryId())),
                        List.of(button("Заменить материалы", "revise:" + review.deliveryId() + ":materials")));
                    api.send(review.engineerId(), review.number().label() + "\n" + decision, actions);
                }
            } catch (TelegramReportApi.ApiFailure error) {
                if (!rejected(error)) throw error;
                System.err.println("TMS Report: не удалось отправить результат проверки в Telegram.");
            }
            store.advanceNotice(review.deliveryId(), review.noticeStep() + 1);
        }
    }

    private void deliveryNotice(long engineer, String message) throws InterruptedException {
        try {
            api.send(engineer, message, MENU);
        } catch (IOException error) {
            System.err.println("TMS Report: уведомление инженеру не доставлено.");
        }
    }

    private void reply(long engineer, String text) throws IOException, InterruptedException {
        api.send(engineer, text, List.of());
    }

    static boolean rejected(TelegramReportApi.ApiFailure error) {
        return error.status() == 400 || error.status() == 403;
    }

    private static Map<String, String> button(String label, String action) {
        return Map.of("text", label, "callback_data", action);
    }
}
