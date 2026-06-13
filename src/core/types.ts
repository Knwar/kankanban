export const LANES = ['backlog', 'queued', 'in_progress', 'in_review', 'done'] as const;
export type Lane = (typeof LANES)[number];

export interface Project {
  id: string;
  name: string;
  root_path: string;
  created_at: number;
}

export interface Task {
  id: string;
  project_id: string;
  title: string;
  lane: Lane;
  requirements: string | null;
  tag: string | null;
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
  agent: string | null;
  rounds: number;
  updated_at: number;
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
  | 'check';

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
