// PostToolUse (matcher: Edit|Write|Bash): worktree activity → ticker event.
import { api, cardIdFrom, contextFor, readStdin } from './lib.js';

const data = await readStdin();
const input = data.tool_input ?? {};
const ctx = await contextFor(data.cwd ?? process.cwd());
const cardId = ctx.cardId ?? cardIdFrom(JSON.stringify(input));
if (!cardId) process.exit(0); // not card work — ignore
if (!ctx.projectId) process.exit(0);
const projectId = ctx.projectId;

// ticker-friendly: path relative to the worktree, or the bash command
const raw = String(input.file_path ?? input.command ?? '');
const file = raw.replace(/^.*\.trees\/[^/]+\//, '').slice(0, 80);

await api('POST', '/event', {
  project_id: projectId,
  task_id: cardId,
  type: 'tool',
  payload: { tool: data.tool_name, file },
  agent: data.agent_type ?? 'main',
});
