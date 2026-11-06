package qwork;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static qwork.Domain.error;
import static qwork.Domain.field;
import static qwork.Domain.number;

final class TripApprovals {
    static final String SQLITE_SCHEMA = """
        CREATE TABLE IF NOT EXISTS trip_approval_settings (
            company_id INTEGER NOT NULL REFERENCES companies(id),
            position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 3),
            approver_id INTEGER NOT NULL REFERENCES users(id),
            PRIMARY KEY (company_id, position),
            UNIQUE (company_id, approver_id)
        );
        CREATE TABLE IF NOT EXISTS work_trip_offer_approvals (
            offer_id INTEGER NOT NULL REFERENCES work_trip_offers(id),
            position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 3),
            approver_id INTEGER NOT NULL REFERENCES users(id),
            decision TEXT CHECK (decision IN ('approved', 'rejected')),
            decided_at TEXT,
            reason TEXT NOT NULL DEFAULT '',
            decided_revision INTEGER CHECK (decided_revision > 0),
            PRIMARY KEY (offer_id, position),
            UNIQUE (offer_id, approver_id),
            CHECK ((decision IS NULL) = (decided_at IS NULL)),
            CHECK ((decision IS NULL) = (decided_revision IS NULL)),
            CHECK (decision IS DISTINCT FROM 'rejected' OR reason <> '')
        );
        """;

    private static final List<String> TITLES = List.of("Директор", "Заместитель директора", "Главный бухгалтер");
    private static final List<String> EXAMPLES = List.of("Айдар Садыков", "Динара Ахметова", "Алия Нурпеисова");
    private static final String SINGLE_TITLE = "Согласующий";
    private static final String CONFIG = """
        SELECT s.position, u.id AS approver_id, u.name AS approver_name
        FROM trip_approval_settings s LEFT JOIN users u ON u.id = s.approver_id AND u.company_id = s.company_id
            AND u.role IN ('manager', 'dispatcher')
        WHERE s.company_id = ? ORDER BY s.position
        """;

    record Stage(int position, long approverId, String name, String decision, String decidedAt, String reason,
                 Long decidedRevision) {
        static Stage from(Map<String, Object> row) {
            return new Stage((int) number(row, "position"), number(row, "approver_id"), (String) row.get("approver_name"),
                (String) row.get("decision"), (String) row.get("decided_at"), (String) row.get("reason"),
                row.get("decided_revision") == null ? null : number(row, "decided_revision"));
        }

        Map<String, Object> json(Stage active, boolean singleApprover) {
            var result = new LinkedHashMap<String, Object>();
            result.put("position", position);
            result.put("title", singleApprover ? SINGLE_TITLE : TITLES.get(position - 1));
            result.put("approverId", Long.toString(approverId));
            result.put("approverName", name);
            result.put("status", decision != null ? decision : this == active ? "waiting" : "pending");
            result.put("decidedAt", decidedAt);
            result.put("reason", reason);
            return result;
        }
    }

    record Decision(Stage stage, String value, String reason, boolean retry) {}

    private TripApprovals() {}

    static Map<String, Object> settings(Connection db, Map<String, Object> user) throws SQLException {
        long company = number(user, "company_id");
        var assigned = configuration(db, company);
        boolean configured = validConfiguration(assigned);
        boolean singleApprover = configured && assigned.size() == 1;
        int stageCount = singleApprover ? 1 : TITLES.size();
        var stages = new ArrayList<Map<String, Object>>();
        for (int i = 0; i < stageCount; i++) {
            var row = assigned.get(i + 1);
            var stage = new LinkedHashMap<String, Object>();
            stage.put("position", i + 1);
            stage.put("title", singleApprover ? SINGLE_TITLE : TITLES.get(i));
            stage.put("exampleName", EXAMPLES.get(i));
            stage.put("approverId", row == null || row.get("approver_id") == null ? null : row.get("approver_id").toString());
            stage.put("approverName", row == null ? null : row.get("approver_name"));
            stages.add(stage);
        }
        var candidates = Accounts.isManager(user) ? Db.rows(db, """
            SELECT id, name FROM users WHERE company_id = ? AND role IN ('manager', 'dispatcher') ORDER BY name, id
            """, company).stream().map(row -> Map.of("id", row.get("id").toString(), "name", row.get("name"))).toList()
            : List.of();
        return Map.of("stages", stages, "candidates", candidates, "canEdit", canEdit(user),
            "configured", configured, "supportsSingleApprover", true);
    }

    static Map<String, Object> saveSettings(Connection db, Map<String, Object> user, Map<String, Object> body)
            throws SQLException {
        if (!canEdit(user)) throw error(403, "Маршрут согласования настраивает создатель компании.");
        if (!(body.get("approverIds") instanceof List<?> ids) || !validStageCount(ids.size())) {
            throw error(400, "Выберите одного согласующего или трёх разных.");
        }
        long company = number(user, "company_id");
        if (Db.postgres()) Db.one(db, "SELECT id FROM companies WHERE id = ? FOR NO KEY UPDATE", company);
        var approvers = new ArrayList<Long>();
        for (Object value : ids) {
            long id = Trips.identifier(value, "Согласующий");
            if (Db.one(db, "SELECT id FROM users WHERE company_id = ? AND id = ? AND role IN ('manager', 'dispatcher')",
                    company, id) == null) {
                throw error(400, "Выберите согласующих из руководителей вашей компании.");
            }
            approvers.add(id);
        }
        if (new HashSet<>(approvers).size() != approvers.size()) throw error(400, "Выберите трёх разных согласующих.");
        Db.update(db, "DELETE FROM trip_approval_settings WHERE company_id = ?", company);
        for (int i = 0; i < approvers.size(); i++) {
            Db.update(db, "INSERT INTO trip_approval_settings(company_id, position, approver_id) VALUES (?, ?, ?)",
                company, i + 1, approvers.get(i));
        }
        return settings(db, user);
    }

