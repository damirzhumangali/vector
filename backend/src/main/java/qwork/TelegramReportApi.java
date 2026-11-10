package qwork;

import com.fasterxml.jackson.databind.JsonNode;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class TelegramReportApi implements AutoCloseable {
    private static final int POLL_SECONDS = 20;
    private final URI botBase;
    private final HttpClient client;

    TelegramReportApi(String token) {
        this(token, URI.create("https://api.telegram.org/"));
    }

    TelegramReportApi(String token, URI base) {
        if (token == null || !token.matches("[0-9]+:[A-Za-z0-9_-]+")) {
            throw new IllegalArgumentException("Проверьте токен бота Telegram.");
        }
        if (base == null || base.getHost() == null || base.getRawQuery() != null || base.getRawFragment() != null
                || (!"https".equals(base.getScheme()) && !"http".equals(base.getScheme()))) {
            throw new IllegalArgumentException("Проверьте адрес Telegram API.");
        }
        var root = base.toString();
        botBase = URI.create(root + (root.endsWith("/") ? "" : "/") + "bot" + token + "/");
        client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    }

    List<JsonNode> updates(long offset) throws IOException, InterruptedException {
        var result = call("getUpdates", Map.of("offset", offset, "timeout", POLL_SECONDS,
            "allowed_updates", List.of("message", "callback_query")), Duration.ofSeconds(POLL_SECONDS + 10));
        if (!result.isArray()) throw new IOException("Telegram вернул некорректный список обновлений.");
        var updates = new ArrayList<JsonNode>(result.size());
        result.forEach(updates::add);
        return updates;
    }

    void setCommands(Long chatId, List<Map<String, String>> commands) throws IOException, InterruptedException {
        var scope = chatId == null ? Map.of("type", "all_private_chats") : Map.of("type", "chat", "chat_id", chatId);
        var result = call("setMyCommands", Map.of("commands", commands, "scope", scope), Duration.ofSeconds(10));
        if (!result.isBoolean() || !result.booleanValue()) {
            throw new IOException("Telegram не подтвердил обновление команд бота.");
        }
    }

    long send(long chatId, String text, List<List<Map<String, String>>> keyboard)
            throws IOException, InterruptedException {
        var fields = new LinkedHashMap<String, Object>();
        fields.put("chat_id", chatId);
        fields.put("text", text);
        fields.put("link_preview_options", Map.of("is_disabled", true));
        if (keyboard != null && !keyboard.isEmpty()) fields.put("reply_markup", Map.of("inline_keyboard", keyboard));
        return call("sendMessage", fields, Duration.ofSeconds(10)).path("message_id").asLong();
    }

    long requestReply(long chatId, String text) throws IOException, InterruptedException {
        var message = call("sendMessage", Map.of("chat_id", chatId, "text", text,
            "reply_markup", Map.of("force_reply", true, "input_field_placeholder", "Причина доработки")),
            Duration.ofSeconds(10));
        long messageId = message.path("message_id").asLong();
        if (messageId <= 0) throw new IOException("Telegram не вернул номер сообщения для замечания.");
        return messageId;
    }

    void edit(long chatId, long messageId, String text) throws IOException, InterruptedException {
        edit(chatId, messageId, text, List.of());
    }

    void edit(long chatId, long messageId, String text, List<List<Map<String, String>>> keyboard)
            throws IOException, InterruptedException {
        call("editMessageText", Map.of("chat_id", chatId, "message_id", messageId, "text", text,
            "link_preview_options", Map.of("is_disabled", true), "reply_markup", Map.of("inline_keyboard", keyboard)),
            Duration.ofSeconds(10));
    }

    void copy(long toChat, long fromChat, long messageId, String caption) throws IOException, InterruptedException {
        var fields = new LinkedHashMap<String, Object>();
        fields.put("chat_id", toChat);
        fields.put("from_chat_id", fromChat);
        fields.put("message_id", messageId);
        if (caption != null) fields.put("caption", caption);
        call("copyMessage", fields, Duration.ofSeconds(10));
    }

    void answer(String callbackId) throws IOException, InterruptedException {
        call("answerCallbackQuery", Map.of("callback_query_id", callbackId), Duration.ofSeconds(10));
    }

    void answer(String callbackId, String text) throws IOException, InterruptedException {
        call("answerCallbackQuery", Map.of("callback_query_id", callbackId, "text", text), Duration.ofSeconds(10));
    }

    private JsonNode call(String method, Map<String, Object> fields, Duration timeout)
            throws IOException, InterruptedException {
        HttpResponse<byte[]> response;
        try {
            var request = HttpRequest.newBuilder(botBase.resolve(method)).timeout(timeout)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofByteArray(Db.JSON.writeValueAsBytes(fields))).build();
            response = client.send(request, HttpResponse.BodyHandlers.ofByteArray());
        } catch (IOException error) {
            throw new IOException("Запрос к Telegram не выполнен.");
        }

        int status = response.statusCode();
        JsonNode body;
        try {
            body = Db.JSON.readTree(response.body());
        } catch (IOException error) {
            throw new ApiFailure(status, 0);
        }
        if (status < 200 || status >= 300 || body == null || !body.path("ok").asBoolean(false)) {
            int code = body == null ? status : body.path("error_code").asInt(status);
            int retryAfter = body == null ? 0 : body.path("parameters").path("retry_after").asInt(0);
            throw new ApiFailure(code, Math.max(0, retryAfter));
        }
        return body.path("result");
    }

    @Override
    public void close() {
        client.close();
    }

    static final class ApiFailure extends IOException {
        private final int status;
        private final int retryAfterSeconds;

        ApiFailure(int status, int retryAfterSeconds) {
            super("Telegram отклонил запрос (код " + status + ").");
            this.status = status;
            this.retryAfterSeconds = retryAfterSeconds;
        }

        int status() { return status; }
        int retryAfterSeconds() { return retryAfterSeconds; }
    }
}
