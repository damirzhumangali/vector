package qwork;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;

import static qwork.Domain.error;
import static qwork.Domain.field;
import static qwork.Domain.number;

final class TripRoutes {
    static final String SQLITE_SCHEMA = """
        CREATE TABLE IF NOT EXISTS work_trip_route_stops (
            id INTEGER PRIMARY KEY,
            offer_id INTEGER NOT NULL REFERENCES work_trip_offers(id),
            position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 50),
            destination TEXT NOT NULL,
            planned_at TEXT,
            visited_at TEXT,
            skipped_at TEXT,
            skip_reason TEXT NOT NULL DEFAULT '',
            UNIQUE (offer_id, position),
            UNIQUE (offer_id, destination),
            CHECK (visited_at IS NULL OR skipped_at IS NULL),
            CHECK ((skipped_at IS NULL) = (skip_reason = '')),
            CHECK (planned_at IS NOT NULL OR (visited_at IS NULL AND skipped_at IS NULL))
        );
        """;

    private static final int MAX_STOPS = 30;
    private static final String PLANNED_ORDER = " ORDER BY s.planned_at IS NULL, s.planned_at, s.position";
    private static final String TRIP_ROUTE = """
        FROM work_trips t
        JOIN work_trip_offers r ON r.trip_id = t.id AND r.company_id = t.company_id AND r.employee_id = t.employee_id
        JOIN work_trip_route_stops s ON s.offer_id = r.id
        WHERE t.company_id = ? AND t.id = ?
        """;

    record Plan(Map<Long, String> times, boolean unchanged) {}

    private TripRoutes() {}

    static List<String> destinations(Map<String, Object> body) {
        if (!body.containsKey("destinations")) return List.of();
        if (!(body.get("destinations") instanceof List<?> values) || values.isEmpty() || values.size() > MAX_STOPS) {
            throw error(400, "Укажите от 1 до 30 точек маршрута.");
        }
        if (body.get("objectId") != null) throw error(400, "Для маршрута укажите названия всех точек.");
        var names = new ArrayList<String>();
        var distinct = new HashSet<String>();
        for (var value : values) {
            if (!(value instanceof String)) throw error(400, "Укажите название каждой точки маршрута.");
            String name = field(Map.of("name", value), "name", "Точка маршрута", 300, false);
            if (!distinct.add(name.toLowerCase(Locale.ROOT))) throw error(400, "Точки маршрута должны различаться.");
            names.add(name);
        }
        return names;
    }

    static void add(Connection db, long offer, List<String> destinations) throws SQLException {
        for (int index = 0; index < destinations.size(); index++) {
            Db.update(db, "INSERT INTO work_trip_route_stops(offer_id, position, destination) VALUES (?, ?, ?)",
                offer, index + 1, destinations.get(index));
        }
    }

    static boolean matchesAssignment(Connection db, long offer, List<String> destinations) throws SQLException {
        var assigned = Db.rows(db, "SELECT destination FROM work_trip_route_stops WHERE offer_id = ? ORDER BY position", offer);
        return assigned.stream().map(stop -> (String) stop.get("destination")).toList().equals(destinations);
    }

    static Plan initialPlan(Connection db, long offer, Object input, String start, String end) throws SQLException {
        var assigned = Db.rows(db, "SELECT id FROM work_trip_route_stops WHERE offer_id = ? ORDER BY position", offer);
        if (assigned.isEmpty() && input == null) return new Plan(Map.of(), true);
        if (!(input instanceof List<?> times) || times.size() != assigned.size()) {
            throw error(400, "Укажите дату и время для каждой точки маршрута.");
        }
        var stops = new ArrayList<Map<String, Object>>();
        for (int index = 0; index < times.size(); index++) {
            if (!(times.get(index) instanceof String time)) {
                throw error(400, "Укажите дату и время для каждой точки маршрута.");
            }
            stops.add(Map.of("id", assigned.get(index).get("id"), "plannedAt", time));
        }
        return plan(db, offer, stops, start, end);
    }

    static Plan plan(Connection db, long offer, Object input, String start, String end) throws SQLException {
        var assigned = new LinkedHashMap<Long, String>();
        for (var stop : Db.rows(db, "SELECT id, planned_at FROM work_trip_route_stops WHERE offer_id = ?", offer)) {
            assigned.put(number(stop, "id"), (String) stop.get("planned_at"));
        }
        if (assigned.isEmpty() && input == null) return new Plan(Map.of(), true);
        if (!(input instanceof List<?> stops) || stops.size() != assigned.size()) {
            throw error(400, "Укажите дату и время для каждой точки маршрута.");
        }
        var times = new LinkedHashMap<Long, String>();
        String previous = null;
        for (var item : stops) {
            if (!(item instanceof Map<?, ?> stop) || !(stop.get("plannedAt") instanceof String plannedAt)) {
                throw error(400, "Укажите дату и время для каждой точки маршрута.");
            }
            long id = Trips.identifier(stop.get("id"), "Точка маршрута");
            if (!assigned.containsKey(id) || times.containsKey(id)) {
                throw error(400, "Укажите каждую назначенную точку маршрута один раз.");
            }
            String time = Trips.plannedTime(Map.of("plannedAt", plannedAt), "plannedAt", "Время посещения точки");
            if (time.compareTo(start) < 0 || time.compareTo(end) > 0) {
                throw error(400, "Время посещения каждой точки должно быть в периоде поездки.");
            }
            if (previous != null && time.compareTo(previous) <= 0) {
                throw error(400, "Время посещения точек должно идти по порядку без совпадений.");
            }
            times.put(id, time);
            previous = time;
        }
        return new Plan(times, assigned.equals(times));
    }

