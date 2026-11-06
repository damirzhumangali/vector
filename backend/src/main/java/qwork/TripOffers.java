package qwork;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

import static qwork.Domain.error;
import static qwork.Domain.field;
import static qwork.Domain.number;

final class TripOffers {
    static final String SQLITE_SCHEMA = """
        CREATE TABLE IF NOT EXISTS work_trip_offers (
            id INTEGER PRIMARY KEY,
            company_id INTEGER NOT NULL REFERENCES companies(id),
            employee_id INTEGER NOT NULL REFERENCES users(id),
            created_by INTEGER NOT NULL REFERENCES users(id),
            request_id TEXT,
            destination TEXT NOT NULL, object_id INTEGER REFERENCES work_sites(id), address TEXT NOT NULL,
            purpose TEXT NOT NULL, comment TEXT NOT NULL,
            planned_start TEXT, planned_end TEXT,
            daily_rate INTEGER CHECK (daily_rate BETWEEN 0 AND 999999999),
            proposed_at TEXT,
            trip_id INTEGER UNIQUE REFERENCES work_trips(id),
            confirmed_at TEXT, confirmed_by INTEGER REFERENCES users(id),
            revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
            UNIQUE (company_id, created_by, request_id),
            CHECK ((planned_start IS NULL) = (planned_end IS NULL)),
            CHECK ((planned_start IS NULL) = (daily_rate IS NULL)),
            CHECK ((planned_start IS NULL) = (proposed_at IS NULL)),
            CHECK (planned_start IS NULL OR planned_end > planned_start),
            CHECK (trip_id IS NULL OR planned_start IS NOT NULL),
            CHECK ((trip_id IS NULL) = (confirmed_at IS NULL)),
            CHECK ((trip_id IS NULL) = (confirmed_by IS NULL))
        );
        CREATE INDEX IF NOT EXISTS work_trip_offers_by_company_employee
            ON work_trip_offers(company_id, employee_id, created_at);
        CREATE TABLE IF NOT EXISTS work_trip_offer_history (
            offer_id INTEGER NOT NULL REFERENCES work_trip_offers(id),
            revision INTEGER NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('proposal', 'revision_requested', 'declined', 'confirmed')),
            actor_id INTEGER NOT NULL REFERENCES users(id),
            happened_at TEXT NOT NULL,
            reason TEXT NOT NULL,
            planned_start TEXT, planned_end TEXT, proposed_at TEXT, proposal_estimate TEXT,
            PRIMARY KEY (offer_id, revision),
            CHECK ((planned_start IS NULL) = (planned_end IS NULL)),
            CHECK ((planned_start IS NULL) = (proposed_at IS NULL)),
            CHECK ((planned_start IS NULL) = (proposal_estimate IS NULL))
        );
        """;

    private static final String SELECT = """
        SELECT r.*, employee.name AS employee_name
        FROM work_trip_offers r
        JOIN users employee ON employee.id = r.employee_id AND employee.company_id = r.company_id
        WHERE r.company_id = ?
        """;

    private record Proposal(String start, String end, String at, TripBudget estimate) {
        static Proposal from(Map<String, Object> row) {
            if (row.get("planned_start") == null) return null;
            var estimate = TripBudget.load(row.get("proposal_estimate"));
            if (estimate == null) estimate = new TripBudget(number(row, "daily_rate"), 0, 0, 0, 0);
            return new Proposal((String) row.get("planned_start"), (String) row.get("planned_end"),
                (String) row.get("proposed_at"), estimate);
        }
    }

    private TripOffers() {}

    static Map<String, Object> list(Connection db, Map<String, Object> user) throws SQLException {
        long company = number(user, "company_id");
        boolean employee = Trips.isEmployee(user);
        String scope = employee ? " AND r.employee_id = ?" : "";
        Object[] parameters = employee ? new Object[] {company, number(user, "id")} : new Object[] {company};
        var rows = Db.rows(db, SELECT + scope + " ORDER BY r.created_at DESC, r.id DESC", parameters);
        return Map.of("offers", details(db, rows, scope, parameters), "supportsTripRoutes", true, "supportsTripImport", true);
    }

