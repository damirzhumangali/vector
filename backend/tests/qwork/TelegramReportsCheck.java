package qwork;

import com.fasterxml.jackson.databind.JsonNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

final class TelegramReportsCheck {
    private static final String TOKEN = "123:fake-test-token";
    private static final long ENGINEER = 4_100_000_001L;
    private static final long STRANGER = 4_100_000_002L;
    private static final long REVIEWER = 4_100_000_003L;
    private static final long OTHER_REVIEWER = 4_100_000_004L;
    private static final long SECOND_ENGINEER = 4_100_000_005L;
    private static final long UNASSIGNED_ENGINEER = 4_100_000_006L;
    private static final long REVIEW_CHAT = -1_004_000_000_001L;
    private static final long WRONG_CHAT = -1_004_000_000_002L;
    private static final long AFTER = 16;
    private static final long DOCUMENT = 19;
    private static final String RESULT = "Проверили проход, заменили считыватель <СКУД>.";

    public static void main(String[] args) throws Exception {
        Path directory = Path.of(args[0]);
        Path configuration = Files.writeString(directory.resolve("telegram-reports.json"), """
            {
              "reviewChatId": %d,
              "engineers": [{"telegramId": %d, "name": "Тестовый инженер"},
                            {"telegramId": %d, "name": "Второй инженер"},
                            {"telegramId": %d, "name": "Инженер без объектов"}],
              "reviewers": [{"telegramId": %d, "name": "Первый руководитель"},
                            {"telegramId": %d, "name": "Второй руководитель"}],
              "sites": [{"id": "north", "name": "Северный объект", "region": "Астана"},
                        {"id": "south", "name": "Южный объект", "region": "Алматы"}],
              "assignments": {"%d": ["north"], "%d": ["south"]}
            }
            """.formatted(REVIEW_CHAT, ENGINEER, SECOND_ENGINEER, UNASSIGNED_ENGINEER, REVIEWER, OTHER_REVIEWER,
                ENGINEER, SECOND_ENGINEER));
        var catalog = TelegramReportCatalog.load(configuration);
        Path database = directory.resolve("telegram-reports.sqlite3");

        try (var telegram = new MockTelegram(); var api = new TelegramReportApi(TOKEN, telegram.uri())) {
            check(api.updates(42).isEmpty(), "Unexpected fake updates");
            var poll = telegram.calls.getFirst();
            check("getUpdates".equals(poll.method()) && poll.payload().path("offset").asLong() == 42,
                "Long polling omitted the saved offset");
            check(poll.payload().path("timeout").asInt() > 0, "Polling does not wait for updates");
            checkCommandMenus(catalog, api, telegram);

            try (var store = new TelegramReportStore(database)) {
                var bot = new TelegramReports(catalog, store, api);
                checkAccess(bot, telegram, store);
                queueReport(bot, telegram, store);

                try {
                    bot.deliver();
                    throw new AssertionError("Expected Telegram 500 during report summary");
                } catch (TelegramReportApi.ApiFailure failure) {
                    check(failure.status() == 500, "Temporary failure lost its status");
                    check(!failure.toString().contains(TOKEN) && !failure.toString().contains("private description"),
                        "Failure exposed credentials or Telegram response data");
                }
                check(store.pending().nextIndex() == 1, "First successful copy was not saved");
                check(telegram.reviewCalls().size() == 2, "Delivery continued after temporary failure");
            }

            try (var store = new TelegramReportStore(database)) {
                var restarted = new TelegramReports(catalog, store, api);
                check(store.offset() == AFTER + 1, "Video submission offset did not survive restart");
                restarted.deliver();
                restarted.deliver();
                check(store.pending() == null, "Report stayed in delivery queue");
                checkDelivery(telegram);
                checkReview(restarted, telegram, store);
                checkScopedObjects(restarted, telegram, store);
                checkDeadlines(restarted, telegram, store);
            }
            try (var store = new TelegramReportStore(database)) {
                int messages = telegram.messages(ENGINEER).size();
                new TelegramReports(catalog, store, api).sendDueReminders(Long.MAX_VALUE);
                check(telegram.messages(ENGINEER).size() == messages,
                    "Restart repeated an already sent deadline reminder");
            }
            try (var store = new TelegramReportStore(directory.resolve("legacy-video-draft.sqlite3"))) {
                checkLegacyVideoDraft(new TelegramReports(catalog, store, api), telegram, store);
            }
        }
        System.out.println("Telegram report workflow passed.");
    }

