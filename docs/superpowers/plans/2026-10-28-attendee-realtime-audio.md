# Attendee realtime audio implementation plan

## Files
- `src/app/attendee-realtime-audio.ts`: signed socket route, Attendee frame validation, Deepgram STT/TTS sessions, bounded lifecycle.
- `src/app/attendee-command-router.ts`: immediately flush completed STT turns while preserving verification and policy flow.
- `src/adapters/attendee.ts`: optionally request per-participant audio and route speech through streaming output.
- `src/app/server.ts`: create WebSocket upgrade handling, register/bind/close audio sessions.
- `src/app/readiness.ts`, `.env.example`, `README.md`: disabled-by-default setup and truthful readiness.
- `src/app/session-usage.ts`: report realtime transcription/output mode.
- `tests/attendee-realtime-audio.test.ts`, `tests/attendee-command-router.test.ts`, `tests/attendee.test.ts`, `tests/readiness.test.ts`: protocol, security, routing, and failure tests.

## Tasks
1. [x] Write failing tests for signed socket URL, validated Attendee frames, Nova-3 final-turn parsing, and immediate-final routing.
2. [x] Implement protocol helpers and bounded HMAC-authenticated hub tests without live provider calls, including signed recovery authenticated against the persisted bot binding.
3. [x] Implement per-speaker Deepgram STT stream with stable final-turn assembly; connect only after opt-in and keep media/transcript payloads out of logs and disk.
4. [x] Implement incremental Deepgram TTS binary streaming to Attendee `bot_output`, with serialized speech, backpressure bounds, chat mirroring, and cleanup.
5. [x] Wire create/restore/leave/shutdown paths, opt-in config, readiness, sample rates, cost/privacy documentation, and numeric Deepgram usage estimates.
6. [x] Run focused tests, full test suite, typecheck, and diff review. Live provider behavior is still unverified because the key/WSS endpoint and consented canary are not configured.

## Review focus
- Race between Attendee socket startup and REST create-bot response.
- Cross-session/bot HMAC replay and bot-ID mismatch.
- Cross-speaker transcript concatenation and interim-result actions.
- Unbounded participant/socket/frame accumulation and reconnect leaks.
- TTS chunk ordering/backpressure and fallback after provider failure.
- Realtime flag misconfiguration must fail closed; disabled mode remains unchanged.
