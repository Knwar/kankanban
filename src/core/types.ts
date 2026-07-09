export const LANES = ['backlog', 'queued', 'in_progress', 'in_review', 'done'] as const;
export type Lane = (typeof LANES)[number];

export interface Project {
  id: string;
  name: string;
  root_path: string;
  created_at: number;
}

export const PHASE_STATUSES = ['planned', 'active', 'done'] as const;
export type PhaseStatus = (typeof PHASE_STATUSES)[number];

export interface Phase {
  id: string;
  project_id: string;
  title: string;
  goal: string | null; // markdown: what this phase delivers
  plan: string | null; // markdown: per-phase implementation plan (filled lazily)
  status: PhaseStatus; // planned → active → done
  position: number;
  created_at: number;
  updated_at: number;
}

/** Phase as the drawer/orchestrator read it: metadata + card progress. */
export interface PhaseView {
  id: string;
  title: string;
  goal: string | null;
  status: PhaseStatus;
  position: number;
  progress: { done: number; total: number };
}

export interface Task {
  id: string;
  project_id: string;
  phase_id: string | null; // the phase this card belongs to, or null (flat/legacy)
  title: string;
  lane: Lane;
  requirements: string | null;
  tag: string | null;
  skill: string | null; // assigned persona skill (from the team roster)
  assigned_agent: string | null;
  worktree_path: string | null;
  branch: string | null;
  depends_on: string | null; // JSON array of task ids
  subtasks: string | null; // JSON array of Subtask (acceptance criteria)
  review_rounds: number;
  position: number;
  created_at: number;
  updated_at: number;
}

export interface Subtask {
  text: string;
  done: boolean;
}

/** Terse card shape returned by board reads (keep token cost low). */
export interface CardSummary {
  id: string;
  title: string;
  lane: Lane;
  tag: string | null;
  skill: string | null;
  agent: string | null;
  rounds: number;
  updated_at: number;
  phase_id: string | null;
  subs: { done: number; total: number } | null;
}

export type EventType =
  | 'create'
  | 'move'
  | 'assign'
  | 'note'
  | 'tool'
  | 'build_start'
  | 'build_end'
  | 'review'
  | 'subtasks'
  | 'check'
  | 'delete'
  | 'redirect'
  | 'phase_create'
  | 'phase_activate'
  | 'phase_done';

export interface TaskEvent {
  id: number;
  project_id: string;
  task_id: string | null;
  type: EventType;
  payload: string | null; // JSON
  agent: string | null;
  created_at: number;
}

export type Verdict = 'pass' | 'fail';

export interface ReviewFinding {
  file: string;
  line?: number;
  severity: string;
  note: string;
}

export interface TeamMember {
  id: string; // agent id
  name: string;
  skill: string | null; // assigned skill name (persona)
  color: string | null;
  created_at: number;
}

export interface SkillInfo {
  name: string;
  description: string;
  source: string; // user | project
}

export interface CardTotals {
  tokens: number;
  tokens_out: number;
  lines_added: number;
  lines_removed: number;
  ms: number;
}

export interface AgentStat extends CardTotals {
  agent: string;
  cards: number;
}

export interface ProjectStats {
  totals: CardTotals & { cards: number };
  agents: AgentStat[];
}

export type AttentionKind =
  | 'review_failed'
  | 'merge_conflict'
  | 'stalled'
  | 'awaiting_review'
  | 'needs_spec';
export type AttentionSeverity = 'blocker' | 'warn' | 'info';

/** One card that needs a human decision, for the overlay's Attention queue. */
export interface AttentionItem {
  card_id: string;
  kind: AttentionKind;
  severity: AttentionSeverity;
  title: string;
  reason: string; // human sentence for the row
  since: number; // epoch ms it entered this state → "23m in state"
  blocking: number; // # open cards whose depends_on includes this card
  agent: string | null;
  phase_id: string | null;
}
