package qwork;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

/** Companies, employee accounts, one-time invitations, and bearer sessions. */
final class Accounts {
    private static final long SESSION_LIFETIME = 7 * 24 * 60 * 60;
    private static final long INVITE_LIFETIME = 7 * 24 * 60 * 60;
    private static final long EMAIL_TOKEN_LIFETIME = 60 * 60;
    private static final long EMAIL_REQUEST_COOLDOWN = 60;
    private static final int HASH_ROUNDS = 600_000;
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final byte[] DUMMY_SALT = new byte[16];
    private static final Set<String> ROLES = Set.of("employee", "dispatcher", "manager");
    private static final Pattern EMAIL = Pattern.compile("[^\\s@]+@[^\\s@]+\\.[^\\s@]+", Pattern.UNICODE_CHARACTER_CLASS);
    private static final Pattern STAFF_LOGIN = Pattern.compile("[a-zA-Z0-9._-]{3,40}");
    private static final Pattern TOKEN = Pattern.compile("[a-zA-Z0-9_-]{43}");
    private static final String USERS_WITH_COMPANY = """
            SELECT u.*, c.code, c.name AS company_name
            FROM users AS u JOIN companies AS c ON c.id = u.company_id
            """;

    private Accounts() {}

    static Map<String, Object> register(Connection db, Map<String, Object> payload) throws SQLException {
        String company = Domain.field(payload, "company", "Компания", 120, false);
        String owner = Domain.field(payload, "owner", "Имя", 120, false);
        String email = Domain.field(payload, "email", "Рабочая почта", 254, false);
        if (!EMAIL.matcher(email).matches()) {
            throw Domain.error(400, "Укажите корректную рабочую почту.");
        }
        String password = passwordFrom(payload, true);
        String login = foldLogin(email);
        byte[] salt = randomBytes(16);
        byte[] digest = passwordDigest(password, salt);
        String code = HexFormat.of().withUpperCase().formatHex(randomBytes(6));
        reserveLogin(db, login);
        long companyId = Db.insert(db, "INSERT INTO companies(code, name) VALUES (?, ?)", code, company);
        long ownerId = Db.insert(db, """
                INSERT INTO users(company_id, name, login, role, is_owner, password_hash, password_salt, email)
                VALUES (?, ?, ?, 'dispatcher', 1, ?, ?, ?)
                """, companyId, owner, login, digest, salt, email);
        bindLogin(db, login, ownerId);
        return issueSession(db, Db.one(db, "SELECT * FROM users WHERE id = ?", ownerId), code, company);
    }

