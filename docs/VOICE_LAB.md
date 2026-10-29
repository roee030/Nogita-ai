# Voice lab

The voice lab tests Nogita by voice outside any meeting. Synthetic colleagues speak questions into live
microphones with background noise. The lab measures how long the room waits between the last word of a question
and the first sound of Nogita's answer, and checks what she did.

```bash
npm run voice-lab                                  # all scenarios
npm run voice-lab -- --list                        # what is available
npm run voice-lab -- --scenario stump,cafe-loud --judge
npm run voice-lab -- --noise cafe --snr 0          # same questions, louder room
npm run voice-lab -- --stt flux-english            # compare speech recognition modes
npm run voice-lab -- --eot 0.8                     # Flux end-of-turn threshold (default 0.8)
npm run voice-lab -- --stt flux-english --eager 0.5  # start answering at Flux's early end-of-turn (production default)
npm run voice-lab -- --scenario actions --live-writes   # really create the Jira tasks it asks for
```

**Requirements in `.env`:** `NOGITA_MODE=live`, `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY` and
`AUTHORIZED_ACTOR_IDS`. The GitHub, Jira and Slack settings are optional; the lab uses whichever are configured.

**Writes:** Jira task creation and Slack posts are intercepted by default. They are logged with their full title
and description and answered with a placeholder link, so a run never changes your board or channels. With
`--live-writes` they really happen, and the report shows the real task key and link. Reads are always live, and
every lookup (`search_tasks`, `search_code`, `read_file`, `recent_commits`...) is logged with its query.

## What is real and what is simulated

```
participant voices (Deepgram Aura-2, cached) + noise ──► lab "Attendee" WebSocket client, 20 ms frames in real time
        ──► AttendeeRealtimeAudioHub ──► Deepgram STT (Nova-3 or Flux) ──► AttendeeCommandRouter
        ──► NogitaEngine + agent (Claude, GitHub, Jira, Slack) ──► hub ──► Deepgram TTS ──► lab client (Nogita's audio)
```

**Real:** everything from the audio hub onwards is the production code with production settings, including
endpointing, the router quiet window, barge-in and the speech queue.

**Simulated:** the meeting platform. The lab plays Attendee by streaming per-participant PCM over the same signed
WebSocket protocol and receiving `realtime_audio.bot_output`. Network delay between Attendee and the server, and
any noise suppression the platform applies, are not included.

## Scenarios

| Name | What it stresses |
| --- | --- |
| `quiet-standup` | Everyday questions, a non-addressed remark (must stay silent), a thank-you |
| `office-chatter` | Colleagues talking nearby at 15 dB; a question with a 0.9 s pause in the middle |
| `cafe-loud` | Many voices and dishes at 5 dB; Jira questions |
| `stump` | Name mid-sentence, a service that does not exist, general knowledge, a prompt-injection "delete every ticket", self-correction, a third-person mention, mental arithmetic |
| `actions` | Task creation (intercepted), an unverified guest asking for a write |
| `barge-in` | Talking over Nogita mid-answer; she must stop and answer the new question |
| `rapid-fire` | Short questions back to back |
| `street-extreme` | Traffic noise 3 dB below speech |
| `team-discussion` | Three people discussing among themselves (she stays silent), then questions and a task built from what was said |
| `standup` | A status round in an office, then "who is blocked?", a task for a named person, and a summary |
| `crosstalk` | A question to Nogita while someone else is still talking on their own microphone |
| `follow-up` | "Open a task" with no details; she asks, and the answer comes without her name |
| `context-memory` | Questions that lean on her previous answer ("and what starts it?") |
| `hand-raise` | The team agrees to log secrets and make a bucket public; she should raise her hand and explain when given the floor |
| `solo-quick` | One person, quiet room, questions she can answer without lookups; her answer must start within 2.5 s |
| `thinking-bridge` | Questions that need Jira or the code: a short "let me check" within 2 s, the right lookup, then the answer |
| `stalled-speaker` | A long "um" mid-question, a question abandoned with "never mind", and a sentence cut off halfway |
| `multi-question` | Two questions in one sentence, and a second person asking before she answered the first |
| `proactive-gap` | The team agrees a bug matters and moves on with no owner; she should raise her hand and offer a task |
| `parallel-lookups` | Two people ask for lookups (the board, the commits) before either answer is ready; both answered, each naming its topic |
| `rapid-questions` | One person asks three questions 1.4 s apart, talking over her answers; none may be dropped |
| `interrupt-resume` | Someone talks over her answer about something else; she finishes the answer afterwards |
| `cancel-stop` | "Actually, never mind" drops an open lookup; "Nogita, stop" ends an answer for good |
| `asked-twice` | The same question repeated while she is still looking: one lookup, one answer |
| `talk-over` | Two people keep talking while her answer is ready; she waits for an opening |

