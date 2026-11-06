CREATE TABLE trip_organizations (
    company_id BIGINT NOT NULL REFERENCES companies(id),
    name_key TEXT NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (company_id, name_key)
);
