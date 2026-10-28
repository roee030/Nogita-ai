# Voice and repository quality design

## Product intent

Nogita is a spoken teammate that can answer grounded questions about the configured repository and, when authorized, work with Jira and Slack. She must wait for the speaker's actual turn, speak promptly and concisely, and say when she is checking something or cannot complete it. A natural voice is a measured outcome, not a claim made from unit tests.

## Evidence and constraints

- Deepgram says Nova-3 `speech_final` is produced by pause detection. Its [endpointing guide](https://developers.deepgram.com/docs/understand-endpointing-interim-results) recommends an application layer for complete utterances. Our Nova-3 path uses 500 ms endpointing and a 1,200 ms quiet window.
- Deepgram's [Flux guide](https://developers.deepgram.com/docs/flux/agent) recommends `EndOfTurn` first, and `StartOfTurn` for interruption. Its [language list](https://developers.deepgram.com/docs/models-languages-overview/) does not list Hebrew for Flux; Nogita must retain the multilingual Nova-3 path for Hebrew.
- Deepgram [documents `Clear`](https://developers.deepgram.com/docs/tts-ws-clear) for stopping buffered TTS after an interruption. The playback side also needs to stop queued audio, not just clear TTS input.
- GitHub's [tree API](https://docs.github.com/en/rest/git/trees) can truncate recursive results and recommends traversing subtrees. The connector now expands truncated trees, but still has a finite 1 MiB per-file bound and does not yet retrieve larger files on demand.
- [SWE-QA](https://aclanthology.org/2026.findings-acl.402/) evaluates cross-file and multi-hop repository questions; matching only four lexical snippets is not evidence of whole-repository competence.

## Approach

Ship measurable improvements in two independent tracks. First, create a frozen local repository-question evaluation set and improve retrieval with revision-pinned tree traversal, chunk-level evidence, and a bounded second search when initial evidence is insufficient. Second, retain Nova-3 as the multilingual default while adding an opt-in English Flux path, tested with synthetic turn-event sequences. Add interruption handling and compare voice candidates in recorded consented calls. Do not enable speculative `EagerEndOfTurn` until basic turns and cancellations are reliable.

## Release gates

- No code evidence for unauthorized speakers; no source excerpt from the wrong revision; no silent truncation or partial index falsely presented as complete.
- Repository evaluation includes direct file questions, cross-file architecture, recent commits, nonexistent symbols, and denied access. Record retrieval recall and grounded answer quality separately.
- Voice evaluation includes mid-sentence pauses, resumed speech, two speakers, interruption during speech, silence, leave, provider error, and English/Hebrew. Record time from user turn end to first audible audio and interruption rate.
- Preserve local and deployed secret separation. Publish only after tests, TypeScript, integration checks, and a short live meeting confirm the behavior.