**Noise kinds:** `quiet`, `white`, `pink`, `brown`, `hum`, `keyboard`, `office`, `cafe`, `street`. The office and
cafe profiles mix real synthesized background chatter in other voices. Noise is set by SNR against a fixed speech
level.

**Adding a scenario:** append it to `tools/voice-lab/scenarios.ts`. A turn takes a speaker, the line or lines to
say, an optional pause, gap, barge-in or overlap with the previous speaker, and an expectation:
- whether she should speak, stay silent or answer in chat only;
- the phrases her answer must mention;
- the phrases it must not mention;
- the write it should or should not attempt, and what that write must contain;
- whether she must have raised her hand earlier;
- the lookups she must make (for example `search_tasks`: she went to the board);
- how soon some sound, and how soon her own words, must start;
- how the question must end in her question tracker (`answered`, `cancelled`, `stopped`...);
- that she stays quiet after the turn (for "stop"), or makes a lookup at most once;
- a note for the judge.

## What a report contains

Reports go to `.voice-lab/reports/<time>/`:
- `report.html`: summary tiles, one timing bar per turn, and every conversation in order (scenarios with a
  failure open first).
- `transcript.md`: the conversations as text. Each turn shows what the person said, what speech recognition
  heard, then everything Nogita did with its delay: a bridge ("One sec."), her own sentences, each lookup,
  chat messages, a raised hand, the Jira task or Slack message with its full text, the result of each check
  and the judge's comment.
- `report.md`: the same as a table.
- `report.json`: every event.
- one stereo WAV per scenario: the room on the left and Nogita on the right, so you can listen to the conversation.

**Timing per turn**, in milliseconds after the last spoken word:

| Stage | From → to |
| --- | --- |
| Endpointing | last word → final transcript from Deepgram |
| Router | final transcript → utterance handed to the engine (quiet window that merges fragments) |
| Thinking | utterance → first sentence ready to speak |
| Voice | first sentence → first audio frame back (TTS and transport) |
| **Response gap** | last word → first sound from Nogita: what the room experiences |
| **Real content** | last word → first sound that is not a canned filler ("One sec."): her own words |
| **Answer itself** | last word → her first words after the turn's last lookup: time to meaningful speech |

The report also gives:
- answer length;
- the time Nogita takes to stop when interrupted;
- the transcript's word error rate;
- whether her name was recognized;
- pass/fail per expectation;
- optional scores from a Claude judge (`--judge`) for correctness, naturalness and length (1-5).

**Conversation management**, from every question's path through the engine's question tracker
(`working → answering → interrupted → answering → answered`, or `cancelled`, `stopped`, `chat_only`, `failed`):
- questions answered aloud, answered only in chat, cancelled by the asker, stopped by the room, and **lost** (never
  answered); question completion is answered aloud / questions not withdrawn;
- the same question asked again while open;
- early starts (speculative, before the end of the turn was confirmed): how many were used and how many rolled back;
- answers cut off by a participant, and how many were finished afterwards;
- how often she started speaking while someone was mid-sentence;
- duplicate writes.

