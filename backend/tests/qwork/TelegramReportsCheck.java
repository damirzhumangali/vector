package qwork;

import com.fasterxml.jackson.databind.JsonNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
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
    private static final long REVIEW_CHAT = -1_004_000_000_001L;
    private static final long WRONG_CHAT = -1_004_000_000_002L;
    private static final long BEFORE = 16;
    private static final long AFTER = 17;
    private static final long DOCUMENT = 19;
    private static final String RESULT = "Проверили проход, заменили считыватель <СКУД>.";

    public static void main(String[] args) throws Exception {
        Path directory = Path.of(args[0]);
        Path configuration = Files.writeString(directory.resolve("telegram-reports.json"), """
            {
              "reviewChatId": %d,
              "engineers": [{"telegramId": %d, "name": "Тестовый инженер"}],
              "reviewers": [{"telegramId": %d, "name": "Первый руководитель"},
                            {"telegramId": %d, "name": "Второй руководитель"}],
              "sites": [{"id": "north", "name": "Северный объект", "region": "Астана"}]
            }
            """.formatted(REVIEW_CHAT, ENGINEER, REVIEWER, OTHER_REVIEWER));
        var catalog = TelegramReportCatalog.load(configuration);
        Path database = directory.resolve("telegram-reports.sqlite3");

        try (var telegram = new MockTelegram(); var api = new TelegramReportApi(TOKEN, telegram.uri())) {
            check(api.updates(42).isEmpty(), "Unexpected fake updates");
            var poll = telegram.calls.getFirst();
            check("getUpdates".equals(poll.method()) && poll.payload().path("offset").asLong() == 42,
                "Long polling omitted the saved offset");
            check(poll.payload().path("timeout").asInt() > 0, "Polling does not wait for updates");

            try (var store = new TelegramReportStore(database)) {
                var bot = new TelegramReports(catalog, store, api);
                checkAccess(bot, telegram, store);
                queueReport(bot, telegram, store);

                try {
                    bot.deliver();
                    throw new AssertionError("Expected Telegram 500 during second copy");
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
                check(store.offset() == 21, "Submission offset did not survive restart");
                restarted.deliver();
                restarted.deliver();
                check(store.pending() == null, "Report stayed in delivery queue");
                checkDelivery(telegram);
                checkReview(restarted, telegram, store);
            }
        }
        System.out.println("Telegram report workflow passed.");
    }

    private static void checkAccess(TelegramReports bot, MockTelegram telegram, TelegramReportStore store) throws Exception {
        bot.handle(message(1, STRANGER, Map.of("text", "/start")));
        check(telegram.lastText(STRANGER).contains("список инженеров"), "Unauthorized user did not get access guidance");
        int responses = telegram.calls.size();
        bot.handle(message(2, STRANGER, Map.of("text", "/new")));
        bot.handle(callback(3, STRANGER, "new"));
        bot.handle(message(4, ENGINEER, REVIEW_CHAT, "supergroup", Map.of("text", "/new")));
        check(telegram.calls.size() == responses, "Report actions were accepted outside the allowlist or private chat");
        check(store.draft(STRANGER) == null && store.draft(ENGINEER) == null, "Unauthorized action created a draft");
    }

    private static void queueReport(TelegramReports bot, MockTelegram telegram, TelegramReportStore store) throws Exception {
        bot.handle(message(5, ENGINEER, Map.of("text", "/start")));
        check("new".equals(telegram.lastButton(ENGINEER)), "Start menu did not offer report creation");
        bot.handle(callback(6, ENGINEER, "new"));
        bot.handle(message(7, ENGINEER, Map.of("text", "астана")));
        check("site:north".equals(telegram.lastButton(ENGINEER)), "Region search did not offer the configured object");
        bot.handle(callback(8, ENGINEER, "site:north"));

        bot.handle(message(9, ENGINEER, Map.of("photo", List.of(Map.of("file_id", "photo")))));
        check(store.draft(ENGINEER).before() == null && telegram.lastText(ENGINEER).contains("видео ДО"),
            "A photo was accepted as the first video");
        bot.handle(message(10, ENGINEER, Map.of("text", "/send")));
        check(store.pending() == null && telegram.reviewCalls().isEmpty(), "An incomplete report reached the review chat");

        var before = message(BEFORE, ENGINEER, Map.of("video", Map.of("file_id", "before")));
        bot.handle(before);
        bot.handle(before);
        check(store.draft(ENGINEER).after() == null && telegram.lastText(ENGINEER).contains("видео ПОСЛЕ"),
            "The same video was accepted twice");
        bot.handle(message(AFTER, ENGINEER, Map.of("document", Map.of("file_id", "after", "mime_type", "video/mp4"))));
        bot.handle(message(18, ENGINEER, Map.of("text", RESULT)));
        bot.handle(message(DOCUMENT, ENGINEER, Map.of("document", Map.of("file_id", "act", "mime_type", "application/pdf"))));

        String sendAction = telegram.lastButton(ENGINEER);
        check(sendAction.startsWith("send:") && telegram.lastText(ENGINEER).contains(RESULT),
            "Complete draft did not show result and a submission button");
        var submit = callback(20, ENGINEER, sendAction);
        bot.handle(submit);
        check(telegram.lastText(ENGINEER).contains("принят к отправке"), "No receipt for the accepted report");
        bot.handle(submit);
        bot.handle(callback(21, ENGINEER, sendAction));
        check(store.draft(ENGINEER) == null && store.pending() != null, "Submission did not move draft into the queue");
        check(telegram.reviewCalls().isEmpty(), "Bot copied media before the delivery worker ran");
    }

    private static void checkDelivery(MockTelegram telegram) {
        var calls = telegram.reviewCalls();
        check(calls.size() == 5, "A report or attachment was lost or sent twice");
        checkCopy(calls.get(0), BEFORE, 200, "Видео до");
        checkCopy(calls.get(1), AFTER, 500, "Видео после");
        checkCopy(calls.get(2), AFTER, 200, "Видео после");
        checkCopy(calls.get(3), DOCUMENT, 200, "Вложение 1");
        var summary = calls.get(4);
        check("sendMessage".equals(summary.method()), "Report summary was not sent as text");
        String text = summary.payload().path("text").asText();
        check(text.contains("Отчёт №1") && text.contains("Северный объект") && text.contains("Тестовый инженер")
                && text.contains(RESULT), "Summary omitted report data");
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
        bot.handle(message(31, ENGINEER, Map.of("text", "/cancel")));

        bot.handle(callback(32, ENGINEER, revise));
        var draft = store.draft(ENGINEER);
        check(draft != null && Long.valueOf(BEFORE).equals(draft.before()) && Long.valueOf(AFTER).equals(draft.after())
                && draft.documents().equals(List.of(DOCUMENT)), "Revision lost previously submitted evidence");
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
        private final AtomicBoolean failAfterOnce = new AtomicBoolean(true);
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
                boolean fail = "copyMessage".equals(method) && payload.path("message_id").asLong() == AFTER
                    && failAfterOnce.getAndSet(false);
                int status = fail ? 500 : 200;
                long messageId = switch (method) {
                    case "sendMessage", "copyMessage" -> fail ? 0 : messageIds.incrementAndGet();
                    case "editMessageText" -> payload.path("message_id").asLong();
                    default -> 0;
                };
                calls.add(new Call(method, payload, status, messageId));
                Object result = switch (method) {
                    case "getUpdates" -> List.of();
                    case "answerCallbackQuery" -> true;
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
