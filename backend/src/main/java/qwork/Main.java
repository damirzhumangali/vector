package qwork;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Connection;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

final class Main {
    private static final int MAX_BODY = 16_384;
    private static final int MAX_PHOTO_BODY = ((Media.MAX_IMAGE_BYTES + 2) / 3) * 4 + MAX_BODY;
    private static final int MAX_IMPORT_BODY = ((XlsxImport.MAX_BYTES + 2) / 3) * 4 + 1024;
    private static final int MAX_REPORT_BODY = 128 * 1024;
    private static final int AUTH_WINDOW_SECONDS = 60;
    private static final String CLIENT_IP_HEADER = switch (env("QWORK_TRUST_PROXY", "")) {
        case "1" -> "X-Forwarded-For"; // Caddy overwrites this header.
        case "render" -> "CF-Connecting-IP"; // Render's Cloudflare edge overwrites this header.
        default -> null;
    };
    private static final Semaphore AUTH_SLOTS = new Semaphore(4);
    private static final Semaphore API_SLOTS = new Semaphore(32);
    private static final Semaphore IMPORT_SLOTS = new Semaphore(2);
    private static final Semaphore PHOTO_REQUEST_SLOTS = new Semaphore(2);
    private static final Semaphore ANALYTICS_SLOTS = new Semaphore(3);
    private static final Set<String> ANALYTICS_FILTERS = Set.of("employeeId", "objectId", "department", "from", "to");
    private static final Map<String, Attempts> ATTEMPTS = new LinkedHashMap<>(16, .75f, true);
    private static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9_-]{43}");
    private static final Pattern EMPLOYEE_INVITE = Pattern.compile("/employees/([0-9]{1,19})/invite");
    private static final Pattern EMPLOYEE_DEPARTMENT = Pattern.compile("/employees/([0-9]{1,19})/department");
    private static final Pattern EMPLOYEE_PASSWORD = Pattern.compile("/employees/([0-9]{1,19})/reset-password");
    private static final Pattern TASK = Pattern.compile("/tasks/([0-9]{1,19})");
    private static final Pattern REPEAT = Pattern.compile("/tasks/([0-9]{1,19})/repeat");
    private static final Pattern REPRESENTATIVE = Pattern.compile("/tasks/([0-9]{1,19})/representative");
    private static final Pattern REPRESENTATIVE_PHOTO = Pattern.compile("/tasks/([0-9]{1,19})/representative/([0-9]{1,19})/photo");
    private static final Pattern PHOTOS = Pattern.compile("/tasks/([0-9]{1,19})/photos");
    private static final Pattern PHOTO = Pattern.compile("/tasks/([0-9]{1,19})/photos/([0-9]{1,19})");
    private static final Pattern PHOTO_REJECT = Pattern.compile("/tasks/([0-9]{1,19})/photos/([0-9]{1,19})/reject");
    private static final Pattern CONFLICT_RESOLVE = Pattern.compile("/sync/conflicts/([A-Fa-f0-9-]{36})/resolve");
    private static final Pattern SHIFT_ACTION = Pattern.compile("/shifts/([0-9]{1,19})/(decision|transfer)");
    private static final Pattern INCIDENT_ACTION = Pattern.compile("/incidents/([0-9]{1,19})/(decision|transfer)");
    private static final Pattern TASK_TRANSFER = Pattern.compile("/tasks/([0-9]{1,19})/transfer");
    private static final Pattern PLANNING_TEMPLATE = Pattern.compile("/planning/templates/([0-9]{1,19})");
    private static final Pattern TRIP_ACTION = Pattern.compile("/trips/([0-9]{1,19})/(start|finish|report)");

    private record Attempts(long start, int count) {}
    private record Result(int status, Map<String, Object> body, byte[] image) {
        Result(int status, Map<String, Object> body) { this(status, body, null); }
    }

    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(env("QWORK_PORT", env("PORT", "8787")));
        if (args.length == 1 && args[0].equals("--health")) {
            try (var client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build()) {
                var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/health"))
                    .timeout(Duration.ofSeconds(3)).build();
                if (client.send(request, HttpResponse.BodyHandlers.discarding()).statusCode() != 200) {
                    System.exit(1);
                }
            }
            return;
        }
        if (!env("RENDER_SERVICE_ID", "").isBlank() && !Db.postgres()) {
            throw new IllegalStateException("Set QWORK_DATABASE_URL to PostgreSQL on Render.");
        }
        Db.initialize();
        var host = env("QWORK_HOST", "127.0.0.1");
        var server = HttpServer.create(new InetSocketAddress(host, port), 128);
        server.createContext("/", Main::handle);
        var executor = Executors.newVirtualThreadPerTaskExecutor();
        var scheduler = Executors.newSingleThreadScheduledExecutor();
        server.setExecutor(executor);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            scheduler.shutdownNow();
            server.stop(2);
            executor.shutdownNow();
        }));
        server.start();
        scheduler.scheduleWithFixedDelay(Main::runPlanning, 5, 30, TimeUnit.SECONDS);
        System.out.printf("qwork Java API listening on %s:%d%n", host, port);
    }

    private static void runPlanning() {
        try (var db = Db.connect(true)) {
            Planning.tick(db);
            db.commit();
        } catch (Exception error) {
            System.err.printf("qwork plan generation failure: %s%n", error.getClass().getSimpleName());
        }
        try {
            List<Long> companies;
            try (var db = Db.connect(false)) {
                companies = AutoAssignment.dueCompanies(db);
            }
            for (long company : companies) {
                try (var db = Db.connect(true)) {
                    AutoAssignment.runCompany(db, company);
                    db.commit();
                } catch (Exception error) {
                    System.err.printf("qwork automatic assignment failure: %s%n", error.getClass().getSimpleName());
                }
            }
        } catch (Exception error) {
            System.err.printf("qwork assignment scan failure: %s%n", error.getClass().getSimpleName());
        }
    }

    private static String env(String name, String fallback) {
        return System.getenv().getOrDefault(name, fallback);
    }

    private static void handle(HttpExchange exchange) throws IOException {
        try (exchange) {
            String path = exchange.getRequestURI().getPath().replaceFirst("/+$", "");
            String method = exchange.getRequestMethod();
            try {
                if ("GET".equals(method) && "/join".equals(path)) {
                    asset(exchange, "/join.html", "text/html; charset=utf-8");
                    return;
                }
                if ("GET".equals(method) && "/invite.js".equals(path)) {
                    asset(exchange, "/invite.js", "text/javascript; charset=utf-8");
                    return;
                }
                if ("GET".equals(method) && "/representative".equals(path)) {
                    asset(exchange, "/representative.html", "text/html; charset=utf-8");
                    return;
                }
                if ("GET".equals(method) && "/representative.js".equals(path)) {
                    asset(exchange, "/representative.js", "text/javascript; charset=utf-8");
                    return;
                }
                if ("GET".equals(method) && ("/verify-email".equals(path) || "/reset-password".equals(path))) {
                    asset(exchange, "/auth-mail.html", "text/html; charset=utf-8");
                    return;
                }
                if ("GET".equals(method) && "/auth-mail.js".equals(path)) {
                    asset(exchange, "/auth-mail.js", "text/javascript; charset=utf-8");
                    return;
                }
                if (!API_SLOTS.tryAcquire()) {
                    throw Domain.error(429, "Сервер занят. Попробуйте через минуту.");
                }
                Result result;
                try {
                    boolean post = "POST".equals(method);
                    boolean importing = post && ("/planning/import".equals(path) || "/planning/import/preview".equals(path));
                    boolean photoRequest = post && ("/sync/events".equals(path) || PHOTOS.matcher(path).matches()
                        || "/representative/decision".equals(path));
                    Semaphore slots = importing ? IMPORT_SLOTS : photoRequest ? PHOTO_REQUEST_SLOTS : null;
                    if (slots != null && !slots.tryAcquire()) {
                        throw Domain.error(429, importing
                            ? "Сейчас обрабатываются другие файлы Excel. Попробуйте снова."
                            : "Сервер обрабатывает другие фотографии. Попробуйте ещё раз.");
                    }
                    try {
                        result = route(exchange, method, path);
                    } finally {
                        if (slots != null) slots.release();
                    }
                } finally {
                    API_SLOTS.release();
                }
                if (result.image() == null) {
                    json(exchange, result.status(), result.body());
                } else {
                    exchange.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
                    String type = LosslessWebp.isWebp(result.image()) ? "image/webp" : "image/jpeg";
                    respond(exchange, result.status(), type, result.image());
                }
            } catch (Domain.Failure error) {
                json(exchange, error.status, Map.of("error", error.getMessage()));
            } catch (IOException error) {
                throw error;
            } catch (Exception error) {
                System.err.printf("qwork API failure: %s%n", error.getClass().getSimpleName());
                json(exchange, 500, Map.of("error", "Сервер не смог обработать запрос."));
            }
        }
    }

    private static Result route(HttpExchange exchange, String method, String path) throws Exception {
        if ("/health".equals(path) && ("GET".equals(method) || "HEAD".equals(method))) {
            try (var db = Db.connect(false)) {
                Db.one(db, "SELECT 1 FROM companies LIMIT 1");
            }
            return ok(Map.of("ok", true));
        }
        if ("POST".equals(method) && Set.of("/representative/preview", "/representative/decision").contains(path)) {
            limitAuthentication("representative:" + clientAddress(exchange));
            boolean decision = "/representative/decision".equals(path);
            var fields = payload(exchange, decision ? RepresentativeReviews.MAX_BODY : MAX_BODY);
            try (var db = Db.connect(decision)) {
                var response = decision ? RepresentativeReviews.decide(db, fields) : RepresentativeReviews.preview(db, fields);
                if (decision) db.commit();
                return ok(response);
            }
        }
        if ("POST".equals(method) && Set.of("/auth/register", "/auth/login", "/auth/email/verify",
                "/auth/password/request", "/auth/password/reset").contains(path)) {
            limitAuthentication(clientAddress(exchange));
            var payload = payload(exchange);
            if (!AUTH_SLOTS.tryAcquire()) {
                throw Domain.error(429, "Сервер занят. Попробуйте через минуту.");
            }
            try (var db = Db.connect(true)) {
                var result = switch (path) {
                    case "/auth/register" -> created(Accounts.register(db, payload));
                    case "/auth/login" -> ok(Accounts.login(db, payload));
                    case "/auth/email/verify" -> ok(Accounts.verifyEmail(db, payload));
                    case "/auth/password/request" -> ok(Accounts.requestPasswordReset(db, payload));
                    default -> ok(Accounts.resetPasswordByEmail(db, payload));
                };
                db.commit();
                return result;
            } finally {
                AUTH_SLOTS.release();
            }
        }

        var authorization = exchange.getRequestHeaders().getFirst("Authorization");
        if (authorization == null || !authorization.regionMatches(true, 0, "Bearer ", 0, 7)
                || !TOKEN.matcher(authorization.substring(7)).matches()) {
            throw Domain.error(401, "Войдите в qwork.");
        }
        var token = authorization.substring(7);
        if (("GET".equals(method) && "/analytics".equals(path))
                || ("POST".equals(method) && "/analytics/export".equals(path))) {
            if (!ANALYTICS_SLOTS.tryAcquire()) {
                throw Domain.error(429, "Сейчас формируются другие отчёты. Попробуйте снова.");
            }
            try {
                return analytics(exchange, token, "POST".equals(method));
            } finally {
                ANALYTICS_SLOTS.release();
            }
        }
        boolean write = ("POST".equals(method) && !"/planning/import/preview".equals(path)) || "PATCH".equals(method);
        var payload = switch (method + " " + path) {
            case "PATCH /auth/email" -> payload(exchange);
            case "POST /tasks" -> payload(exchange, MAX_REPORT_BODY);
            case "POST /employees", "POST /objects", "POST /shifts",
                 "POST /shifts/calendar", "POST /incidents", "POST /planning/templates",
                 "POST /planning/assignment-settings", "POST /field-work/defaults", "POST /trips",
                 "POST /field-control/work-mode" -> payload(exchange);
            case "POST /planning/import", "POST /planning/import/preview" -> payload(exchange, MAX_IMPORT_BODY);
            case "POST /sync/events" -> payload(exchange, MAX_PHOTO_BODY);
            default -> {
                if ("PATCH".equals(method) && TASK.matcher(path).matches()) {
                    yield payload(exchange, MAX_REPORT_BODY);
                }
                if ("POST".equals(method) && PHOTOS.matcher(path).matches()) {
                    yield payload(exchange, MAX_PHOTO_BODY);
                }
                if (("PATCH".equals(method) && (PLANNING_TEMPLATE.matcher(path).matches()
                            || EMPLOYEE_DEPARTMENT.matcher(path).matches()))
                        || ("POST".equals(method) && (REPEAT.matcher(path).matches() || PHOTO_REJECT.matcher(path).matches()
                            || SHIFT_ACTION.matcher(path).matches() || INCIDENT_ACTION.matcher(path).matches()
                            || TASK_TRANSFER.matcher(path).matches() || EMPLOYEE_PASSWORD.matcher(path).matches()))) {
                    yield payload(exchange);
                }
                yield Map.<String, Object>of();
            }
        };
        try (var db = Db.connect(write)) {
            var user = Accounts.authenticate(db, token);
            var result = authenticated(db, user, token, method, path, payload,
                "original=1".equals(exchange.getRequestURI().getRawQuery()));
            if (write) {
                db.commit();
            }
            return result;
        }
    }

    private static Result analytics(HttpExchange exchange, String token, boolean export) throws Exception {
        Map<String, String> filters;
        String format = "";
        if (export) {
            var fields = new LinkedHashMap<>(payload(exchange));
            format = Domain.field(fields, "format", "Формат отчёта", 4, false);
            if (!"xlsx".equals(format) && !"pdf".equals(format)) {
                throw Domain.error(400, "Выберите формат Excel или PDF.");
            }
            fields.remove("format");
            filters = new LinkedHashMap<>();
            for (var field : fields.entrySet()) {
                if (!ANALYTICS_FILTERS.contains(field.getKey()) || !(field.getValue() instanceof String value)) {
                    throw Domain.error(400, "Проверьте фильтры отчёта.");
                }
                filters.put(field.getKey(), value);
            }
        } else {
            filters = analyticsQuery(exchange.getRequestURI().getRawQuery());
        }
        Map<String, Object> report;
        try (var db = Db.connect(false)) {
            if (Db.postgres()) db.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
            var user = Accounts.authenticate(db, token);
            report = Analytics.report(db, user, filters);
        }
        if (!export) return ok(report);
        boolean spreadsheet = "xlsx".equals(format);
        byte[] file = spreadsheet ? AnalyticsExport.xlsx(report) : AnalyticsExport.pdf(report);
        return ok(Map.of(
            "base64", Base64.getEncoder().encodeToString(file),
            "filename", "qwork-analytics." + format,
            "mimeType", spreadsheet ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                : "application/pdf"));
    }

    private static Map<String, String> analyticsQuery(String query) {
        var filters = new LinkedHashMap<String, String>();
        if (query == null || query.isBlank()) return filters;
        if (query.length() > MAX_BODY) throw Domain.error(400, "Проверьте фильтры отчёта.");
        try {
            for (String part : query.split("&")) {
                String[] pair = part.split("=", 2);
                String key = URLDecoder.decode(pair[0], StandardCharsets.UTF_8);
                if (pair.length != 2 || !ANALYTICS_FILTERS.contains(key)
                        || filters.putIfAbsent(key, URLDecoder.decode(pair[1], StandardCharsets.UTF_8)) != null) {
                    throw Domain.error(400, "Проверьте фильтры отчёта.");
                }
            }
        } catch (IllegalArgumentException error) {
            throw Domain.error(400, "Проверьте фильтры отчёта.");
        }
        return filters;
    }

    private static Result authenticated(Connection db, Map<String, Object> user, String token,
                                        String method, String path, Map<String, Object> payload,
                                        boolean original) throws Exception {
        switch (method + " " + path) {
            case "POST /auth/logout":
                Db.update(db, "DELETE FROM sessions WHERE token_hash = ?", Accounts.tokenDigest(token));
                return ok(Map.of("ok", true));
            case "GET /auth/me":
                var profile = new LinkedHashMap<>(Accounts.me(db, user));
                profile.put("emailSendingAvailable", Mailer.configured());
                return ok(profile);
            case "PATCH /auth/email": return ok(Accounts.setEmail(db, user, payload));
            case "POST /auth/email/request": return ok(Accounts.requestEmailVerification(db, user));
            case "GET /employees": return ok(Accounts.listEmployees(db, user));
            case "POST /employees": return created(Accounts.createEmployee(db, user, payload));
            case "GET /tasks": return ok(Tasks.listTasks(db, user));
            case "POST /tasks": return created(Tasks.createTask(db, user, payload));
            case "GET /objects": return ok(Places.list(db, user));
            case "POST /objects": return created(Places.create(db, user, payload));
            case "GET /field-work/defaults": return ok(FieldWork.defaults(db, user));
            case "POST /field-work/defaults": return ok(FieldWork.saveDefault(db, user, payload));
            case "GET /trips": return ok(Trips.list(db, user));
            case "POST /trips": return created(Trips.create(db, user, payload));
            case "GET /field-control": return ok(FieldControl.dashboard(db, user));
            case "POST /field-control/work-mode": return ok(FieldControl.setWorkMode(db, user, payload));
            case "POST /sync/events": return ok(Sync.apply(db, user, payload));
            case "GET /sync/conflicts": return ok(Sync.conflicts(db, user));
            case "GET /shifts": return ok(Shift.list(db, user));
            case "POST /shifts": return created(Shift.create(db, user, payload));
            case "POST /shifts/calendar":
                var savedDay = Shift.saveDay(db, user, payload);
                Planning.calendarChanged(db, Domain.number(user, "company_id"));
                return ok(savedDay);
            case "GET /incidents": return ok(Incidents.list(db, user));
            case "POST /incidents": return created(Incidents.create(db, user, payload));
            case "GET /planning/templates": return ok(Planning.list(db, user));
            case "POST /planning/templates": return created(Planning.save(db, user, null, payload));
            case "POST /planning/generate": return ok(Planning.generate(db, user));
            case "POST /planning/import/preview": return ok(XlsxImport.process(db, user, payload, false));
            case "POST /planning/import": return ok(XlsxImport.process(db, user, payload, true));
            case "GET /planning/jobs": return ok(AutoAssignment.list(db, user));
            case "POST /planning/assign": return ok(AutoAssignment.run(db, user));
            case "GET /planning/assignment-settings": return ok(AutoAssignment.settings(db, user, null));
            case "POST /planning/assignment-settings": return ok(AutoAssignment.settings(db, user, payload));
            default: break;
        }
        var conflict = CONFLICT_RESOLVE.matcher(path);
        if ("POST".equals(method) && conflict.matches()) {
            return ok(Sync.resolve(db, user, conflict.group(1)));
        }
        var trip = TRIP_ACTION.matcher(path);
        if (trip.matches()) {
            long tripId = id(trip.group(1));
            String action = trip.group(2);
            if ("GET".equals(method) && "report".equals(action)) return ok(Trips.report(db, user, tripId));
            if ("POST".equals(method) && !"report".equals(action)) return ok(Trips.act(db, user, tripId, action));
        }
        var representative = REPRESENTATIVE.matcher(path);
        if (representative.matches()) {
            long taskId = id(representative.group(1));
            if ("GET".equals(method)) return ok(RepresentativeReviews.summary(db, user, taskId));
            if ("POST".equals(method)) return created(RepresentativeReviews.issue(db, user, taskId));
        }
        var representativePhoto = REPRESENTATIVE_PHOTO.matcher(path);
        if ("GET".equals(method) && representativePhoto.matches()) {
            return new Result(200, null, RepresentativeReviews.photo(db, user,
                id(representativePhoto.group(1)), id(representativePhoto.group(2))));
        }
        if ("POST".equals(method)) {
            var shift = SHIFT_ACTION.matcher(path);
            if (shift.matches()) {
                long shiftId = id(shift.group(1));
                return ok("decision".equals(shift.group(2)) ? Shift.decide(db, user, shiftId, payload)
                    : Shift.transfer(db, user, shiftId, payload));
            }
            var incident = INCIDENT_ACTION.matcher(path);
            if (incident.matches()) {
                long incidentId = id(incident.group(1));
                return ok("decision".equals(incident.group(2)) ? Incidents.decide(db, user, incidentId, payload)
                    : Incidents.transfer(db, user, incidentId, payload));
            }
            var handoff = TASK_TRANSFER.matcher(path);
            if (handoff.matches()) {
                long assigneeId = Incidents.id(payload, "assigneeId", "Исполнитель");
                return ok(Incidents.reassign(db, user, id(handoff.group(1)), assigneeId));
            }
        }
        var invite = EMPLOYEE_INVITE.matcher(path);
        if ("POST".equals(method) && invite.matches()) {
            return created(Accounts.reissueInvite(db, user, id(invite.group(1))));
        }
        var department = EMPLOYEE_DEPARTMENT.matcher(path);
        if ("PATCH".equals(method) && department.matches()) {
            return ok(Accounts.setDepartment(db, user, id(department.group(1)), payload));
        }
        var passwordReset = EMPLOYEE_PASSWORD.matcher(path);
        if ("POST".equals(method) && passwordReset.matches()) {
            return ok(Accounts.resetPassword(db, user, id(passwordReset.group(1)), payload));
        }
        var task = TASK.matcher(path);
        if ("PATCH".equals(method) && task.matches()) {
            return ok(Tasks.updateTask(db, user, id(task.group(1)), payload));
        }
        var template = PLANNING_TEMPLATE.matcher(path);
        if ("PATCH".equals(method) && template.matches()) {
            return ok(Planning.save(db, user, id(template.group(1)), payload));
        }
        var repeat = REPEAT.matcher(path);
        if ("POST".equals(method) && repeat.matches()) {
            return created(Tasks.repeatTask(db, user, id(repeat.group(1)), payload));
        }
        var photos = PHOTOS.matcher(path);
        if (photos.matches()) {
            long taskId = id(photos.group(1));
            if ("GET".equals(method)) {
                return ok(Media.list(db, user, taskId));
            }
            if ("POST".equals(method)) {
                var response = new LinkedHashMap<>(Media.upload(db, user, taskId, payload));
                response.putAll(Tasks.taskResponse(db, user, taskId));
                return created(response);
            }
        }
        var photo = PHOTO.matcher(path);
        if ("GET".equals(method) && photo.matches()) {
            return new Result(200, null, Media.read(db, user, id(photo.group(1)), id(photo.group(2)), original));
        }
        var rejection = PHOTO_REJECT.matcher(path);
        if ("POST".equals(method) && rejection.matches()) {
            long taskId = id(rejection.group(1));
            var response = new LinkedHashMap<>(Media.reject(db, user, taskId, id(rejection.group(2)), payload));
            response.putAll(Tasks.taskResponse(db, user, taskId));
            return ok(response);
        }
        throw Domain.error(404, "Маршрут не найден.");
    }

    private static long id(String value) {
        try {
            return Long.parseLong(value);
        } catch (NumberFormatException error) {
            throw Domain.error(404, "Маршрут не найден.");
        }
    }

    private static Map<String, Object> payload(HttpExchange exchange) throws IOException {
        return payload(exchange, MAX_BODY);
    }

    private static Map<String, Object> payload(HttpExchange exchange, int limit) throws IOException {
        byte[] body = exchange.getRequestBody().readNBytes(limit + 1);
        if (body.length == 0 || body.length > limit) {
            throw Domain.error(400, "Некорректный размер запроса.");
        }
        try {
            Map<String, Object> value = Db.JSON.readerFor(new TypeReference<Map<String, Object>>() {})
                .with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readValue(body);
            if (value == null) {
                throw Domain.error(400, "Ожидается объект JSON.");
            }
            return value;
        } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
            throw Domain.error(400, "Некорректный JSON. Ожидается объект JSON.");
        }
    }

    private static String clientAddress(HttpExchange exchange) {
        List<String> forwarded = CLIENT_IP_HEADER == null ? null : exchange.getRequestHeaders().get(CLIENT_IP_HEADER);
        if (forwarded != null && forwarded.size() == 1) {
            var value = forwarded.getFirst().strip();
            try {
                if (value.contains(":") && value.matches("[0-9A-Fa-f:.]+")) {
                    return InetAddress.getByName(value).getHostAddress();
                }
                if (value.matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}")) {
                    return InetAddress.getByName(value).getHostAddress();
                }
            } catch (java.net.UnknownHostException ignored) {
                // Only numeric addresses set by the trusted proxy are accepted.
            }
        }
        return exchange.getRemoteAddress().getAddress().getHostAddress();
    }

    private static synchronized void limitAuthentication(String address) {
        long now = System.nanoTime();
        var previous = ATTEMPTS.get(address);
        if (previous == null || now - previous.start() >= Duration.ofSeconds(AUTH_WINDOW_SECONDS).toNanos()) {
            previous = new Attempts(now, 0);
        }
        if (previous.count() >= 12) {
            throw Domain.error(429, "Слишком много попыток. Попробуйте через минуту.");
        }
        ATTEMPTS.put(address, new Attempts(previous.start(), previous.count() + 1));
        if (ATTEMPTS.size() > 4096) {
            ATTEMPTS.remove(ATTEMPTS.keySet().iterator().next());
        }
    }

    private static Result ok(Map<String, Object> body) {
        return new Result(200, body);
    }

    private static Result created(Map<String, Object> body) {
        return new Result(201, body);
    }

    private static void json(HttpExchange exchange, int status, Map<String, Object> data) throws IOException {
        if (status == 429) {
            exchange.getResponseHeaders().set("Retry-After", String.valueOf(AUTH_WINDOW_SECONDS));
        }
        respond(exchange, status, "application/json; charset=utf-8", Db.JSON.writeValueAsBytes(data));
    }

    private static void asset(HttpExchange exchange, String path, String type) throws IOException {
        try (var stream = Main.class.getResourceAsStream(path)) {
            if (stream == null) {
                throw Domain.error(404, "Страница не найдена.");
            }
            var headers = exchange.getResponseHeaders();
            headers.set("Referrer-Policy", "no-referrer");
            headers.set("X-Content-Type-Options", "nosniff");
            headers.set("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; "
                + "base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
            respond(exchange, 200, type, stream.readAllBytes());
        }
    }

    private static void respond(HttpExchange exchange, int status, String type, byte[] data) throws IOException {
        exchange.getResponseHeaders().set("Content-Type", type);
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        if ("HEAD".equals(exchange.getRequestMethod())) {
            exchange.getResponseHeaders().set("Content-Length", String.valueOf(data.length));
            exchange.sendResponseHeaders(status, -1);
            return;
        }
        exchange.sendResponseHeaders(status, data.length);
        exchange.getResponseBody().write(data);
    }
}