    private static void checkCommandMenus(TelegramReportCatalog catalog, TelegramReportApi api, MockTelegram telegram)
            throws Exception {
        var reviewers = new LinkedHashMap<>(catalog.reviewers());
        reviewers.put(ENGINEER, catalog.engineers().get(ENGINEER));
        var roles = new TelegramReportCatalog(catalog.reviewChatId(), catalog.engineers(), catalog.sites(),
            reviewers, catalog.assignments());
        TelegramReports.syncCommandMenus(roles, api);
        check("all_private_chats".equals(telegram.calls.get(1).payload().path("scope").path("type").asText())
            && telegram.menu(null).equals(List.of("start", "help", "id")), "Fallback menu exposed work commands");
        check(telegram.menu(SECOND_ENGINEER).equals(List.of("new", "cancel", "start", "help", "id")),
            "Engineer menu did not contain only its allowed work commands");
        check(telegram.menu(REVIEWER).equals(List.of("missing", "start", "help", "id")),
            "Reviewer menu did not contain only its allowed work commands");
        check(telegram.menu(ENGINEER).equals(List.of("new", "cancel", "missing", "start", "help", "id")),
            "An engineer who also reviews reports did not receive both sets of commands");
    }

    private static void checkAccess(TelegramReports bot, MockTelegram telegram, TelegramReportStore store) throws Exception {
        bot.handle(message(1, STRANGER, Map.of("text", "/start")));
        check(telegram.lastText(STRANGER).contains("список инженеров"), "Unauthorized user did not get access guidance");
        check(telegram.menu(STRANGER).equals(List.of("start", "help", "id")),
            "Start did not replace a potentially stale role-specific menu");
        int responses = telegram.calls.size();
        bot.handle(message(2, STRANGER, Map.of("text", "/new")));
        bot.handle(callback(3, STRANGER, "new"));
        bot.handle(message(4, ENGINEER, REVIEW_CHAT, "supergroup", Map.of("text", "/new")));
        check(telegram.calls.size() == responses, "Report actions were accepted outside the allowlist or private chat");
        check(store.draft(STRANGER) == null && store.draft(ENGINEER) == null, "Unauthorized action created a draft");
    }

    private static void queueReport(TelegramReports bot, MockTelegram telegram, TelegramReportStore store) throws Exception {
        telegram.failCommandsOnce.set(true);
        bot.handle(message(5, ENGINEER, Map.of("text", "/start")));
        check(buttons(telegram.lastMessage(ENGINEER)).equals(List.of("site:north"))
            && telegram.lastText(ENGINEER).contains("Выберите свой объект"),
            "Start did not list only the engineer's assigned object");
        bot.handle(message(6, ENGINEER, Map.of("text", "алматы")));
        check(buttons(telegram.lastMessage(ENGINEER)).isEmpty(), "Search revealed another engineer's object");
        bot.handle(message(7, ENGINEER, Map.of("text", "астана")));
        check("site:north".equals(telegram.lastButton(ENGINEER)), "Region search did not offer the configured object");
        bot.handle(callback(8, ENGINEER, "site:north"));
        check(telegram.lastText(ENGINEER).contains("Видео после работ")
            && telegram.lastText(ENGINEER).contains("Северный объект"), "Video prompt omitted the selected object");

        bot.handle(message(9, ENGINEER, Map.of("photo", List.of(Map.of("file_id", "photo")))));
        check(store.draft(ENGINEER).after() == null && telegram.lastText(ENGINEER).contains("нужен видеоролик")
            && telegram.lastText(ENGINEER).contains("видео после работ"), "A photo did not get a step-specific correction");
        bot.handle(message(10, ENGINEER, Map.of("text", "/send")));
        check(store.pending() == null && telegram.reviewCalls().isEmpty(), "An incomplete report reached the review chat");
        bot.handle(message(11, ENGINEER, Map.of("video", Map.of("file_id", "album-video"), "media_group_id", "album")));
        check(store.draft(ENGINEER).after() == null && telegram.lastText(ENGINEER).contains("отдельным сообщением"),
            "An album video was accepted or did not get upload instructions");

        var after = message(AFTER, ENGINEER, Map.of("document", Map.of("file_id", "after", "mime_type", "video/mp4")));
        bot.handle(after);
        var queued = store.pending();
        check(store.draft(ENGINEER) == null && queued != null && queued.after() == AFTER
            && queued.before() == null && queued.documents().isEmpty(),
            "Sending one video without a caption did not submit the report");
        bot.handle(after);
        check(store.pending().id() == queued.id() && store.review(queued.id() + 1) == null,
            "Retrying the video queued a second report");
        check(telegram.reviewCalls().isEmpty(), "Bot copied media before the delivery worker ran");
    }

