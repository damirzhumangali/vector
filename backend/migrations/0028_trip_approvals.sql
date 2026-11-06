ALTER TABLE work_trip_offers ADD COLUMN self_requested INTEGER NOT NULL DEFAULT 0 CHECK (self_requested IN (0, 1));

CREATE TABLE trip_approval_settings (
    company_id BIGINT NOT NULL REFERENCES companies(id),
    position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 3),
    approver_id BIGINT NOT NULL REFERENCES users(id),
    PRIMARY KEY (company_id, position),
    UNIQUE (company_id, approver_id)
);

CREATE TABLE work_trip_offer_approvals (
    offer_id BIGINT NOT NULL REFERENCES work_trip_offers(id),
    position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 3),
    approver_id BIGINT NOT NULL REFERENCES users(id),
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
