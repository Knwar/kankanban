// SubagentStart (matcher: builder): log build_start for the builder's card.
// The lane transition to in_progress is enforced deterministically at assign_card
// (the card id is known there). We do NOT fall back to "first queued card" — that
// raced across concurrent builders and only advanced one of them.
import { api, cardIdFromEvent, projectIdFor, readStdin } from './lib.js';

const data = await readStdin();
const projectId = await projectIdFor(data.cwd ?? process.cwd());
if (!projectId) process.exit(0);

const cardId = cardIdFromEvent(data);
if (!cardId) process.exit(0);

const agent = data.agent_type ?? 'builder';
await api('POST', `/task/${cardId}/move`, { lane: 'in_progress', agent }); // idempotent safety
await api('POST', '/event', { project_id: projectId, task_id: cardId, type: 'build_start', agent });
