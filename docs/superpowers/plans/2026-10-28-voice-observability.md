# Voice observability implementation plan

## Files
- `src/app/session-usage.ts`: add bounded per-stage timing samples and report summaries.
- `src/adapters/attendee.ts`: measure current speech flow stages with an optional callback.
- `src/app/server.ts`: connect Attendee timing callbacks to session usage, including restored sessions.
- `tests/session-usage.test.ts`, `tests/attendee.test.ts`: add behavioral tests before implementation.
- `docs/architecture-next.md`: document metric meaning and the realtime voice follow-up.

## Tasks
1. Add failing tests for stage aggregation, percentiles, sample bounds, and invalid durations; run them to confirm the expected failures.
2. Add an optional duration callback to AttendeeMeeting and tests that assert timings for chat mirror, synthesis, audio submission, and total submission, including failures.
3. Wire callback to session usage for newly created and restored meetings; implement usage stage summaries.
4. Update architecture notes to distinguish measurable submission latency from audible playback latency and define the next realtime audio benchmark.
5. Run focused tests, full test suite, and typecheck; inspect diff and confirm no secrets or transcript/audio retention.

## Review focus
- Chat mirror failure must not be mislabeled as successful speech.
- Synthesis or provider submission failure still records elapsed duration without exposing error payloads.
- Stage names and usage report remain backward-compatible for existing fields.
- Samples are bounded and scoped per meeting.
- Documentation must not claim that provider acceptance proves audio playback.
