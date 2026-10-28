# Meeting verification and responsive conversation

## Intent

Nogita must recognize the authorized owner's spoken meeting challenge despite ordinary speech-to-text formatting, then answer as a responsive teammate without inventing code facts. Target first audible feedback within 1 second and a substantive answer within 3 seconds are measurement goals, not claims about the current providers.

## Current system and evidence

- Attendee bot `bot_5SrvqUASDzBBjtoA` was ended at the user's request. Its six transcript turns represented the same spoken code as English digit words, joined digits, and hyphenated digits. The router compares normalized full strings, which rejects those forms.
- Attendee supplies per-participant audio to Nogita; Deepgram Nova-3 multilingual handles English/Hebrew and Aura provides streaming output. A 1.2-second caption quiet window and a 4.5-second progress timer add audible delay. The current model call waits for complete structured JSON.
- The repository index is already prepared at startup and refreshed by TTL, but it is not a semantic module map. The full source cannot safely or cheaply be placed in every prompt.

## Goals and constraints

- Verify only a six-digit code following `Nogita verify`, from one speaker in one active meeting. Accept speech-recognition digit words and separators; reject missing/wrong/extra digits or a command appended to the challenge. Do not log challenge text.
- Keep a fast, truthful conversational path. A quick acknowledgment may say that Nogita is checking, but must never guess a file, status, or answer before grounded evidence arrives.
- Measure transcript-to-response, model time-to-first-token, and audio submission separately. Report p50/p95 with no stored transcript or raw audio.
- Keep the current Attendee integration and Hebrew-capable Nova-3 as default. Flux currently lacks Hebrew; any English-only Flux experiment must be opt-in with turn-resumption cancellation and a consented evaluation.
- Keep Haiku as the default. Add an optional, bounded Sonnet path only when evaluation shows a quality gain; never add Opus by default or turn every simple question into two model calls.
- No credentials, transcripts, or raw audio in Git. No new paid infrastructure or meeting starts without a user request.

## Approaches considered

1. **Incremental pipeline on Attendee (chosen):** repair challenge parsing, measure stages, lower non-factual progress latency, then test streaming and conditional model escalation. Reuses the current identity, Jira, GitHub, and audio controls.
2. Replace the meeting provider with Recall now: new provider and deployment work, while the actual authentication bug would remain. Rejected.
3. Always run Haiku and Sonnet in parallel: easy perceived responsiveness, but expensive, can create conflicting answers, and still needs interruption/cancellation. Rejected as a default.

## Sequence and gates

1. Repair challenge recognition from the six observed transcript variants, including negative cases, and deploy after tests. The current public meeting-chat challenge is a possession check, not strong proof of identity; sensitive write actions need a later private enrollment/authentication design.
2. Add latency instrumentation and a consented 20-question benchmark. Separate processing, first model token, first audio submitted, and audible playback (the last cannot be claimed without a listener/participant-side signal).
3. Stream model text and TTS in sentence units only after a cancellation path prevents overlapping turns. Acknowledge slow work with varied, content-free phrases; a result follows in the same request context.
4. Route simple grounded questions to Haiku and escalate difficult code work to Sonnet behind configuration, budget, timeout, and answer-quality evaluations. Prompt caching is an optimization only after measuring cache hit rates.
5. Build a safe module map and opportunistic prefetch using existing source filtering. Add a semantic index only if the fixed QA set shows lexical retrieval is inadequate.

## Reference constraints

- Anthropic Messages supports SSE streaming and automatic prompt caching; streaming has errors and stop reasons that must be handled: https://platform.claude.com/docs/en/build-with-claude/streaming and https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Deepgram Flux supports eager turn events and cancellation, but its published language list excludes Hebrew; Nova-3 multilingual supports Hebrew: https://developers.deepgram.com/docs/flux/configuration and https://developers.deepgram.com/docs/models-languages-overview/ and https://developers.deepgram.com/docs/nova-3-language-prompting
- Attendee supports bidirectional 16 kHz websocket audio: https://docs.attendee.dev/guides/realtimeaudio
