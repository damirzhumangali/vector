CREATE TABLE push_devices (
    token TEXT PRIMARY KEY,
    session_hash BYTEA NOT NULL UNIQUE REFERENCES sessions(token_hash) ON DELETE CASCADE
);

CREATE TABLE incident_push_jobs (
    incident_id BIGINT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    token TEXT NOT NULL REFERENCES push_devices(token) ON DELETE CASCADE,
    next_attempt BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    ticket_id TEXT,
    PRIMARY KEY (incident_id, token)
);

CREATE INDEX incident_push_jobs_due ON incident_push_jobs(next_attempt);
CREATE INDEX incident_push_jobs_device ON incident_push_jobs(token);
