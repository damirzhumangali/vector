package qwork;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.DeserializationFeature;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.net.InetAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.sql.Connection;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Semaphore;
import java.util.regex.Pattern;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

@RestController
final class QworkApiController {
    private static final int MAX_BODY = 16_384;
    private static final int MAX_PHOTO_BODY = ((Media.MAX_IMAGE_BYTES + 2) / 3) * 4 + MAX_BODY;
    private static final int MAX_IMPORT_BODY = ((XlsxImport.MAX_BYTES + 2) / 3) * 4 + 1024;
    private static final int MAX_REPORT_BODY = 128 * 1024;
    private static final int AUTH_WINDOW_SECONDS = 60;
    private static final String CLIENT_IP_HEADER = switch (System.getenv().getOrDefault("QWORK_TRUST_PROXY", "")) {
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
    private static final Pattern CONTRACT = Pattern.compile("/contracts/([0-9]{1,19})");
    private static final Pattern CONTRACT_ACTIVATION = Pattern.compile("/contracts/([0-9]{1,19})/activate");
    private static final Pattern CONTRACT_RECEIPTS = Pattern.compile("/contracts/([0-9]{1,19})/receipts");
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
    private static final Pattern TRIP_TASKS = Pattern.compile("/trips/([0-9]{1,19})/tasks");
    private static final Pattern TRIP_BUDGET = Pattern.compile("/trips/([0-9]{1,19})/(budget|estimate)");
    private static final Pattern TRIP_ACTUAL_EXPENSES = Pattern.compile("/trips/([0-9]{1,19})/actual-expenses");
    private static final Pattern TRIP_STOP = Pattern.compile("/trips/([0-9]{1,19})/stops/([0-9]{1,19})");
    private static final Pattern TRIP_REQUEST_DECISION = Pattern.compile("/trip-requests/([0-9]{1,19})/decision");
    private static final Pattern TRIP_OFFER_ACTION = Pattern.compile("/trip-offers/([0-9]{1,19})/(proposal|confirm|revise|decline|approval)");

    private record Attempts(long start, int count) {}
    private record Result(int status, Map<String, Object> body, byte[] image) {
        Result(int status, Map<String, Object> body) { this(status, body, null); }
    }

    @RequestMapping(path = "/**", method = {RequestMethod.GET, RequestMethod.HEAD, RequestMethod.POST,
        RequestMethod.PATCH, RequestMethod.PUT, RequestMethod.DELETE, RequestMethod.OPTIONS, RequestMethod.TRACE})
    void handle(HttpServletRequest request, HttpServletResponse response) throws IOException {
        String path = URI.create(request.getRequestURI()).getPath().replaceFirst("/+$", "");
        String method = request.getMethod();
        boolean head = "HEAD".equals(method);
        try {
            if ("GET".equals(method) && "/join".equals(path)) {
                asset(response, "/join.html", "text/html; charset=utf-8");
                return;
            }
            if ("GET".equals(method) && "/invite.js".equals(path)) {
                asset(response, "/invite.js", "text/javascript; charset=utf-8");
                return;
            }
            if ("GET".equals(method) && "/representative".equals(path)) {
                asset(response, "/representative.html", "text/html; charset=utf-8");
                return;
            }
            if ("GET".equals(method) && "/representative.js".equals(path)) {
                asset(response, "/representative.js", "text/javascript; charset=utf-8");
                return;
            }
            if ("GET".equals(method) && ("/verify-email".equals(path) || "/reset-password".equals(path))) {
                asset(response, "/auth-mail.html", "text/html; charset=utf-8");
                return;
            }
            if ("GET".equals(method) && "/auth-mail.js".equals(path)) {
                asset(response, "/auth-mail.js", "text/javascript; charset=utf-8");
                return;
            }
            if (!API_SLOTS.tryAcquire()) {
                throw Domain.error(429, "Сервер занят. Попробуйте через минуту.");
            }
            Result result;
            try {
                boolean post = "POST".equals(method);
                boolean importing = post && ("/planning/import".equals(path) || "/planning/import/preview".equals(path)
                    || "/trip-offers/import".equals(path));
                boolean photoRequest = post && ("/sync/events".equals(path) || PHOTOS.matcher(path).matches()
                    || "/representative/decision".equals(path));
                Semaphore slots = importing ? IMPORT_SLOTS : photoRequest ? PHOTO_REQUEST_SLOTS : null;
                if (slots != null && !slots.tryAcquire()) {
                    throw Domain.error(429, importing
                        ? "Сейчас обрабатываются другие файлы Excel. Попробуйте снова."
                        : "Сервер обрабатывает другие фотографии. Попробуйте ещё раз.");
                }
                try {
                    result = route(request, method, path);
                } finally {
                    if (slots != null) slots.release();
                }
            } finally {
                API_SLOTS.release();
            }
            if (result.image() == null) {
                json(response, head, result.status(), result.body());
            } else {
                response.setHeader("X-Content-Type-Options", "nosniff");
                respond(response, head, result.status(), Media.contentType(result.image()), result.image());
            }
        } catch (Domain.Failure error) {
            json(response, head, error.status, error.code == null ? Map.of("error", error.getMessage())
                : Map.of("error", error.getMessage(), "code", error.code));
        } catch (IOException error) {
            throw error;
        } catch (Exception error) {
            System.err.printf("qwork API failure: %s%n", error.getClass().getSimpleName());
            json(response, head, 500, Map.of("error", "Сервер не смог обработать запрос."));
        }
    }

    private static Result route(HttpServletRequest request, String method, String path) throws Exception {
        if ("/health".equals(path) && ("GET".equals(method) || "HEAD".equals(method))) {
            try (var db = Db.connect(false)) {
                Db.one(db, "SELECT 1 FROM companies LIMIT 1");
            }
            return ok(Map.of("ok", true));
        }
        if ("POST".equals(method) && Set.of("/representative/preview", "/representative/decision").contains(path)) {
            limitAuthentication("representative:" + clientAddress(request));
            boolean decision = "/representative/decision".equals(path);
            var fields = payload(request, decision ? RepresentativeReviews.MAX_BODY : MAX_BODY);
            try (var db = Db.connect(decision)) {
                var response = decision ? RepresentativeReviews.decide(db, fields) : RepresentativeReviews.preview(db, fields);
                if (decision) db.commit();
                return ok(response);
            }
        }
        if ("POST".equals(method) && Set.of("/auth/register", "/auth/login", "/auth/email/verify",
                "/auth/password/request", "/auth/password/reset").contains(path)) {
            limitAuthentication(clientAddress(request));
            var payload = payload(request);
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

        var authorization = request.getHeader("Authorization");
        if (authorization == null || !authorization.regionMatches(true, 0, "Bearer ", 0, 7)
                || !TOKEN.matcher(authorization.substring(7)).matches()) {
            throw Domain.error(401, "Войдите в qwork.");
        }
        var token = authorization.substring(7);
        if (("GET".equals(method) && ("/analytics".equals(path) || "/analytics/trip-expenses".equals(path)))
                || ("POST".equals(method) && "/analytics/export".equals(path))) {
            if (!ANALYTICS_SLOTS.tryAcquire()) {
                throw Domain.error(429, "Сейчас формируются другие отчёты. Попробуйте снова.");
            }
            try {
                return analytics(request, token, path);
            } finally {
                ANALYTICS_SLOTS.release();
            }
        }
        boolean write = ("POST".equals(method) && !"/planning/import/preview".equals(path)) || "PATCH".equals(method)
            || ("PUT".equals(method) && CONTRACT.matcher(path).matches());
        var payload = switch (method + " " + path) {
            case "PATCH /auth/email" -> payload(request);
            case "POST /tasks" -> payload(request, MAX_REPORT_BODY);
            case "POST /employees", "POST /objects", "POST /shifts", "POST /notifications/device",
                 "POST /shifts/calendar", "POST /incidents", "POST /planning/templates",
                 "POST /planning/assignment-settings", "POST /field-work/defaults", "POST /trip-approval-settings",
                 "POST /field-control/work-mode", "POST /trip-offers", "POST /trip-organizations",
                 "POST /contracts" -> payload(request);
            case "POST /planning/import", "POST /planning/import/preview", "POST /trip-offers/import" -> payload(request, MAX_IMPORT_BODY);
            case "POST /sync/events" -> payload(request, MAX_PHOTO_BODY);
            default -> {
                if (("PUT".equals(method) && CONTRACT.matcher(path).matches())
                        || ("POST".equals(method) && (CONTRACT_ACTIVATION.matcher(path).matches()
                            || CONTRACT_RECEIPTS.matcher(path).matches()))) {
                    yield payload(request);
                }
                if ("PATCH".equals(method) && TASK.matcher(path).matches()) {
                    yield payload(request, MAX_REPORT_BODY);
                }
                if ("POST".equals(method) && PHOTOS.matcher(path).matches()) {
                    yield payload(request, MAX_PHOTO_BODY);
                }
                if (("PATCH".equals(method) && (PLANNING_TEMPLATE.matcher(path).matches()
                            || EMPLOYEE_DEPARTMENT.matcher(path).matches()))
                        || ("POST".equals(method) && (REPEAT.matcher(path).matches() || PHOTO_REJECT.matcher(path).matches()
                            || SHIFT_ACTION.matcher(path).matches() || INCIDENT_ACTION.matcher(path).matches()
                            || TASK_TRANSFER.matcher(path).matches() || EMPLOYEE_PASSWORD.matcher(path).matches()
                            || TRIP_TASKS.matcher(path).matches() || TRIP_BUDGET.matcher(path).matches()
                            || TRIP_ACTUAL_EXPENSES.matcher(path).matches() || TRIP_STOP.matcher(path).matches()
                            || TRIP_REQUEST_DECISION.matcher(path).matches() || TRIP_OFFER_ACTION.matcher(path).matches()))) {
                    yield payload(request);
                }
                yield Map.<String, Object>of();
            }
        };
        try (var db = Db.connect(write)) {
            if (Db.postgres() && "GET".equals(method) && ("/contracts".equals(path) || CONTRACT.matcher(path).matches()
                    || "/trip-offers".equals(path)
                    || (path.endsWith("/report") && TRIP_ACTION.matcher(path).matches()))) {
                db.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
            } else if (Db.postgres() && "POST".equals(method)
                    && ("/trip-offers/import".equals(path) || "/trip-organizations".equals(path)
                        || "/trip-offers".equals(path) || "/trip-approval-settings".equals(path)
                        || TRIP_OFFER_ACTION.matcher(path).matches() || CONTRACT_RECEIPTS.matcher(path).matches())) {
                db.setTransactionIsolation(Connection.TRANSACTION_READ_COMMITTED);
            }
            var user = Accounts.authenticate(db, token);
            var result = authenticated(db, user, token, method, path, payload,
                "original=1".equals(request.getQueryString()));
            if (write) {
                db.commit();
            }
            return result;
        }
    }

    private static Result analytics(HttpServletRequest request, String token, String path) throws Exception {
        boolean export = "/analytics/export".equals(path);
        Map<String, String> filters;
        String format = "";
        if (export) {
            var fields = new LinkedHashMap<>(payload(request));
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
            filters = analyticsQuery(request.getQueryString());
        }
        Map<String, Object> report;
        try (var db = Db.connect(false)) {
            if (Db.postgres()) db.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
            var user = Accounts.authenticate(db, token);
            report = "/analytics/trip-expenses".equals(path)
                ? TripExpenseAnalytics.report(db, user, filters)
                : Analytics.report(db, user, filters);
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
        String operation = method + " " + path;
        if (Accounts.isAccountant(user) && !accountantOperation(operation, method, path)) {
            throw Domain.error(403, "Бухгалтеру доступны договоры и настройки своего аккаунта.");
        }
        switch (operation) {
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
            case "GET /contracts": return ok(Contracts.list(db, user));
            case "POST /contracts": return created(Contracts.create(db, user, payload));
            case "GET /field-work/defaults": return ok(FieldWork.defaults(db, user));
            case "POST /field-work/defaults": return ok(FieldWork.saveDefault(db, user, payload));
            case "GET /trips": return ok(Trips.list(db, user));
            case "POST /trips", "POST /trip-requests":
                throw Domain.error(403, "Сотрудник отправляет командировку на согласование в разделе «Выезды».");
            case "GET /trip-requests": return ok(TripRequests.list(db, user));
            case "GET /trip-offers": return ok(TripOffers.list(db, user));
            case "GET /trip-destinations": return ok(Places.tripDestinations(db, user));
            case "GET /trip-approval-settings": return ok(TripApprovals.settings(db, user));
            case "POST /trip-approval-settings": return ok(TripApprovals.saveSettings(db, user, payload));
            case "POST /trip-organizations": return ok(TripOrganizations.save(db, user, payload));
            case "GET /trip-offers/import/template": return ok(TripXlsxImport.template(user));
            case "POST /trip-offers": return created(TripOffers.create(db, user, payload));
            case "POST /trip-offers/import": return ok(TripXlsxImport.process(db, user, payload));
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
            case "POST /notifications/device": return ok(IncidentPush.register(db, token, payload));
            case "GET /planning/templates": return ok(Planning.list(db, user));
            case "POST /planning/templates": return created(Planning.save(db, user, null, payload));
            case "POST /planning/generate": return ok(Planning.generate(db, user));
            case "POST /planning/import/preview": return ok(XlsxImport.process(db, user, payload, false));
            case "POST /planning/import": return ok(XlsxImport.process(db, user, payload, true));
            case "GET /planning/imports": return ok(XlsxImport.journal(db, user));
            case "GET /planning/jobs": return ok(AutoAssignment.list(db, user));
            case "POST /planning/assign": return ok(AutoAssignment.run(db, user));
            case "GET /planning/assignment-settings": return ok(AutoAssignment.settings(db, user, null));
            case "POST /planning/assignment-settings": return ok(AutoAssignment.settings(db, user, payload));
            default: break;
        }
        var contract = CONTRACT.matcher(path);
        if (contract.matches()) {
            long contractId = id(contract.group(1));
            if ("GET".equals(method)) return ok(Contracts.detail(db, user, contractId));
            if ("PUT".equals(method)) return ok(Contracts.update(db, user, contractId, payload));
        }
        var contractActivation = CONTRACT_ACTIVATION.matcher(path);
        if ("POST".equals(method) && contractActivation.matches()) {
            return ok(Contracts.activate(db, user, id(contractActivation.group(1)), payload));
        }
        var contractReceipts = CONTRACT_RECEIPTS.matcher(path);
        if ("POST".equals(method) && contractReceipts.matches()) {
            return created(Contracts.recordReceipt(db, user, id(contractReceipts.group(1)), payload));
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
        var tripTasks = TRIP_TASKS.matcher(path);
        if ("POST".equals(method) && tripTasks.matches()) {
            return ok(Trips.attachTasks(db, user, id(tripTasks.group(1)), payload));
        }
        var tripBudget = TRIP_BUDGET.matcher(path);
        if ("POST".equals(method) && tripBudget.matches()) {
            return ok(Trips.updateBudget(db, user, id(tripBudget.group(1)), "estimate".equals(tripBudget.group(2)), payload));
        }
        var tripExpenses = TRIP_ACTUAL_EXPENSES.matcher(path);
        if ("POST".equals(method) && tripExpenses.matches()) {
            return ok(TripActualExpenses.save(db, user, id(tripExpenses.group(1)), payload));
        }
        var tripStop = TRIP_STOP.matcher(path);
        if ("POST".equals(method) && tripStop.matches()) {
            return ok(TripRoutes.record(db, user, id(tripStop.group(1)), id(tripStop.group(2)), payload));
        }
        var tripRequest = TRIP_REQUEST_DECISION.matcher(path);
        if ("POST".equals(method) && tripRequest.matches()) {
            return ok(TripRequests.decide(db, user, id(tripRequest.group(1)), payload));
        }
        var offer = TRIP_OFFER_ACTION.matcher(path);
        if ("POST".equals(method) && offer.matches()) {
            long offerId = id(offer.group(1));
            return ok(switch (offer.group(2)) {
                case "proposal" -> TripOffers.propose(db, user, offerId, payload);
                case "confirm" -> TripOffers.confirm(db, user, offerId, payload);
                case "revise" -> TripOffers.revise(db, user, offerId, payload);
                case "decline" -> TripOffers.decline(db, user, offerId, payload);
                case "approval" -> TripOffers.approve(db, user, offerId, payload);
                default -> throw Domain.error(404, "Маршрут не найден.");
            });
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

    private static boolean accountantOperation(String operation, String method, String path) {
        return switch (operation) {
            case "GET /auth/me", "POST /auth/logout", "PATCH /auth/email", "POST /auth/email/request", "GET /contracts" -> true;
            default -> ("GET".equals(method) && CONTRACT.matcher(path).matches())
                || ("POST".equals(method) && CONTRACT_RECEIPTS.matcher(path).matches());
        };
    }

    private static Map<String, Object> payload(HttpServletRequest request) throws IOException {
        return payload(request, MAX_BODY);
    }

    private static Map<String, Object> payload(HttpServletRequest request, int limit) throws IOException {
        byte[] body = request.getInputStream().readNBytes(limit + 1);
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

    private static String clientAddress(HttpServletRequest request) {
        var forwarded = CLIENT_IP_HEADER == null ? List.<String>of() : Collections.list(request.getHeaders(CLIENT_IP_HEADER));
        if (forwarded.size() == 1) {
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
        return request.getRemoteAddr();
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

    private static void json(HttpServletResponse response, boolean head, int status, Map<String, Object> data) throws IOException {
        if (status == 429) {
            response.setHeader("Retry-After", String.valueOf(AUTH_WINDOW_SECONDS));
        }
        respond(response, head, status, "application/json; charset=utf-8", Db.JSON.writeValueAsBytes(data));
    }

    private static void asset(HttpServletResponse response, String path, String type) throws IOException {
        try (var stream = QworkApiController.class.getResourceAsStream(path)) {
            if (stream == null) {
                throw Domain.error(404, "Страница не найдена.");
            }
            response.setHeader("Referrer-Policy", "no-referrer");
            response.setHeader("X-Content-Type-Options", "nosniff");
            response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; "
                + "base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
            respond(response, false, 200, type, stream.readAllBytes());
        }
    }

    private static void respond(HttpServletResponse response, boolean head, int status, String type, byte[] data)
            throws IOException {
        response.setStatus(status);
        response.setContentType(type);
        response.setHeader("Cache-Control", "no-store");
        response.setContentLength(data.length);
        if (!head) response.getOutputStream().write(data);
    }
}
