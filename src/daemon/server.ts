import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as board from '../core/board.js';
import { openDb } from '../core/db.js';
import type { Project, Task } from '../core/types.js';
import { Broadcaster } from './broadcast.js';

const PORT = Number(process.env.PORT ?? 7890);
const DB_PATH = process.env.DB_PATH ?? join(process.cwd(), 'data', 'board.db');
const OVERLAY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'overlay');

const db = openDb(DB_PATH);
const broadcaster = new Broadcaster();

// ── broadcast plumbing ──────────────────────────────────────────────
// board.ts appends events on every write; the daemon flushes anything
// newer than the last broadcast id out to subscribers after each write.
let lastEventId =
  (db.prepare('SELECT MAX(id) AS max FROM task_events').get() as { max: number | null }).max ?? 0;

function flushEvents(): void {
  const events = db
    .prepare('SELECT * FROM task_events WHERE id > ? ORDER BY id')
    .all(lastEventId) as { id: number; project_id: string }[];
  for (const event of events) {
    broadcaster.send(event.project_id, { type: 'event', event });
    lastEventId = event.id;
  }
}

function toCard(task: Task) {
  return {
    id: task.id,
    title: task.title,
    lane: task.lane,
    tag: task.tag,
    agent: task.assigned_agent,
    rounds: task.review_rounds,
    updated_at: task.updated_at,
    subs: board.progressOf(task.subtasks),
  };
}

const STARTED_AT = Date.now();

interface LimitWindow { used_percentage: number; resets_at: number }
let usage: { five_hour: LimitWindow | null; seven_day: LimitWindow | null } | null = null;

function projectStats(projectId: string) {
  const rows = db
    .prepare(
      `SELECT r.verdict, COUNT(*) AS n FROM reviews r
       JOIN tasks t ON t.id = r.task_id WHERE t.project_id = ? GROUP BY r.verdict`,
    )
    .all(projectId) as { verdict: string; n: number }[];
  const reviews = { pass: 0, fail: 0 };
  for (const row of rows) reviews[row.verdict as 'pass' | 'fail'] = row.n;
  return { started_at: STARTED_AT, reviews };
}

/** Broadcast a card upsert + any events the write produced. */
function announce(task: Task): void {
  broadcaster.send(task.project_id, { type: 'card', project_id: task.project_id, card: toCard(task) });
  flushEvents();
}

// ── git (for the overlay's commit modal) ────────────────────────────
const execFileAsync = promisify(execFile);

function projectRoot(projectId: string): string | null {
  const row = db.prepare('SELECT root_path FROM projects WHERE id = ?').get(projectId) as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}

async function git(root: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, ...args]);
    return stdout;
  } catch (err) {
    // git writes some failures to stdout (e.g. "nothing to commit")
    const e = err as { stderr?: string; stdout?: string; message: string };
    throw new Error((e.stderr || e.stdout || e.message).trim());
  }
}

async function gitStatus(root: string) {
  const branch = (await git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
  const porcelain = await git(root, 'status', '--porcelain');
  const files = porcelain
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const path = line.slice(3);
      return {
        status: line.slice(0, 2).trim(),
        path: path.includes(' -> ') ? path.split(' -> ')[1] : path, // renames
      };
    });
  return { branch, files };
}

async function gitDiff(root: string, file: string): Promise<string> {
  const tracked = await git(root, 'diff', 'HEAD', '--', file);
  if (tracked) return tracked;
  // untracked file → whole content as additions (no-index exits 1 on diff)
  try {
    return await execFileAsync('git', ['-C', root, 'diff', '--no-index', '--', '/dev/null', file])
      .then((r) => r.stdout);
  } catch (err) {
    return (err as { stdout?: string }).stdout ?? '';
  }
}

