ALTER TABLE tasks ADD COLUMN purpose TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3);
ALTER TABLE tasks ADD COLUMN manager_id BIGINT REFERENCES users(id);
ALTER TABLE tasks ADD COLUMN checklist TEXT;
ALTER TABLE tasks ADD COLUMN outcome TEXT;
ALTER TABLE tasks ADD COLUMN photo_pairs TEXT;
ALTER TABLE tasks ADD COLUMN repeat_reason TEXT NOT NULL DEFAULT '';

CREATE TABLE field_work_defaults (
    company_id BIGINT NOT NULL REFERENCES companies(id),
    scope TEXT NOT NULL CHECK (scope IN ('object', 'department')),
    scope_key TEXT NOT NULL,
    manager_id BIGINT NOT NULL REFERENCES users(id),
    PRIMARY KEY (company_id, scope, scope_key)
);

ALTER TABLE task_media DROP CONSTRAINT task_media_kind_check;
ALTER TABLE task_media ADD CONSTRAINT task_media_kind_check
    CHECK (kind IN ('material', 'before', 'after', 'checklist'));
ALTER TABLE task_media ADD COLUMN pair_key TEXT NOT NULL DEFAULT 'main';
ALTER TABLE task_media ADD COLUMN checklist_id TEXT;
DROP INDEX task_media_active_proof;
CREATE UNIQUE INDEX task_media_active_proof ON task_media(task_id, kind, pair_key)
    WHERE kind IN ('before', 'after') AND rejected_at IS NULL;
