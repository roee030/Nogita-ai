# Meeting readiness, webcam presence and missions (2026-10-29)

What changed in this round, what each change was verified against, and what still needs a real Google Meet with
people in it. Verification levels used below:

- **unit**: automated tests against fakes (`npm test`, 331 tests).
- **live-tools**: run against the real Anthropic, Jira and GitHub from this machine (read-only).
- **voice-lab**: the production voice path with synthetic speakers (see `docs/VOICE_LAB.md`); only Meet is simulated.
- **real-meet**: a real Google Meet with people. **Nothing in this round has been verified in a real Meet yet.**

## Milestone 1: conversation reliability

| Change | Where | Verified |
|---|---|---|
| The 30 s follow-up window closes once someone else speaks; a "yeah" keeps it open but never reaches the model; words to another person by name ("Dana, ...", "..., right Dana?", "guys, ...") never count as a follow-up | `engine.ts` `followUpRuledOut`, `addressesSomeoneElse` | unit |
| One-to-one vs group counts every speaker heard, including unverified guests (before, a guest who spoke still left her in "one-to-one" mode, answering every unnamed question) | `engine.ts` `noteSpeaker` | unit |
| "Stop", "never mind" and a correction stop the piece playing **now**, not only queued pieces; a stopped piece is never resumed (before, stale audio finished playing when the voice-level detector missed the "stop") | `speech-floor.ts` `drop` + `stopPlayback`, `MeetingPort.interruptSpeech` | unit |
| A compound interruption ("Nogita, stop. Just tell me the name of the main file") stops the old answer and processes the remainder as a new request instead of dropping either half | `engine.ts` `splitLeadingStop` | unit; focused voice-lab rerun pending |
| "No, I meant ..." from the asker replaces their open question (up to 60 s) and answers the corrected one; the old answer is not posted to chat either | `engine.ts` `looksLikeCorrection` | unit |
| A cut-off answer resumes from the first sentence not heard (playback time is measured by the audio bridge), not from the start; if everything was heard it is not repeated | `speech-floor.ts` `unheard`, `SpeechInterruptedError.playedMs` | unit |
| Every confirmed question ends in a final status, even when its run throws (no screen stuck on "thinking") | `engine.ts` | unit |
| Side remarks ("Okay, dropping that.", mission updates) no longer hold the floor for 6 s after they are spoken | `engine.ts` `sayAside` | unit |
| Flux is refused while Hebrew is a meeting language (`NOGITA_LANGUAGES`, default `en,he`): Flux has no Hebrew; Nova-3 multilingual stays, with language hints from configuration | `attendee-realtime-audio.ts` `chooseSttMode` | unit, server boot |
| A complete request ending in a period ("Nogita, show me the open tasks.") waits 0.3 s, not 1.2 s, before it goes to the engine | `attendee-command-router.ts` | unit |
| Spoken answers: one or two sentences (~20 words) by default, hard cap 45 words (was 2-3 sentences / 60); she says plainly when unsure and never claims something is done without a tool result | `agent-prompt.ts`, `engine.ts` | unit (prompt only; quality needs listening) |
| The presence page reconnects after a server restart: its key is derived from `ATTENDEE_WEBHOOK_SECRET` and restored with the session (before: 404 and "Connection issue" for the rest of the meeting) | `presence.ts`, `server.ts` | unit, server boot |
| The speaking look ends when her speech actually stops (bridge signal), not on a timer; a question with no news for 2 minutes leaves the screen | `presence.ts` | unit |
| Screen cards are refused while an unverified participant is in the call; cards clear after 2 minutes | `agent-tools.ts`, `server.ts` | unit |
| Per-turn diagnostics (`NOGITA_STATE_DIR/turns/*.jsonl`): heard (with Nova-3 confidence), turn result, question statuses, tools, speech start/end and how much was heard, first audio, interruptions and their latency, screen states, missions. Redacted by default (no words, hashed people); `NOGITA_TURN_LOG=full` only for consented test meetings | `turn-log.ts` | unit |
| Release report: `npm run turn-report` computes p50/p95 first audible response, interruption-to-silence p95, missed/lost questions, stale speech after a stop, stuck screens, completion rate, long answers, unnamed activations to review | `tools/turn-report.ts` | unit |

## Milestone 2: her webcam instead of a screen share