// ── http helpers ────────────────────────────────────────────────────
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (name.includes('..') || name.includes('/')) return json(res, 404, { error: 'not found' });
  try {
    const content = await readFile(join(OVERLAY_DIR, name));
    res.writeHead(200, { 'content-type': MIME[extname(name)] ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

// ── routes ──────────────────────────────────────────────────────────
async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const { pathname } = url;
  const method = req.method ?? 'GET';

  if (method === 'GET' && pathname === '/project') {
    const root = url.searchParams.get('root');
    if (!root) return json(res, 400, { error: 'root required' });
    const project = board.getOrCreateProject(db, root, url.searchParams.get('name') ?? undefined);
    return json(res, 200, { project_id: project.id, name: project.name });
  }

  if (method === 'GET' && ['/board', '/active', '/next'].includes(pathname)) {
    const project = url.searchParams.get('project');
    if (!project) return json(res, 400, { error: 'project required' });
    if (pathname === '/board') return json(res, 200, board.getBoard(db, project));
    if (pathname === '/active') return json(res, 200, board.getActiveCards(db, project));
    const next = board.getNextCard(db, project);
    return json(res, 200, next && { ...toCard(next), requirements: next.requirements, depends_on: next.depends_on });
  }

  if (method === 'POST' && pathname === '/task') {
    const b = await readBody(req);
    if (!b.project_id || !b.title) return json(res, 400, { error: 'project_id and title required' });
    const task = board.createTask(db, b.project_id, b.title, {
      tag: b.tag,
      requirements: b.requirements,
      depends_on: b.depends_on,
    });
    announce(task);
    return json(res, 200, { task_id: task.id });
  }

  const taskMatch = pathname.match(/^\/task\/([^/]+)(?:\/(move|review|check))?$/);
  if (taskMatch) {
    const [, taskId, action] = taskMatch;
    if (method === 'GET' && !action) {
      // full detail for the overlay's card modal
      const task = board.getTask(db, taskId);
      return json(res, 200, {
        ...task,
        depends_on: task.depends_on ? JSON.parse(task.depends_on) : [],
        subtasks: task.subtasks ? JSON.parse(task.subtasks) : [],
      });
    }
    const b = await readBody(req);

    if (method === 'PATCH' && !action) {
      const rest = { ...b };
      delete rest.subtasks;
      delete rest.agent;
      let task;
      // assignment (agent + worktree + branch together) logs an assign event
      if (b.assigned_agent && b.worktree_path && b.branch) {
        task = board.assignCard(db, taskId, b.assigned_agent, b.worktree_path, b.branch);
        delete rest.assigned_agent;
        delete rest.worktree_path;
        delete rest.branch;
      }
      if (Array.isArray(b.subtasks)) task = board.setSubtasks(db, taskId, b.subtasks, b.agent);
      if (!task || Object.keys(rest).length > 0) task = board.updateTask(db, taskId, rest);
      announce(task);
      return json(res, 200, { task_id: task.id });
    }
    if (method === 'POST' && action === 'check') {
      if (typeof b.index !== 'number') return json(res, 400, { error: 'index required' });
      const { task, moved } = board.checkSubtask(db, taskId, b.index, b.done ?? true, b.agent);
      announce(task);
      return json(res, 200, { task_id: task.id, lane: task.lane, subs: board.progressOf(task.subtasks), moved });
    }
    if (method === 'POST' && action === 'move') {
      if (!b.lane) return json(res, 400, { error: 'lane required' });
      const task = board.moveTask(db, taskId, b.lane, b.agent);
      announce(task);
      return json(res, 200, { task_id: task.id, lane: task.lane });
    }
    if (method === 'POST' && action === 'review') {
      if (!b.verdict) return json(res, 400, { error: 'verdict required' });
      const review = board.recordReview(db, taskId, b.verdict, b.findings ?? []);
      flushEvents();
      return json(res, 200, review);
    }
  }

  if (method === 'GET' && (pathname === '/git/status' || pathname === '/git/diff')) {
    const project = url.searchParams.get('project');
    const root = project && projectRoot(project);
    if (!root) return json(res, 404, { error: 'unknown project' });
    if (pathname === '/git/status') return json(res, 200, await gitStatus(root));
    const file = url.searchParams.get('file');
    if (!file) return json(res, 400, { error: 'file required' });
    res.writeHead(200, { 'content-type': 'text/plain' });
    return void res.end(await gitDiff(root, file));
  }

  if (method === 'POST' && pathname === '/git/commit') {
    const b = await readBody(req);
    const root = b.project_id && projectRoot(b.project_id);
    if (!root) return json(res, 404, { error: 'unknown project' });
    if (!b.message) return json(res, 400, { error: 'message required' });
    await git(root, 'add', '-A');
    const args = ['commit', '-m', b.message];
    if (b.description) args.push('-m', b.description);
    await git(root, ...args); // throws "nothing to commit" etc. → 400
    let push_error = null;
    try {
      await git(root, 'push');
    } catch (err) {
      push_error = (err as Error).message;
    }
    return json(res, 200, { ok: true, pushed: !push_error, push_error });
  }

  if (method === 'POST' && pathname === '/usage') {
    // subscription limit usage pushed by the statusline script.
    // account-level + ephemeral: memory only, broadcast to every client.
    const b = await readBody(req);
    if (!b.five_hour && !b.seven_day) return json(res, 400, { error: 'five_hour or seven_day required' });
    usage = { five_hour: b.five_hour ?? usage?.five_hour ?? null, seven_day: b.seven_day ?? usage?.seven_day ?? null };
    broadcaster.sendAll({ type: 'usage', usage });
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/status') {
    // ephemeral: broadcast-only, never stored — live "what is the agent doing"
    const b = await readBody(req);
    if (!b.project_id || !b.verb) return json(res, 400, { error: 'project_id and verb required' });
    broadcaster.send(b.project_id, {
      type: 'status',
      status: {
        agent: b.agent ?? 'agent',
        verb: b.verb,
        detail: b.detail ?? '',
        task_id: b.task_id ?? null,
      },
    });
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/event') {
    const b = await readBody(req);
    if (!b.project_id || !b.type) return json(res, 400, { error: 'project_id and type required' });
    board.appendEvent(db, b);
    flushEvents();
    return json(res, 200, { ok: true });
  }

  if (method === 'GET') return serveStatic(res, pathname);
  return json(res, 404, { error: 'not found' });
}

// ── server ──────────────────────────────────────────────────────────
const server = createServer((req, res) => {
  route(req, res).catch((err: Error) => json(res, 400, { error: err.message }));
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  // explicit ?project= filters; otherwise subscribe to everything and
  // seed the overlay with the most recently created project's board.
  const requested = url.searchParams.get('project');
  broadcaster.add(ws, requested);
  const project = requested
    ? (db.prepare('SELECT * FROM projects WHERE id = ?').get(requested) as Project | undefined)
    : (db.prepare('SELECT * FROM projects ORDER BY created_at DESC LIMIT 1').get() as
        | Project
        | undefined);
  ws.send(
    JSON.stringify({
      type: 'init',
      project: project ? { id: project.id, name: project.name } : null,
      board: project ? board.getBoard(db, project.id) : [],
      events: project ? board.getRecentEvents(db, project.id, 10).reverse() : [],
      stats: project ? projectStats(project.id) : { started_at: STARTED_AT, reviews: { pass: 0, fail: 0 } },
      usage,
    }),
  );
});

// listen failures surface on both the http server and the ws wrapper
function onListenError(err: NodeJS.ErrnoException): void {
  if (err.code === 'EADDRINUSE') {
    console.error(`port ${PORT} already in use — is another board daemon running?`);
    process.exit(1);
  }
  throw err;
}
server.on('error', onListenError);
wss.on('error', onListenError);

server.listen(PORT, () => {
  console.log(`board daemon on http://localhost:${PORT}  (db: ${DB_PATH})`);
});
