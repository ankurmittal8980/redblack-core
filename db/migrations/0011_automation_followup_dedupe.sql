-- Guarantee that automation cannot leave duplicate open follow-up tasks for the same lead/title.
-- Preserve the oldest open task and cancel any historical duplicates before installing the invariant.

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY workspace_id, lead_id, title
           ORDER BY created_at, id
         ) AS duplicate_rank
    FROM tasks
   WHERE lead_id IS NOT NULL
     AND source = 'automation'
     AND status IN ('pending', 'in_progress')
)
UPDATE tasks
   SET status = 'cancelled',
       updated_at = now()
 WHERE id IN (SELECT id FROM ranked WHERE duplicate_rank > 1);

CREATE UNIQUE INDEX IF NOT EXISTS tasks_automation_one_open_followup_key
  ON tasks(workspace_id, lead_id, title)
  WHERE lead_id IS NOT NULL
    AND source = 'automation'
    AND status IN ('pending', 'in_progress');
