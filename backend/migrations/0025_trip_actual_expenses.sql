CREATE TABLE work_trip_actual_expenses (
    trip_id BIGINT PRIMARY KEY REFERENCES work_trips(id),
    transport BIGINT NOT NULL CHECK (transport BETWEEN 0 AND 999999999),
    lodging BIGINT NOT NULL CHECK (lodging BETWEEN 0 AND 999999999),
    meals BIGINT NOT NULL CHECK (meals BETWEEN 0 AND 999999999),
    other BIGINT NOT NULL CHECK (other BETWEEN 0 AND 999999999),
    note TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_at TEXT NOT NULL
);
