#!/usr/bin/env node
// git worktree helpers: one isolated worktree per card.
//   add    <task_id>            create .trees/<id> on branch card/<id>
//   remove <task_id> [--force]  drop the worktree (+ branch if merged; -D with --force)
//   merge  <task_id>            merge card/<id> into the current branch, then clean up
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [cmd, taskId, flag] = process.argv.slice(2);
if (!['add', 'remove', 'merge'].includes(cmd ?? '') || !taskId) {
  console.error('usage: node scripts/worktree.js <add|remove|merge> <task_id> [--force]');
  process.exit(1);
}

const tree = join('.trees', taskId);
const branch = `card/${taskId}`;

function git(...args) {
  return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
}

/** Keep .trees/ out of git status via the local-only exclude file. */
function excludeTrees() {
  const exclude = join(git('rev-parse', '--git-common-dir'), 'info', 'exclude');
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (!current.split('\n').includes('.trees/')) appendFileSync(exclude, '.trees/\n');
}

if (cmd === 'add') {
  excludeTrees();
  git('worktree', 'add', tree, '-b', branch);
  console.log(`${tree} on ${branch}`);
} else if (cmd === 'remove') {
  git('worktree', 'remove', ...(flag === '--force' ? ['--force'] : []), tree);
  try {
    git('branch', flag === '--force' ? '-D' : '-d', branch);
  } catch {
    // unmerged branch without --force: keep it, the worktree is gone
  }
  console.log(`removed ${tree}`);
} else {
  try {
    git('merge', '--no-ff', branch, '-m', `Merge ${branch}`);
  } catch {
    console.error(`merge of ${branch} conflicted — resolve and commit, or run: git merge --abort`);
    process.exit(1);
  }
  git('worktree', 'remove', tree);
  git('branch', '-d', branch);
  console.log(`merged ${branch}, removed ${tree}`);
}
