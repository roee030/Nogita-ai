# Graceful Slack work draining implementation plan

- [x] Add failing tests for success, rejection, timeout, and post-shutdown refusal.
- [x] Implement a bounded in-flight work tracker.
- [x] Track signed Events API and Socket Mode Slack work.
- [x] Install idempotent `SIGTERM`/`SIGINT` shutdown handlers in both runtimes.
- [x] Document the exact guarantee and remaining KAN-11 crash window.
- [x] Run full tests, typecheck, and diff validation.
- [x] Commit, push, verify CI, and update KAN-11/PR.
