# Nogita: next architecture decisions

## Product goal
An invited engineering teammate that hears direct requests, answers with evidence,
executes authorized actions once, and leaves reliably. Reliability and measurable
response time take priority over adding integrations.

## Research, 2026-10-27
- LiveKit turn tuning: https://docs.livekit.io/agents/logic/turns/tuning/
  Separate endpointing, interruption handling, and generation latency. Tune one
  variable at a time. Its settings are examples, not settings supported by Attendee.
- Microsoft voice practices: https://learn.microsoft.com/azure/foundry/agents/concepts/voice-agent-best-practice
  Measure time to first audio and individual stages, keep spoken replies short,
  and provide recovery after recognition failures.
- Attendee audio: https://docs.attendee.dev/guides/realtimeaudio
  A future streaming bridge can receive and send PCM. Current implementation
  uses closed captions plus MP3 output, so it cannot claim streaming interruption.

## Current architecture and constraints
Signed webhooks enter an encrypted file queue, then speaker verification and
caption assembly feed a serialized policy-controlled engine. Claude plans;
GitHub supplies evidence and Jira executes explicit writes. Local TTS sends MP3
through Attendee. Render Free has ephemeral filesystem storage, so encrypted
queue records do not survive instance replacement or redeploy; cross-redeploy
queue durability remains blocked until persistent storage is configured.
Readiness blocks on Render unless persistent storage is explicitly confirmed;
the authenticated `/api/connections` endpoint separately probes
GitHub, Jira, Attendee, Slack authentication and configured Anthropic model
availability. The Anthropic check uses the read-only Models API; it does not
send a prompt or incur inference usage. Provider audio acceptance does not prove
playback to a human.

## Priorities
1. Instrument processing latency now, without retaining spoken text. Distinguish
   it from caption arrival delay and actual time to audible response.
2. Add provider probes with bounded timeouts and actionable errors. Verify GitHub
   from the deployed process, not just from a developer machine.
3. Build recorded scenario evaluations: fragmented request, unknown speaker,
   repeated delivery, provider outage, leave during an in-flight action.
4. Move queue, identity bindings and usage accounting to shared durable storage
   before multiple workers or instances. A paid storage decision needs approval.
5. Benchmark natural TTS and streaming audio behind the existing MeetingPort.
   Compare first-audio latency, recognition quality, interruption support and
   cost per successful task before selecting a new paid provider.
6. Scope production GitHub access to one repository with a GitHub App. The
   current user credential is a development bridge, not the multi-tenant design.

## Reliability changes, 2026-10-28
- Failed command processing now returns to the encrypted queue for bounded
  exponential retries; the fallback chat still tells the user the command did
  not complete. After the retry limit the queue dead-letters the event.
- Failed provider leave retains the session and Attendee bot ID for another
  leave attempt. Admin cleanup now happens only after the provider confirms.
- Speaker verification binds only after its confirmation message is delivered.
- The HTTP service now consumes Socket Mode events when `SLACK_APP_TOKEN` is
  configured. Readiness requires an active websocket or signed Events API; token
  configuration by itself is not treated as a live connection.
- Slack thread sessions are capped at 500 and expire after 30 minutes idle.
  Cleanup protects in-flight work and leaves sessions intact if the meeting
  provider cannot confirm departure.

## Release gates
No success acknowledgement before provider success. No duplicate task after
retry. An external failure must allow a subsequent leave command. Measure median
and p95, and retain only bounded numeric telemetry. Do not lower caption buffering
blindly: shorter delays can split requests and cause duplicate actions.

## Voice observability, 2026-10-28
- The authenticated session usage report now exposes bounded numeric p50/p95/max
  durations for chat mirroring, local TTS synthesis, Attendee audio submission,
  and total speech submission. It does not retain spoken text or audio.
- `speech_submission` ends when Attendee accepts the output request. It is not
  time-to-first-audio and does not prove playback by an unmuted meeting client.
- The current path is explicitly reported as `closed_captions_mp3`; do not call
  it streaming or interruptible. `processingLatency` is engine work time, not
  speech-end-to-first-audible-audio.
- Next voice milestone: expose Attendee's documented 16 kHz per-participant or
  mixed PCM WebSocket input/output behind a feature flag, then benchmark two
  realtime agent providers with the same consented scenario set. Record numeric
  stage timing, transcript/speaker/turn accuracy, interruption behavior, and
  provider-reported usage; do not store raw media by default.

## Initial implementation
Expose a bounded window of engine processing durations (including engine queue
wait) through the authenticated usage report. This is not end-to-end voice
latency; caption assembly, transport and playback remain separate future metrics.

## Opt-in realtime voice milestone, 2026-10-28
- Implemented a disabled-by-default Attendee PCM bridge using per-participant
  streams, separate Deepgram Nova-3 multilingual recognition sessions, and
  streamed English Aura-2 speech output. Every completed turn still enters the
  existing command router and meeting verification/policy boundary.
- Signed WSS routes pin/restore only bot IDs confirmed by the persisted hashed
  session binding. Participant join/leave events bind a UUID to metadata; display
  names are never treated as identity. Audio, text, and provider payloads are not
  persisted or logged by this bridge.
- Session usage now reports numeric speech-stage latency and an estimated
  Deepgram breakdown (submitted PCM duration + TTS characters) separately from
  Attendee and Claude costs. Provider invoices remain authoritative.
- Live voice quality, interruption behavior, first-audible-output timing, Hebrew
  speech, and contracted cost have not been validated. No credentials were
  provisioned, paid API calls made, or deployment performed; a consented canary
  and an active Deepgram key are still required before enabling the flag.