Each scenario in `transcript.md` opens with a table of its questions and their paths, and every status change
appears in the conversation as a `question` line.

## Findings so far

The findings, and the fixes they led to, are listed in the commit history of `tools/voice-lab` and in the
latest report:
1. **Name recognition.** Deepgram heard "Nogita" as "Nokita", "Notita", "Nokata" or "Nikita" in a quiet room, so
   Nogita answered 0 of 4 addressed questions by voice.
   - **First fix:** keyterm prompting for the wake word on every STT stream. This improved recognition to 2 of 4.
   - **Second fix:** `normalizeWakeWord` restores a word within two edits of "nogita", but only where an address can
     stand. Mid-sentence mentions such as "I asked Nikita" are left alone.
2. **Router wait.** The router waited its full 1.2 s quiet window after Deepgram had already finalized the
   question, which was the largest single delay. A finished question to Nogita (ending in "?") now waits 300 ms.
   If the speaker keeps talking, interim speech still extends the window.
3. **Answer length.** Spoken answers ran 22-28 s. The voice prompt now asks for about 35 words, and the hard cap
   is 60 words. The rest goes to chat.
4. **Noise blocked every turn (Nova-3).** Steady hum, typing or chatter kept silence-based endpointing from ever
   firing. Interim words arrived, but no turn completed, so Nogita never answered in a noisy room. Turns now also
   complete on Deepgram's `UtteranceEnd`, which works from word timings.
5. **A new speaker's words were dropped.** The hub buffered 32 frames while a speaker's Deepgram stream
   connected. At 20 ms frames that is 0.64 s, shorter than a slow handshake, so the stream was closed and
   reopened while the person kept talking. The buffer now holds up to 5 s.
6. **Muting right after speaking lost the words.** Without more audio the recognizer never ended the turn. After
   200 ms without frames the hub now sends up to 3 s of silence.
7. **Background talk interrupted every answer.** Chatter on an open microphone was transcribed and treated as a
   barge-in, so her speech was cut before a sound was heard. Now only speech may interrupt her. Speech here means
   at least 100 ms within 6 dB of that speaker's own level and within 12 dB of the room's loudest speaker.
   - Both levels fade over minutes, not seconds, so a colleague talking ten seconds later does not become "the
     speaker".
   - Transcripts are always delivered. Dropping "quiet" turns was tried and lost real speech in a loud cafe.
8. **Flux was slow in noise.** In an office it waited up to its 7 s end-of-turn timeout. The timeout is now 3 s.
   - We tried ending the turn when the speaker's own voice went quiet. It cut sentences in half at 5 dB SNR,
     where loudness cannot tell speech from the room, so it was removed.
   - A new stream also starts with 0.5 s of silence: Flux missed an opening "Nogita" when audio began at once.
9. **Recognition quirks around the name.** The recognizer produced "Lokita", a stray "No" before the name, the
   name between commas mid-sentence, and dropped commas ("Nogita summarize", "Nogita and what starts it"). All of
   these are now understood as addresses. Third-person phrases ("Nogita is great", "Dana, Nogita, and Avi") are
   not.
10. **A question followed by instructions closed the follow-up window.** For example: "What should the task be
    about? Give me a title." The reply without her name was ignored. Any question in the last two sentences now
    opens the window.
11. **Fillers delayed ready answers.** A 2 s filler started just before the model's first sentence, which then
    waited behind it. Agent fillers are now short ("One sec.") and stay out of chat.

12. **Time to her own words** (19 scenarios, Flux, Haiku). Median 2.4 s from the last word, p90 4.4 s. Of that,
    end-of-turn detection takes about 1.1 s, the model about 1.2 s and the voice 0.26 s.
    - **Thinking off by default.** Haiku answered without thinking first; the median was 2.6 s with thinking off
      but before the other fixes, and 3.0 s with thinking on. Judged correctness was the same.
    - **Warm voice connection.** It opens when the meeting audio connects and again right after an interruption.
      Voice time fell from 0.7-1.4 s on a cold connection to 0.26 s.
    - **Warm prompt cache.** The stable prompt and tools are cached when the session starts and refreshed while
      the meeting is quiet, so the first question does not pay for a cold cache.
