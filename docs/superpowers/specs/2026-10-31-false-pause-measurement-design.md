# False-pause measurement design

## Goal

Measure whether turn-taking v2 pauses Nogita for non-speech sounds while she is speaking. Text labels such as "cough" are not valid evidence: the lab must inject real PCM into the same participant microphone path used by speech.

## Design

The lab adds deterministic procedural cough, typing, and laughter clips. A dedicated scenario injects each clip during active playback. These turns are marked acoustic-only, so any `playback_pause` in their acoustic window is a false pause regardless of whether STT later emits text.

The realtime hub emits a matching `playback_resume` diagnostic with the pause duration and reason (`backchannel` or timeout). The report aggregates attempts, false pauses, rate, Wilson 95% upper bound, and pause-duration distribution.

## Acceptance

- Every perturbation is actual non-silent PCM and bypasses participant TTS.
- The scenario covers cough, typing, and laughter during active playback.
- Every pause can be paired with a resume or interruption and its duration remains auditable in `report.json`.
- Rollout evidence should include enough repetitions for the Wilson upper bound to be meaningful; the recommended gate is upper95 <= 5% and p90 pause duration <= 300 ms.