    private static void checkDelivery(MockTelegram telegram) {
        var calls = telegram.reviewCalls();
        check(calls.size() == 3, "A report or video was lost or sent twice");
        checkCopy(calls.get(0), AFTER, 200, "Видео после");
        check("sendMessage".equals(calls.get(1).method()) && calls.get(1).status() == 500,
            "The simulated failure did not happen after the video copy");
        var summary = calls.get(2);
        check("sendMessage".equals(summary.method()) && summary.status() == 200, "Report summary was not delivered as text");
        String text = summary.payload().path("text").asText();
        check(text.contains("Отчёт №1") && text.contains("Северный объект") && text.contains("Тестовый инженер")
                && !text.contains("Результат:"), "Summary omitted report data or added an empty result");
        check(!summary.payload().has("parse_mode") && summary.payload().path("link_preview_options").path("is_disabled").asBoolean(),
            "Summary did not send plain text with previews disabled");
        check(telegram.lastText(ENGINEER).contains("доставлены в чат проверки"), "Engineer did not get delivery confirmation");
    }

    private static void checkCopy(Call call, long messageId, int status, String caption) {
        check("copyMessage".equals(call.method()) && call.status() == status
                && call.payload().path("from_chat_id").asLong() == ENGINEER
                && call.payload().path("message_id").asLong() == messageId
                && call.payload().path("caption").asText().equals("Отчёт №1 · " + caption),
            "Wrong copy step for Telegram message " + messageId);
    }