    static Map<String, Object> login(Connection db, Map<String, Object> payload) throws SQLException {
        String login = foldLogin(Domain.field(payload, "login", "Почта или логин", 254, false));
        String password = passwordFrom(payload, false);
        byte[] inviteHash = null;
        Map<String, Object> user;
        String invalidLogin = "Проверьте почту или логин и пароль. Для первого входа используйте персональное приглашение.";

        if (payload.containsKey("inviteToken")) {
            if (!(payload.get("inviteToken") instanceof String token) || !TOKEN.matcher(token).matches()) {
                throw Domain.error(400, "Проверьте персональную ссылку приглашения.");
            }
            inviteHash = tokenDigest(token);
            user = Db.one(db, USERS_WITH_COMPANY
                    + " WHERE u.invite_hash = ? AND u.invite_expires_at > ? AND u.login = ?" + userLock(),
                    inviteHash, now(), login);
            invalidLogin = "Проверьте логин и пароль. Если ссылка использована или истекла, войдите обычным способом или запросите новое приглашение.";
        } else if (payload.containsKey("code")) {
            // Older accounts can still identify their company explicitly when their login was duplicated.
            String code = Domain.field(payload, "code", "Ссылка компании", 64, false).toUpperCase(Locale.ROOT);
            user = Db.one(db, USERS_WITH_COMPANY
                    + " WHERE c.code = ? AND u.login = ? AND u.invite_required = 0" + userLock(), code, login);
        } else {
            var identifier = Db.one(db, "SELECT user_id FROM login_registry WHERE login = ?", login);
            if (identifier != null && identifier.get("user_id") == null) {
                passwordDigest(password, DUMMY_SALT);
                throw legacyCompanyRequired();
            }
            user = identifier == null ? null : Db.one(db, USERS_WITH_COMPANY
                    + " WHERE u.id = ? AND u.invite_required = 0" + userLock(), identifier.get("user_id"));
        }

        byte[] digest = passwordDigest(password, user == null ? DUMMY_SALT : (byte[]) user.get("password_salt"));
        if (user == null || !MessageDigest.isEqual(digest, (byte[]) user.get("password_hash"))) {
            throw Domain.error(401, invalidLogin);
        }
        if (inviteHash != null) {
            boolean changingPassword = Domain.number(user, "invite_required") != 0;
            if (changingPassword && !payload.containsKey("newPassword")) {
                return Map.of("requiresPasswordChange", true);
            }
            byte[] newSalt = changingPassword ? randomBytes(16) : (byte[]) user.get("password_salt");
            byte[] newDigest = (byte[]) user.get("password_hash");
            if (changingPassword) {
                String newPassword = newPasswordFrom(payload, password);
                newDigest = passwordDigest(newPassword, newSalt);
            }

            long userId = Domain.number(user, "id");
            int claimed = Db.update(db, """
                    UPDATE users SET invite_hash = NULL, invite_expires_at = NULL, invite_required = 0,
                        password_hash = ?, password_salt = ?
                    WHERE id = ? AND invite_hash = ? AND invite_expires_at > ?
                    """, newDigest, newSalt, userId, inviteHash, now());
            if (claimed != 1) {
                throw Domain.error(401, invalidLogin);
            }
            if (changingPassword) {
                Db.update(db, "DELETE FROM sessions WHERE user_id = ?", userId);
                Db.update(db, "DELETE FROM password_resets WHERE user_id = ?", userId);
            }
            user = Db.one(db, USERS_WITH_COMPANY + " WHERE u.id = ?", userId);
        }
        return issueSession(db, user, (String) user.get("code"), (String) user.get("company_name"));
    }

    private static String userLock() {
        return Db.postgres() ? " FOR UPDATE OF u" : "";
    }

    private static Domain.Failure legacyCompanyRequired() {
        return Domain.error(409, "Для этого старого аккаунта укажите ссылку компании: такой логин раньше использовался в нескольких компаниях.");
    }

    private static String newPasswordFrom(Map<String, Object> payload, String temporaryPassword) {
        var newPassword = new LinkedHashMap<String, Object>();
        newPassword.put("password", payload.get("newPassword"));
        String value = passwordFrom(newPassword, true);
        if (value.equals(temporaryPassword)) {
            throw Domain.error(400, "Личный пароль должен отличаться от временного.");
        }
        return value;
    }

    static Map<String, Object> authenticate(Connection db, String token) throws SQLException {
        Map<String, Object> user = Db.one(db, """
                SELECT u.* FROM sessions AS s JOIN users AS u ON u.id = s.user_id
                WHERE s.token_hash = ? AND s.expires_at > ? AND u.invite_required = 0
                """, tokenDigest(token), now());
        if (user == null) {
            throw Domain.error(401, "Войдите в qwork снова.");
        }
        return user;
    }

    static Map<String, Object> me(Connection db, Map<String, Object> user) throws SQLException {
        var account = Db.one(db, USERS_WITH_COMPANY + " WHERE u.id = ?", Domain.number(user, "id"));
        return Map.of("user", userJson(account), "company", Map.of(
                "code", account.get("code"), "name", account.get("company_name")));
    }

