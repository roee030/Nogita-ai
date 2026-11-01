# Turn-taking: v2 or legacy

The data for Roee's decision (board task P5-9). Production runs legacy today (`NOGITA_TURN_TAKING_V2=false`).

## Recommendation

**Switch to v2.** In both passes v2 does better on everything turn-taking is for:
- it stops talking when someone interrupts her, in about 0.2 s (legacy: about 1.3 s, up to 1.5 s)
- it doesn't stop for "mm-hm" (7 of 8 kept; legacy kept 2 of 8)
- it never started talking over anyone (legacy: 8 times)

What v2 costs: a cough or a laugh while she talks pauses her for about 0.8 s, 4 times out of 6, before she goes on. Legacy didn't pause at all. That's the "false-pause acceptance" `.env.example` asks for before turning v2 on, and **it doesn't pass yet**.

Talking over people for more than a second, and stopping mid-answer for every "mm-hm", hurt a meeting more than a short pause on a cough. So switch now, and treat false pauses as the next fix rather than a blocker. If the rule "no v2 until false pauses pass" stands, keep legacy and fix false pauses first. The numbers below don't change between the two readings, only the weight given to that one row.

## What was run

- **Date:** 1 November 2026.
- **Command:** `npm run voice-lab -- --scenario <the 10 below> --turn-taking v2|legacy --repeat 2`
- **Setup:** Flux English STT, Haiku 5.5, Aura-2 Thalia, intercepted writes, production warm-up.
- **Order:** the two modes ran one after the other on the same machine, 2 passes each, so timing is comparable.
- **Reports:** `.voice-lab/reports/2026-11-01-tt10-{v2,legacy}-r{1,2}/`.

The ten scenarios are the ones where turn-taking decides the outcome, plus a quiet baseline:
- barge-in
- false-pause
- backchannels
- interrupt-resume
- talk-over
- cut-off
- crosstalk
- meeting-room
- cancel-stop
- quiet-standup

A third pass was not needed: the differences are large and the same in both passes.

## Numbers

Both passes together unless a row says otherwise.

| Measure | v2 | legacy | Better |
|---|---|---|---|
| Turns that passed every check | 70 / 88 (80%); 35 and 35 per pass | 63 / 88 (72%); 31 and 32 per pass | v2 |
| Stopped after being interrupted (n=6 each) | 159–296 ms; p50 by pass 237 / 189 ms | 37–1528 ms; p50 by pass 1371 / 1274 ms | v2 |
| "Mm-hm" while she talks: kept talking | 7 / 8 | 2 / 8 (6 false stops) | v2 |
| Started speaking over someone | 0 | 8 | v2 |
| Answers cut off by her own stop logic | 6 | 12 | v2 |
| Cough, laugh or typing while she talks: paused | **4 / 6, about 0.83 s each (p90)** | 0 / 6 | legacy |
| Response gap p50 / p90 (end of speech to first sound) | 2.04 / 4.13 s | 2.32 / 5.39 s | v2, slightly |
| Questions answered / asked | 49 / 57 | 46 / 53 | similar |
| Questions lost | 1 | 2 | similar |
| Duplicate writes, errors | 0, 0 | 0, 0 | same |

Turns passed by scenario (both passes):

| Scenario | v2 | legacy |
|---|---|---|
| backchannels | 15 / 16 | 10 / 16 |
| cancel-stop | 8 / 8 | 5 / 8 |
| barge-in | 3 / 4 | 2 / 4 |
| interrupt-resume | 3 / 6 | 2 / 6 |
| talk-over | 2 / 6 | 4 / 6 |
| meeting-room | 11 / 16 | 12 / 16 |
| quiet-standup, false-pause, crosstalk, cut-off | 8/10, 12/12, 6/6, 8/10 | the same |

The "false-pause" scenario's turns pass in both modes; its cough and laugh probes are counted in the "paused" row, not as turns. On the phase 5 gate, interruption-to-silence p95 under 500 ms, v2 is within it in the lab and legacy is not. The gate itself is measured at the listener in a real meeting.

## Where each one still fails

- **v2:**
  - `talk-over`, 2 of 6: with the team still talking when her answer is ready, she waits and then the answer is cut off.
  - `meeting-room`, 11 of 16: mostly "name heard", a transcription problem the same in both modes.
  - `interrupt-resume`, 3 of 6.
  - The false pauses above.
- **legacy:**
  - stops for backchannels
  - slow to stop when interrupted ("stops when interrupted" failed 5 times)
  - speaks over people
  - `cancel-stop`, 5 of 8

## Caveats

- Small samples: 6 interruptions, 8 backchannels and 6 noise probes per mode. The direction is the same in both passes, but a rate such as "4 of 6" has a wide range (upper 95% bound for false pauses: 94%).
- Lab times are measured at the server. A real meeting adds the meeting provider's own delay; P5-8's meetings measure it at the listener.
- Recognition errors ("name heard" in the meeting-room scenario) hit both modes the same and say nothing about turn-taking.

## If v2 is chosen

1. Set `NOGITA_TURN_TAKING_V2=true` on the server.
2. Watch the first meetings' turn logs in `npm run dashboard`: interruption p95, and "spoke over someone".
3. Add a board task for false pauses: no pause, or a much shorter one, on a cough or laugh, with the `false-pause` scenario as its gate.
