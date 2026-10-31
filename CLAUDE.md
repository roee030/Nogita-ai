# Working on Nogita (Claude Code)

Two AI agents work on this repository: Claude Code and Codex. Roee merges. The shared state is GitHub plus
`docs/TASK_BOARD.md`; nobody keeps status by hand.

## When Roee says "continue" (or any "keep working")

Run the loop in `docs/TASK_BOARD.md` without asking:

1. `git fetch origin` and `npm run board -- --agent claude`.
2. Fix any PR listed under "Fix first" (failing CI, conflict with main, changes requested) on its own branch.
3. Do what "Next" says. "Continue" means switch to that task's branch and go on. "Start" means a new branch
   `claude/<ID>-<slug>` from `origin/main`, an empty "<ID>: start" commit, push, and a draft PR titled "<ID>: ..." at
   once: the draft PR is the lock Codex sees.
4. Done with a task: `npm test` and `npm run typecheck` pass, a **Handoff** section in the PR description, `gh pr ready`.
5. Back to step 1. Stop only when the board says "Nothing to start"; then report what is under "Waiting on Roee".

## Rules

- Work only on board tasks owned by Claude. Work in `D:\Nogita-ai`; never edit files in `D:\Nogita-ai-codex`.
- Never commit to `main` and never merge. Switch branches only with a clean working tree.
- A file outside your task's list that belongs to Codex's open PR: stop and ask Roee.
- Behavior changes go behind a flag that is off by default.
- Do not write status into the board; GitHub is the status.
- When few tasks are left for either agent, add the next phase from `docs/WORK_PLAN.md` to the board in its own PR.
