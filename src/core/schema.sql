CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,           -- uuid
  name        TEXT NOT NULL,
  root_path   TEXT NOT NULL UNIQUE,       -- absolute cwd, for get_or_create
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,        -- short id, also used as worktree name
  project_id     TEXT NOT NULL REFERENCES projects(id),
  title          TEXT NOT NULL,
  lane           TEXT NOT NULL DEFAULT 'backlog',   -- backlog|queued|in_progress|in_review|done
  requirements   TEXT,                    -- markdown, authored from discussion
  tag            TEXT,                    -- ui|api|db|infra
  assigned_agent TEXT,                    -- current owner label
  worktree_path  TEXT,                    -- .trees/<id>  (also the agent<->card correlation key)
  branch         TEXT,                    -- card/<id>
  depends_on     TEXT,                    -- JSON array of task ids
  subtasks       TEXT,                    -- JSON array of {text,done} acceptance criteria
  review_rounds  INTEGER NOT NULL DEFAULT 0,
  position       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_events (  -- audit log + live ticker feed
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL,
  task_id     TEXT,                       -- nullable for project-level events
  type        TEXT NOT NULL,              -- create|move|assign|note|tool|build_start|build_end|review
  payload     TEXT,                       -- JSON: {from,to} | {tool,file} | ...
  agent       TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  round       INTEGER NOT NULL,
  verdict     TEXT NOT NULL,              -- pass|fail
  findings    TEXT,                       -- JSON: [{file,line,severity,note}]
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_lane ON tasks(project_id, lane, position);
CREATE INDEX IF NOT EXISTS idx_events_recent ON task_events(project_id, created_at);
