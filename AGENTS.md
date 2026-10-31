# Working on Nogita (Codex)

Two AI agents work on this repository: Codex and Claude Code. Roee assigns the work and merges.

Before any work, read:

1. `docs/TASK_BOARD.md`: who does what now, the working rules, and which files each task touches.
2. `docs/WORK_PLAN.md`: the plan, the reasons, and the success gates.

The rules that matter most:

- Work only on a task that the board assigns to Codex.
- Work in your own worktree, `D:\Nogita-ai-codex`, never in `D:\Nogita-ai` (that is Claude's).
- One branch and one PR per task, named `codex/<task-id>-<slug>`. Open a draft PR as soon as you start: it is the lock
  that tells Claude the task is taken. Never commit to `main` and never merge.
- Before you start, check open PRs (`gh pr list --state open`) for overlap with your task's files. On overlap, wait or ask Roee.
- Update only your own rows of the board, inside the task's PR, and add a handoff note.
- `npm test` and `npm run typecheck` pass before a PR is marked ready. Behavior changes go behind a flag that is off by default.