    static void savePlan(Connection db, long offer, Plan plan) throws SQLException {
        for (var stop : plan.times().entrySet()) {
            Db.update(db, "UPDATE work_trip_route_stops SET planned_at = ? WHERE offer_id = ? AND id = ?",
                stop.getValue(), offer, stop.getKey());
        }
    }

    static Map<Long, List<Map<String, Object>>> forOffers(Connection db, String scope, Object[] parameters)
            throws SQLException {
        var routes = new LinkedHashMap<Long, List<Map<String, Object>>>();
        for (var stop : Db.rows(db, """
            SELECT s.* FROM work_trip_route_stops s JOIN work_trip_offers r ON r.id = s.offer_id
            WHERE r.company_id = ?
            """ + scope + PLANNED_ORDER, parameters)) {
            routes.computeIfAbsent(number(stop, "offer_id"), id -> new ArrayList<>()).add(json(stop));
        }
        return routes;
    }

    static List<Map<String, Object>> forTrip(Connection db, Map<String, Object> user, long tripId) throws SQLException {
        long company = number(user, "company_id");
        var rows = Trips.isEmployee(user)
            ? Db.rows(db, "SELECT s.* " + TRIP_ROUTE + " AND t.employee_id = ?" + PLANNED_ORDER,
                company, tripId, number(user, "id"))
            : Db.rows(db, "SELECT s.* " + TRIP_ROUTE + PLANNED_ORDER, company, tripId);
        return rows.stream().map(TripRoutes::json).toList();
    }

    static Map<String, Object> record(Connection db, Map<String, Object> user, long tripId, long stopId,
                                      Map<String, Object> body) throws SQLException {
        if (!Trips.isEmployee(user)) throw error(403, "Посещение отмечает назначенный сотрудник.");
        long company = number(user, "company_id");
        long employee = number(user, "id");
        Trips.lockEmployee(db, company, employee);
        var stop = Db.one(db, "SELECT s.*, t.started_at, t.finished_at " + TRIP_ROUTE
            + " AND t.employee_id = ? AND s.id = ?", company, tripId, employee, stopId);
        if (stop == null) throw error(404, "Точка маршрута не найдена.");
        String outcome = field(body, "outcome", "Результат посещения", 7, false);
        boolean skipped = "skipped".equals(outcome);
        if (!skipped && !"visited".equals(outcome)) throw error(400, "Выберите результат посещения точки.");
        String reason = skipped ? field(body, "reason", "Причина пропуска", 500, false) : "";
        if (stop.get("visited_at") != null || stop.get("skipped_at") != null) {
            boolean same = skipped ? stop.get("skipped_at") != null && reason.equals(stop.get("skip_reason"))
                : stop.get("visited_at") != null;
            if (same) return Map.of("stop", json(stop));
            throw error(409, "Результат посещения уже сохранён.");
        }
        if (stop.get("started_at") == null || stop.get("finished_at") != null) {
            throw error(409, "Посещение можно отметить во время командировки.");
        }
        String at = Trips.now();
        var updated = Db.one(db, """
            UPDATE work_trip_route_stops SET visited_at = ?, skipped_at = ?, skip_reason = ?
            WHERE id = ? AND offer_id = ? RETURNING *
            """, skipped ? null : at, skipped ? at : null, reason, stopId, number(stop, "offer_id"));
        return Map.of("stop", json(updated));
    }

    static void requireCompleted(Connection db, Map<String, Object> user, long tripId) throws SQLException {
        if (Db.one(db, "SELECT 1 " + TRIP_ROUTE
            + " AND t.employee_id = ? AND s.visited_at IS NULL AND s.skipped_at IS NULL LIMIT 1",
            number(user, "company_id"), tripId, number(user, "id")) != null) {
            throw error(409, "Отметьте посещение или причину пропуска каждой точки маршрута.");
        }
    }

    private static Map<String, Object> json(Map<String, Object> stop) {
        var result = new LinkedHashMap<String, Object>();
        result.put("id", Objects.toString(stop.get("id")));
        result.put("destination", stop.get("destination"));
        result.put("plannedAt", stop.get("planned_at"));
        result.put("visitedAt", stop.get("visited_at"));
        result.put("skippedAt", stop.get("skipped_at"));
        result.put("skipReason", stop.get("skip_reason"));
        return result;
    }
}
