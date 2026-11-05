ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1));
ALTER TABLE users ADD COLUMN email_verify_hash BYTEA;
ALTER TABLE users ADD COLUMN email_verify_expires_at BIGINT;
UPDATE users SET email = login WHERE is_owner = 1;
CREATE UNIQUE INDEX users_by_email_verification ON users(email_verify_hash) WHERE email_verify_hash IS NOT NULL;

ALTER TABLE login_registry DROP CONSTRAINT login_registry_user_id_key;
CREATE INDEX login_registry_by_user ON login_registry(user_id);

CREATE TABLE password_resets (
    token_hash BYTEA PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    expires_at BIGINT NOT NULL
);
CREATE INDEX password_resets_by_user ON password_resets(user_id);
CREATE INDEX password_resets_by_expiry ON password_resets(expires_at);