    private static void checkReview(TelegramReports bot, MockTelegram telegram, TelegramReportStore store) throws Exception {
        var firstSummary = telegram.lastMessage(REVIEW_CHAT);
        String firstApproval = button(firstSummary, "review:a:");
        String firstRework = button(firstSummary, "review:r:");
        int groupCalls = telegram.reviewCalls().size();
        int engineerMessages = telegram.messages(ENGINEER).size();

        bot.handle(callback(22, STRANGER, REVIEW_CHAT, firstSummary.messageId(), firstApproval));
        bot.handle(callback(23, REVIEWER, WRONG_CHAT, firstSummary.messageId(), firstApproval));
        bot.handle(callback(24, REVIEWER, REVIEW_CHAT, firstSummary.messageId() + 100, firstApproval));
        bot.deliver();
        check(telegram.reviewCalls().size() == groupCalls && telegram.messages(ENGINEER).size() == engineerMessages,
            "An unauthorized or misplaced review changed the report");

        bot.handle(callback(25, REVIEWER, REVIEW_CHAT, firstSummary.messageId(), firstRework));
        bot.deliver();
        var reasonPrompt = telegram.lastMessage(REVIEW_CHAT);
        check(reasonPrompt.payload().path("reply_markup").path("force_reply").asBoolean(),
            "Rework reason was not requested with Telegram ForceReply");
        check(telegram.edits().isEmpty(), "Report status changed before a reviewer entered a reason");
        String reason = "Уточните, какие входы проверили.";

        bot.handle(groupReply(26, OTHER_REVIEWER, REVIEW_CHAT, reasonPrompt.messageId(), reason));
        bot.handle(groupReply(27, REVIEWER, WRONG_CHAT, reasonPrompt.messageId(), reason));
        bot.handle(groupReply(28, REVIEWER, REVIEW_CHAT, reasonPrompt.messageId() + 100, reason));
        bot.deliver();
        check(telegram.edits().isEmpty() && telegram.messages(ENGINEER).size() == engineerMessages,
            "An unrelated reply returned the report for rework");

        var returnReply = groupReply(29, REVIEWER, REVIEW_CHAT, reasonPrompt.messageId(), reason);
        bot.handle(returnReply);
        bot.deliver();
        check(telegram.edits().size() == 1 && editTargets(telegram.edits().getFirst(), firstSummary),
            "Rework did not update the original group summary");
        check(telegram.edits().getFirst().payload().path("text").asText().contains(reason),
            "Rework reason is missing from the group summary");
        var returned = telegram.lastMessage(ENGINEER);
        check(returned.payload().path("text").asText().contains(reason), "Engineer did not receive the rework reason");
        var revisionActions = buttons(returned);
        String revise = revisionActions.stream().filter(action -> action.startsWith("revise:") && !action.endsWith(":materials"))
            .findFirst().orElseThrow(() -> new AssertionError("Engineer could not revise the result"));
        check(revisionActions.contains(revise + ":materials"),
            "Engineer was not offered both ways to revise the report");
        bot.handle(returnReply);
        bot.deliver();
        check(telegram.edits().size() == 1 && telegram.lastMessage(ENGINEER).equals(returned),
            "Duplicate rework reply notified the engineer twice");

        bot.handle(callback(30, ENGINEER, revise + ":materials"));
        var replacement = store.draft(ENGINEER);
        check(replacement != null && "north".equals(replacement.siteId()) && replacement.before() == null
                && replacement.after() == null && replacement.documents().isEmpty(),
            "Replacing materials did not reset evidence while keeping the object");
        bot.handle(message(301, ENGINEER, Map.of("video", Map.of("file_id", "replacement"))));
        check(store.draft(ENGINEER).after() == 301L && store.pending() == null
                && button(telegram.lastMessage(ENGINEER), "send:").endsWith(":301"),
            "A replacement video did not reach the optional preview");
        bot.handle(message(31, ENGINEER, Map.of("text", "/cancel")));

        bot.handle(callback(32, ENGINEER, revise));
        var draft = store.draft(ENGINEER);
        check(draft != null && draft.before() == null && Long.valueOf(AFTER).equals(draft.after())
                && draft.documents().isEmpty(), "Revision lost previously submitted video");
        bot.handle(message(320, ENGINEER, Map.of("text", "/send")));
        check(store.pending() == null && telegram.lastText(ENGINEER).contains("исправленный комментарий"),
            "Text correction could resend the returned report without a correction");
        String amended = "Проверили вход №2, считыватель работает.";
        bot.handle(message(33, ENGINEER, Map.of("text", amended)));
        String resubmit = button(telegram.lastMessage(ENGINEER), "send:");
        bot.handle(callback(34, ENGINEER, resubmit));
        bot.deliver();
        var revisedSummary = telegram.lastMessage(REVIEW_CHAT);
        String amendedText = revisedSummary.payload().path("text").asText();
        check(amendedText.contains("Отчёт №1 · версия 2") && amendedText.contains(amended),
            "Resubmission lost its report number or updated result");
        String revisedApproval = button(revisedSummary, "review:a:");
        check(!revisedApproval.equals(firstApproval), "Review buttons did not distinguish the new submission");

        int beforeApproval = telegram.messages(ENGINEER).size();
        bot.handle(callback(35, REVIEWER, REVIEW_CHAT, firstSummary.messageId(), firstApproval));
        bot.deliver();
        check(telegram.edits().size() == 1 && telegram.messages(ENGINEER).size() == beforeApproval,
            "Stale approval affected the revised report");
        var approve = callback(36, OTHER_REVIEWER, REVIEW_CHAT, revisedSummary.messageId(), revisedApproval);
        bot.handle(approve);
        bot.deliver();
        check(telegram.edits().size() == 2 && editTargets(telegram.edits().getLast(), revisedSummary)
                && telegram.edits().getLast().payload().path("text").asText().contains("Принято")
                && buttons(telegram.edits().getLast()).isEmpty(),
            "Approval did not update the revised group summary");
        check(telegram.messages(ENGINEER).size() == beforeApproval + 1
                && telegram.lastText(ENGINEER).contains("Отчёт №1 · версия 2")
                && telegram.lastText(ENGINEER).contains("Принято"), "Engineer did not receive the approval");
        bot.handle(approve);
        bot.deliver();
        check(telegram.edits().size() == 2 && telegram.messages(ENGINEER).size() == beforeApproval + 1,
            "Duplicate approval changed status or sent an extra notification");
    }

