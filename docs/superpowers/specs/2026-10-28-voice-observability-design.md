# Voice observability design

## Intent
Make Nogita's meeting voice pipeline measurable before replacing providers. The first increment records bounded numeric durations for chat mirroring, local TTS synthesis, provider audio submission, and total speech submission. It must not imply that provider acceptance means a participant heard the audio.

## Goals
- Separate speech pipeline stages in the existing authenticated session usage report.
- Keep only a bounded rolling sample per stage and expose p50/p95/max.
- Avoid retaining transcript text, audio, speaker identifiers, or provider payloads.
- Preserve existing meeting behavior and make instrumentation optional for other adapters.

## Non-goals
- No new paid voice provider, keys, or external calls.
- No real-time audio/WebSocket transport in this increment.
- No change to transcript buffering or authorization policy.
- No claim of end-to-end audible latency; Attendee does not provide playback confirmation here.

## Approaches
1. Add stage timings around current Attendee speech flow (chosen): smallest safe increment, establishes a baseline without provider or deployment changes; does not improve voice quality by itself.
2. Replace the whole voice path with a realtime agent: potentially natural and interruptible, but requires provider choice, credentials, transport, cost approval, and live validation.
3. Add a standalone TTS provider while retaining caption turns: allows voice comparison but leaves turn detection and interruption latency unresolved.

## Design
AttendeeMeeting reports stage duration callbacks for `chat_mirror`, `tts_synthesis`, and `audio_submission`, plus total `speech_submission`. SessionUsageRegistry stores at most 200 valid durations per stage, rounds to integer milliseconds, and derives percentiles on demand. The public report labels the current path `closed_captions_mp3` and explicitly says audio playback is unconfirmed. Existing `processingLatency` remains unchanged.

## Acceptance
- Tests prove each stage is recorded on success and on relevant failures, invalid samples are ignored, samples remain bounded, and sessions do not share data.
- Typecheck and full test suite pass.
- No transcript, audio, raw provider event, or token is added to usage telemetry.

## Builder calls
Work in the existing clean feature branch. No external provider credentials are assumed. This is the first measurable slice of the broader voice improvement effort, not completion of streaming voice.
