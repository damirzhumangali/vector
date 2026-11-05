package qwork;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;

/** Loopback gateway exposing only token-protected email confirmation and password reset flows. */
public final class MailPublicGateway {
    private static final int MAX_BODY = 16_384;
    private static final int MAX_RESPONSE = 262_144;
    private static final Set<String> PAGES = Set.of("/verify-email", "/reset-password", "/auth-mail.js");
    private static final Set<String> ACTIONS = Set.of("/auth/email/verify", "/auth/password/reset");
    private static final List<String> RESPONSE_HEADERS = List.of(
        "Content-Type", "Content-Security-Policy", "Referrer-Policy", "X-Content-Type-Options");

    private final HttpClient client = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(2))
        .followRedirects(HttpClient.Redirect.NEVER)
        .build();
    private final Semaphore requests = new Semaphore(8);
    private final String upstream;

    private MailPublicGateway(int upstreamPort) {
        upstream = "http://127.0.0.1:" + upstreamPort;
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 0) throw new IllegalArgumentException("Mail gateway does not accept arguments.");
        int port = port("QWORK_MAIL_GATEWAY_PORT", "8788");
        int upstreamPort = port("QWORK_PORT", System.getenv().getOrDefault("PORT", "8787"));
        if (port == upstreamPort) throw new IllegalArgumentException("Mail gateway and API ports must differ.");
        var gateway = new MailPublicGateway(upstreamPort);
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 16);
        var executor = Executors.newVirtualThreadPerTaskExecutor();
        server.setExecutor(executor);
        server.createContext("/", gateway::handle);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            server.stop(1);
            executor.shutdownNow();
            gateway.client.close();
        }));
        server.start();
        System.out.printf("qwork mail gateway listening on 127.0.0.1:%d (mail routes only)%n", port);
    }

    private static int port(String key, String fallback) {
        String value = System.getenv().getOrDefault(key, fallback);
        if (!value.matches("[0-9]{1,5}")) throw new IllegalArgumentException("Invalid " + key + ".");
        int result = Integer.parseInt(value);
        if (result < 1 || result > 65535) throw new IllegalArgumentException("Invalid " + key + ".");
        return result;
    }

    private void handle(HttpExchange exchange) throws IOException {
        try (exchange) {
            String path = exchange.getRequestURI().getRawPath();
            String method = exchange.getRequestMethod();
            // Match the raw path exactly: encoding, suffixes and queries cannot expand this allowlist.
            if (exchange.getRequestURI().getRawQuery() != null) {
                error(exchange, 404, "Страница не найдена.");
                return;
            }
            if ("/health".equals(path) && Set.of("GET", "HEAD").contains(method)) {
                respond(exchange, 200, "application/json; charset=utf-8", "{\"ok\":true}".getBytes(StandardCharsets.UTF_8));
                return;
            }
            boolean page = PAGES.contains(path) && Set.of("GET", "HEAD").contains(method);
            boolean action = ACTIONS.contains(path) && "POST".equals(method);
            if (!page && !action) {
                error(exchange, 404, "Страница не найдена.");
                return;
            }
            if (action && !jsonContentType(exchange)) {
                error(exchange, 415, "Ожидается application/json.");
                return;
            }
            if (!requests.tryAcquire()) {
                error(exchange, 503, "Сервис занят. Попробуйте позже.");
                return;
            }
            try {
                byte[] body = action ? exchange.getRequestBody().readNBytes(MAX_BODY + 1) : new byte[0];
                if (body.length > MAX_BODY) {
                    error(exchange, 413, "Слишком большой запрос.");
                    return;
                }
                var request = HttpRequest.newBuilder(URI.create(upstream + path))
                    .timeout(Duration.ofSeconds(15))
                    .header("Accept", page ? "*/*" : "application/json")
                    .method(method, action ? HttpRequest.BodyPublishers.ofByteArray(body) : HttpRequest.BodyPublishers.noBody());
                if (action) request.header("Content-Type", "application/json");
                // No user-provided cookies, authorization, forwarding headers or destinations are propagated.
                var response = client.send(request.build(), HttpResponse.BodyHandlers.ofInputStream());
                byte[] result;
                try (var input = response.body()) {
                    result = input.readNBytes(MAX_RESPONSE + 1);
                }
                if (result.length > MAX_RESPONSE || response.statusCode() >= 300 && response.statusCode() < 400) {
                    error(exchange, 502, "Сервис временно недоступен.");
                    return;
                }
                for (String header : RESPONSE_HEADERS) {
                    response.headers().firstValue(header).ifPresent(value -> exchange.getResponseHeaders().set(header, value));
                }
                respond(exchange, response.statusCode(), response.headers().firstValue("Content-Type")
                    .orElse("application/json; charset=utf-8"), result);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                error(exchange, 502, "Сервис временно недоступен.");
            } catch (IOException failure) {
                error(exchange, 502, "Сервис временно недоступен.");
            } finally {
                requests.release();
            }
        }
    }

    private static boolean jsonContentType(HttpExchange exchange) {
        List<String> values = exchange.getRequestHeaders().get("Content-Type");
        return values != null && values.size() == 1
            && "application/json".equalsIgnoreCase(values.getFirst().split(";", 2)[0].strip());
    }

    private static void error(HttpExchange exchange, int status, String message) throws IOException {
        respond(exchange, status, "application/json; charset=utf-8",
            ("{\"error\":\"" + message + "\"}").getBytes(StandardCharsets.UTF_8));
    }

    private static void respond(HttpExchange exchange, int status, String contentType, byte[] body) throws IOException {
        exchange.getResponseHeaders().set("Content-Type", contentType);
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.getResponseHeaders().set("Referrer-Policy", "no-referrer");
        exchange.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        if ("HEAD".equals(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(status, -1);
        } else {
            exchange.sendResponseHeaders(status, body.length);
            exchange.getResponseBody().write(body);
        }
    }
}