Audited first. Attendee's `voice_agent_settings.url` shows a page as the bot's **webcam**; `screenshare_url` shares it
as a screen; the two cannot be combined. The question was whether the webcam mode replaces our realtime voice. Attendee's
source (`shared_chromedriver_payload.js`, `BotOutputManager`) answers it: the page's media stream and the websocket PCM
(`realtime_audio.bot_output`) both feed the same gain node into the bot's microphone, so they are mixed. Our page is
silent, so her voice, transcription, barge-in and tools are unchanged.

- `NOGITA_PRESENCE` now defaults to `camera` (her participant tile); `screenshare` and `off` remain.
- The page has a camera layout (`?view=camera`): larger orb and text, kept away from the edges Meet crops.
- States, all from real backend signals: Ready, Listening, Understanding (question confirmed, model working),
  Investigating (a read tool running), Working (a write running), Speaking (her audio), Needs approval (a mission
  waiting on its owner), plus warnings. The orbit pace follows the phase; speech and listening motion follow real audio.
- Content she is asked to show (a task, a task list, code) fills her tile for up to 2 minutes, with the orb in the
  corner. A real screen share alongside the webcam is not possible through this Attendee interface.

Verified: unit (states), screenshots of every look in the browser (preview mode), server boot. **Not verified: how it
looks and sounds in a real Meet tile.**

## Milestone 3: delegated missions

"Nogita, take care of KAN-20" → the agent calls `delegate_mission`; she says one short line and a mission starts.

- Durable: one JSON file per mission (`NOGITA_STATE_DIR/missions`), atomic writes, owner, goal, definition of done,
  status, every step, and its own model conversation. Independent of the meeting.
