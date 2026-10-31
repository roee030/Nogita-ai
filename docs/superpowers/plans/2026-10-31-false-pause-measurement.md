# False-pause measurement implementation plan

1. Add failing tests for deterministic acoustic perturbations, TTS bypass, scenario coverage, resume diagnostics, and summary statistics.
2. Generate cough, typing, and laughter PCM in `tools/voice-lab/noise.ts`.
3. Extend scenario turns and playback to inject acoustic-only clips while Nogita is speaking.
4. Emit `playback_resume` events from the realtime hub and capture exact pause duration in the rig.
5. Add false-pause rate, Wilson upper bound, and duration stats to JSON, Markdown, HTML/console summaries, and lab documentation.
6. Run focused tests, all tests, typecheck, diff checks, and GitHub Actions before merge.

