package qwork;

import com.fasterxml.jackson.core.JsonProcessingException;
import java.time.Instant;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.Map;
import java.util.Set;

import static qwork.Domain.error;

record TripBudget(long dailyRate, long transport, long lodging, long meals, long other) {
    private static final ZoneId COMPANY_ZONE = ZoneId.of("Asia/Almaty");
    private static final long MAX_AMOUNT = 999_999_999;
    private static final Set<String> AMOUNTS = Set.of("dailyRate", "transport", "lodging", "meals", "other");

    static TripBudget read(Object value) {
        if (value == null) return null;
        if (!(value instanceof Map<?, ?> amounts) || !AMOUNTS.containsAll(amounts.keySet())) {
            throw error(400, "Проверьте суммы расходов командировки.");
        }
        if (amounts.isEmpty()) return null;
        return new TripBudget(amount(amounts, "dailyRate", "Ставка за день"),
            amount(amounts, "transport", "Проезд"), amount(amounts, "lodging", "Жильё"),
            amount(amounts, "meals", "Питание"), amount(amounts, "other", "Прочие расходы"));
    }

    private static long amount(Map<?, ?> amounts, String key, String label) {
        if (!amounts.containsKey(key)) return 0;
        Object value = amounts.get(key);
        if ((value instanceof Integer || value instanceof Long)
                && ((Number) value).longValue() >= 0 && ((Number) value).longValue() <= MAX_AMOUNT) {
            return ((Number) value).longValue();
        }
        throw error(400, "Поле «" + label + "» должно быть целым числом от 0 до 999 999 999 ₸.");
    }

    static String store(TripBudget budget) {
        if (budget == null) return null;
        try {
            return Db.JSON.writeValueAsString(budget);
        } catch (JsonProcessingException failure) {
            throw new IllegalStateException("Unable to encode trip budget", failure);
        }
    }

    static TripBudget load(Object stored) {
        if (stored == null) return null;
        try {
            return Db.JSON.readValue(stored.toString(), TripBudget.class);
        } catch (JsonProcessingException failure) {
            throw new IllegalStateException("Unable to decode trip budget", failure);
        }
    }

    static long plannedDays(Map<String, Object> row) {
        var firstDay = Instant.parse((String) row.get("planned_start")).atZone(COMPANY_ZONE).toLocalDate();
        var lastDay = Instant.parse((String) row.get("planned_end")).atZone(COMPANY_ZONE).toLocalDate();
        return ChronoUnit.DAYS.between(firstDay, lastDay) + 1;
    }

    static Map<String, Object> json(Object stored, long days) {
        var budget = load(stored);
        return budget == null ? null : budget.json(days);
    }

    Map<String, Object> json(long days) {
        long workTotal = dailyRate * days;
        long expensesTotal = transport + lodging + meals + other;
        return Map.of("currency", "KZT", "days", days, "dailyRate", dailyRate,
            "transport", transport, "lodging", lodging, "meals", meals, "other", other,
            "workTotal", workTotal, "expensesTotal", expensesTotal, "total", workTotal + expensesTotal);
    }
}
