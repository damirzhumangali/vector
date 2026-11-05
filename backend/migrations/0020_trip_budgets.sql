ALTER TABLE work_trips ADD COLUMN object_id BIGINT REFERENCES work_sites(id);
ALTER TABLE work_trips ADD COLUMN address TEXT NOT NULL DEFAULT '';
ALTER TABLE work_trips ADD COLUMN budget TEXT;
ALTER TABLE work_trips ADD COLUMN estimate TEXT;
ALTER TABLE work_trip_requests ADD COLUMN estimate TEXT;
