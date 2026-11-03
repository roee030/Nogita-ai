# Gemini Live viability spike (P7-1): gate A data

Data for Roee's gate A decision (P7-2), measured on 3 November 2026. The plan and the thresholds, set before the run,
are in `docs/VOICE_ENGINE_PLAN.md`.

## Recommendation

**Gate A fails. Stop phase 7 here.**

Gemini Live is faster to answer, and it does not pause on a cough. But on everything gate A checks it takes turns *worse*
than the cascaded v2 pipeline:
- It starts while people are mid-turn.
- It answers people who were not talking to it.
- It loses more questions.
- It is slower to stop when interrupted.
- It stops for "mm-hm".

The replay of the real 1 November meeting says the same. Hebrew rating is moot: the gate already fails without it.

## What was run

- **Gemini:** `gemini-3.8-live`, voice Kore, through `tools/gemini-spike/` (throwaway).
  - Every participant's microphone, with the scenario's noise, mixed and streamed at real time.
  - Her audio played on a real-time clock that stops on the server's `interrupted`.
  - No tools: the prompt tells her to speak only when addressed, stay silent on half-sentences and side talk, and stop
    when interrupted.
- **v2:** the frozen cascaded pipeline at commit `95cb776`, through the voice lab, with `--turn-taking v2`.
- **Both measured by the same code** (`tools/voice-bench/result.ts`, kept) on the same event types.
- **Repetitions:** 10 turn-taking scenarios × 5, and 4 safety scenarios × 10 (other-people-conversation, long-pauses,
  stalled-speaker, room-crosstalk). Both engines faced 160 questions.
- **Hebrew:** 2 of the 4 Hebrew scenarios × 5, voiced by Gemini TTS. The other two did not run: Gemini TTS hit its daily
  quota (429).
- **Real speech:** Roee's own utterances from the 1 November Meet, cut from Attendee's recording by the transcript's
  times, with the old Nogita muted. Replayed to Gemini 5 times.
- **Cost:** Gemini ~$2.4 for the spike (cap $25). v2 ~$2.6.

## Numbers

| Measure | Gemini | v2 | Gate A threshold | Gemini passes |
|---|---|---|---|---|
| Answered when not addressed | 12 | 8 | 0 | no |
| Started inside someone's turn (half-sentence, pause) | 47 | 19 | 0 | no |
| Started while someone spoke | 47 | 20 | 0 | no |
| Stop after interruption p50 / p95 | 300 / 616 ms (n=15) | 244 / 329 ms (n=13) | p95 ≤ 500 ms and ≤ v2 + 100 | no |
| Questions lost (of 160) | 9 | 5 | ≤ v2 | no |
| First sound after a question, p50 / p95 | 1.22 / 1.84 s | 2.43 / 5.54 s | p50 ≤ 2.5 s | yes |
| "Mm-hm" while she talks: kept talking | 5 / 20 | 19 / 19 | (not a gate) | - |
| Cough or laugh: paused | 0 / 15 | 9 / 14 | (not a gate) | - |
| USD per meeting hour (est.) | $2.20 | $1.73 | ≤ 1.5 × v2, never > $3 | yes |
| Hebrew, rated by Roee | not rated | - | ≥ 4 / ≥ 4 | moot |

On the 10 turn-taking scenarios alone (5 passes each, 100 questions each), the gap is smaller but in the same direction:

| Measure | Gemini | v2 |
|---|---|---|
| Lost | 2 | 2 |
| Not addressed | 5 | 5 |
| Started inside a turn | 7 | 2 |

The rest of the "inside a turn" gap is in the long-pause and stalled-speaker scenarios, where Gemini answers the first
half of a sentence. Hebrew: 30 questions, 1 lost, 0 answers to side talk, 7 starts inside a turn (on the half-sentence
scenario), first sound p50 1.2 s.

**The 1 November Meet replayed (Roee's real voice).** "Jumped in" means she started inside one of his utterances, or in
a pause he went on from within 2 s.

| | Answers | Jumped in |
|---|---|---|
| The deployed Nogita (legacy) | 12 | 4 |
| Gemini, 5 replays | 2 to 9 per replay | 2 to 6 per replay |

Gemini jumped in on:
- "All the PR that we pushed today…" every time.
- The middle of his spoken verification code.
- "Nogita, I just want to know…" in 3 of 5.

Utterance edges come from Attendee's transcript times, which are approximate.

## What this says beyond the gate

- **Native turn-taking does not solve half-sentences.** Both engines answer the first half of a sentence after a long
  pause, and Gemini does it more. The fix stays in our own logic: the incomplete-turn hold, and P5-14 / P5-18 if
  unfrozen.
- **Gemini's real advantage is speed (~1.2 s to first sound) and not pausing on noise.** If speed becomes the problem,
  the cascaded pipeline's 2.4 s is where to work. The early-start (eager) path and model routing are the levers.
- **The measurements are ready for any engine.** `tools/voice-bench/result.ts` turns a scenario's event log into the
  normalized result, and the voice lab now records Deepgram and Anthropic usage. A later engine (OpenAI Realtime, a newer
  Gemini) can be measured against the same baseline in a day.

## Files

- **Results:** `docs/voice-benchmarks/v2-baseline.json` (the frozen v2 baseline, priced with `SessionUsageRegistry`, the
  code behind `/api/sessions/:id/usage`) and `docs/voice-benchmarks/gemini-spike-2026-11-03.json`.
- **Raw runs** (local, not in git): `.voice-lab/gemini-spike/gate-a/`, `.voice-lab/reports/p7-v2-*`,
  `.voice-lab/recordings/gemini-replay.json`.
- **Prices:** Gemini's token prices are third-party list prices, not confirmed on Google's page.
