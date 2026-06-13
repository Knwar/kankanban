// PostToolUse (matcher: Edit|Write|Bash): worktree activity → ticker event.
import { api, cardIdFrom, projectIdFor, readStdin } from './lib.js';

const data = await readStdin();
const input = data.tool_input ?? {};
const cardId = cardIdFrom(JSON.stringify(input));
if (!cardId) process.exit(0); // not card work — ignore

const projectId = await projectIdFor(data.cwd ?? process.cwd());
if (!projectId) process.exit(0);

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