    static Map<String, Object> setEmail(Connection db, Map<String, Object> user,
                                         Map<String, Object> payload) throws SQLException {
        if (!payload.containsKey("email")) {
            throw Domain.error(400, "Укажите почту или оставьте поле пустым.");
        }
        String email = optionalEmail(payload);
        String password = passwordFrom(payload, false);
        long userId = Domain.number(user, "id");
        var account = currentAccount(db, userId);
        if (!MessageDigest.isEqual(passwordDigest(password, (byte[]) account.get("password_salt")),
                (byte[]) account.get("password_hash"))) {
            throw Domain.error(401, "Проверьте текущий пароль.");
        }
        String previous = Objects.toString(account.get("email"), "");
        requireAvailableEmail(db, email, userId);
        if (email.equals(previous)) return me(db, account);
        String previousIdentifier = foldLogin(previous);
        if (!previousIdentifier.equals(account.get("login"))) {
            Db.update(db, "DELETE FROM login_registry WHERE login = ? AND user_id = ?", previousIdentifier, userId);
        }
        Db.update(db, """
                UPDATE users SET email = ?, email_verified = 0,
                    email_verify_hash = NULL, email_verify_expires_at = NULL WHERE id = ?
                """, email, userId);
        Db.update(db, "DELETE FROM password_resets WHERE user_id = ?", userId);
        return me(db, account);
    }

    static Map<String, Object> requestEmailVerification(Connection db, Map<String, Object> user)
            throws Exception {
        long userId = Domain.number(user, "id");
        var account = currentAccount(db, userId);
        String email = Objects.toString(account.get("email"), "");
        if (email.isEmpty()) throw Domain.error(400, "Сначала укажите почту в профиле.");
        if (Domain.number(account, "email_verified") != 0) return Map.of("verified", true);
        requireAvailableEmail(db, email, userId);
        requireEmailDelivery();
        long now = now();
        if (account.get("email_verify_expires_at") instanceof Number expiry
                && expiry.longValue() > now + EMAIL_TOKEN_LIFETIME - EMAIL_REQUEST_COOLDOWN) {
            throw emailCooldown();
        }
        String token = randomToken();
        Db.update(db, "UPDATE users SET email_verify_hash = ?, email_verify_expires_at = ? WHERE id = ?",
                tokenDigest(token), now + EMAIL_TOKEN_LIFETIME, userId);
        Mailer.sendVerification(email, token);
        return Map.of("sent", true);
    }

    static Map<String, Object> verifyEmail(Connection db, Map<String, Object> payload) throws SQLException {
        String token = emailToken(payload);
        byte[] hash = tokenDigest(token);
        var account = Db.one(db, """
                SELECT u.* FROM users u WHERE u.email_verify_hash = ? AND u.email_verify_expires_at > ?
                """ + userLock(), hash, now());
        if (account == null) throw invalidEmailToken();
        long userId = Domain.number(account, "id");
        String email = Objects.toString(account.get("email"), "");
        if (email.isEmpty()) throw invalidEmailToken();
        String emailIdentifier = foldLogin(email);
        Db.update(db, """
                INSERT INTO login_registry(login, user_id) VALUES (?, ?)
                ON CONFLICT (login) DO NOTHING
                """, emailIdentifier, userId);
        var identifier = Db.one(db, "SELECT user_id FROM login_registry WHERE login = ?", emailIdentifier);
        if (identifier == null || !(identifier.get("user_id") instanceof Number owner)
                || owner.longValue() != userId) {
            throw emailAlreadyUsed();
        }
        int verified = Db.update(db, """
                UPDATE users SET email_verified = 1, email_verify_hash = NULL, email_verify_expires_at = NULL
                WHERE id = ? AND email_verify_hash = ? AND email_verify_expires_at > ?
                """, userId, hash, now());
        if (verified != 1) throw invalidEmailToken();
        return Map.of("verified", true);
    }