    static Map<String, Object> create(Connection db, Map<String, Object> user, Map<String, Object> body) throws SQLException {
        return result(db, find(db, user, createId(db, user, body)));
    }

    static long createId(Connection db, Map<String, Object> user, Map<String, Object> body) throws SQLException {
        Accounts.requireDispatcher(user);
        long company = number(user, "company_id");
        long dispatcher = number(user, "id");
        long employee = Trips.identifier(body.get("employeeId"), "Сотрудник");
        String requestId = requestId(body);
        var destinations = TripRoutes.destinations(body);
        var destination = destinations.isEmpty() ? Trips.destination(db, user, body, null)
            : new Trips.Destination(null, destinations.getFirst(), "");
        String purpose = field(body, "purpose", "Что нужно сделать", 1000, false);
        String comment = field(body, "comment", "Комментарий", 1000, true);
        Trips.lockEmployee(db, company, employee);
        var inserted = Db.one(db, """
            INSERT INTO work_trip_offers(company_id, employee_id, created_by, request_id,
                destination, object_id, address, purpose, comment, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (company_id, created_by, request_id) DO NOTHING RETURNING id
            """, company, employee, dispatcher, requestId, destination.name(), destination.objectId(),
            destination.address(), purpose, comment, Trips.now());
        if (inserted != null) {
            long offerId = number(inserted, "id");
            TripRoutes.add(db, offerId, destinations);
            return offerId;
        }

        var existing = Db.one(db, SELECT + " AND r.created_by = ? AND r.request_id = ?", company, dispatcher, requestId);
        if (existing == null || number(existing, "employee_id") != employee
                || !Objects.equals(Objects.toString(existing.get("object_id"), null), Objects.toString(destination.objectId(), null))
                || !destination.name().equals(existing.get("destination")) || !destination.address().equals(existing.get("address"))
                || !purpose.equals(existing.get("purpose")) || !comment.equals(existing.get("comment"))
                || !TripRoutes.matchesAssignment(db, number(existing, "id"), destinations)) {
            throw error(409, "Этот идентификатор отправки уже использован для другой командировки.");
        }
        return number(existing, "id");
    }

    static Map<String, Object> propose(Connection db, Map<String, Object> user, long id, Map<String, Object> body)
            throws SQLException {
        if (!Trips.isEmployee(user)) throw error(403, "Даты и ставку предлагает назначенный сотрудник.");
        var row = lockAndFind(db, user, id);
        requireNotDeclined(row);
        String start = Trips.plannedTime(body, "plannedStart", "Начало командировки");
        String end = Trips.plannedTime(body, "plannedEnd", "Окончание командировки");
        if (end.compareTo(start) <= 0) throw error(400, "Окончание командировки должно быть позже начала.");
        var estimate = proposalEstimate(body);
        var plan = TripRoutes.plan(db, id, body.get("stops"), start, end);
        var current = Proposal.from(row);
        if (current != null && start.equals(current.start()) && end.equals(current.end())
                && estimate.equals(current.estimate()) && plan.unchanged()) {
            return result(db, row);
        }
        if (row.get("trip_id") != null) throw error(409, "Командировка уже согласована.");
        if (!plan.times().isEmpty() && !body.containsKey("expectedRevision")) {
            throw error(400, "Обновите карточку, чтобы предложить маршрут.");
        }
        checkRevision(row, body);
        preserveLegacyProposal(db, row, current);
        String proposedAt = Trips.now();
        Db.update(db, """
            UPDATE work_trip_offers SET planned_start = ?, planned_end = ?, daily_rate = ?, proposed_at = ?,
                proposal_estimate = ?, revision = revision + 1 WHERE company_id = ? AND id = ?
            """, start, end, estimate.dailyRate(), proposedAt, TripBudget.store(estimate), number(user, "company_id"), id);
        if (!plan.unchanged()) TripRoutes.savePlan(db, id, plan);
        recordHistory(db, user, row, "proposal", "", proposedAt, new Proposal(start, end, proposedAt, estimate));
        return result(db, find(db, user, id));
    }

