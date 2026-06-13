// Thin stdio MCP client of the board daemon. Never touches SQLite.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const DAEMON_URL = process.env.DAEMON_URL ?? 'http://localhost:7890';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Call the daemon; degrade to a readable error if it's down or rejects. */
async function api(method: string, path: string, body?: unknown): Promise<ToolResult> {
  try {
    const res = await fetch(`${DAEMON_URL}${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { content: [{ type: 'text', text }], isError: !res.ok };
  } catch {
    return {
      content: [{ type: 'text', text: `board daemon unreachable at ${DAEMON_URL} — board features unavailable; continue without them or ask the user to run scripts/dev.sh` }],
      isError: true,
    };
  }
}

const server = new McpServer({ name: 'kankan', version: '0.1.0' });

server.registerTool(
  'get_or_create_project',
  {
    description: 'Get or create the board project for a directory. Returns {project_id,name}.',
    inputSchema: { root_path: z.string(), name: z.string().optional() },
  },
  ({ root_path, name }) => {
    const params = new URLSearchParams({ root: root_path });
    if (name) params.set('name', name);
    return api('GET', `/project?${params}`);
  },
);

server.registerTool(
  'get_board',
  {
    description: 'Full board as summary cards (id,title,lane,tag,agent). Use sparingly; prefer get_active_card.',
    inputSchema: { project_id: z.string() },
  },
  ({ project_id }) => api('GET', `/board?project=${encodeURIComponent(project_id)}`),
);

server.registerTool(
  'get_active_card',
  {
    description: 'Cards currently in_progress — "what am I on?".',
    inputSchema: { project_id: z.string() },
  },
  ({ project_id }) => api('GET', `/active?project=${encodeURIComponent(project_id)}`),
);

server.registerTool(
  'get_next_card',
  {
    description: 'Top backlog card whose depends_on are all done, or null.',
    inputSchema: { project_id: z.string() },
  },
  ({ project_id }) => api('GET', `/next?project=${encodeURIComponent(project_id)}`),
);

server.registerTool(
  'create_task',
  {
    description: 'Create a task in the backlog. Returns {task_id}.',
    inputSchema: {
      project_id: z.string(),
      title: z.string(),
      tag: z.enum(['ui', 'api', 'db', 'infra']).optional(),
      requirements: z.string().optional(),
      depends_on: z.array(z.string()).optional(),
    },
  },
  (input) => api('POST', '/task', input),
);

server.registerTool(
  'update_task',
  {
    description: 'Update a task’s requirements, tag, depends_on, or subtasks (acceptance criteria, replaces the whole list).',
    inputSchema: {
      task_id: z.string(),
      requirements: z.string().optional(),
      tag: z.enum(['ui', 'api', 'db', 'infra']).optional(),
      depends_on: z.array(z.string()).optional(),
      subtasks: z.array(z.string()).optional(),
    },
  },
  ({ task_id, ...patch }) => api('PATCH', `/task/${task_id}`, patch),
);

server.registerTool(
  'check_subtask',
  {
    description: 'Mark one acceptance criterion done (by zero-based index). When the last one is checked on an in_progress card, the daemon auto-moves it to in_review.',
    inputSchema: {
      task_id: z.string(),
      index: z.number().int().min(0),
      done: z.boolean().optional(),
    },
  },
  ({ task_id, index, done }) =>
    api('POST', `/task/${task_id}/check`, { index, done: done ?? true, agent: 'builder' }),
);

server.registerTool(
  'move_task',
  {
    description: 'Move a card to a lane. Judgment moves only (e.g. backlog→queued, review routing) — in_progress/in_review transitions are fired by hooks, not you.',
    inputSchema: {
      task_id: z.string(),
      lane: z.enum(['backlog', 'queued', 'in_progress', 'in_review', 'done']),
    },
  },
  ({ task_id, lane }) => api('POST', `/task/${task_id}/move`, { lane, agent: 'orchestrator' }),
);

server.registerTool(
  'assign_card',
  {
    description: 'Record dispatch: which agent owns the card, in which worktree, on which branch.',
    inputSchema: {
      task_id: z.string(),
      agent: z.string(),
      worktree_path: z.string(),
      branch: z.string(),
    },
  },
  ({ task_id, agent, worktree_path, branch }) =>
    api('PATCH', `/task/${task_id}`, { assigned_agent: agent, worktree_path, branch }),
);

server.registerTool(
  'record_review',
  {
    description: 'Record a review verdict for a card; bumps the review round.',
    inputSchema: {
      task_id: z.string(),
      verdict: z.enum(['pass', 'fail']),
      findings: z
        .array(
          z.object({
            file: z.string(),
            line: z.number().optional(),
            severity: z.string(),
            note: z.string(),
          }),
        )
        .optional(),
    },
  },
  ({ task_id, verdict, findings }) => api('POST', `/task/${task_id}/review`, { verdict, findings }),
);

await server.connect(new StdioServerTransport());