    private static void checkScopedObjects(TelegramReports bot, MockTelegram telegram, TelegramReportStore store) throws Exception {
        bot.handle(message(37, SECOND_ENGINEER, Map.of("text", "/start")));
        check(buttons(telegram.lastMessage(SECOND_ENGINEER)).equals(List.of("site:south")),
            "Second engineer did not see only their assigned object");
        bot.handle(callback(38, SECOND_ENGINEER, "site:north"));
        check(store.draft(SECOND_ENGINEER).siteId() == null
            && buttons(telegram.lastMessage(SECOND_ENGINEER)).equals(List.of("site:south")),
            "A forged callback selected another engineer's object");
        bot.handle(message(39, UNASSIGNED_ENGINEER, Map.of("text", "/start")));
        check(store.draft(UNASSIGNED_ENGINEER) == null
            && buttons(telegram.lastMessage(UNASSIGNED_ENGINEER)).isEmpty()
            && telegram.lastText(UNASSIGNED_ENGINEER).contains("не назначили объекты"),
            "Engineer without assignments saw objects or started a draft");
    }

    private static void checkDeadlines(TelegramReports bot, MockTelegram telegram, TelegramReportStore store)
            throws Exception {
        var dueAt = ZonedDateTime.now(ZoneId.of("Asia/Almaty")).plusHours(1).withSecond(0).withNano(0);
        int before = telegram.calls.size();
        bot.handle(message(100, STRANGER, Map.of("text", "/deadline")));
        bot.handle(message(101, STRANGER, Map.of("text", "/missing")));
        check(telegram.calls.size() == before && bot.nextReminderAt() == Long.MAX_VALUE,
            "An unauthorized user accessed report deadlines");

        bot.handle(message(106, REVIEWER, Map.of("text", "/missing")));
        check(telegram.lastText(REVIEWER).contains("Южный объект")
            && telegram.lastText(REVIEWER).contains("Видеоотчёт ещё не отправлен")
            && !telegram.lastText(REVIEWER).contains("Северный объект"),
            "Reviewers could not see assigned objects awaiting their first report without deadlines");
        int engineerMessages = telegram.messages(SECOND_ENGINEER).size();
        bot.handle(message(107, SECOND_ENGINEER, Map.of("text", "/missing")));
        check(telegram.messages(SECOND_ENGINEER).size() == engineerMessages, "Engineer could access the reviewer list");

        var assignments = List.of(new TelegramReportStore.DeadlineAssignment(ENGINEER, "north"),
            new TelegramReportStore.DeadlineAssignment(SECOND_ENGINEER, "south"));
        long due = dueAt.toEpochSecond();
        store.setDeadlines(102, assignments, Instant.now().getEpochSecond(), due);
        bot.handle(message(103, REVIEWER, Map.of("text", "/missing")));
        check(telegram.lastText(REVIEWER).contains("Северный объект")
            && telegram.lastText(REVIEWER).contains("Южный объект")
            && bot.nextReminderAt() == due, "A historical report satisfied a new deadline");

        bot.handle(callback(104, SECOND_ENGINEER, "site:south"));
        bot.handle(message(105, SECOND_ENGINEER, Map.of("video", Map.of("file_id", "new-video"), "caption", RESULT)));
        check(store.pending() != null && store.pending().header().contains(RESULT),
            "Submitting a video lost its optional caption");
        store.setDeadlines(108, assignments, Instant.now().getEpochSecond(), due);
        bot.handle(message(109, REVIEWER, Map.of("text", "/missing")));
        check(telegram.lastText(REVIEWER).contains("Северный объект")
            && !telegram.lastText(REVIEWER).contains("Южный объект"),
            "A submitted report stayed on the missing list after the same deadline was entered again");

        int firstMessages = telegram.messages(ENGINEER).size();
        int secondMessages = telegram.messages(SECOND_ENGINEER).size();
        bot.sendDueReminders(due - 1);
        check(telegram.messages(ENGINEER).size() == firstMessages, "The bot reminded before the deadline");
        bot.sendDueReminders(due);
        bot.sendDueReminders(due + 60);
        check(telegram.messages(ENGINEER).size() == firstMessages + 1
            && telegram.lastText(ENGINEER).contains("Северный объект")
            && telegram.messages(SECOND_ENGINEER).size() == secondMessages
            && bot.nextReminderAt() == Long.MAX_VALUE, "Reminder was duplicated, missed or sent to the wrong engineer");
    }

