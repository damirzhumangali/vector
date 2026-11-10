package qwork;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;

import java.sql.Connection;
import java.sql.SQLException;
import java.text.Normalizer;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

import static qwork.Domain.error;
import static qwork.Domain.field;
import static qwork.Domain.number;

final class Contracts {
    static final String SQLITE_SCHEMA = """
        CREATE TABLE IF NOT EXISTS work_contracts (
            id INTEGER PRIMARY KEY,
            company_id INTEGER NOT NULL REFERENCES companies(id),
            number TEXT NOT NULL,
            number_key TEXT NOT NULL,
            signed_on TEXT NOT NULL,
            customer TEXT NOT NULL,
            legal_entity TEXT NOT NULL,
            legal_entity_key TEXT NOT NULL,
            object_ids TEXT NOT NULL,
            installation_amount INTEGER NOT NULL CHECK (installation_amount BETWEEN 0 AND 999999999999),
            support_amount INTEGER NOT NULL CHECK (support_amount BETWEEN 0 AND 999999999999),
            payment_mode TEXT NOT NULL CHECK (payment_mode IN ('combined', 'separate')),
            payments TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active')),
            revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
            CHECK (installation_amount > 0 OR support_amount > 0),
            UNIQUE (company_id, legal_entity_key, number_key)
        );
        CREATE INDEX IF NOT EXISTS work_contracts_by_company ON work_contracts(company_id, signed_on DESC, id DESC);
        CREATE TABLE IF NOT EXISTS contract_payment_receipts (
            id INTEGER PRIMARY KEY,
            contract_id INTEGER NOT NULL REFERENCES work_contracts(id),
            payment_index INTEGER NOT NULL CHECK (payment_index BETWEEN 0 AND 60),
            request_id TEXT NOT NULL,
            amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 1999999999998),
            received_on TEXT NOT NULL,
            created_at TEXT NOT NULL,
            recorded_by INTEGER NOT NULL REFERENCES users(id),
            recorded_by_name TEXT NOT NULL,
            UNIQUE (contract_id, request_id)
        );
        CREATE INDEX IF NOT EXISTS contract_receipts_by_payment
            ON contract_payment_receipts(contract_id, payment_index, received_on, id);
        """;

