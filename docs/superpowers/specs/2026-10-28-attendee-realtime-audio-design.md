# Attendee realtime audio design

## Intent
Add an opt-in, provider-backed realtime audio path that reduces fragmented caption handling and replaces local robotic MP3 synthesis with streamed PCM. Preserve the existing Nogita engine, meeting-scoped verification, allowlist policy, task idempotency, and chat fallback.

## Goals
- Receive Attendee per-participant 16 kHz PCM over its documented WebSocket integration.
- Stream each participant's audio to a separate Deepgram streaming STT session so speaker UUID identity remains explicit.
- Use multilingual Nova-3 streaming STT with English/Hebrew hints and final-segment assembly before forwarding one utterance into the existing authorization/command router.
- Stream English Aura TTS PCM chunks back through the Attendee WebSocket, stopping/closing resources at session end.
- Keep the feature disabled by default; expose no external call until an operator explicitly enables it and configures credentials.
- Keep only numeric stage metrics; do not persist audio or transcripts.

## Non-goals
- No change to external tool policy or model-driven execution authority.
- No paid provider calls, secrets provisioning, or deployment in this change.
- No claim that Deepgram Aura supports Hebrew speech; the selected `aura-2-thalia-en` voice is English. Aura-2 has additional language variants, but Hebrew is not listed.
- No browser playback proof; audio submission is observable, human audibility still needs a live evaluation.

## Approaches
1. Deepgram STT + streamed Deepgram TTS around the existing NogitaEngine (chosen): preserves current identity, policy, Jira/GitHub actions, and Claude reasoning; uses two simpler audio services and existing chat fallback. Tradeoff: more orchestration than an all-in-one voice agent, plus English-only chosen TTS.
2. Deepgram Voice Agent as the complete conversational brain: fewer media components and built-in turn-taking, but action authorization/tool routing would need a new secure function-call bridge and risk bypassing existing policy if implemented hastily.
3. Keep captions and swap only local TTS: low risk but does not fix fragmented understanding, interruption, or end-to-end latency.

## Design
An `AttendeeRealtimeAudioHub` owns signed meeting-scoped WebSocket routes and per-session sockets. Attendee connections are authenticated using an HMAC URL tied to the session; the first provider bot ID is pinned and compared with the control-plane bot ID. Incoming `realtime_audio.per_participant` frames are size/rate/sample validated, routed to a bounded per-speaker STT socket, and never logged. Only stable final turns are passed to a new immediate-final method on `AttendeeCommandRouter`; all verification and policy behavior remains shared.

Outgoing TTS uses Deepgram's streaming Speak WebSocket (`linear16`, 16 kHz, no WAV container). Binary frames are converted to bounded base64 Attendee `realtime_audio.bot_output` messages. This is a provider output submission measurement, not proof of playback. Audio and provider sockets close on websocket replacement, participant/session end, service shutdown, or transport error.

Realtime mode requires `NOGITA_REALTIME_AUDIO_ENABLED=true`, an HTTPS-hosted WSS endpoint, existing privacy review, and `DEEPGRAM_API_KEY`. Disabled mode retains current captions + MP3 behavior and makes no Deepgram requests.

## Acceptance
- Protocol parsers reject unexpected bot, trigger, sample rate, malformed/oversized frames, and invalid HMACs.
- STT final fragments are assembled only within one participant stream; interim hypotheses never trigger work.
- Only completed final turns reach the existing meeting-scoped verification and router; unauthorized speakers remain unauthorized.
- TTS chunks stream without building one complete MP3; provider disconnect produces the existing chat fallback and does not duplicate tool actions.
- Sessions, provider sockets, queues, and metrics stay bounded; close/leave clears all session-scoped audio state.
- Full unit suite and typecheck pass. Live provider verification is blocked until a user-provided Deepgram key and an explicitly scheduled test meeting.

## Builder calls
Use Nova-3 multilingual on `/v1/listen` because the project conversations use Hebrew and English; Flux currently does not list Hebrew. Use the English Aura model for the first canary because prior meeting tests were in English, and record Hebrew speech output as a known gap rather than silently claiming support.
