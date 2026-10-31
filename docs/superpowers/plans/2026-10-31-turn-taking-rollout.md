# Turn-taking v2 rollout implementation plan

1. Add failing tests for the default legacy profile and explicit v2 profile in `tests/attendee-realtime-audio.test.ts` and `tests/conversation-flow.test.ts`.
2. Add a typed `turnTakingV2` option to `RealtimeAudioOptions`; use it to select thresholds and the pause/classify path.
3. Restore the speech-floor default lease to 1 s and have `server.ts` pass 3 s only when v2 is enabled.
4. Parse and validate `NOGITA_TURN_TAKING_V2` in `server.ts`, document it in `.env.example`, and make the voice lab explicitly enable v2.
5. Move Cartesia to `devDependencies`, refresh the lockfile, and add a repository guardrail proving it is absent from production dependencies.
6. Run focused tests, all tests, typecheck, diff checks, and GitHub Actions before merge.

