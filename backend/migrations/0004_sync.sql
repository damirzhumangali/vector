ALTER TABLE task_events ADD COLUMN received_at TEXT;

CREATE TABLE sync_events (
    company_id BIGINT NOT NULL REFERENCES companies(id),
    event_id TEXT NOT NULL,
    task_id BIGINT NOT NULL REFERENCES tasks(id),
    actor_id BIGINT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('patch', 'photo')),
    expected_revision BIGINT NOT NULL,
    payload_hash TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    requested_status TEXT,
    photo_kind TEXT,
    conflict_reason TEXT,
    server_status TEXT,
    server_revision BIGINT,
    resolved_at TEXT,
    resolved_by BIGINT REFERENCES users(id),
    PRIMARY KEY (company_id, event_id)
);

CREATE INDEX sync_events_by_task ON sync_events(task_id, expected_revision);
CREATE INDEX sync_conflicts_by_company ON sync_events(company_id, received_at)
    WHERE conflict_reason IS NOT NULL;