    static Map<String, Object> requestPasswordReset(Connection db, Map<String, Object> payload)
            throws Exception {
        requireEmailDelivery();
        String login = foldLogin(Domain.field(payload, "login", "Почта или логин", 254, false));
        var identifier = Db.one(db, "SELECT user_id FROM login_registry WHERE login = ?", login);
        Map<String, Object> account = identifier == null || identifier.get("user_id") == null ? null
                : Db.one(db, "SELECT u.* FROM users u WHERE u.id = ?" + userLock(), identifier.get("user_id"));
        String email = account == null ? "" : Objects.toString(account.get("email"), "");
        if (account == null || email.isEmpty() || Domain.number(account, "email_verified") == 0
                || Domain.number(account, "invite_required") != 0) {
            return Map.of("sent", true);
        }
        long userId = Domain.number(account, "id");
        long now = now();
        var previous = Db.one(db, "SELECT MAX(expires_at) AS expiry FROM password_resets WHERE user_id = ?", userId);
        if (previous != null && previous.get("expiry") instanceof Number expiry
                && expiry.longValue() > now + EMAIL_TOKEN_LIFETIME - EMAIL_REQUEST_COOLDOWN) {
            // Keep the public response identical when a request was already sent recently.
            return Map.of("sent", true);
        }
        String token = randomToken();
        Db.update(db, "DELETE FROM password_resets WHERE user_id = ? OR expires_at <= ?", userId, now);
        Db.update(db, "INSERT INTO password_resets(token_hash, user_id, expires_at) VALUES (?, ?, ?)",
                tokenDigest(token), userId, now + EMAIL_TOKEN_LIFETIME);
        Mailer.sendPasswordReset(email, token);
        return Map.of("sent", true);
    }

    static Map<String, Object> resetPasswordByEmail(Connection db, Map<String, Object> payload)
            throws SQLException {
        byte[] hash = tokenDigest(emailToken(payload));
        String password = passwordFrom(payload, true);
        var request = Db.one(db, "SELECT user_id FROM password_resets WHERE token_hash = ? AND expires_at > ?",
                hash, now());
        if (request == null) throw invalidEmailToken();
        long userId = Domain.number(request, "user_id");
        var account = Db.one(db, "SELECT u.* FROM users u WHERE u.id = ?" + userLock(), userId);
        if (account == null || Domain.number(account, "invite_required") != 0
                || Db.one(db, "SELECT user_id FROM password_resets WHERE token_hash = ? AND expires_at > ?",
                    hash, now()) == null) {
            throw invalidEmailToken();
        }
        byte[] salt = randomBytes(16);
        Db.update(db, "UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?",
                passwordDigest(password, salt), salt, userId);
        Db.update(db, "DELETE FROM sessions WHERE user_id = ?", userId);
        Db.update(db, "DELETE FROM password_resets WHERE user_id = ?", userId);
        return Map.of("reset", true);
    }

    private static Map<String, Object> currentAccount(Connection db, long userId) throws SQLException {
        var account = Db.one(db, "SELECT u.* FROM users u WHERE u.id = ? AND u.invite_required = 0" + userLock(), userId);
        if (account == null) throw Domain.error(401, "Войдите в qwork снова.");
        return account;
    }

    private static void requireEmailDelivery() {
        if (!Mailer.configured()) {
            throw Domain.error(503, "Отправка писем пока не подключена. Для входа используйте логин, а для сброса пароля обратитесь к диспетчеру.");
        }
    }

    private static String emailToken(Map<String, Object> payload) {
        Object token = payload.get("token");
        if (!(token instanceof String text) || !TOKEN.matcher(text).matches()) throw invalidEmailToken();
        return text;
    }

    private static Domain.Failure invalidEmailToken() {
        return Domain.error(400, "Ссылка недействительна или истекла. Запросите новое письмо.");
    }

    private static Domain.Failure emailCooldown() {
        return Domain.error(429, "Письмо уже отправлено. Подождите минуту перед повторной отправкой.");
    }

