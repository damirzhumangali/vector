package qwork;

import java.sql.Connection;
import java.sql.SQLException;
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
        """;

    private static final String SELECT = """
        SELECT offer.*, employee.name AS employee_name
        FROM work_trip_offers offer
        JOIN users employee ON employee.id = offer.employee_id AND employee.company_id = offer.company_id
        WHERE offer.company_id = ?
        """;

    private TripOffers() {}

    static Map<String, Object> list(Connection db, Map<String, Object> user) throws SQLException {
        long company = number(user, "company_id");
        String order = " ORDER BY offer.created_at DESC, offer.id DESC";
        var rows = Trips.isEmployee(user)
            ? Db.rows(db, SELECT + " AND offer.employee_id = ?" + order, company, number(user, "id"))
            : Db.rows(db, SELECT + order, company);
        return Map.of("offers", rows.stream().map(TripOffers::json).toList());
    }

    static Map<String, Object> create(Connection db, Map<String, Object> user, Map<String, Object> body) throws SQLException {
        Accounts.requireDispatcher(user);
        long company = number(user, "company_id");
        long dispatcher = number(user, "id");
        long employee = Trips.identifier(body.get("employeeId"), "Сотрудник");
        String requestId = requestId(body);
        var destination = Trips.destination(db, user, body, null);
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
        if (inserted != null) return result(find(db, user, number(inserted, "id")));

        var existing = Db.one(db, SELECT + " AND offer.created_by = ? AND offer.request_id = ?", company, dispatcher, requestId);
        if (existing == null || number(existing, "employee_id") != employee
                || !Objects.equals(Objects.toString(existing.get("object_id"), null), Objects.toString(destination.objectId(), null))
                || !destination.name().equals(existing.get("destination")) || !destination.address().equals(existing.get("address"))
                || !purpose.equals(existing.get("purpose")) || !comment.equals(existing.get("comment"))) {
            throw error(409, "Этот идентификатор отправки уже использован для другой командировки.");
        }
        return result(existing);
    }

    static Map<String, Object> propose(Connection db, Map<String, Object> user, long id, Map<String, Object> body)
            throws SQLException {
        if (!Trips.isEmployee(user)) throw error(403, "Даты и ставку предлагает назначенный сотрудник.");
        var row = lockAndFind(db, user, id);
        String start = Trips.plannedTime(body, "plannedStart", "Начало командировки");
        String end = Trips.plannedTime(body, "plannedEnd", "Окончание командировки");
        if (end.compareTo(start) <= 0) throw error(400, "Окончание командировки должно быть позже начала.");
        long rate = dailyRate(body);
        if (start.equals(row.get("planned_start")) && end.equals(row.get("planned_end"))
                && rate == number(row, "daily_rate")) {
            return result(row);
        }
        if (row.get("trip_id") != null) throw error(409, "Командировка уже согласована.");
        checkRevision(row, body);
        Db.update(db, """
            UPDATE work_trip_offers SET planned_start = ?, planned_end = ?, daily_rate = ?, proposed_at = ?,
                revision = revision + 1 WHERE company_id = ? AND id = ?
            """, start, end, rate, Trips.now(), number(user, "company_id"), id);
        return result(find(db, user, id));
    }

    static Map<String, Object> confirm(Connection db, Map<String, Object> user, long id, Map<String, Object> body)
            throws SQLException {
        Accounts.requireDispatcher(user);
        long company = number(user, "company_id");
        var row = lockAndFind(db, user, id);
        if (row.get("trip_id") != null) return result(row);
        checkRevision(row, body);
        if (row.get("planned_start") == null) throw error(409, "Дождитесь дат и ставки от сотрудника.");
        var place = new Trips.Destination(row.get("object_id") == null ? null : number(row, "object_id"),
            (String) row.get("destination"), (String) row.get("address"));
        long trip = Trips.schedule(db, company, number(row, "employee_id"), number(row, "created_by"),
            place, "", (String) row.get("purpose"), (String) row.get("planned_start"), (String) row.get("planned_end"),
            List.of(), null, estimate(row));
        Db.update(db, """
            UPDATE work_trip_offers SET trip_id = ?, confirmed_at = ?, confirmed_by = ?, revision = revision + 1
            WHERE company_id = ? AND id = ?
            """, trip, Trips.now(), number(user, "id"), company, id);
        return result(find(db, user, id));
    }

    private static Map<String, Object> lockAndFind(Connection db, Map<String, Object> user, long id) throws SQLException {
        var row = find(db, user, id);
        Trips.lockEmployee(db, number(user, "company_id"), number(row, "employee_id"));
        return find(db, user, id);
    }

    private static Map<String, Object> find(Connection db, Map<String, Object> user, long id) throws SQLException {
        var row = Db.one(db, SELECT + " AND offer.id = ?", number(user, "company_id"), id);
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

    private static long dailyRate(Map<String, Object> body) {
        Object value = body.get("dailyRate");
        if (value == null) throw error(400, "Укажите ставку за день.");
        return TripBudget.read(Map.of("dailyRate", value)).dailyRate();
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

    private static TripBudget estimate(Map<String, Object> row) {
        return new TripBudget(number(row, "daily_rate"), 0, 0, 0, 0);
    }

    private static Map<String, Object> result(Map<String, Object> row) {
        return Map.of("offer", json(row));
    }

    private static Map<String, Object> json(Map<String, Object> row) {
        var out = new LinkedHashMap<String, Object>();
        boolean proposed = row.get("planned_start") != null;
        String tripId = Objects.toString(row.get("trip_id"), null);
        out.put("id", row.get("id").toString());
        out.put("employeeId", row.get("employee_id").toString());
        out.put("employeeName", row.get("employee_name"));
        out.put("destination", row.get("destination"));
        out.put("address", row.get("address"));
        out.put("objectId", Objects.toString(row.get("object_id"), null));
        out.put("purpose", row.get("purpose"));
        out.put("comment", row.get("comment"));
        out.put("status", tripId != null ? "confirmed" : proposed ? "awaiting_confirmation" : "awaiting_employee");
        out.put("plannedStart", row.get("planned_start"));
        out.put("plannedEnd", row.get("planned_end"));
        out.put("dailyRate", row.get("daily_rate"));
        Long days = proposed ? TripBudget.plannedDays(row) : null;
        out.put("plannedDays", days);
        out.put("estimate", proposed ? estimate(row).json(days) : null);
        out.put("tripId", tripId);
        out.put("revision", row.get("revision"));
        out.put("createdAt", row.get("created_at"));
        out.put("proposedAt", row.get("proposed_at"));
        out.put("confirmedAt", row.get("confirmed_at"));
        return out;
    }
}
