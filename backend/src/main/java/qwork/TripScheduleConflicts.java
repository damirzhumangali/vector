package qwork;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static qwork.Domain.number;

final class TripScheduleConflicts {
    enum Source {
        REQUEST("work_trip_requests", "r.status = 'pending'"),
        OFFER("work_trip_offers", "r.planned_start IS NOT NULL AND r.trip_id IS NULL AND r.declined_at IS NULL");

        final String table;
        final String awaitingDecision;

        Source(String table, String awaitingDecision) {
            this.table = table;
            this.awaitingDecision = awaitingDecision;
        }
    }

    record Conflicts(List<Map<String, Object>> shifts, List<Map<String, Object>> trips) {
        Map<String, Object> json() {
            return Map.of("shifts", shifts, "trips", trips);
        }
    }

    static final Conflicts EMPTY = new Conflicts(List.of(), List.of());

    private TripScheduleConflicts() {}

    static Map<Long, Conflicts> read(Connection db, Source source, String scope, Object[] parameters) throws SQLException {
        var rows = Db.rows(db, """
            WITH pending AS (
                SELECT r.id, r.company_id, r.employee_id, r.planned_start, r.planned_end
                FROM %s r WHERE r.company_id = ? AND %s %s
            )
            SELECT r.id AS request_id, shift.id AS conflict_id, shift.starts_at AS starts_at,
                shift.ends_at AS ends_at, shift.kind AS label, 'shift' AS kind
            FROM pending r JOIN shifts shift ON shift.company_id = r.company_id AND shift.employee_id = r.employee_id
            WHERE shift.finished_at IS NULL AND shift.starts_at < r.planned_end AND shift.ends_at > r.planned_start
            UNION ALL
            SELECT r.id, trip.id, trip.planned_start, trip.planned_end, trip.destination, 'trip'
            FROM pending r JOIN work_trips trip ON trip.company_id = r.company_id AND trip.employee_id = r.employee_id
            WHERE trip.finished_at IS NULL AND trip.planned_start < r.planned_end AND trip.planned_end > r.planned_start
            ORDER BY starts_at, conflict_id
            """.formatted(source.table, source.awaitingDecision, scope), parameters);
        var conflicts = new LinkedHashMap<Long, Conflicts>();
        for (var row : rows) {
            var items = conflicts.computeIfAbsent(number(row, "request_id"),
                id -> new Conflicts(new ArrayList<>(), new ArrayList<>()));
            String id = row.get("conflict_id").toString();
            if ("shift".equals(row.get("kind"))) {
                items.shifts().add(Map.of("id", id, "kind", row.get("label"),
                    "startsAt", row.get("starts_at"), "endsAt", row.get("ends_at")));
            } else {
                items.trips().add(Map.of("id", id, "destination", row.get("label"),
                    "plannedStart", row.get("starts_at"), "plannedEnd", row.get("ends_at")));
            }
        }
        return conflicts;
    }
}
