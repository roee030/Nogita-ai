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
through Attendee. Render Free has ephemeral filesystem storage. Readiness checks
configuration; the authenticated `/api/connections` endpoint separately probes
GitHub, Jira, Attendee and Slack authentication. Provider audio acceptance does
not prove playback to a human.

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
- HTTP readiness now requires signed Slack Events API configuration; Socket Mode
  configuration alone does not make the HTTP server a Slack event consumer.

## Release gates
No success acknowledgement before provider success. No duplicate task after
retry. An external failure must allow a subsequent leave command. Measure median
and p95, and retain only bounded numeric telemetry. Do not lower caption buffering
blindly: shorter delays can split requests and cause duplicate actions.

## Initial implementation
Expose a bounded window of engine processing durations (including engine queue
wait) through the authenticated usage report. This is not end-to-end voice
latency; caption assembly, transport and playback remain separate future metrics.
