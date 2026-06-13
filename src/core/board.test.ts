import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  appendEvent,
  assignCard,
  checkSubtask,
  createTask,
  getActiveCards,
  getBoard,
  getNextCard,
  getOrCreateProject,
  getRecentEvents,
  moveTask,
  recordReview,
  setSubtasks,
  updateTask,
} from './board.js';
import { openDb } from './db.js';

function setup() {
  const db = openDb();
  const project = getOrCreateProject(db, '/tmp/demo-app', 'Demo App');
  return { db, project };
}

describe('projects', () => {
  it('get_or_create is idempotent on root_path', () => {
    const { db, project } = setup();
    const again = getOrCreateProject(db, '/tmp/demo-app');
    assert.equal(again.id, project.id);
    assert.equal(again.name, 'Demo App');
  });

  it('derives name from path when omitted', () => {
    const { db } = setup();
    const p = getOrCreateProject(db, '/tmp/other-app');
    assert.equal(p.name, 'other-app');
  });
});

describe('tasks', () => {
  it('creates in backlog with incrementing position', () => {
    const { db, project } = setup();
    const a = createTask(db, project.id, 'First');
    const b = createTask(db, project.id, 'Second', { tag: 'ui' });
    assert.equal(a.lane, 'backlog');
    assert.equal(b.position, a.position + 1);
    assert.equal(b.tag, 'ui');
  });

  it('logs a create event', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'First');
    const events = getRecentEvents(db, project.id);
    assert.equal(events[0].type, 'create');
    assert.equal(events[0].task_id, task.id);
  });

  it('updates requirements and depends_on', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'First');
    const updated = updateTask(db, task.id, {
      requirements: '## Spec\n- do the thing',
      depends_on: ['abc123'],
    });
    assert.equal(updated.requirements, '## Spec\n- do the thing');
    assert.deepEqual(JSON.parse(updated.depends_on!), ['abc123']);
    assert.ok(updated.updated_at >= task.updated_at);
  });

  it('rejects an empty patch and unknown tasks', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'First');
    assert.throws(() => updateTask(db, task.id, {}), /empty patch/);
    assert.throws(() => updateTask(db, 'nope', { tag: 'ui' }), /no such task/);
  });
});

describe('moves', () => {
  it('moves between lanes and logs from/to', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'First');
    const moved = moveTask(db, task.id, 'in_progress', 'builder-1');
    assert.equal(moved.lane, 'in_progress');
    const event = getRecentEvents(db, project.id)[0];
    assert.equal(event.type, 'move');
    assert.deepEqual(JSON.parse(event.payload!), { from: 'backlog', to: 'in_progress' });
    assert.equal(event.agent, 'builder-1');
  });

  it('rejects invalid lanes', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'First');
    assert.throws(() => moveTask(db, task.id, 'doing'), /invalid lane/);
  });

  it('same-lane move is a no-op (no event)', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'First');
    const before = getRecentEvents(db, project.id).length;
    moveTask(db, task.id, 'backlog');
    assert.equal(getRecentEvents(db, project.id).length, before);
  });
});

describe('assignment', () => {
  it('records agent, worktree and branch', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'First');
    const assigned = assignCard(db, task.id, 'builder-1', `.trees/${task.id}`, `card/${task.id}`);
    assert.equal(assigned.assigned_agent, 'builder-1');
    assert.equal(assigned.worktree_path, `.trees/${task.id}`);
    assert.equal(assigned.branch, `card/${task.id}`);
    assert.equal(getRecentEvents(db, project.id)[0].type, 'assign');
  });
});

describe('next card', () => {
  it('returns top backlog card with satisfied deps', () => {
    const { db, project } = setup();
    const a = createTask(db, project.id, 'Schema');
    const b = createTask(db, project.id, 'API', { depends_on: [a.id] });
    // b depends on a (not done) -> a is next
    assert.equal(getNextCard(db, project.id)!.id, a.id);
    moveTask(db, a.id, 'done');
    // a done -> b eligible
    assert.equal(getNextCard(db, project.id)!.id, b.id);
    moveTask(db, b.id, 'done');
    assert.equal(getNextCard(db, project.id), null);
  });

  it('skips blocked cards in favor of later eligible ones', () => {
    const { db, project } = setup();
    const a = createTask(db, project.id, 'Blocked', { depends_on: ['missing-dep'] });
    const b = createTask(db, project.id, 'Free');
    assert.equal(getNextCard(db, project.id)!.id, b.id);
    assert.equal(a.position < b.position, true);
  });
});

