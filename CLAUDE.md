# Working on Nogita (Claude Code)

Claude Code is the only agent on this repository. Roee merges. The shared state is GitHub plus
`docs/TASK_BOARD.md`; nobody keeps status by hand.

## When Roee says "continue" (or any "keep working")

Run the whole board in one chat, without asking:

1. `git fetch origin` and `npm run board`.
2. Fix any PR listed under "Fix first" (failing CI, conflict with main, changes requested) on its own branch.
3. Do what "Next" says. "Continue" means switch to that task's branch and go on. "Start" means a new branch
   `claude/<ID>-<slug>` from `origin/main`, an empty "<ID>: start" commit, push, and a draft PR titled "<ID>: ..." at
   once. If the board lists "Builds on" PRs, merge those branches into the new branch right after creating it, and
   name them in the PR description ("Builds on #55; merge that first").
4. Done with a task: `npm test` and `npm run typecheck` pass, a **Handoff** section in the PR description, `gh pr ready`.
5. **Keep going until the board is empty.** After `gh pr ready`, go back to step 1. Your PRs waiting for review count
   as done for what depends on them, so you never wait for a merge. Stop only when the board says "Nothing to start".
   Then report every PR you opened, in merge order (oldest first), one line each with its link and what it does, and
   what is under "Waiting on Roee". Keep each task its own branch and PR.

## Rules

- Work only on board tasks. Work in `D:\Nogita-ai`.
- Never commit to `main` and never merge. Switch branches only with a clean working tree.
- Behavior changes go behind a flag that is off by default.
- Do not write status into the board; GitHub is the status.
- When few tasks are left, add the next phase from `docs/WORK_PLAN.md` to the board in its own PR. The board is read
  from `origin/main`, so new tasks appear only after Roee merges that PR: stop there and say so.
