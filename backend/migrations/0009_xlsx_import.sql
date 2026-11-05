CREATE TABLE IF NOT EXISTS planning_imports (
    company_id BIGINT NOT NULL REFERENCES companies(id),
    fingerprint TEXT NOT NULL,
    PRIMARY KEY (company_id, fingerprint)
);