    private static void checkLegacyVideoDraft(TelegramReports bot, MockTelegram telegram, TelegramReportStore store)
            throws Exception {
        bot.handle(message(120, ENGINEER, Map.of("text", "/deadline")));
        check(store.draft(ENGINEER) == null && store.missingDeadlines().isEmpty()
            && buttons(telegram.lastMessage(ENGINEER)).stream().noneMatch(action -> action.startsWith("dl:")),
            "The old command still opened a deadline picker");

        long before = 14;
        store.save(new TelegramReportStore.Draft(ENGINEER, "north", before, AFTER, null, List.of(DOCUMENT)));
        bot.handle(message(121, ENGINEER, Map.of("text", "/start")));
        var preview = telegram.lastMessage(ENGINEER);
        check(preview.payload().path("text").asText().contains("Проверьте отчёт")
            && preview.payload().path("text").asText().contains("✓ Видео после работ"),
            "A video saved before the update could not be resumed");
        bot.handle(callback(122, ENGINEER, button(preview, "send:")));
        var report = store.pending();
        check(report != null && report.before() == before && report.after() == AFTER
            && report.documents().equals(List.of(DOCUMENT)), "Resuming the draft lost existing materials");
        check(store.draft(ENGINEER) == null && !report.header().contains("Результат:"),
            "A legacy video draft still required a separate result message");
        int reviewCallsBefore = telegram.reviewCalls().size();
        bot.deliver();
        var delivered = telegram.reviewCalls().subList(reviewCallsBefore, telegram.reviewCalls().size());
        check(delivered.size() == 4 && store.pending() == null, "Legacy report materials were not delivered");
        checkCopy(delivered.get(0), before, 200, "Видео до");
        checkCopy(delivered.get(1), AFTER, 200, "Видео после");
        checkCopy(delivered.get(2), DOCUMENT, 200, "Вложение 1");
    }

    private static boolean editTargets(Call edit, Call message) {
        return edit.payload().path("message_id").asLong() == message.messageId();
    }

    private static String button(Call call, String prefix) {
        return buttons(call).stream().filter(action -> action.startsWith(prefix)).findFirst()
            .orElseThrow(() -> new AssertionError("Telegram message did not offer action " + prefix));
    }

    private static List<String> buttons(Call call) {
        var actions = new ArrayList<String>();
        for (var row : call.payload().path("reply_markup").path("inline_keyboard")) {
            for (var key : row) actions.add(key.path("callback_data").asText());
        }
        return actions;
    }

    private static JsonNode message(long updateId, long sender, Map<String, Object> fields) {
        return message(updateId, sender, sender, "private", fields);
    }

    private static JsonNode message(long updateId, long sender, long chatId, String chatType, Map<String, Object> fields) {
        var message = new LinkedHashMap<>(fields);
        message.put("message_id", updateId);
        message.put("chat", Map.of("id", chatId, "type", chatType));
        message.put("from", Map.of("id", sender));
        return Db.JSON.valueToTree(Map.of("update_id", updateId, "message", message));
    }

    private static JsonNode callback(long updateId, long sender, String action) {
        return callback(updateId, sender, sender, 0, action);
    }