    private static final long MAX_AMOUNT = 999_999_999_999L;
    private static final int MAX_OBJECTS = 50;
    private static final int MAX_SUPPORT_PAYMENTS = 60;
    private static final ZoneId PAYMENT_ZONE = ZoneId.of("Asia/Almaty");
    private static final Set<String> MODES = Set.of("combined", "separate");
    private static final Pattern SPACES = Pattern.compile("\\s+", Pattern.UNICODE_CHARACTER_CLASS);
    private static final Pattern DATE = Pattern.compile("[0-9]{4}-[0-9]{2}-[0-9]{2}");
    private static final Pattern OBJECT_ID = Pattern.compile("[1-9][0-9]{0,18}");
    private static final Pattern REQUEST_ID = Pattern.compile(
        "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    private static final TypeReference<List<String>> OBJECT_IDS = new TypeReference<>() {};
    private static final TypeReference<List<Payment>> PAYMENTS = new TypeReference<>() {};

    private record Payment(String dueOn, long installationAmount, long supportAmount) {}

    private record Draft(String number, String signedOn, String customer, String legalEntity,
                         List<String> objectIds, long installationAmount, long supportAmount,
                         String paymentMode, List<Payment> payments) {}

    private Contracts() {}

    static Map<String, Object> list(Connection db, Map<String, Object> user) throws SQLException {
        requireContractReader(user);
        long company = number(user, "company_id");
        var rows = Db.rows(db, """
            SELECT * FROM work_contracts WHERE company_id = ? ORDER BY signed_on DESC, id DESC
            """, company);
        var totals = new HashMap<Long, Map<Integer, Long>>();
        for (var payment : Db.rows(db, """
            SELECT r.contract_id, r.payment_index, SUM(r.amount) AS paid
            FROM contract_payment_receipts r JOIN work_contracts c ON c.id = r.contract_id
            WHERE c.company_id = ? GROUP BY r.contract_id, r.payment_index
            """, company)) {
            totals.computeIfAbsent(number(payment, "contract_id"), key -> new HashMap<>())
                .put((int) number(payment, "payment_index"), number(payment, "paid"));
        }
        return Map.of("contracts", rows.stream()
            .map(row -> json(row, totals.getOrDefault(number(row, "id"), Map.of()), null)).toList());
    }

    static Map<String, Object> detail(Connection db, Map<String, Object> user, long id) throws SQLException {
        requireContractReader(user);
        return detail(db, find(db, number(user, "company_id"), id, false));
    }

    static List<Map<String, Object>> tripSources(Connection db, long company, List<Map<String, Object>> sites)
            throws SQLException {
        var names = siteNames(sites);
        var result = new ArrayList<Map<String, Object>>();
        for (var contract : Db.rows(db, """
            SELECT id, number, object_ids FROM work_contracts
            WHERE company_id = ? AND status = 'active' ORDER BY signed_on DESC, id DESC
            """, company)) {
            var ids = storedObjectIds(contract);
            if (ids.isEmpty() || !names.keySet().containsAll(ids)) continue;
            var objects = ids.stream().map(id -> Map.of("id", id, "name", names.get(id))).toList();
            result.add(Map.of("id", contract.get("id").toString(), "number", contract.get("number"), "objects", objects));
        }
        return result;
    }

    static List<String> tripDestinations(Connection db, long company, long contractId, Object input, String city)
            throws SQLException {
        var contract = Db.one(db, """
            SELECT object_ids FROM work_contracts WHERE company_id = ? AND id = ? AND status = 'active'
            """, company, contractId);
        if (contract == null) throw error(404, "Действующий договор не найден.");
        var ids = storedObjectIds(contract);
        if (ids.isEmpty()) throw error(409, "В этом договоре нет объектов для командировки.");
        if (!(input instanceof List<?> route) || route.size() != ids.size()
                || !new HashSet<>(route).equals(new HashSet<>(ids))) {
            throw error(400, "Укажите каждый объект из договора один раз.");
        }

        var names = siteNames(Db.rows(db, "SELECT id, name FROM work_sites WHERE company_id = ?", company));
        if (!names.keySet().containsAll(ids)) throw error(409, "Объекты договора недоступны.");
        // The trip stores a snapshot of each name. Distinguish objects with the same name by ID.
        boolean duplicateNames = ids.stream().map(id -> names.get(id).toLowerCase(Locale.ROOT)).distinct().count() != ids.size();
        var destinations = new ArrayList<String>();
        for (Object id : route) {
            String name = names.get(id);
            if (duplicateNames) name += " · объект №" + id;
            if (!city.isEmpty()) name = city + " · " + name;
            destinations.add(field(Map.of("name", name), "name", "Точка маршрута", 300, false));
        }
        return destinations;
    }

    private static Map<String, String> siteNames(List<Map<String, Object>> sites) {
        var names = new HashMap<String, String>();
        for (var site : sites) names.put(site.get("id").toString(), (String) site.get("name"));
        return names;
    }

    private static Map<String, Object> detail(Connection db, Map<String, Object> row) throws SQLException {
        var totals = new HashMap<Integer, Long>();
        var history = new HashMap<Integer, List<Map<String, Object>>>();
        for (var receipt : Db.rows(db, """
            SELECT id, payment_index, amount, received_on, created_at, recorded_by, recorded_by_name
            FROM contract_payment_receipts WHERE contract_id = ? ORDER BY received_on, id
            """, number(row, "id"))) {
            int index = (int) number(receipt, "payment_index");
            long amount = number(receipt, "amount");
            totals.merge(index, amount, Long::sum);
            history.computeIfAbsent(index, key -> new ArrayList<>()).add(Map.of(
                "id", receipt.get("id").toString(),
                "amount", amount,
                "receivedOn", receipt.get("received_on"),
                "createdAt", receipt.get("created_at"),
                "recordedBy", Map.of("id", receipt.get("recorded_by").toString(), "name", receipt.get("recorded_by_name"))
            ));
        }
        return Map.of("contract", json(row, totals, history));
    }

    static Map<String, Object> create(Connection db, Map<String, Object> user, Map<String, Object> body)
            throws SQLException {
        Accounts.requireManager(user);
        long company = number(user, "company_id");
        Draft draft = parse(db, company, body);
        Planning.lockCompany(db, company);
        requireUnique(db, company, 0, draft);
        long id = Db.insert(db, """
            INSERT INTO work_contracts(company_id, number, number_key, signed_on, customer, legal_entity,
                legal_entity_key, object_ids, installation_amount, support_amount, payment_mode, payments)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, company, draft.number(), key(draft.number()), draft.signedOn(), draft.customer(), draft.legalEntity(),
            key(draft.legalEntity()), encode(draft.objectIds()), draft.installationAmount(), draft.supportAmount(),
            draft.paymentMode(), encode(draft.payments()));
        return detail(db, user, id);
    }

    static Map<String, Object> update(Connection db, Map<String, Object> user, long id, Map<String, Object> body)
            throws SQLException {
        Accounts.requireManager(user);
        long company = number(user, "company_id");
        Planning.lockCompany(db, company);
        var row = find(db, company, id, true);
        long revision = revision(body);
        requireRevision(row, revision);
        if (!"draft".equals(row.get("status"))) throw error(409, "Действующий договор закрыт для редактирования.");
        Draft draft = parse(db, company, body);
        requireUnique(db, company, id, draft);
        Db.update(db, """
            UPDATE work_contracts SET number = ?, number_key = ?, signed_on = ?, customer = ?, legal_entity = ?,
                legal_entity_key = ?, object_ids = ?, installation_amount = ?, support_amount = ?, payment_mode = ?,
                payments = ?, revision = revision + 1
            WHERE company_id = ? AND id = ?
            """, draft.number(), key(draft.number()), draft.signedOn(), draft.customer(), draft.legalEntity(),
            key(draft.legalEntity()), encode(draft.objectIds()), draft.installationAmount(), draft.supportAmount(),
            draft.paymentMode(), encode(draft.payments()), company, id);
        return detail(db, user, id);
    }

    static Map<String, Object> activate(Connection db, Map<String, Object> user, long id, Map<String, Object> body)
            throws SQLException {
        Accounts.requireManager(user);
        long company = number(user, "company_id");
        var row = find(db, company, id, true);
        long revision = revision(body);
        if ("active".equals(row.get("status"))) return detail(db, row);
        requireRevision(row, revision);
        Db.update(db, """
            UPDATE work_contracts SET status = 'active', revision = revision + 1 WHERE company_id = ? AND id = ?
            """, company, id);
        return detail(db, user, id);
    }

    static Map<String, Object> recordReceipt(Connection db, Map<String, Object> user, long id, Map<String, Object> body)
            throws SQLException {
        if (!Accounts.isAccountant(user)) throw error(403, "Поступление может записать бухгалтер.");
        // A contract's locked schedule is immutable. Its row lock serializes receipt writes on PostgreSQL.
        var row = find(db, number(user, "company_id"), id, true);
        if (!"active".equals(row.get("status"))) {
            throw error(409, "Сначала руководитель должен активировать договор.", "contract_not_active");
        }
        var plan = paymentPlan(row);
        int index = (int) integer(body.get("paymentIndex"), 0, plan.size() - 1, "Выберите платёж из графика.");
        long amount = integer(body.get("amount"), 1, 2 * MAX_AMOUNT, "Укажите положительную сумму в целых тенге.");
        String receivedOn = date(body.get("receivedOn"), "Дата поступления");
        if (LocalDate.parse(receivedOn).isAfter(LocalDate.now(PAYMENT_ZONE))) {
            throw error(400, "Дата поступления не может быть позже сегодняшней даты.");
        }
        String requestId = field(body, "requestId", "Идентификатор операции", 36, false).toLowerCase(Locale.ROOT);
        if (!REQUEST_ID.matcher(requestId).matches()) throw error(400, "Проверьте идентификатор операции.");
        long actor = number(user, "id");
        var prior = Db.one(db, """
            SELECT payment_index, amount, received_on, recorded_by
            FROM contract_payment_receipts WHERE contract_id = ? AND request_id = ?
            """, id, requestId);
        if (prior != null) {
            if (number(prior, "payment_index") != index || number(prior, "amount") != amount
                    || !receivedOn.equals(prior.get("received_on")) || number(prior, "recorded_by") != actor) {
                throw error(409, "Эта операция уже использована для другого поступления.",
                    "contract_receipt_request_conflict");
            }
            return detail(db, row);
        }

        long paid = number(Db.one(db, """
            SELECT COALESCE(SUM(amount), 0) AS paid
            FROM contract_payment_receipts WHERE contract_id = ? AND payment_index = ?
            """, id, index), "paid");
        var payment = plan.get(index);
        if (amount > payment.installationAmount() + payment.supportAmount() - paid) {
            throw error(409, "Сумма больше остатка по этому платежу.", "contract_receipt_exceeds_balance");
        }
        Db.update(db, """
            INSERT INTO contract_payment_receipts(
                contract_id, payment_index, request_id, amount, received_on, created_at, recorded_by, recorded_by_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, id, index, requestId, amount, receivedOn, Instant.now().toString(), actor, user.get("name"));
        return detail(db, row);
    }

    private static void requireContractReader(Map<String, Object> user) {
        if (!Accounts.isManager(user) && !Accounts.isAccountant(user)) {
            throw error(403, "Договоры доступны руководителю и бухгалтеру.");
        }
    }

    private static Map<String, Object> find(Connection db, long company, long id, boolean lock) throws SQLException {
        var row = Db.one(db, "SELECT * FROM work_contracts WHERE company_id = ? AND id = ?"
            + (lock && Db.postgres() ? " FOR UPDATE" : ""), company, id);
        if (row == null) throw error(404, "Договор не найден.");
        return row;
    }

    private static void requireUnique(Connection db, long company, long id, Draft draft) throws SQLException {
        var existing = Db.one(db, """
            SELECT id FROM work_contracts WHERE company_id = ? AND legal_entity_key = ? AND number_key = ? AND id <> ?
            """, company, key(draft.legalEntity()), key(draft.number()), id);
        if (existing != null) throw error(409, "У этого ТОО уже есть договор с таким номером.", "contract_duplicate");
    }

    private static String key(String value) {
        String folded = SPACES.matcher(value).replaceAll(" ").strip().toLowerCase(Locale.ROOT);
        return Normalizer.normalize(folded, Normalizer.Form.NFC);
    }

    private static long revision(Map<String, Object> body) {
        return integer(body.get("revision"), 1, Integer.MAX_VALUE, "Проверьте версию договора.");
    }

    private static void requireRevision(Map<String, Object> row, long revision) {
        if (revision != number(row, "revision")) {
            throw error(409, "Договор уже изменился. Откройте его заново.", "contract_revision");
        }
    }

    private static Draft parse(Connection db, long company, Map<String, Object> body) throws SQLException {
        String contractNumber = field(body, "number", "Номер договора", 80, false);
        String signedOn = date(body.get("signedOn"), "Дата договора");
        String customer = field(body, "customer", "Заказчик", 200, false);
        String legalEntity = field(body, "legalEntity", "Наше ТОО", 200, false);
        long installation = amount(body.get("installationAmount"), "Монтаж");
        long support = amount(body.get("supportAmount"), "Сопровождение");
        if (installation == 0 && support == 0) throw error(400, "Укажите сумму за монтаж или сопровождение.");
        String mode = field(body, "paymentMode", "Способ оплаты", 8, false);
        if (!MODES.contains(mode)) throw error(400, "Выберите способ оплаты.");
        var payments = payments(body.get("payments"), signedOn, installation, support, mode);
        return new Draft(contractNumber, signedOn, customer, legalEntity, objectIds(db, company, body.get("objectIds")),
            installation, support, mode, payments);
    }

    private static List<String> objectIds(Connection db, long company, Object value) throws SQLException {
        if (value == null) return List.of();
        if (!(value instanceof List<?> objects) || objects.size() > MAX_OBJECTS) {
            throw error(400, "Выберите до 50 объектов из справочника.");
        }
        var ids = new LinkedHashSet<String>();
        var params = new ArrayList<>();
        params.add(company);
        for (Object item : objects) {
            if (!(item instanceof String id) || !OBJECT_ID.matcher(id).matches() || !ids.add(id)) {
                throw error(400, "Выберите каждый объект из справочника один раз.");
            }
            try {
                params.add(Long.parseLong(id));
            } catch (NumberFormatException invalidId) {
                throw error(400, "Выберите объект из справочника.");
            }
        }
        if (!ids.isEmpty()) {
            String placeholders = String.join(", ", java.util.Collections.nCopies(ids.size(), "?"));
            if (Db.rows(db, "SELECT id FROM work_sites WHERE company_id = ? AND id IN (" + placeholders + ")",
                    params.toArray()).size() != ids.size()) {
                throw error(400, "Один из выбранных объектов недоступен.");
            }
        }
        return List.copyOf(ids);
    }

    private static List<Payment> payments(Object value, String signedOn, long installation, long support, String mode) {
        if (!(value instanceof List<?> rows) || rows.isEmpty() || rows.size() > MAX_SUPPORT_PAYMENTS + 1) {
            throw error(400, "Заполните график оплаты: один платёж за монтаж и до 60 платежей за сопровождение.");
        }
        var payments = new ArrayList<Payment>();
        long plannedInstallation = 0;
        long plannedSupport = 0;
        int installationCount = 0;
        int supportCount = 0;
        boolean combined = "combined".equals(mode);
        if (combined && rows.size() != 1) throw error(400, "Для общей оплаты укажите один платёж.");

        for (Object item : rows) {
            if (!(item instanceof Map<?, ?> row)) throw error(400, "Проверьте график оплаты.");
            String dueOn = date(row.get("dueOn"), "Срок оплаты");
            if (dueOn.compareTo(signedOn) < 0) throw error(400, "Срок оплаты не может быть раньше даты договора.");
            long installationPart = amount(row.get("installationAmount"), "Монтаж в платеже");
            long supportPart = amount(row.get("supportAmount"), "Сопровождение в платеже");
            if (installationPart == 0 && supportPart == 0) throw error(400, "Укажите положительную сумму платежа.");
            if (!combined && installationPart > 0 && supportPart > 0) {
                throw error(400, "При раздельной оплате монтаж и сопровождение указываются в разных платежах.");
            }
            if (installationPart > 0) installationCount++;
            if (supportPart > 0) supportCount++;
            plannedInstallation += installationPart;
            plannedSupport += supportPart;
            payments.add(new Payment(dueOn, installationPart, supportPart));
        }
        if (installationCount > 1 || supportCount > MAX_SUPPORT_PAYMENTS) {
            throw error(400, "Укажите один платёж за монтаж и не более 60 платежей за сопровождение.");
        }
        if (plannedInstallation != installation || plannedSupport != support) {
            throw error(400, "Суммы платежей за монтаж и сопровождение должны совпадать с суммами договора.");
        }
        payments.sort(Comparator.comparing(Payment::dueOn));
        return List.copyOf(payments);
    }

    private static String date(Object value, String label) {
        if (value instanceof String text && DATE.matcher(text).matches()) {
            try {
                if (LocalDate.parse(text).getYear() > 0) return text;
            } catch (DateTimeParseException ignored) {
                // Reject impossible dates rather than adjusting them.
            }
        }
        throw error(400, "Укажите корректную дату в поле «" + label + "».");
    }

    private static long amount(Object value, String label) {
        return integer(value, 0, MAX_AMOUNT,
            "Поле «" + label + "» должно быть целым числом от 0 до 999 999 999 999 ₸.");
    }

    private static long integer(Object value, long min, long max, String message) {
        if (value instanceof Integer || value instanceof Long) {
            long amount = ((Number) value).longValue();
            if (amount >= min && amount <= max) return amount;
        }
        throw error(400, message);
    }

    private static String encode(Object value) {
        try {
            return Db.JSON.writeValueAsString(value);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Unable to encode contract data", error);
        }
    }

    private static List<Payment> paymentPlan(Map<String, Object> row) {
        try {
            return Db.JSON.readValue((String) row.get("payments"), PAYMENTS);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Unable to decode contract payment plan", error);
        }
    }

    private static List<String> storedObjectIds(Map<String, Object> row) {
        try {
            return Db.JSON.readValue((String) row.get("object_ids"), OBJECT_IDS);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Unable to decode contract objects", error);
        }
    }

    private static Map<String, Object> json(Map<String, Object> row, Map<Integer, Long> totals,
                                           Map<Integer, List<Map<String, Object>>> history) {
        var result = new LinkedHashMap<String, Object>();
        long installation = number(row, "installation_amount");
        long support = number(row, "support_amount");
        long paid = totals.values().stream().mapToLong(Long::longValue).sum();
        result.put("id", row.get("id").toString());
        result.put("number", row.get("number"));
        result.put("signedOn", row.get("signed_on"));
        result.put("customer", row.get("customer"));
        result.put("legalEntity", row.get("legal_entity"));
        result.put("installationAmount", installation);
        result.put("supportAmount", support);
        result.put("paidAmount", paid);
        result.put("outstandingAmount", installation + support - paid);
        result.put("paymentMode", row.get("payment_mode"));
        result.put("status", row.get("status"));
        result.put("revision", number(row, "revision"));
        result.put("objectIds", storedObjectIds(row));
        var plan = paymentPlan(row);
        var payments = new ArrayList<Map<String, Object>>(plan.size());
        for (int index = 0; index < plan.size(); index++) {
            var payment = plan.get(index);
            long paidAmount = totals.getOrDefault(index, 0L);
            var entry = new LinkedHashMap<String, Object>();
            entry.put("paymentIndex", index);
            entry.put("dueOn", payment.dueOn());
            entry.put("installationAmount", payment.installationAmount());
            entry.put("supportAmount", payment.supportAmount());
            entry.put("paidAmount", paidAmount);
            entry.put("outstandingAmount", payment.installationAmount() + payment.supportAmount() - paidAmount);
            if (history != null) entry.put("receipts", history.getOrDefault(index, List.of()));
            payments.add(entry);
        }
        result.put("payments", payments);
        return result;
    }
}