    static Map<String, Object> confirm(Connection db, Map<String, Object> user, long id, Map<String, Object> body)
            throws SQLException {
        Accounts.requireDispatcher(user);
        long company = number(user, "company_id");
        var row = lockAndFind(db, user, id);
        requireNotDeclined(row);
        if (row.get("trip_id") != null) return result(db, row);
        checkRevision(row, body);
        var proposal = Proposal.from(row);
        if (proposal == null) throw error(409, "Дождитесь дат и ставки от сотрудника.");
        preserveLegacyProposal(db, row, proposal);
        var place = new Trips.Destination(row.get("object_id") == null ? null : number(row, "object_id"),
            (String) row.get("destination"), (String) row.get("address"));
        long trip = Trips.schedule(db, company, number(row, "employee_id"), number(row, "created_by"),
            place, "", (String) row.get("purpose"), proposal.start(), proposal.end(), List.of(), null, proposal.estimate());
        String confirmedAt = Trips.now();
        Db.update(db, """
            UPDATE work_trip_offers SET trip_id = ?, confirmed_at = ?, confirmed_by = ?, revision = revision + 1
            WHERE company_id = ? AND id = ?
            """, trip, confirmedAt, number(user, "id"), company, id);
        recordHistory(db, user, row, "confirmed", "", confirmedAt, proposal);
        return result(db, find(db, user, id));
    }

    static Map<String, Object> revise(Connection db, Map<String, Object> user, long id, Map<String, Object> body)
            throws SQLException {
        Accounts.requireDispatcher(user);
        var row = lockAndFind(db, user, id);
        requireNotDeclined(row);
        if (row.get("trip_id") != null) throw error(409, "Командировка уже согласована.");
        String reason = field(body, "reason", "Что нужно уточнить", 500, false);
        var proposal = Proposal.from(row);
        if (proposal == null && matchesLatestHistory(db, row, "revision_requested", reason)) return result(db, row);
        checkRevision(row, body);
        if (proposal == null) throw error(409, "Дождитесь дат и ставки от сотрудника.");
        preserveLegacyProposal(db, row, proposal);
        Db.update(db, """
            UPDATE work_trip_offers SET planned_start = NULL, planned_end = NULL, daily_rate = NULL,
                proposed_at = NULL, proposal_estimate = NULL, revision = revision + 1
            WHERE company_id = ? AND id = ?
            """, number(user, "company_id"), id);
        recordHistory(db, user, row, "revision_requested", reason, Trips.now(), proposal);
        return result(db, find(db, user, id));
    }

    static Map<String, Object> decline(Connection db, Map<String, Object> user, long id, Map<String, Object> body)
            throws SQLException {
        if (!Trips.isEmployee(user)) throw error(403, "Об отказе сообщает назначенный сотрудник.");
        var row = lockAndFind(db, user, id);
        if (row.get("trip_id") != null) throw error(409, "Командировка уже согласована.");
        String reason = field(body, "reason", "Причина отказа", 500, false);
        if (row.get("declined_at") != null && matchesLatestHistory(db, row, "declined", reason)) return result(db, row);
        requireNotDeclined(row);
        checkRevision(row, body);
        var proposal = Proposal.from(row);
        preserveLegacyProposal(db, row, proposal);
        String declinedAt = Trips.now();
        Db.update(db, """
            UPDATE work_trip_offers SET declined_at = ?, revision = revision + 1 WHERE company_id = ? AND id = ?
            """, declinedAt, number(user, "company_id"), id);
        recordHistory(db, user, row, "declined", reason, declinedAt, proposal);
        return result(db, find(db, user, id));
    }

    private static Map<String, Object> lockAndFind(Connection db, Map<String, Object> user, long id) throws SQLException {
        var row = find(db, user, id);
        Trips.lockEmployee(db, number(user, "company_id"), number(row, "employee_id"));
        return find(db, user, id);
    }

    private static Map<String, Object> find(Connection db, Map<String, Object> user, long id) throws SQLException {
        var row = Db.one(db, SELECT + " AND r.id = ?", number(user, "company_id"), id);
        if (row == null || (Trips.isEmployee(user) && number(row, "employee_id") != number(user, "id"))) {
            throw error(404, "Назначение на командировку не найдено.");
        }
        return row;
    }

