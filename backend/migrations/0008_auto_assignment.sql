CREATE TABLE assignment_settings (
    company_id BIGINT PRIMARY KEY REFERENCES companies(id),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    max_active_tasks INTEGER NOT NULL CHECK (max_active_tasks BETWEEN 1 AND 50)
);

CREATE INDEX task_events_gps_arrivals ON task_events(actor_id, id)
    WHERE status = 'arrived' AND position IS NOT NULL;
