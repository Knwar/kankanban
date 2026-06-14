// Shared helpers for kankan hooks. Hooks are best-effort: daemon down
// or fields missing must never break the session — degrade to exit 0.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const DAEMON = process.env.DAEMON_URL ?? 'http://localhost:7890';

export async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function api(method, path, body) {
  try {
    const res = await fetch(`${DAEMON}${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(1500),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function projectIdFor(cwd) {
  // create=0: hooks must never create a project — only the orchestrator / `kankan init` do.
  const project = await api('GET', `/project?root=${encodeURIComponent(cwd)}&create=0`);
  return project?.project_id ?? null;
}

/**
 * Resolve { projectId, cardId } for a cwd, mapping a kankan worktree back to
 * its parent project. Inside .../.trees/<id>/... the project is the parent
 * repo and the card is <id>; otherwise the project owns the cwd directly.
 * Never creates a project — so builder activity surfaces on the real board.
 */
export async function contextFor(cwd) {
  const m = String(cwd ?? '').match(/^(.*?)\/\.trees\/([^/]+)/);
  const root = m ? m[1] : String(cwd ?? '');
  const cardId = m ? m[2] : null;
  const project = await api('GET', `/project?root=${encodeURIComponent(root)}&create=0`);
  return { projectId: project?.project_id ?? null, cardId };
}

/** Worktree path is the agent↔card correlation key: .trees/<id> → <id>. */
export function cardIdFrom(text) {
  const matches = String(text ?? '').match(/\.trees\/([A-Za-z0-9_-]+)/g);
  if (!matches) return null;
  return matches[matches.length - 1].slice('.trees/'.length); // most recent mention
}

function expand(p) {
  return p?.startsWith('~') ? homedir() + p.slice(1) : p;
}

function scanFile(path, fromEnd = 0) {
  try {
    const p = expand(path);
    if (!p || !existsSync(p)) return null;
    const text = readFileSync(p, 'utf8');
    return cardIdFrom(fromEnd ? text.slice(-fromEnd) : text);
  } catch {
    return null;
  }
}

/** Derive the card id from a Subagent{Start,Stop} event. */
export function cardIdFromEvent(data) {
  // 1) anywhere in the event payload itself
  const direct = cardIdFrom(JSON.stringify(data));
  if (direct) return direct;
  // 2) the subagent transcript — it contains the dispatch prompt
  const candidates = [data.agent_transcript_path];
  if (data.transcript_path && data.agent_id) {
    candidates.push(
      String(data.transcript_path).replace(/\.jsonl$/, `/subagents/agent-${data.agent_id}.jsonl`),
    );
  }
  for (const candidate of candidates) {
    const id = scanFile(candidate);
    if (id) return id;
  }
  // 3) tail of the main transcript (most recent dispatch wins)
  return scanFile(data.transcript_path, 64 * 1024);
}
