CREATE TABLE login_registry (
    login TEXT PRIMARY KEY,
    user_id BIGINT UNIQUE REFERENCES users(id) DEFERRABLE INITIALLY IMMEDIATE
);

INSERT INTO login_registry(login, user_id)
SELECT login, CASE WHEN COUNT(*) = 1 THEN MIN(id) ELSE NULL END
FROM users GROUP BY login;