    static void requireDispatcher(Map<String, Object> user) {
        if (!"dispatcher".equals(user.get("role"))) {
            throw Domain.error(403, "Действие доступно диспетчеру.");
        }
    }

    static void requireReviewer(Map<String, Object> user) {
        Object role = user.get("role");
        if (!"dispatcher".equals(role) && !"manager".equals(role)) {
            throw Domain.error(403, "Проверка отчёта доступна диспетчеру и руководителю.");
        }
    }

    static Map<String, Object> listEmployees(Connection db, Map<String, Object> user) throws SQLException {
        requireDispatcher(user);
        var employees = Db.rows(db, "SELECT * FROM users WHERE company_id = ? ORDER BY name, id",
                Domain.number(user, "company_id"));
        return Map.of("employees", employees.stream().map(Accounts::userJson).toList());
    }

    static Map<String, Object> createEmployee(Connection db, Map<String, Object> user,
                                               Map<String, Object> payload) throws SQLException {
        if (Domain.number(user, "is_owner") == 0) {
            throw Domain.error(403, "Добавить сотрудника может диспетчер, создавший компанию.");
        }
        String name = Domain.field(payload, "name", "Имя", 120, false);
        String login = Domain.field(payload, "login", "Логин", 40, false).toLowerCase(Locale.ROOT);
        String department = Domain.field(payload, "department", "Подразделение", 120, true);
        String email = optionalEmail(payload);
        if (!STAFF_LOGIN.matcher(login).matches()) {
            throw Domain.error(400, "Придумайте логин из 3–40 символов: латинские буквы, цифры, точка, дефис или подчёркивание.");
        }
        if (!(payload.get("role") instanceof String role) || !ROLES.contains(role)) {
            throw Domain.error(400, "Выберите роль сотрудника.");
        }
        requireAvailableEmail(db, email, 0);

        String temporaryPassword = temporaryPasswordFrom(payload);
        byte[] salt = randomBytes(16);
        byte[] digest = passwordDigest(temporaryPassword, salt);
        String invite = randomToken();
        reserveLogin(db, login);
        long userId;
        try {
            userId = Db.insert(db, """
                    INSERT INTO users(company_id, name, login, role, password_hash, password_salt,
                                      invite_hash, invite_expires_at, invite_required, department, email)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                    """, Domain.number(user, "company_id"), name, login, role,
                    digest, salt, tokenDigest(invite), now() + INVITE_LIFETIME, department, email);
        } catch (SQLException error) {
            if ("23505".equals(error.getSQLState()) || error.getErrorCode() == 19
                    || error.getErrorCode() == 2067) {
                throw Domain.error(409, "Этот логин уже занят. Придумайте другой.");
            }
            throw error;
        }
        bindLogin(db, login, userId);
        Map<String, Object> employee = Db.one(db, "SELECT * FROM users WHERE id = ?", userId);
        return Map.of("employee", userJson(employee), "inviteToken", invite,
                "temporaryPassword", temporaryPassword);
    }

    static Map<String, Object> setDepartment(Connection db, Map<String, Object> user, long employeeId,
                                             Map<String, Object> payload) throws SQLException {
        if (Domain.number(user, "is_owner") == 0) {
            throw Domain.error(403, "Изменить подразделение может диспетчер, создавший компанию.");
        }
        if (!payload.containsKey("department")) {
            throw Domain.error(400, "Укажите подразделение или передайте пустое значение.");
        }
        String department = Domain.field(payload, "department", "Подразделение", 120, true);
        long company = Domain.number(user, "company_id");
        int updated = Db.update(db, """
                UPDATE users SET department = ? WHERE id = ? AND company_id = ? AND is_owner = 0
                """, department, employeeId, company);
        if (updated != 1) {
            throw Domain.error(404, "Сотрудник не найден.");
        }
        var employee = Db.one(db, "SELECT * FROM users WHERE id = ? AND company_id = ?", employeeId, company);
        return Map.of("employee", userJson(employee));
    }

