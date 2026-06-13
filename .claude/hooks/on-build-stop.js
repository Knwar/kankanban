// SubagentStop (matcher: builder): card → in_review + build_end event.
import { api, cardIdFromEvent, projectIdFor, readStdin } from './lib.js';

const data = await readStdin();
const projectId = await projectIdFor(data.cwd ?? process.cwd());
if (!projectId) process.exit(0);

let cardId = cardIdFromEvent(data);
if (!cardId) {
  const board = (await api('GET', `/board?project=${projectId}`)) ?? [];
  cardId = board.find((c) => c.lane === 'in_progress')?.id ?? null;
}
if (!cardId) process.exit(0);

const agent = data.agent_type ?? 'builder';
await api('POST', `/task/${cardId}/move`, { lane: 'in_review', agent });
await api('POST', '/event', { project_id: projectId, task_id: cardId, type: 'build_end', agent });
