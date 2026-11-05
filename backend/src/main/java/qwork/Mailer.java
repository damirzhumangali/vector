package qwork;

import java.io.IOException;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

final class Mailer {
    private static final int MAX_ERROR_BYTES = 8_192;
    private static final Set<String> ERROR_CODES = Set.of(
        "invalid_parameter", "missing_parameter", "out_of_range", "unauthorized", "document_not_found",
        "method_not_allowed", "not_enough_credits", "permission_denied", "duplicate_parameter",
        "duplicate_request", "invalid_request", "account_disabled", "forbidden", "too_many_requests",
        "validation_error", "rate_limit_exceeded", "missing_api_key", "invalid_api_key", "restricted_api_key",
        "invalid_from_address", "not_found", "invalid_idempotency_key", "invalid_idempotent_request",
        "idempotency_key_in_use", "application_error", "internal_server_error");
    private static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9_-]{43}");
    private static final Pattern SENDER_EMAIL = Pattern.compile(
        "[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?"
            + "(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+");
    private static final Set<String> LOOPBACK = Set.of("localhost", "127.0.0.1", "::1", "[::1]");
    private static final HttpClient CLIENT = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .followRedirects(HttpClient.Redirect.NEVER)
        .build();

    private enum Provider {
        RESEND("https://api.resend.com/emails"),
        BREVO("https://api.brevo.com/v3/smtp/email");

        final String endpoint;

        Provider(String endpoint) { this.endpoint = endpoint; }
    }

    private record Configuration(Provider provider, String apiKey, String from, URI endpoint, String publicUrl) {}
    private record DeliveryFailure(String code, String category) {}

    private Mailer() {}

    static boolean configured() {
        return configuration() != null;
    }

    static void sendVerification(String email, String token) {
        send(email, token, "verify-email", "Подтвердите почту в qwork",
            "Подтвердите почту, чтобы использовать её для входа и восстановления доступа.", "Подтвердить почту");
    }

    static void sendPasswordReset(String email, String token) {
        send(email, token, "reset-password", "Восстановление доступа к qwork",
            "Откройте ссылку, чтобы установить новый пароль для вашего аккаунта qwork.", "Установить пароль");
    }

    private static void send(String email, String token, String action, String subject,
                             String description, String button) {
        Configuration config = configuration();
        if (config == null) {
            throw Domain.error(503, "Отправка писем пока не настроена. Обратитесь к администратору qwork.");
        }
        if (email == null || email.isBlank() || email.length() > 254 || containsLineBreak(email)
                || token == null || !TOKEN.matcher(token).matches()) {
            throw Domain.error(400, "Проверьте адрес почты и запросите новую ссылку.");
        }
        String link = config.publicUrl() + "/" + action + "#" + token;
        String text = description + "\n\n" + link
            + "\n\nЕсли вы не запрашивали это письмо, просто закройте его.";
        String html = "<!doctype html><html lang=\"ru\"><body>"
            + "<h2>" + subject + "</h2><p>" + description + "</p>"
            + "<p><a href=\"" + escape(link) + "\">" + button + "</a></p>"
            + "<p>Если вы не запрашивали это письмо, просто закройте его.</p></body></html>";
        try {
            String idempotency = idempotencyKey(action, token);
            Map<String, Object> message = config.provider() == Provider.BREVO
                ? Map.of("sender", Map.of("email", config.from(), "name", "qwork"),
                    "to", List.of(Map.of("email", email)), "subject", subject,
                    "textContent", text, "htmlContent", html,
                    "headers", Map.of("IdempotencyKey", idempotency))
                : Map.of("from", config.from(), "to", List.of(email), "subject", subject,
                    "text", text, "html", html);
            byte[] payload = Db.JSON.writeValueAsBytes(message);
            var request = HttpRequest.newBuilder(config.endpoint())
                .timeout(Duration.ofSeconds(12))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofByteArray(payload));
            if (config.provider() == Provider.BREVO) {
                request.header("api-key", config.apiKey());
            } else {
                request.header("Authorization", "Bearer " + config.apiKey())
                    .header("Idempotency-Key", idempotency);
            }
            var response = sendRequest(request.build());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                DeliveryFailure failure = deliveryFailure(response.statusCode(), response.body());
                reportFailure(config, action, response.statusCode(), failure);
                throw Domain.error(502, failureMessage(response.statusCode(), failure.category()));
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            reportFailure(config, action, 0, new DeliveryFailure("none", "interrupted"));
            throw Domain.error(502, "Отправка письма прервана. Попробуйте снова.");
        } catch (IOException failure) {
            reportFailure(config, action, 0, new DeliveryFailure("none", networkCategory(failure)));
            throw Domain.error(502, "Не удалось отправить письмо. Попробуйте позже.");
        }
    }

    private static HttpResponse<byte[]> sendRequest(HttpRequest request) throws IOException, InterruptedException {
        var pending = CLIENT.sendAsync(request, info -> info.statusCode() >= 200 && info.statusCode() < 300
            ? HttpResponse.BodySubscribers.mapping(HttpResponse.BodySubscribers.discarding(), unused -> new byte[0])
            : new ErrorBodySubscriber());
        try {
            // The deadline also covers response-body delivery, not only connecting/receiving headers.
            return pending.get(request.timeout().orElse(Duration.ofSeconds(12)).toNanos(), TimeUnit.NANOSECONDS);
        } catch (TimeoutException timeout) {
            pending.cancel(true);
            throw new java.net.http.HttpTimeoutException("Mail provider request timed out.");
        } catch (ExecutionException failure) {
            Throwable cause = failure.getCause();
            if (cause instanceof IOException io) throw io;
            throw new IOException("Mail provider request failed.", cause);
        } catch (InterruptedException interrupted) {
            pending.cancel(true);
            throw interrupted;
        }
    }

    private static final class ErrorBodySubscriber implements HttpResponse.BodySubscriber<byte[]> {
        private final CompletableFuture<byte[]> body = new CompletableFuture<>();
        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream(MAX_ERROR_BYTES);
        private Flow.Subscription subscription;

        @Override public CompletionStage<byte[]> getBody() { return body; }

        @Override public void onSubscribe(Flow.Subscription next) {
            if (subscription != null) { next.cancel(); return; }
            subscription = next;
            next.request(1);
        }

        @Override public void onNext(List<ByteBuffer> buffers) {
            for (ByteBuffer buffer : buffers) {
                byte[] chunk = new byte[Math.min(buffer.remaining(), MAX_ERROR_BYTES - bytes.size())];
                buffer.get(chunk);
                bytes.writeBytes(chunk);
                if (bytes.size() == MAX_ERROR_BYTES) {
                    subscription.cancel();
                    body.complete(bytes.toByteArray());
                    return;
                }
            }
            subscription.request(1);
        }

        @Override public void onError(Throwable failure) { body.completeExceptionally(failure); }
        @Override public void onComplete() { body.complete(bytes.toByteArray()); }
    }

    private static DeliveryFailure deliveryFailure(int status, byte[] body) {
        String code = "unknown";
        String message = "";
        try {
            var json = Db.JSON.readTree(body);
            if (json != null && json.isObject()) {
                String rawCode = json.path("code").asText(json.path("name").asText(""));
                if (ERROR_CODES.contains(rawCode)) code = rawCode;
                message = json.path("message").asText("").toLowerCase(Locale.ROOT);
            }
        } catch (IOException ignored) {
            // JSON parser diagnostics may contain response fragments; never log them.
        }
        String category;
        if ((message.contains("smtp") || message.contains("transactional") || message.contains("account")
                || message.contains("sending")) && (message.contains("not activated") || message.contains("not yet activated") || message.contains("not active")
                || message.contains("disabled") || message.contains("deactivated"))) category = "activation";
        else if (message.contains("ip address") || message.contains("unauthorised ip")
                || message.contains("unauthorized ip") || message.contains("unrecognized ip")
                || message.contains("unrecognised ip")) category = "unauthorised_ip";
        else if (message.contains("idempot") || code.contains("idempot")) category = "idempotency_key";
        else if (message.contains("sender") || message.contains("from address")) category = "sender";
        else if (message.contains("domain")) category = "domain";
        else if (message.contains("permission") || message.contains("scope") || message.contains("access denied")) category = "permission";
        else if (message.contains("credit") || message.contains("quota") || code.equals("not_enough_credits")) category = "quota";
        else if (status == 401 || code.equals("invalid_api_key") || code.equals("missing_api_key")) category = "authentication";
        else if (status == 429) category = "rate_limit";
        else if (code.equals("invalid_parameter") || code.equals("missing_parameter")
                || code.equals("invalid_request") || code.equals("validation_error")) category = "payload_validation";
        else if (status == 403) category = "access";
        else if (status >= 500) category = "provider_error";
        else category = "provider_response";
        return new DeliveryFailure(code, category);
    }

    private static String failureMessage(int status, String category) {
        if (category.equals("activation")) {
            return "Почтовый сервис ещё не активировал отправку писем. Обратитесь к администратору.";
        }
        if (category.equals("unauthorised_ip")) {
            return "Почтовый сервис отклонил подключение с этого сервера. Обратитесь к администратору.";
        }
        if (status == 401) return "Почтовый сервис отклонил ключ доступа. Обратитесь к администратору.";
        if (status == 403) return "Почтовый сервис не разрешает отправку. Администратору нужно проверить активацию и права доступа.";
        if (status == 429) return "Превышен лимит отправки писем. Попробуйте позже.";
        return "Не удалось отправить письмо. Попробуйте позже.";
    }

    private static String networkCategory(Throwable failure) {
        for (int depth = 0; failure != null && depth < 8; depth++, failure = failure.getCause()) {
            if (failure instanceof java.net.http.HttpConnectTimeoutException) return "connect_timeout";
            if (failure instanceof java.net.http.HttpTimeoutException) return "request_timeout";
            if (failure instanceof javax.net.ssl.SSLException) return "tls";
            if (failure instanceof java.net.UnknownHostException) return "dns";
            if (failure instanceof java.net.ConnectException) return "connection";
        }
        return "io";
    }

    private static void reportFailure(Configuration config, String action, int status, DeliveryFailure failure) {
        // Only constants/allowlisted labels are logged, never raw provider responses, secrets or addresses.
        System.err.printf("qwork mail failure provider=%s action=%s status=%d code=%s category=%s%n",
            config.provider(), action, status, failure.code(), failure.category());
    }

    private static Configuration configuration() {
        Provider provider;
        try {
            provider = Provider.valueOf(System.getenv().getOrDefault("QWORK_EMAIL_PROVIDER", "resend")
                .strip().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException invalid) {
            return null;
        }
        String apiKey = System.getenv().getOrDefault("QWORK_EMAIL_API_KEY", "").strip();
        String from = System.getenv().getOrDefault("QWORK_EMAIL_FROM", "").strip();
        String publicUrl = System.getenv().getOrDefault("QWORK_PUBLIC_URL",
            System.getenv().getOrDefault("RENDER_EXTERNAL_URL", "")).strip().replaceFirst("/+$", "");
        String endpoint = System.getenv().getOrDefault("QWORK_EMAIL_API_URL", provider.endpoint).strip();
        if (apiKey.isBlank() || from.isBlank() || publicUrl.isBlank()
                || apiKey.length() > 4096 || from.length() > 1024
                || apiKey.codePoints().anyMatch(character -> character < 33 || character > 126)
                || containsLineBreak(from)) return null;
        if (provider == Provider.BREVO && (from.length() > 254 || !SENDER_EMAIL.matcher(from).matches()
                || from.startsWith(".") || from.contains("..") || from.contains(".@"))) return null;
        try {
            URI publicUri = URI.create(publicUrl);
            URI apiUri = URI.create(endpoint);
            if (!cleanUri(publicUri) || !"https".equalsIgnoreCase(publicUri.getScheme())) return null;
            if (!cleanUri(apiUri)) return null;
            boolean secure = "https".equalsIgnoreCase(apiUri.getScheme());
            boolean localTest = "http".equalsIgnoreCase(apiUri.getScheme())
                && LOOPBACK.contains(apiUri.getHost().toLowerCase(Locale.ROOT));
            if (!secure && !localTest) return null;
            return new Configuration(provider, apiKey, from, apiUri, publicUri.toASCIIString());
        } catch (IllegalArgumentException invalid) {
            return null;
        }
    }

    private static boolean cleanUri(URI uri) {
        return uri.getHost() != null && uri.getRawUserInfo() == null
            && uri.getRawQuery() == null && uri.getRawFragment() == null
            && (uri.getPort() == -1 || uri.getPort() >= 1 && uri.getPort() <= 65535);
    }

    private static boolean containsLineBreak(String text) {
        return text.indexOf('\n') >= 0 || text.indexOf('\r') >= 0;
    }

    private static String idempotencyKey(String action, String token) {
        try {
            byte[] input = (action + ":" + token).getBytes(StandardCharsets.UTF_8);
            return "qwork-" + action + "-" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(input));
        } catch (NoSuchAlgorithmException unavailable) {
            throw new IllegalStateException("SHA-256 unavailable");
        }
    }

    private static String escape(String value) {
        return value.replace("&", "&amp;").replace("\"", "&quot;")
            .replace("<", "&lt;").replace(">", "&gt;");
    }
}
