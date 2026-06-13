# Kankan protocol

This project orchestrates app development on a live Kanban board. You are the orchestrator: you plan, dispatch builder/reviewer subagents, and route cards by judgment. The board is a mirror of real agent activity.

Board access is ONLY through the `kankan` MCP tools. Never open `data/board.db` directly. The daemon must be running (`scripts/dev.sh`); if board tools report it unreachable, keep working and ask the user to start it.

Lanes: `backlog → queued → in_progress → in_review → done`

## Session start

- On a feature request: `get_or_create_project` with the absolute cwd; use the returned `project_id` for everything after.
- "What am I on?" → `get_active_card`. Use `get_board` sparingly — it's the expensive read.

## Planning

- Decompose feature requests with the `planner` subagent (pass it the `project_id` and the request). It creates backlog cards with `depends_on` ordering.
- Any card touching shared/central files (package manifests, routing, DI container, barrel/export files, DB migrations) is non-parallelizable: later cards that touch the same area must `depends_on` it.

## Working a card

1. **Pick**: `get_next_card` (it respects `depends_on`). Discuss requirements with the user, then write the agreed spec into the card with `update_task` BEFORE any building — both `requirements` (description) and `subtasks` (acceptance criteria: small, verifiable steps the builder checks off). `move_task → queued` once it's ready for dispatch.
2. **Dispatch**: create the isolation worktree, then record the assignment, then spawn the builder:
   - `kankan worktree add <id>` (creates `.trees/<id>` on branch `card/<id>`)
   - `assign_card(task_id, <agent label>, .trees/<id>, card/<id>)`
   - Spawn `builder` with: card id, the full requirements text, and the worktree path.
3. **Parallelism**: dispatch two builders at once only when their cards have disjoint `depends_on` AND disjoint file scope — spawn both Task calls in a single message so they run concurrently. Never two builders in one worktree.
4. **Review**: when a card reaches `in_review`, get the real diff yourself — `git -C .trees/<id> diff main...card/<id>` — and spawn `reviewer` with: card id, requirements, that diff, and the worktree path. The reviewer judges the diff, never the builder's self-report.
5. **Route the verdict** (your judgment):
   - **pass** → `kankan worktree merge <id>` (merges `card/<id>` into main and cleans up), then `move_task → done`. If the merge conflicts, resolve it in the main checkout like any merge conflict — the worktree and branch stay until it's resolved.
   - **fail** → fold the findings into the card's requirements (`update_task`), `move_task → in_progress`, redispatch `builder` into the same worktree (do NOT remove it).
   - Hard cap: 2 review rounds. After a second fail, stop and surface the findings to the user. Abandoning a card: `kankan worktree remove <id> --force`.

## Rules

- The `in_progress` / `in_review` transitions are fired automatically: by lifecycle hooks, and by the daemon when a builder checks the last acceptance criterion. Your `move_task` calls are for judgment moves only: `queued`, `done`, and fail→`in_progress` routing. (Until the hooks are installed, do the mechanical moves manually too.)
- Treat any subagent summary as intent, not proof. Verify with the diff and tests.
- Keep board chatter terse; don't echo full requirement bodies back into conversation unless asked.
