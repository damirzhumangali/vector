package qwork;

import java.sql.Connection;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

import static qwork.Domain.number;

final class TripExpenseAnalytics {
    private static final String MATCH = """
        FROM work_trips t JOIN users u ON u.id = t.employee_id AND u.company_id = t.company_id
        LEFT JOIN work_trip_offers offer ON offer.trip_id = t.id AND offer.company_id = t.company_id
        LEFT JOIN work_trip_actual_expenses expenses ON expenses.trip_id = t.id
        WHERE t.company_id = ? AND u.role = 'employee'
        """;

    private TripExpenseAnalytics() {}

    static Map<String, Object> report(Connection db, Map<String, Object> user, Map<String, String> input)
            throws SQLException {
        String department = Analytics.authorizedDepartment(user);
        long company = number(user, "company_id");
        var filters = Analytics.Filters.read(input, department);
        String scope = department.isEmpty() ? MATCH : MATCH + " AND u.department = ?";
        Object[] scopeParams = department.isEmpty() ? new Object[]{company} : new Object[]{company, department};
        var options = Analytics.options(db, company, department, scope, scopeParams);
        if (!department.isEmpty()) options.requireAllowed(filters);

        var criteria = new StringBuilder(scope);
        var arguments = new ArrayList<>(List.of(scopeParams));
        if (filters.employee() != null) {
            criteria.append(" AND t.employee_id = ?");
            arguments.add(filters.employee());
        }
        if (filters.object() != null) {
            criteria.append(" AND t.object_id = ?");
            arguments.add(filters.object());
        }
        if (department.isEmpty() && !filters.department().isEmpty()) {
            criteria.append(" AND u.department = ?");
            arguments.add(filters.department());
        }

        var rows = Db.rows(db, """
            SELECT t.id, t.employee_id, t.destination, t.object_id, t.address, t.planned_start, t.planned_end,
                t.started_at, t.finished_at, t.budget, t.estimate, u.name AS employee_name, u.department,
                offer.id AS offer_id, expenses.trip_id AS actual_id, expenses.transport, expenses.lodging,
                expenses.meals, expenses.other, expenses.note, expenses.updated_at
            """ + criteria + " ORDER BY t.planned_start DESC, t.id DESC", arguments.toArray());

        var totals = new Summary();
        var trips = new ArrayList<Map<String, Object>>();
        for (var row : rows) {
            if (!filters.includes(Instant.parse((String) row.get("planned_start")))) continue;
            var plan = TripActualExpenses.plannedBudget(row);
            var actual = row.get("actual_id") == null ? null : TripActualExpenses.expenses(row);
            totals.add(plan, actual);
            trips.add(trip(row, plan, actual));
        }
        return Map.of("filters", filters.json(), "scope", Map.of("department", department),
            "options", options.json(), "summary", totals.json(), "trips", trips);
    }

    private static Map<String, Object> trip(Map<String, Object> row, TripBudget plan, TripBudget actual) {
        var result = new LinkedHashMap<String, Object>();
        result.put("id", row.get("id").toString());
        result.put("employeeId", row.get("employee_id").toString());
        result.put("employeeName", row.get("employee_name"));
        result.put("department", row.get("department"));
        result.put("destination", row.get("destination"));
        result.put("objectId", Objects.toString(row.get("object_id"), null));
        result.put("address", row.get("address"));
        result.put("plannedStart", row.get("planned_start"));
        result.put("plannedEnd", row.get("planned_end"));
        result.put("startedAt", row.get("started_at"));
        result.put("finishedAt", row.get("finished_at"));
        result.put("status", Trips.status(row));
        result.put("plan", plan == null ? null : plan.json(TripBudget.plannedDays(row)));
        result.put("actual", actual == null ? null : Map.of(
            "transport", actual.transport(), "lodging", actual.lodging(), "meals", actual.meals(), "other", actual.other(),
            "expensesTotal", actual.expensesTotal(), "note", row.get("note"), "updatedAt", row.get("updated_at")));
        result.put("delta", plan == null || actual == null ? null : actual.expensesTotal() - plan.expensesTotal());
        return result;
    }

    private static final class Summary {
        private long tripCount;
        private long plannedCount;
        private long actualCount;
        private long comparableCount;
        private long plannedTotal;
        private long actualTotal;
        private long comparablePlannedTotal;
        private long comparableActualTotal;

        void add(TripBudget plan, TripBudget actual) {
            tripCount++;
            if (plan != null) {
                plannedCount++;
                plannedTotal += plan.expensesTotal();
            }
            if (actual != null) {
                actualCount++;
                actualTotal += actual.expensesTotal();
            }
            if (plan != null && actual != null) {
                comparableCount++;
                comparablePlannedTotal += plan.expensesTotal();
                comparableActualTotal += actual.expensesTotal();
            }
        }

        Map<String, Object> json() {
            var result = new LinkedHashMap<String, Object>();
            result.put("currency", "KZT");
            result.put("tripCount", tripCount);
            result.put("plannedCount", plannedCount);
            result.put("actualCount", actualCount);
            result.put("comparableCount", comparableCount);
            result.put("plannedTotal", plannedCount == 0 ? null : plannedTotal);
            result.put("actualTotal", actualCount == 0 ? null : actualTotal);
            result.put("comparablePlannedTotal", comparableCount == 0 ? null : comparablePlannedTotal);
            result.put("comparableActualTotal", comparableCount == 0 ? null : comparableActualTotal);
            result.put("delta", comparableCount == 0 ? null : comparableActualTotal - comparablePlannedTotal);
            return result;
        }
    }
}
