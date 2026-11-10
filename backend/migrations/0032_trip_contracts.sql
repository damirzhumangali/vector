ALTER TABLE work_trip_offers ADD COLUMN contract_id BIGINT REFERENCES work_contracts(id);

ALTER TABLE work_trip_route_stops DROP CONSTRAINT work_trip_route_stops_position_check;
ALTER TABLE work_trip_route_stops ADD CONSTRAINT work_trip_route_stops_position_check
    CHECK (position BETWEEN 1 AND 50);
