// SessionStart: print a compact board summary into context.
import { api, readStdin } from './lib.js';

const data = await readStdin();
const cwd = data.cwd ?? process.cwd();
const project = await api('GET', `/project?root=${encodeURIComponent(cwd)}`);
if (!project) process.exit(0); // daemon down — stay silent

const board = (await api('GET', `/board?project=${project.project_id}`)) ?? [];
const lanes = ['backlog', 'queued', 'in_progress', 'in_review', 'done'];
const counts = lanes.map((l) => `${l}:${board.filter((c) => c.lane === l).length}`).join(' ');

console.log(`[kankan] project_id=${project.project_id} (${project.name})`);
console.log(`[kankan] ${counts}`);
const inFlight = board.filter((c) => c.lane === 'in_progress' || c.lane === 'in_review');
for (const c of inFlight) {
  console.log(`[kankan]   ${c.id} "${c.title}" ${c.lane}${c.agent ? ` (${c.agent})` : ''}`);
}
