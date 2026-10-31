# Listener-side Meet probe

## Intent

Measure what a second Meet participant actually hears: the delay from the end of a question to Nogita's first audible sound, and from saying “wait” to stable silence. Keep the raw recording for audit and produce data that can be compared across meetings.

## Constraints

- Run locally and keep recordings on the participant's machine.
- Require explicit recording consent; never upload audio.
- Stay outside the production voice path and add no runtime dependencies.
- Treat timings as listener-side observations, not server estimates.

## Approaches

1. **Browser recorder plus deterministic report (chosen).** A localhost page uses `getUserMedia`, records WebM, samples RMS every 20 ms, and lets the listener mark question ends and “wait”. Node analyses the envelope and compares JSON sessions. This is portable, auditable, and directly measures Meet playback.
2. Native loopback capture. More automatic, but platform-specific and would require a native dependency.
3. Hand-entered stopwatch results. Smallest implementation, but not auditable and too inconsistent for comparing meetings.

## Detection

First sound is the first 60 ms run above the session's calibrated active threshold after a question marker. Silence is the first 300 ms run below that threshold after a wait marker. Missing transitions remain `null`; they are never reported as zero.

## Non-goals

The probe does not identify speakers, transcribe speech, join Meet itself, or change interruption behavior.