- Loop (`src/core/missions.ts`): investigates with read tools on its own (the owner's access), records findings,
  and finishes only through `finish_mission`, which is accepted only when the cited identifiers (task keys, commit
  hashes, paths, URLs) appear in the mission's own tool results. A tool call is not completion.
- Authorization: every write (create a task, post a message) stops the mission as "awaiting approval"; only the
  owner can approve or decline (`decide_mission` by voice or chat, or `npm run mission -- approve M-...`). Writes are
  keyed by their own tool call, so an approval runs exactly once. Code changes and PRs are not available yet.
- Recovery: a restarted server resumes working missions from their last saved step; a write that may have run
  before a crash is never repeated: the model is told to check it first. Model failures retry with backoff
  (3 attempts), then the mission fails and says so. A budget of 24 model rounds, then it escalates as blocked.
- Visibility: progress lines go to the meeting (spoken at an opening, after the questions people are waiting for, and
  in chat) while it is open, else to `NOGITA_MISSION_CHANNEL`. The webcam shows Investigating / Working / Needs
  approval. `GET /missions` and `/missions/M-...` (admin token) list missions and their history.

Verified:
- unit: investigation, refusal of unproven completion, owner-only approval, exactly-once write, decline, restart
  resume from disk, a write interrupted by a crash, bounded retries, and the voice path "take care of KAN-20" → "approve".
- live-tools (2026-10-29, read-only, real Claude + Jira + GitHub, `npm run mission`):
  - "Take care of KAN-20": checked the task, comments, commits and repository in ~12 s, recorded that only a real
    approved meeting remains and that the task is unassigned, and escalated as blocked with an owner recommendation
    instead of claiming completion.
  - Restart: a mission was killed by `timeout` mid-investigation; `list` showed it unchanged (looking never starts
    work); a new process resumed it from disk and continued. It then blocked honestly because the commit tool gave
    two different answers, which exposed a real adapter bug (fixed: `recentCommits` now loads the code snapshot first).
  - Two Slack reads failed in that run (probably missing scopes on the bot token); not investigated further.

## Voice lab after these changes (Nova-3 multilingual, the production default)

Run 1, 2026-10-29, 8 scenarios (quiet-standup, team-discussion, barge-in, cancel-stop, follow-up, interrupt-resume,
solo-quick, context-memory), report `.voice-lab/reports/2026-10-29T19-22-44-055Z`:

- Response gap (end of the question to her first sound): **p50 3.15 s, p90 3.81 s, max 5.79 s (n=21). The 1.0 s /
  2.0 s targets are missed by a wide margin.** Earlier Flux runs were in the same range (p50 2-3.9 s), so this is not
  new; the gap is dominated by end-of-turn detection plus the model's first sentence.
- 22/32 checks passed; 19 questions: 16 answered, 1 chat only, 1 cancelled, 1 stopped, **0 lost**; she spoke over
  someone once.
- Failures and what was done about each:
  - "Nogita, stop. Just tell me the name of the main file." never reached the engine (no transcript). She did stop
    talking. Engine handling of the compound stop is covered by a unit test; the missing transcript is upstream
    (recognition or the router) and is **not explained yet**.
  - "In three or four sentences, how...": the lowered word cap cut her after one sentence. Fixed: base cap back to 60
    words, 120 when they ask for detail; the prompt still asks for one or two sentences by default.
  - The asker answered Dana ("yes, you sound fine") and that dropped her own cut-off answer to chat. Fixed: "the asker
    moved on" only counts when nobody else spoke since the cut.
  - "Nogita, open a task." / "To add caching..." → she asked again who should own it. Fixed in the prompt: an owner
    is optional; an unnamed owner means an unassigned task.
  - "NOGIYA WALK ME THROUGH..." and "Nogita in one sentence." were not taken as her name. Fixed: more words may follow
    her name (walk, take, handle, approve, "in one sentence"...); "Nikita should..." / "Nokia should..." still do not wake her.
  - solo-quick answers took 2.5-3.7 s against the lab's 2.5-3 s checks (latency, above).

Run 2 after those fixes, the 5 scenarios that failed (`.voice-lab/reports/2026-10-29T19-33-19-681Z`):
**12/16 passed, name recognized 11/11, 0 lost, response gap p50 2.87 s / p90 3.26 s (n=11)**. follow-up,
cancel-stop and "in one sentence" now pass. Still open:
- Barge-in: "stop. Just tell me the name of the main file" now stops the old answer and answers "src/app/server.ts",
  but only after a 9 s code search (the agent searched instead of answering from the repository map). A further
  spoken line came 8 s later; it is not yet clear whether it belonged to the stopped answer (that would be stale speech)
  or to the new one. **Needs investigation.**
- Interrupt-resume: her answer now resumes after the asker answers someone else; when cut again she replays a long
  piece. The lab still flags it.
- Latency: every answer is 2.2-4.5 s after the question, against a 1.0 s / 2.0 s target.

Also in the tree: a compound "stop. <new request>" handler (`splitLeadingStop` in `engine.ts`) and its test were added
by someone else during this round; they fit these changes and pass.

## What a real Meet test still has to show (needs you)

Run with `NOGITA_TURN_LOG=full` (everyone consents) and then `npm run turn-report -- --out report.md`. Three sessions,
at least two people besides Nogita:

1. Call her once; she answers. Then two follow-ups without her name; then Dana answers you and you ask Dana something:
   she must stay silent.
2. A guest (unmapped account) joins and speaks: unnamed questions are no longer hers; "show me KAN-20" is refused on screen.
3. Interrupt her mid-answer and keep talking; later interrupt and go quiet (she resumes from the unheard sentence);
   say "stop" quietly; say "No, I meant ...".
4. Her tile: Ready, Listening, Understanding, Investigating, Speaking, a card; check it is legible in a normal grid.
5. "Nogita, take care of KAN-20" → progress on her tile → approve by voice → result. End the meeting while a mission
   runs; restart the server; check it resumes (`npm run mission -- list`).
6. Restart the server mid-meeting: the tile must come back by itself.

Targets (`docs/voice-benchmark.md`): first audible response p50 ≤ 1.0 s / p95 ≤ 2.0 s, interruption to silence
p95 ≤ 0.3 s, no missed or silently lost questions, no speech after a stop, no stuck screens.

## Remaining risks

- Speaker targeting is rules plus the model's judgement; a quiet unnamed question in a group is now ignored more
  often (by design). Measure false negatives in the real sessions.
- "Heard" is estimated from playback time at 14 characters per second; Aura-2's real pace varies.
- Attendee's microphone handling may switch the mic off 2 s after our PCM ends while the (silent) page stream plays;
  harmless today, untested live.
- Missions run inside the server process; one process, file storage, no locking across processes. On an ephemeral
  filesystem (the Render Free deployment) missions and turn logs survive a process restart but not a redeploy: give
  `NOGITA_STATE_DIR` a persistent disk before relying on missions there.
- Missions cannot change code or open pull requests.
