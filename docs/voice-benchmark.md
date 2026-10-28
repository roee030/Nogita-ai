# Nogita voice benchmark

This is the repeatable evaluation gate before selecting or enabling a realtime
voice provider. Targets below are proposed product goals, not measured results
or guarantees from a provider.

## Candidate paths

1. Current baseline: Attendee closed captions + Claude text reasoning + local
   `espeak-ng` MP3 uploaded to Attendee.
2. Attendee PCM stream + Deepgram Nova-3 multilingual STT / Aura-2 streaming TTS around Nogita's existing brain and policy.
3. Attendee PCM stream + OpenAI Realtime.

Run the same consented scenario set with each candidate. Keep existing policy,
speaker verification, tools, and task idempotency identical. Provider-specific
prompting may change only after a baseline run is recorded.

## Scenario set

- Natural direct question, with a short answer and a follow-up.
- One request delivered as fragmented captions, then repeated by webhook retry.
- Authorized speaker opens exactly one task; unknown speaker asks to open one.
- Two people speak in sequence; then they briefly overlap.
- Participant interrupts Nogita mid-sentence with a correction and a new request.
- Backchannel (“yeah”, “right”) and a short within-sentence pause while Nogita
  is listening; verify neither is treated as an unintended turn boundary.
- Names, acronyms, numbers, repository terms, and mixed English/Hebrew speech.
- Noisy/quiet input and distant microphone.
- Explicit “leave” command, meeting empty, and 3 minutes of silence.
- Provider timeout/disconnect during listening, reasoning, and speech output;
  confirm chat fallback and that another request or leave still works.

Each case has a human-labeled expected transcript, speaker, intent, allowed
action, and expected response. Use synthetic or consented recordings; do not
retain production meeting audio by default.

## Measurements

- **Audible response latency:** participant speech end to first audible output
  sample, measured from provider/audio playback events where possible. Report
  p50 and p95. Provider API acceptance is not an audible-playback measurement.
- **Recognition:** word error rate (WER), command/intent accuracy, and speaker
  attribution accuracy; report by noise level and language rather than only one
  overall score.
- **Turn-taking:** time to stop after interruption, percentage of real
  interruptions detected, false interruptions on backchannels/noise, and
  accidental response starts while a participant is still talking.
- **Task correctness:** authorized action success, unauthorized action count,
  duplicate action count, and fallback-chat delivery on every voice failure.
- **Naturalness:** blind human rating for intelligibility, pacing, pronunciation,
  prosody, and conversational fit. Compare both identical text and live turns.
- **Cost:** provider-reported audio/session usage + reasoning usage + Attendee
  meeting duration, divided by successful conversations and successful tasks.
  Include idle time and reconnects; close sessions promptly and reconcile final
  provider usage when available.

At the 2026-10-28 Deepgram pricing page snapshot, Nova-3 multilingual streaming
was listed at $0.0058/minute and Aura-2 at $0.03/1,000 characters on pay-as-you-go
(rates may change and can be promotional). That implies about $0.174 for 30
minutes of STT plus $0.009 for 300 TTS characters, before Attendee, Claude,
taxes, retries, and account-specific billing. This is only a planning estimate;
the service keeps the two Deepgram assumptions configurable and reports them
separately from actual provider invoices.

## Initial go/no-go targets

Treat these as goals to validate with the product owner, not hard-coded claims:

- First audible response p50 <= 1.0 s and p95 <= 2.0 s after the user finishes.
- No unauthorized or duplicate task creation in the evaluation set.
- At least 95% direct-request intent accuracy and 98% known-speaker attribution
  on the labeled set, with zero unauthorized writes.
- p95 interruption stop <= 300 ms; false-interruption rate <= 2% on
  backchannels/noise cases.
- Human naturalness median >= 4/5 and no recurring severe pronunciation issue.
- Agreed cost ceiling per 30-minute session and per successful task; do not
  enable paid traffic until this ceiling is selected and verified from usage.

## Decision rule

Reject a candidate that fails safety or task-correctness gates regardless of
voice quality. Among the remaining candidates, compare p95 audible latency,
recognition/turn-taking, human naturalness, failure recovery, then cost. Keep a
provider-neutral interface and the current chat fallback. Enable any realtime
provider only behind an explicit feature flag and a separately reviewed audio
processing/retention setting.

## Primary references

- Attendee realtime audio: https://docs.attendee.dev/guides/realtimeaudio
- Deepgram Voice Agent events: https://developers.deepgram.com/docs/voice-agent-outputs/
- OpenAI realtime conversations and interruptions: https://developers.openai.com/api/docs/guides/realtime-conversations
- LiveKit turn-taking tuning: https://docs.livekit.io/agents/logic/turns/tuning/
- Deepgram pricing (rates are volatile; verify against the account before a canary): https://deepgram.com/pricing
