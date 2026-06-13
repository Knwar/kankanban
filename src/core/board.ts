import { randomBytes, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { DB } from './db.js';
import {
  LANES,
  type CardSummary,
  type EventType,
  type Lane,
  type Project,
  type ReviewFinding,
  type Subtask,
  type Task,
  type TaskEvent,
  type Verdict,
} from './types.js';

function now(): number {
  return Date.now();
}

function shortId(): string {
  return randomBytes(4).toString('hex');
}

function assertLane(lane: string): asserts lane is Lane {
  if (!LANES.includes(lane as Lane)) throw new Error(`invalid lane: ${lane}`);
}

export function getTask(db: DB, taskId: string): Task {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
  if (!task) throw new Error(`no such task: ${taskId}`);
  return task;
}

export function appendEvent(
  db: DB,
  e: {
    project_id: string;
    task_id?: string | null;
    type: EventType;
    payload?: unknown;
    agent?: string | null;
  },
): TaskEvent {
  const created_at = now();
  const payload = e.payload === undefined ? null : JSON.stringify(e.payload);
  const result = db
    .prepare(
      `INSERT INTO task_events (project_id, task_id, type, payload, agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(e.project_id, e.task_id ?? null, e.type, payload, e.agent ?? null, created_at);
  return {
    id: Number(result.lastInsertRowid),
    project_id: e.project_id,
    task_id: e.task_id ?? null,
    type: e.type,
    payload,
    agent: e.agent ?? null,
    created_at,
  };
}

export function getOrCreateProject(db: DB, rootPath: string, name?: string): Project {
  const existing = db.prepare('SELECT * FROM projects WHERE root_path = ?').get(rootPath) as
    | Project
    | undefined;
  if (existing) return existing;
  const project: Project = {
    id: randomUUID(),
    name: name ?? basename(rootPath),
    root_path: rootPath,
    created_at: now(),
  };
  db.prepare('INSERT INTO projects (id, name, root_path, created_at) VALUES (?, ?, ?, ?)').run(
    project.id,
    project.name,
    project.root_path,
    project.created_at,
  );
  return project;
}

export function createTask(
  db: DB,
  projectId: string,
  title: string,
  opts: { tag?: string; requirements?: string; depends_on?: string[] } = {},
): Task {
  const ts = now();
  const max = db
    .prepare('SELECT MAX(position) AS max FROM tasks WHERE project_id = ?')
    .get(projectId) as { max: number | null };
  const task: Task = {
    id: shortId(),
    project_id: projectId,
    title,
    lane: 'backlog',
    requirements: opts.requirements ?? null,
    tag: opts.tag ?? null,
    assigned_agent: null,
    worktree_path: null,
    branch: null,
    depends_on: opts.depends_on ? JSON.stringify(opts.depends_on) : null,
    subtasks: null,
    review_rounds: 0,
    position: (max.max ?? 0) + 1,
    created_at: ts,
    updated_at: ts,
  };
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, lane, requirements, tag, depends_on, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.project_id,
    task.title,
    task.lane,
    task.requirements,
    task.tag,
    task.depends_on,
    task.position,
    task.created_at,
    task.updated_at,
  );
  appendEvent(db, { project_id: projectId, task_id: task.id, type: 'create', payload: { title } });
  return task;
}

const UPDATABLE = [
  'requirements',
  'tag',
  'depends_on',
  'assigned_agent',
  'worktree_path',
  'branch',
] as const;
type UpdatableField = (typeof UPDATABLE)[number];

export function updateTask(
  db: DB,
  taskId: string,
  patch: Partial<Record<UpdatableField, string | string[] | null>>,
): Task {
  getTask(db, taskId); // existence check
  const sets: string[] = [];
  const values: (string | null)[] = [];
  for (const field of UPDATABLE) {
    if (!(field in patch)) continue;
    const raw = patch[field];
    sets.push(`${field} = ?`);
    values.push(Array.isArray(raw) ? JSON.stringify(raw) : (raw ?? null));
  }
  if (sets.length === 0) throw new Error('empty patch');
  db.prepare(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(
    ...values,
    now(),
    taskId,
  );
  return getTask(db, taskId);
}

export function moveTask(db: DB, taskId: string, lane: string, agent?: string): Task {
  assertLane(lane);
  const task = getTask(db, taskId);
  if (task.lane !== lane) {
    db.prepare('UPDATE tasks SET lane = ?, updated_at = ? WHERE id = ?').run(lane, now(), taskId);
    appendEvent(db, {
      project_id: task.project_id,
      task_id: taskId,
      type: 'move',
      payload: { from: task.lane, to: lane },
      agent,
    });
  }
  return getTask(db, taskId);
}

export function assignCard(
  db: DB,
  taskId: string,
  agent: string,
  worktreePath: string,
  branch: string,
): Task {
  const task = updateTask(db, taskId, {
    assigned_agent: agent,
    worktree_path: worktreePath,
    branch,
  });
  appendEvent(db, {
    project_id: task.project_id,
    task_id: taskId,
    type: 'assign',
    payload: { worktree: worktreePath, branch },
    agent,
  });
  return task;
}

export function recordReview(
  db: DB,
  taskId: string,
  verdict: Verdict,
  findings: ReviewFinding[] = [],
): { task_id: string; round: number; verdict: Verdict } {
  if (verdict !== 'pass' && verdict !== 'fail') throw new Error(`invalid verdict: ${verdict}`);
  const task = getTask(db, taskId);
  const round = task.review_rounds + 1;
  db.prepare(
    'INSERT INTO reviews (task_id, round, verdict, findings, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(taskId, round, verdict, JSON.stringify(findings), now());
  db.prepare('UPDATE tasks SET review_rounds = ?, updated_at = ? WHERE id = ?').run(
    round,
    now(),
    taskId,
  );
  appendEvent(db, {
    project_id: task.project_id,
    task_id: taskId,
    type: 'review',
    payload: { verdict, round, findings: findings.length },
  });
  return { task_id: taskId, round, verdict };
}

/** Acceptance-criteria progress for a card's subtasks JSON, or null if none. */
export function progressOf(json: string | null): { done: number; total: number } | null {
  if (!json) return null;
  const subs = JSON.parse(json) as Subtask[];
  if (subs.length === 0) return null;
  return { done: subs.filter((s) => s.done).length, total: subs.length };
}

/** Replace a card's acceptance criteria. Strings arrive unchecked. */
export function setSubtasks(
  db: DB,
  taskId: string,
  items: (string | Subtask)[],
  agent?: string,
): Task {
  const task = getTask(db, taskId);
  const subs: Subtask[] = items.map((item) =>
    typeof item === 'string' ? { text: item, done: false } : { text: item.text, done: !!item.done },
  );
  db.prepare('UPDATE tasks SET subtasks = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(subs),
    now(),
    taskId,
  );
  appendEvent(db, {
    project_id: task.project_id,
    task_id: taskId,
    type: 'subtasks',
    payload: { total: subs.length },
    agent,
  });
  return getTask(db, taskId);
}

/**
 * Check (or uncheck) one acceptance criterion. Deterministic rule: when the
 * last one is checked on an in_progress card, the card moves to in_review.
 */
export function checkSubtask(
  db: DB,
  taskId: string,
  index: number,
  done = true,
  agent?: string,
): { task: Task; moved: boolean } {
  const task = getTask(db, taskId);
  const subs: Subtask[] = task.subtasks ? JSON.parse(task.subtasks) : [];
  if (!subs[index]) throw new Error(`no subtask ${index} on ${taskId}`);
  subs[index].done = done;
  db.prepare('UPDATE tasks SET subtasks = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(subs),
    now(),
    taskId,
  );
  appendEvent(db, {
    project_id: task.project_id,
    task_id: taskId,
    type: 'check',
    payload: { index, text: subs[index].text, done, progress: progressOf(JSON.stringify(subs)) },
    agent,
  });
  let moved = false;
  if (done && task.lane === 'in_progress' && subs.every((s) => s.done)) {
    moveTask(db, taskId, 'in_review', agent ?? 'auto');
    moved = true;
  }
  return { task: getTask(db, taskId), moved };
}

const CARD_COLUMNS =
  'id, title, lane, tag, assigned_agent AS agent, review_rounds AS rounds, updated_at, subtasks';

function toSummary(row: CardSummary & { subtasks: string | null }): CardSummary {
  const { subtasks, ...card } = row;
  return { ...card, subs: progressOf(subtasks) };
}

export function getBoard(db: DB, projectId: string): CardSummary[] {
  return (
    db
      .prepare(`SELECT ${CARD_COLUMNS} FROM tasks WHERE project_id = ? ORDER BY lane, position`)
      .all(projectId) as (CardSummary & { subtasks: string | null })[]
  ).map(toSummary);
}

export function getActiveCards(db: DB, projectId: string): CardSummary[] {
  return (
    db
      .prepare(
        `SELECT ${CARD_COLUMNS} FROM tasks WHERE project_id = ? AND lane = 'in_progress' ORDER BY position`,
      )
      .all(projectId) as (CardSummary & { subtasks: string | null })[]
  ).map(toSummary);
}

/** Top backlog card whose depends_on are all done, or null. */
export function getNextCard(db: DB, projectId: string): Task | null {
  const backlog = db
    .prepare(`SELECT * FROM tasks WHERE project_id = ? AND lane = 'backlog' ORDER BY position`)
    .all(projectId) as Task[];
  const isDone = db.prepare(`SELECT 1 FROM tasks WHERE id = ? AND lane = 'done'`);
  for (const task of backlog) {
    const deps: string[] = task.depends_on ? JSON.parse(task.depends_on) : [];
    if (deps.every((id) => isDone.get(id))) return task;
  }
  return null;
}

export function getRecentEvents(db: DB, projectId: string, limit = 20): TaskEvent[] {
  return db
    .prepare('SELECT * FROM task_events WHERE project_id = ? ORDER BY id DESC LIMIT ?')
    .all(projectId, limit) as TaskEvent[];
}