13. **Flux threshold 0.7 was worse.** Deepgram's default ended turns at the pause after "Nogita,", so she
    answered her own name and was cut off by the rest of the question (51/74 passed against 61/74 at 0.8).
    It stays at 0.8.
14. **Reasoning spoken aloud.** Without thinking, the model sometimes said its reasoning ("This question is about
    the meaning of life, so..."). The prompt now says everything it writes is spoken, and keeps the lead-in
    before a lookup to six words.
15. **The name without a comma.** "Nogita should reminder emails go through a queue?" and "Nogita in one
    sentence, what is this?" were not taken as addressed. A question that opens with her name now is, unless
    it is about her ("Nogita was down?").
16. **Asking twice.** After getting the details of a task she asked whether to open it "as is". She now acts
    once she has what the request needs. "Open one for me to ..." after an earlier task is now an explicit
    request.

17. **Stage 2: several questions at once, early start** (25 scenarios, Flux, Haiku, early end-of-turn 0.5,
    report `stage2-final`). First sound p50 2.05 s, p90 3.56 s (stage 1: 2.42 s / 4.38 s). The answer itself (first
    words after the last lookup) p50 2.05 s, p90 3.92 s. Model to first sentence p50 0.62 s (stage 1: 1.19 s): the
    early start hides most of it. 76/91 turns passed; judge correct 3.57, natural 3.19, concise 3.57 (stage 1:
    3.69 / 2.81 / 3.13). 55 questions: 49 answered aloud, 3 only in chat, 1 cancelled, 2 stopped, **0 lost**;
    completion 94%. 63 early starts: 52 used, 11 rolled back with nothing said. 4 answers cut off, all finished.
18. **A second asker no longer costs the first answer.** The engine used to answer one utterance at a time and a
    barge-in dropped the rest of an answer. Each question now runs on its own and speech goes through one floor;
    in `parallel-lookups` both lookups ran at once and both answers were spoken, each naming its topic.
19. **What the lab found in the new design, now fixed:**
    - A turn that was only "Nogita." got an empty answer; her name alone now waits for the question.
    - The same person's new question resumed their old answer again and again; it now goes to chat.
    - A cut-off "Sure, checking the board." was repeated as "As I was saying, sure, checking the board."
    - After a pause mid-question ("can you check... um, which file starts the server?") she answered the first
      half; the half-answer is now dropped and the whole question answered.
    - "Stop. Just tell me the main file." stopped her but lost the request after "stop".
    - The chat note "I heard you. I'm checking that now." contradicted quick spoken answers; it is off for live voice.
    - A quoted example question in her answer (like "Nogita, how does auth work?") made the next remark look like
      a reply to her.

**Known open issues:**
- She can still begin a lead-in up to about 0.6 s after someone else starts talking (3 times in the full run): the
  floor waits for a person's voice, but the first 100-300 ms of a new speaker are not detected yet.
- Same-person questions less than about 3 s apart are often merged by Flux into one turn (she answers both).
- Spoken answers are long: p50 16.6 s. Every answer is also in chat; a shorter spoken limit is worth testing.
- The judge scores each turn's own time window, so with overlapping questions an answer that lands in the next
  turn's window is judged against the wrong question.
- On an open microphone in an office, nearby talk merges into the speaker's turn and delays the answer
  (up to 5 s).
- The `aura-2-arcas-en` lab voice is often heard as "The guitar" instead of "Nogita".

**Simulation caveats found along the way:**
- Deepgram's TTS occasionally returns a near-silent, unintelligible clip. The lab now rejects clips that peak
  below -15 dBFS and re-synthesizes them.
- `VOICE_LAB_TRACE=1` logs every Deepgram event and stream close, for debugging a turn that was never heard.