    static void begin(Connection db, long company, long offer) throws SQLException {
        var assigned = configuration(db, company);
        if (!validConfiguration(assigned)) {
            throw error(409, "Попросите создателя компании настроить согласование командировок.");
        }
        for (var row : assigned.values()) {
            Db.update(db, "INSERT INTO work_trip_offer_approvals(offer_id, position, approver_id) VALUES (?, ?, ?)",
                offer, row.get("position"), row.get("approver_id"));
        }
    }

    private static Map<Integer, Map<String, Object>> configuration(Connection db, long company) throws SQLException {
        var assigned = new LinkedHashMap<Integer, Map<String, Object>>();
        for (var row : Db.rows(db, CONFIG, company)) assigned.put((int) number(row, "position"), row);
        return assigned;
    }

    private static boolean validConfiguration(Map<Integer, Map<String, Object>> assigned) {
        if (!validStageCount(assigned.size())) return false;
        for (int position = 1; position <= assigned.size(); position++) {
            var row = assigned.get(position);
            if (row == null || row.get("approver_id") == null) return false;
        }
        return true;
    }

    private static boolean validStageCount(int count) {
        return count == 1 || count == TITLES.size();
    }

    private static boolean validStages(List<Stage> stages) {
        if (!validStageCount(stages.size())) return false;
        for (int index = 0; index < stages.size(); index++) {
            if (stages.get(index).position() != index + 1) return false;
        }
        return true;
    }

    static Map<Long, List<Stage>> forOffers(Connection db, String scope, Object[] parameters) throws SQLException {
        var approvals = new LinkedHashMap<Long, List<Stage>>();
        for (var row : Db.rows(db, """
            SELECT a.*, u.name AS approver_name FROM work_trip_offer_approvals a
            JOIN work_trip_offers r ON r.id = a.offer_id
            JOIN users u ON u.id = a.approver_id AND u.company_id = r.company_id
            WHERE r.company_id = ?
            """ + scope + " ORDER BY a.offer_id, a.position", parameters)) {
            approvals.computeIfAbsent(number(row, "offer_id"), id -> new ArrayList<>()).add(Stage.from(row));
        }
        return approvals;
    }

    static Stage active(List<Stage> stages) {
        if (!validStages(stages)) return null;
        for (var stage : stages) {
            if ("rejected".equals(stage.decision())) return null;
            if (stage.decision() == null) return stage;
        }
        return null;
    }

    static Decision decide(List<Stage> stages, long actor, long expectedRevision, long currentRevision,
                           Map<String, Object> body) {
        Object value = body.get("stage");
        if (!(value instanceof Integer || value instanceof Long) || ((Number) value).longValue() < 1
                || ((Number) value).longValue() > TITLES.size()) {
            throw error(400, "Укажите этап согласования от 1 до 3.");
        }
        String action = field(body, "action", "Решение", 7, false);
        String decision = switch (action) {
            case "approve" -> "approved";
            case "reject" -> "rejected";
            default -> throw error(400, "Выберите решение по командировке.");
        };
        String reason = field(body, "reason", "Причина решения", 500, !"rejected".equals(decision));
        if (!validStages(stages)) throw error(409, "Маршрут согласования недоступен.");
        if (((Number) value).longValue() > stages.size()) throw error(400, "В маршруте нет такого этапа согласования.");
        var stage = stages.get(((Number) value).intValue() - 1);
        if (stage.approverId() != actor) throw error(403, "Решение принимает назначенный согласующий.");
        if (stage.decidedRevision() != null && expectedRevision == stage.decidedRevision() - 1
                && decision.equals(stage.decision()) && reason.equals(stage.reason())) {
            return new Decision(stage, decision, reason, true);
        }
        if (expectedRevision != currentRevision) throw error(409, "Условия командировки изменились. Обновите карточку.");
        if (stage != active(stages)) throw error(409, "Сейчас этот этап недоступен для согласования.");
        return new Decision(stage, decision, reason, false);
    }

    static void record(Connection db, long offer, Decision decision, long revision, String at) throws SQLException {
        Db.update(db, """
            UPDATE work_trip_offer_approvals SET decision = ?, decided_at = ?, reason = ?, decided_revision = ?
            WHERE offer_id = ? AND position = ?
            """, decision.value(), at, decision.reason(), revision, offer, decision.stage().position());
    }

    static boolean isFinalApproval(Decision decision, int stageCount) {
        return "approved".equals(decision.value()) && decision.stage().position() == stageCount;
    }

    private static boolean canEdit(Map<String, Object> user) {
        return Accounts.isManager(user) && number(user, "is_owner") != 0;
    }
}