    private static JsonNode callback(long updateId, long sender, long chat, long messageId, String action) {
        return Db.JSON.valueToTree(Map.of("update_id", updateId, "callback_query", Map.of(
            "id", "callback-" + updateId, "from", Map.of("id", sender), "data", action,
            "message", Map.of("message_id", messageId, "chat", Map.of("id", chat, "type", chat < 0 ? "supergroup" : "private")))));
    }

    private static JsonNode groupReply(long updateId, long sender, long chat, long replyTo, String reason) {
        return message(updateId, sender, chat, "supergroup", Map.of("text", reason, "reply_to_message", Map.of(
            "message_id", replyTo, "chat", Map.of("id", chat, "type", "supergroup"),
            "from", Map.of("id", 123, "is_bot", true))));
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private record Call(String method, JsonNode payload, int status, long messageId) {}

    private static final class MockTelegram implements AutoCloseable {
        private final HttpServer server;
        private final List<Call> calls = new CopyOnWriteArrayList<>();
        private final AtomicBoolean failSummaryOnce = new AtomicBoolean(true);
        private final AtomicBoolean failCommandsOnce = new AtomicBoolean();
        private final AtomicLong messageIds = new AtomicLong(500);

        MockTelegram() throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/bot" + TOKEN + "/", this::handle);
            server.start();
        }

        URI uri() { return URI.create("http://127.0.0.1:" + server.getAddress().getPort()); }

        private void handle(HttpExchange exchange) throws IOException {
            try (exchange) {
                String method = exchange.getRequestURI().getPath().substring(("/bot" + TOKEN + "/").length());
                var payload = Db.JSON.readTree(exchange.getRequestBody());
                boolean fail = ("sendMessage".equals(method) && payload.path("chat_id").asLong() == REVIEW_CHAT
                    && failSummaryOnce.getAndSet(false))
                    || ("setMyCommands".equals(method) && failCommandsOnce.getAndSet(false));
                int status = fail ? 500 : 200;
                long messageId = switch (method) {
                    case "sendMessage", "copyMessage" -> fail ? 0 : messageIds.incrementAndGet();
                    case "editMessageText" -> payload.path("message_id").asLong();
                    default -> 0;
                };
                calls.add(new Call(method, payload, status, messageId));
                Object result = switch (method) {
                    case "getUpdates" -> List.of();
                    case "answerCallbackQuery", "setMyCommands" -> true;
                    default -> Map.of("message_id", messageId);
                };
                var data = Db.JSON.writeValueAsBytes(fail
                    ? Map.of("ok", false, "error_code", 500, "description", "private description " + TOKEN)
                    : Map.of("ok", true, "result", result));
                exchange.sendResponseHeaders(status, data.length);
                exchange.getResponseBody().write(data);
            }
        }

        List<Call> reviewCalls() {
            return calls.stream().filter(call -> call.payload().path("chat_id").asLong() == REVIEW_CHAT).toList();
        }

        List<String> menu(Long user) {
            var matching = calls.stream().filter(call -> "setMyCommands".equals(call.method()))
                .filter(call -> user == null
                    ? "all_private_chats".equals(call.payload().path("scope").path("type").asText())
                    : "chat".equals(call.payload().path("scope").path("type").asText())
                        && call.payload().path("scope").path("chat_id").asLong() == user)
                .toList();
            var commands = new ArrayList<String>();
            matching.getLast().payload().path("commands").forEach(command -> commands.add(command.path("command").asText()));
            return commands;
        }

        List<Call> messages(long user) {
            return calls.stream().filter(call -> "sendMessage".equals(call.method())
                && call.payload().path("chat_id").asLong() == user).toList();
        }

        List<Call> edits() {
            return reviewCalls().stream().filter(call -> "editMessageText".equals(call.method())).toList();
        }

        Call lastMessage(long user) { return messages(user).getLast(); }

        String lastText(long user) { return lastMessage(user).payload().path("text").asText(); }

        String lastButton(long user) {
            return lastMessage(user).payload().path("reply_markup").path("inline_keyboard").path(0).path(0)
                .path("callback_data").asText();
        }

        @Override
        public void close() { server.stop(0); }
    }
}
