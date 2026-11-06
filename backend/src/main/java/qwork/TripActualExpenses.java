package qwork;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

import static qwork.Domain.error;
import static qwork.Domain.field;
import static qwork.Domain.number;

final class TripActualExpenses {
    static final String SQLITE_SCHEMA = """
        CREATE TABLE IF NOT EXISTS work_trip_actual_expenses (
            trip_id INTEGER PRIMARY KEY REFERENCES work_trips(id),
            transport INTEGER NOT NULL CHECK (transport BETWEEN 0 AND 999999999),
            lodging INTEGER NOT NULL CHECK (lodging BETWEEN 0 AND 999999999),
            meals INTEGER NOT NULL CHECK (meals BETWEEN 0 AND 999999999),
            other INTEGER NOT NULL CHECK (other BETWEEN 0 AND 999999999),
            note TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK (revision > 0),
            updated_at TEXT NOT NULL
        );
        """;

    private static final Set<String> BODY_FIELDS = Set.of(
        "transport", "lodging", "meals", "other", "note", "expectedRevision"
    );

    private TripActualExpenses() {}

    static Map<String, Object> read(Connection db, Map<String, Object> tripRow) throws SQLException {
        return json(tripRow, find(db, number(tripRow, "id")));
    }

    static Map<String, Object> save(Connection db, Map<String, Object> user, long id, Map<String, Object> body)
            throws SQLException {
        if (!Trips.isEmployee(user)) {
            throw error(403, "Фактические расходы указывает назначенный сотрудник.");
        }
        Trips.lockEmployee(db, number(user, "company_id"), number(user, "id"));
        var trip = Trips.find(db, user, id);
        if (trip.get("started_at") == null) {
            throw error(409, "Сначала отметьте начало командировки.");
        }
        if (!BODY_FIELDS.containsAll(body.keySet())) {
            throw error(400, "Проверьте поля фактических расходов.");
        }
        var requested = body.get("expectedRevision");
        if (!(requested instanceof Integer || requested instanceof Long) || ((Number) requested).longValue() < 0) {
            throw error(400, "Некорректная версия фактических расходов.");
        }
        String note = field(body, "note", "Примечание", 1000, true);
        var amounts = new LinkedHashMap<>(body);
        amounts.remove("note");
        amounts.remove("expectedRevision");
        var budget = amounts.isEmpty() ? new TripBudget(0, 0, 0, 0, 0) : TripBudget.read(amounts);
        var previous = find(db, id);
        if (previous != null && budget.equals(expenses(previous)) && note.equals(previous.get("note"))) {
            return Map.of("actualExpenses", json(trip, previous));
        }
        long currentRevision = previous == null ? 0 : number(previous, "revision");
        if (((Number) requested).longValue() != currentRevision) {
            throw error(409, "Фактические расходы изменились. Обновите карточку командировки.");
        }
        if (previous == null) {
            Db.update(db, """
                INSERT INTO work_trip_actual_expenses(trip_id, transport, lodging, meals, other, note, revision, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?)
                """, id, budget.transport(), budget.lodging(), budget.meals(), budget.other(), note, Trips.now());
        } else {
            Db.update(db, """
                UPDATE work_trip_actual_expenses
                SET transport = ?, lodging = ?, meals = ?, other = ?, note = ?, revision = revision + 1, updated_at = ?
                WHERE trip_id = ?
                """, budget.transport(), budget.lodging(), budget.meals(), budget.other(), note, Trips.now(), id);
        }
        return Map.of("actualExpenses", read(db, trip));
    }

    private static Map<String, Object> find(Connection db, long tripId) throws SQLException {
        return Db.one(db, "SELECT * FROM work_trip_actual_expenses WHERE trip_id = ?", tripId);
    }

    private static TripBudget expenses(Map<String, Object> row) {
        return new TripBudget(0, number(row, "transport"), number(row, "lodging"),
            number(row, "meals"), number(row, "other"));
    }

    private static long sumExpenses(TripBudget amounts) {
        return amounts.transport() + amounts.lodging() + amounts.meals() + amounts.other();
    }

    private static Map<String, Object> json(Map<String, Object> trip, Map<String, Object> row) {
        Object plannedBudget = trip.get("offer_id") != null || trip.get("budget") == null
            ? trip.get("estimate") : trip.get("budget");
        var plan = TripBudget.load(plannedBudget);
        Long workTotal = plan == null ? null : plan.dailyRate() * TripBudget.plannedDays(trip);
        Long plannedExpenses = plan == null ? null : sumExpenses(plan);
        Long plannedTotal = plan == null ? null : workTotal + plannedExpenses;
        Long actualExpenses = row == null ? null : sumExpenses(expenses(row));
        Long actualTotal = row == null ? null : actualExpenses + (workTotal == null ? 0 : workTotal);

        var out = new LinkedHashMap<String, Object>();
        out.put("currency", "KZT");
        out.put("revision", row == null ? 0L : number(row, "revision"));
        out.put("transport", row == null ? null : number(row, "transport"));
        out.put("lodging", row == null ? null : number(row, "lodging"));
        out.put("meals", row == null ? null : number(row, "meals"));
        out.put("other", row == null ? null : number(row, "other"));
        out.put("expensesTotal", actualExpenses);
        out.put("plannedExpensesTotal", plannedExpenses);
        out.put("expenseDelta", actualExpenses == null || plannedExpenses == null ? null : actualExpenses - plannedExpenses);
        out.put("workTotal", workTotal);
        out.put("plannedTotal", plannedTotal);
        out.put("actualTotal", actualTotal);
        out.put("totalDelta", actualTotal == null || plannedTotal == null ? null : actualTotal - plannedTotal);
        out.put("note", row == null ? null : row.get("note"));
        out.put("updatedAt", row == null ? null : row.get("updated_at"));
        return out;
    }
}