describe('reviews', () => {
  it('records verdicts and bumps review_rounds', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'First');
    const r1 = recordReview(db, task.id, 'fail', [
      { file: 'src/x.ts', line: 10, severity: 'major', note: 'off by one' },
    ]);
    assert.equal(r1.round, 1);
    const r2 = recordReview(db, task.id, 'pass');
    assert.equal(r2.round, 2);
    const event = getRecentEvents(db, project.id)[0];
    assert.equal(event.type, 'review');
    assert.deepEqual(JSON.parse(event.payload!), { verdict: 'pass', round: 2, findings: 0 });
  });
});

describe('subtasks (acceptance criteria)', () => {
  it('sets criteria unchecked and reports progress in summaries', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'First');
    setSubtasks(db, task.id, ['write code', 'write tests', 'verify']);
    const [card] = getBoard(db, project.id);
    assert.deepEqual(card.subs, { done: 0, total: 3 });
    const event = getRecentEvents(db, project.id)[0];
    assert.equal(event.type, 'subtasks');
  });

  it('checks one criterion and logs progress', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'First');
    setSubtasks(db, task.id, ['a', 'b']);
    const { task: updated, moved } = checkSubtask(db, task.id, 0, true, 'builder-1');
    assert.equal(moved, false);
    assert.deepEqual(JSON.parse(updated.subtasks!), [
      { text: 'a', done: true },
      { text: 'b', done: false },
    ]);
    const event = getRecentEvents(db, project.id)[0];
    assert.equal(event.type, 'check');
    assert.deepEqual(JSON.parse(event.payload!).progress, { done: 1, total: 2 });
  });

  it('auto-moves to in_review when the last criterion is checked in_progress', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'First');
    setSubtasks(db, task.id, ['a', 'b']);
    moveTask(db, task.id, 'in_progress');
    checkSubtask(db, task.id, 0);
    assert.equal(checkSubtask(db, task.id, 1).moved, true);
    assert.equal(getBoard(db, project.id)[0].lane, 'in_review');
  });

  it('does not auto-move from other lanes or on uncheck', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'First');
    setSubtasks(db, task.id, ['a']);
    // all checked but still queued -> stays put
    assert.equal(checkSubtask(db, task.id, 0).moved, false);
    assert.equal(getBoard(db, project.id)[0].lane, 'backlog');
    // unchecking never moves
    moveTask(db, task.id, 'in_progress');
    assert.equal(checkSubtask(db, task.id, 0, false).moved, false);
    assert.throws(() => checkSubtask(db, task.id, 5), /no subtask/);
  });

  it('cards without criteria have null subs', () => {
    const { db, project } = setup();
    createTask(db, project.id, 'Plain');
    assert.equal(getBoard(db, project.id)[0].subs, null);
  });
});

describe('board reads', () => {
  it('returns terse card summaries only', () => {
    const { db, project } = setup();
    createTask(db, project.id, 'First', { requirements: 'long spec text' });
    const [card] = getBoard(db, project.id);
    assert.deepEqual(Object.keys(card).sort(), ['agent', 'id', 'lane', 'rounds', 'subs', 'tag', 'title', 'updated_at']);
  });

  it('active cards are the in_progress lane', () => {
    const { db, project } = setup();
    const a = createTask(db, project.id, 'First');
    createTask(db, project.id, 'Second');
    moveTask(db, a.id, 'in_progress');
    const active = getActiveCards(db, project.id);
    assert.equal(active.length, 1);
    assert.equal(active[0].id, a.id);
  });

  it('events are scoped to their project', () => {
    const { db, project } = setup();
    const other = getOrCreateProject(db, '/tmp/other-app');
    appendEvent(db, { project_id: other.id, type: 'note', payload: { msg: 'hi' } });
    assert.equal(getRecentEvents(db, project.id).length, 0);
  });
});