    static Map<String, Object> reissueInvite(Connection db, Map<String, Object> user, long employeeId)
            throws SQLException {
        if (Domain.number(user, "is_owner") == 0) {
            throw Domain.error(403, "Обновить приглашение может диспетчер, создавший компанию.");
        }
        String invite = randomToken();
        int updated = Db.update(db, """
                UPDATE users SET invite_hash = ?, invite_expires_at = ?
                WHERE id = ? AND company_id = ? AND is_owner = 0
                """, tokenDigest(invite), now() + INVITE_LIFETIME, employeeId, Domain.number(user, "company_id"));
        if (updated != 1) {
            throw Domain.error(404, "Сотрудник не найден.");
        }
        return Map.of("inviteToken", invite);
    }

    static Map<String, Object> resetPassword(Connection db, Map<String, Object> user, long employeeId,
                                               Map<String, Object> payload) throws SQLException {
        if (Domain.number(user, "is_owner") == 0) {
            throw Domain.error(403, "Сбросить пароль может диспетчер, создавший компанию.");
        }
        long company = Domain.number(user, "company_id");
        var employee = Db.one(db, """
                SELECT u.* FROM users u WHERE u.id = ? AND u.company_id = ? AND u.is_owner = 0
                """ + userLock(), employeeId, company);
        if (employee == null) throw Domain.error(404, "Сотрудник не найден.");
        String password = temporaryPasswordFrom(payload);
        byte[] salt = randomBytes(16);
        String invite = randomToken();
        Db.update(db, """
                UPDATE users SET password_hash = ?, password_salt = ?, invite_hash = ?,
                    invite_expires_at = ?, invite_required = 1 WHERE id = ? AND company_id = ?
                """, passwordDigest(password, salt), salt, tokenDigest(invite), now() + INVITE_LIFETIME,
                employeeId, company);
        Db.update(db, "DELETE FROM sessions WHERE user_id = ?", employeeId);
        Db.update(db, "DELETE FROM password_resets WHERE user_id = ?", employeeId);
        employee = Db.one(db, "SELECT * FROM users WHERE id = ?", employeeId);
        return Map.of("employee", userJson(employee), "inviteToken", invite,
                "temporaryPassword", password);
    }

    private static void requireAvailableEmail(Connection db, String email, long userId) throws SQLException {
        if (email.isEmpty()) return;
        var identifier = Db.one(db, "SELECT user_id FROM login_registry WHERE login = ?", foldLogin(email));
        if (identifier != null && (!(identifier.get("user_id") instanceof Number owner)
                || owner.longValue() != userId)) {
            throw emailAlreadyUsed();
        }
    }

    private static Domain.Failure emailAlreadyUsed() {
        return Domain.error(409, "Эта почта уже используется другим аккаунтом qwork. Укажите другую почту.");
    }

    private static void reserveLogin(Connection db, String login) throws SQLException {
        int reserved = Db.update(db, """
                INSERT INTO login_registry(login, user_id) VALUES (?, NULL)
                ON CONFLICT (login) DO NOTHING
                """, login);
        if (reserved != 1) {
            throw Domain.error(409, "Эта почта или логин уже используются. Войдите в существующий аккаунт или выберите другой логин.");
        }
    }

    private static void bindLogin(Connection db, String login, long userId) throws SQLException {
        Db.update(db, "UPDATE login_registry SET user_id = ? WHERE login = ?", userId, login);
    }

