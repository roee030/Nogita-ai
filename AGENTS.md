# Working on Nogita (Codex)

Two AI agents work on this repository: Codex and Claude Code. Roee merges. The shared state is GitHub plus
`docs/TASK_BOARD.md`; nobody keeps status by hand.

## When Roee says "continue" (or any "keep working")

Run the loop in `docs/TASK_BOARD.md` without asking:

1. `git fetch origin` and `npm run board -- --agent codex`.
2. Fix any PR listed under "Fix first" (failing CI, conflict with main, changes requested) on its own branch.
3. Do what "Next" says. "Continue" means switch to that task's branch and go on. "Start" means a new branch
   `codex/<ID>-<slug>` from `origin/main`, an empty "<ID>: start" commit, push, and a draft PR titled "<ID>: ..." at
   once: the draft PR is the lock Claude sees.
4. Done with a task: `npm test` and `npm run typecheck` pass, a **Handoff** section in the PR description, `gh pr ready`.
5. **One task per chat.** After `gh pr ready`, stop. End your reply with the PR link for Roee to merge, one line on
   what it does, and what the board shows as your next task (or that it waits on a merge). Roee merges and opens a new
   chat with "continue". Fixes from step 2 do not count as the task: fix them, then go on to "Next".
   If the board says "Nothing to start", stop and report what is under "Waiting on Roee", with links.

## Rules

- Work only on board tasks owned by Codex. Work in `D:\Nogita-ai-codex`; never edit files in `D:\Nogita-ai`.
- Never commit to `main` and never merge. Switch branches only with a clean working tree.
- A file outside your task's list that belongs to Claude's open PR: stop and ask Roee.
- Behavior changes go behind a flag that is off by default.
- Do not write status into the board; GitHub is the status.
