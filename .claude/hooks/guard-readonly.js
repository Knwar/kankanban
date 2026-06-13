// PreToolUse (matcher: Edit|Write|MultiEdit): deny writes from the reviewer.
// Belt-and-suspenders with the reviewer's restricted tool list.
import { readStdin } from './lib.js';

const WRITERS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const data = await readStdin();
if (data.agent_type === 'reviewer' && WRITERS.has(data.tool_name)) {
  console.error('reviewer is read-only: record this as a finding via record_review instead of editing');
  process.exit(2);
}
