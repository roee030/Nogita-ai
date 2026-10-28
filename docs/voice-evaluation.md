# Nogita voice evaluation

Run this only in a consented, short test meeting. Record timings and ratings, not audio, transcripts, tokens, or personal data in Git.

## Script

1. Verify the authorized owner, then ask a simple greeting and a short repository question.
2. Pause for two seconds in the middle of a repository question, then finish it. Count any premature response.
3. Ask a cross-file question about how meeting speech can create a Jira task; check the spoken answer and source link.
4. Ask whether interruption can stop audio already submitted to Attendee. Nogita should distinguish local queue cancellation from unverified provider playback clearing.
5. Interrupt Nogita during a long answer, then ask a different question. Check whether old audio continues.
6. Ask a second speaker to talk; confirm the speakers are not merged and authorization is preserved.
7. Ask in Hebrew. The Nova-3 multilingual path should remain available; Flux English mode is not a Hebrew test.
8. Ask Nogita to leave. Confirm the spoken/chat notice and the bot departure.

## Conversation-continuity regression script

Use a fresh authorized meeting for each run. Note the local clock time at the end of each spoken request, first chat acknowledgement, first audible response, final answer, and confirmed provider exit. Do not put the transcript or verification code in Git.

1. Say: “Let's do them both. Nogita, what is this project about?” Expect an acknowledgement and an answer, not silence. Check the answer against a repository source link.
2. Ask a direct read-only question that makes Nogita ask whether to continue. Reply once: “Yes, please.” Expect a reply to that same question; repeat “Yes, please” after the answer and expect no replay.
3. Have another participant say “Yes, please” after Nogita asks the owner a question. Expect no owner-authorized continuation.
4. Ask a slow repository question. If Nogita says “One second”, expect the next response to be an answer or a clear failure for that same request, without asking for permission again.
5. Say: “Nogita, drop this meeting.” Expect a leave notice and confirmed bot exit, not a claim that the user must remove her.

For each turn, distinguish an ignored request (no acknowledgement) from processing delay (acknowledged but no answer), model delay, TTS submission delay, and actual audible delay. Do not infer audible latency from transcript timestamps alone.

## Metrics

- Time from actual end of the human turn to first audible Nogita audio: p50 and p95 across at least 10 turns.
- Premature responses during intentional mid-sentence pauses: count / 10.
- Correct interruption cancellation: count / 5.
- Repository questions with correct answer and supporting file link: count / 10.
- Unsupported-capability questions answered honestly: count / 3.
- Voice naturalness, pacing, and intelligibility: blinded 1–5 ratings from at least two listeners for each candidate voice.
- Direct requests acknowledged and answered or failed explicitly: count / total.
- Progress phrases followed by an answer or clear failure to the same request: count / total; orphaned progress phrases: count.
- Follow-up replies resolved to the right authorized speaker and prior question: count / total.

These are evaluation targets to measure in a real call, not performance claims from automated tests.

## Voice comparison

Run the same short, consented script with `DEEPGRAM_TTS_MODEL` set in the deployed environment to `aura-2-thalia-en`, `aura-2-luna-en`, and `aura-2-asteria-en`, one at a time. Keep the wording, meeting conditions, and listeners fixed. These are candidate voices, not a predetermined winner. The current realtime output path supports Aura-2 English voices only; do not use a Flux TTS model string with this setting.
