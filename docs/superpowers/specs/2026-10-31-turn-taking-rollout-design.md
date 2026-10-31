# Turn-taking v2 rollout design

## Problem

The measured turn-taking changes (80 ms / -9 dB own-voice gate, pause-and-classify backchannels, and a 3 s speech-floor lease) reached `main` without an independent rollout switch. `NOGITA_REALTIME_AUDIO_ENABLED` controls the whole realtime pipeline, so it cannot disable only the new behavior while keeping realtime speech available.

## Decision

Add `NOGITA_TURN_TAKING_V2`, strictly parsed as a boolean and disabled by default. The switch selects one coherent profile:

- disabled: the pre-change 100 ms / -6 dB gate, transcript-driven interruption, no acoustic pause, and a 1 s speech-floor lease;
- enabled: the measured 80 ms / -9 dB gate, acoustic pause followed by backchannel resume or interruption, and a 3 s speech-floor lease.

The production server passes the same value to the realtime hub and the engine floor. The voice lab explicitly enables v2 so its acceptance measurements continue to exercise the candidate profile instead of the safe default.

`@cartesia/cartesia-js` moves to `devDependencies`: it is used only by the lab benchmark and must not enter the runtime container installed with `npm ci --omit=dev`.

## Safety and observability

Invalid flag values make readiness/configuration fail rather than silently selecting a profile. The example environment documents the flag and keeps it false. Existing realtime audio remains independently controlled by `NOGITA_REALTIME_AUDIO_ENABLED`.

## Acceptance criteria

1. With the flag absent or false, own voice does not acoustically pause output and the legacy threshold/lease apply.
2. With the flag true, output pauses within the existing 300 ms acceptance budget, backchannels resume it, and sustained speech cancels it.
3. The server uses one flag value for both realtime audio and the speech floor.
4. The voice lab opts into v2 explicitly.
5. The production dependency tree excludes Cartesia while lab installs still include it.

