CREATE TABLE task_assignment_changes (
    task_id BIGINT NOT NULL REFERENCES tasks(id),
    previous_revision BIGINT NOT NULL,
    previous_assignee_id BIGINT NOT NULL REFERENCES users(id),
    PRIMARY KEY (task_id, previous_revision)
);

CREATE INDEX task_assignment_changes_by_assignee
    ON task_assignment_changes(task_id, previous_assignee_id);

CREATE FUNCTION qwork_record_task_assignment_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO task_assignment_changes(task_id, previous_revision, previous_assignee_id)
    VALUES (OLD.id, OLD.revision, OLD.assignee_id);
    RETURN NEW;
END;
$$;

CREATE TRIGGER qwork_task_assignment_change
    AFTER UPDATE OF assignee_id ON tasks
    FOR EACH ROW WHEN (OLD.assignee_id IS DISTINCT FROM NEW.assignee_id)
    EXECUTE FUNCTION qwork_record_task_assignment_change();
