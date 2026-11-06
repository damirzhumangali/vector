ALTER TABLE work_trip_offers ADD COLUMN proposal_estimate TEXT;
ALTER TABLE work_trip_offers ADD COLUMN declined_at TEXT;

CREATE TABLE work_trip_offer_history (
    offer_id BIGINT NOT NULL REFERENCES work_trip_offers(id),
    revision INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('proposal', 'revision_requested', 'declined', 'confirmed')),
    actor_id BIGINT NOT NULL REFERENCES users(id),
    happened_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    planned_start TEXT,
    planned_end TEXT,
    proposed_at TEXT,
    proposal_estimate TEXT,
    PRIMARY KEY (offer_id, revision),
    CHECK ((planned_start IS NULL) = (planned_end IS NULL)),
    CHECK ((planned_start IS NULL) = (proposed_at IS NULL)),
    CHECK ((planned_start IS NULL) = (proposal_estimate IS NULL))
);