    private static void checkRevision(Map<String, Object> row, Map<String, Object> body) {
        Object requested = body.getOrDefault("expectedRevision", row.get("revision"));
        if (!(requested instanceof Integer || requested instanceof Long) || ((Number) requested).longValue() < 1) {
            throw error(400, "Некорректная версия командировки.");
        }
        if (((Number) requested).longValue() != number(row, "revision")) {
            throw error(409, "Условия командировки изменились. Обновите карточку.");
        }
    }

    private static TripBudget proposalEstimate(Map<String, Object> body) {
        if (body.get("dailyRate") == null) throw error(400, "Укажите ставку за день.");
        var amounts = new LinkedHashMap<String, Object>();
        for (String key : List.of("dailyRate", "transport", "lodging", "meals", "other")) {
            if (body.containsKey(key)) amounts.put(key, body.get(key));
        }
        return TripBudget.read(amounts);
    }

    private static String requestId(Map<String, Object> body) {
        if (!body.containsKey("requestId")) return null;
        String input = field(body, "requestId", "Идентификатор отправки", 36, false);
        try {
            String canonical = UUID.fromString(input).toString();
            if (canonical.equalsIgnoreCase(input)) return canonical;
        } catch (IllegalArgumentException invalid) {
            // Reject malformed identifiers.
        }
        throw error(400, "Некорректный идентификатор отправки.");
    }

    private static void requireNotDeclined(Map<String, Object> row) {
        if (row.get("declined_at") != null) throw error(409, "Сотрудник уже отказался от командировки.");
    }

    private static boolean matchesLatestHistory(Connection db, Map<String, Object> row, String kind, String reason)
            throws SQLException {
        return Db.one(db, """
            SELECT 1 FROM work_trip_offer_history WHERE offer_id = ? AND revision = ? AND kind = ? AND reason = ?
            """, number(row, "id"), number(row, "revision"), kind, reason) != null;
    }

    private static void recordHistory(Connection db, Map<String, Object> user, Map<String, Object> row,
                                      String kind, String reason, String at, Proposal proposal) throws SQLException {
        insertHistory(db, number(row, "id"), number(row, "revision") + 1, kind, number(user, "id"), reason, at, proposal);
    }

    private static void preserveLegacyProposal(Connection db, Map<String, Object> row, Proposal proposal) throws SQLException {
        if (proposal != null && row.get("proposal_estimate") == null) {
            insertHistory(db, number(row, "id"), number(row, "revision"), "proposal",
                number(row, "employee_id"), "", proposal.at(), proposal);
        }
    }