    static byte[] tokenDigest(String token) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8));
        } catch (GeneralSecurityException error) {
            throw new IllegalStateException("SHA-256 unavailable", error);
        }
    }

    private static Map<String, Object> issueSession(Connection db, Map<String, Object> user,
                                                     String companyCode, String companyName) throws SQLException {
        long userId = Domain.number(user, "id");
        String token = randomToken();
        long now = now();
        String lastLoginAt = Instant.ofEpochSecond(now).toString().replace("Z", "+00:00");
        Db.update(db, "UPDATE users SET last_login_at = ? WHERE id = ?", lastLoginAt, userId);
        Db.update(db, "DELETE FROM sessions WHERE expires_at <= ?", now);
        Db.update(db, "INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)",
                tokenDigest(token), userId, now + SESSION_LIFETIME);
        Map<String, Object> userData = userJson(user);
        userData.put("lastLoginAt", lastLoginAt);
        return Map.of("token", token, "user", userData, "company", Map.of("code", companyCode, "name", companyName));
    }

    private static Map<String, Object> userJson(Map<String, Object> row) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("id", Long.toString(Domain.number(row, "id")));
        result.put("name", row.get("name"));
        result.put("login", row.get("login"));
        result.put("email", Objects.toString(row.get("email"), ""));
        result.put("emailVerified", Domain.number(row, "email_verified") != 0);
        result.put("role", row.get("role"));
        result.put("department", row.get("department"));
        result.put("isOwner", Domain.number(row, "is_owner") != 0);
        result.put("lastLoginAt", row.get("last_login_at"));
        result.put("invitePending", Domain.number(row, "invite_required") != 0);
        return result;
    }

    private static String optionalEmail(Map<String, Object> payload) {
        String email = Domain.field(payload, "email", "Почта", 254, true);
        if (!email.isEmpty() && !EMAIL.matcher(email).matches()) {
            throw Domain.error(400, "Укажите корректную почту сотрудника или оставьте поле пустым.");
        }
        return email;
    }

    private static String temporaryPasswordFrom(Map<String, Object> payload) {
        if (!payload.containsKey("password")
                || payload.get("password") instanceof String password && password.isBlank()) {
            return "Qw-" + Base64.getUrlEncoder().withoutPadding().encodeToString(randomBytes(15));
        }
        return passwordFrom(payload, true);
    }

    private static String passwordFrom(Map<String, Object> payload, boolean isNew) {
        if (!(payload.get("password") instanceof String password) || password.isEmpty()
                || password.codePointCount(0, password.length()) > 128
                || password.codePoints().anyMatch(codePoint -> codePoint >= 0xD800 && codePoint <= 0xDFFF)) {
            throw Domain.error(400, "Введите пароль.");
        }
        if (isNew && password.codePointCount(0, password.length()) < 8) {
            throw Domain.error(400, "Пароль должен содержать не менее 8 символов.");
        }
        return password;
    }

    private static byte[] passwordDigest(String password, byte[] salt) {
        var spec = new PBEKeySpec(password.toCharArray(), salt, HASH_ROUNDS, 256);
        try {
            return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
        } catch (GeneralSecurityException error) {
            throw new IllegalStateException("PBKDF2 unavailable", error);
        } finally {
            spec.clearPassword();
        }
    }

    private static String foldLogin(String value) {
        // Fold one character at a time to avoid context-dependent final sigma.
        StringBuilder folded = new StringBuilder(value.length());
        value.codePoints().forEach(codePoint -> {
            String character = Character.toString(codePoint);
            if (codePoint == 0x0131) { // dotless i has no default Unicode case fold
                folded.append(character);
            } else if (Character.UnicodeBlock.of(codePoint) == Character.UnicodeBlock.CHEROKEE
                    || Character.UnicodeBlock.of(codePoint) == Character.UnicodeBlock.CHEROKEE_SUPPLEMENT) {
                folded.append(character.toUpperCase(Locale.ROOT));
            } else {
                folded.append(character.toLowerCase(Locale.ROOT).toUpperCase(Locale.ROOT).toLowerCase(Locale.ROOT));
            }
        });
        return folded.toString();
    }

    private static byte[] randomBytes(int size) {
        byte[] bytes = new byte[size];
        RANDOM.nextBytes(bytes);
        return bytes;
    }

    private static String randomToken() {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(randomBytes(32));
    }

    private static long now() {
        return Instant.now().getEpochSecond();
    }
}