    private static void insertHistory(Connection db, long id, long revision, String kind, long actor,
                                      String reason, String at, Proposal proposal) throws SQLException {
        Db.update(db, """
            INSERT INTO work_trip_offer_history(offer_id, revision, kind, actor_id, happened_at, reason,
                planned_start, planned_end, proposed_at, proposal_estimate)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, id, revision, kind, actor, at, reason,
            proposal == null ? null : proposal.start(), proposal == null ? null : proposal.end(),
            proposal == null ? null : proposal.at(), proposal == null ? null : TripBudget.store(proposal.estimate()));
    }

    private static Map<String, Object> result(Connection db, Map<String, Object> row) throws SQLException {
        return Map.of("offer", details(db, List.of(row), " AND r.id = ?",
            new Object[] {number(row, "company_id"), number(row, "id")}).getFirst());
    }

    private static List<Map<String, Object>> details(Connection db, List<Map<String, Object>> rows,
                                                       String scope, Object[] parameters) throws SQLException {
        if (rows.isEmpty()) return List.of();
        var history = new LinkedHashMap<Long, List<Map<String, Object>>>();
        for (var item : Db.rows(db, """
            SELECT h.* FROM work_trip_offer_history h
            JOIN work_trip_offers r ON r.id = h.offer_id
            WHERE r.company_id = ?
            """ + scope + " ORDER BY h.offer_id, h.revision", parameters)) {
            history.computeIfAbsent(number(item, "offer_id"), id -> new ArrayList<>()).add(item);
        }
        boolean awaitingConfirmation = rows.stream().anyMatch(row -> "awaiting_confirmation".equals(status(row)));
        var conflicts = awaitingConfirmation ? TripScheduleConflicts.read(db, TripScheduleConflicts.Source.OFFER, scope, parameters)
            : Map.<Long, TripScheduleConflicts.Conflicts>of();
        var routes = TripRoutes.forOffers(db, scope, parameters);
        return rows.stream().map(row -> {
            long id = number(row, "id");
            return json(row, history.getOrDefault(id, List.of()), conflicts.getOrDefault(id, TripScheduleConflicts.EMPTY),
                routes.getOrDefault(id, List.of()));
        }).toList();
    }

    private static String status(Map<String, Object> row) {
        if (row.get("declined_at") != null) return "declined";
        if (row.get("trip_id") != null) return "confirmed";
        return row.get("planned_start") == null ? "awaiting_employee" : "awaiting_confirmation";
    }

    private static Map<String, Object> json(Map<String, Object> row, List<Map<String, Object>> events,
                                            TripScheduleConflicts.Conflicts conflicts, List<Map<String, Object>> route) {
        var out = new LinkedHashMap<String, Object>();
        String status = status(row);
        out.put("id", row.get("id").toString());
        out.put("employeeId", row.get("employee_id").toString());
        out.put("employeeName", row.get("employee_name"));
        out.put("destination", row.get("destination"));
        out.put("address", row.get("address"));
        out.put("objectId", Objects.toString(row.get("object_id"), null));
        out.put("purpose", row.get("purpose"));
        out.put("comment", row.get("comment"));
        out.put("stops", route);
        out.put("status", status);
        out.putAll(proposalJson(Proposal.from(row)));
        out.put("tripId", Objects.toString(row.get("trip_id"), null));
        out.put("revision", row.get("revision"));
        out.put("createdAt", row.get("created_at"));
        out.put("confirmedAt", row.get("confirmed_at"));
        out.put("declinedAt", row.get("declined_at"));
        out.put("conflicts", ("awaiting_confirmation".equals(status) ? conflicts : TripScheduleConflicts.EMPTY).json());
        var history = new ArrayList<Map<String, Object>>();
        Map<String, Object> previousProposal = null;
        String revisionReason = null;
        String declineReason = null;
        for (var event : events) {
            if (number(event, "revision") > number(row, "revision")) break;
            var details = new LinkedHashMap<String, Object>();
            var proposal = Proposal.from(event);
            var snapshot = proposal == null ? null : proposalJson(proposal);
            String kind = (String) event.get("kind");
            String reason = (String) event.get("reason");
            if ("revision_requested".equals(kind)) {
                previousProposal = snapshot;
                revisionReason = reason;
            } else if ("declined".equals(kind)) {
                declineReason = reason;
            }
            details.put("kind", kind);
            details.put("actorId", event.get("actor_id").toString());
            details.put("at", event.get("happened_at"));
            details.put("reason", reason);
            details.put("proposal", snapshot);
            history.add(details);
        }
        out.put("revisionReason", "awaiting_employee".equals(status) ? revisionReason : null);
        out.put("previousProposal", previousProposal);
        out.put("declineReason", declineReason);
        out.put("history", history);
        return out;
    }

    private static Map<String, Object> proposalJson(Proposal proposal) {
        var out = new LinkedHashMap<String, Object>();
        Long days = proposal == null ? null : TripBudget.plannedDays(proposal.start(), proposal.end());
        out.put("plannedStart", proposal == null ? null : proposal.start());
        out.put("plannedEnd", proposal == null ? null : proposal.end());
        out.put("dailyRate", proposal == null ? null : proposal.estimate().dailyRate());
        out.put("plannedDays", days);
        out.put("estimate", proposal == null ? null : proposal.estimate().json(days));
        out.put("proposedAt", proposal == null ? null : proposal.at());
        return out;
    }
}
