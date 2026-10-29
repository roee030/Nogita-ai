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
```

**Requirements in `.env`:** `NOGITA_MODE=live`, `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY` and
`AUTHORIZED_ACTOR_IDS`. The GitHub, Jira and Slack settings are optional; the lab uses whichever are configured.

**Writes:** Jira task creation and Slack posts are intercepted. They are logged and answered with a placeholder
link, so a run never changes your board or channels. Reads are live.

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
- a note for the judge.

## What a report contains

Reports go to `.voice-lab/reports/<time>/`:
- `report.html`: summary tiles and one timing bar per turn.
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

The report also gives:
- answer length;
- the time Nogita takes to stop when interrupted;
- the transcript's word error rate;
- whether her name was recognized;
- pass/fail per expectation;
- optional scores from a Claude judge (`--judge`) for correctness, naturalness and length (1-5).

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

**Simulation caveats found along the way:**
- Deepgram's TTS occasionally returns a near-silent, unintelligible clip. The lab now rejects clips that peak
  below -15 dBFS and re-synthesizes them.
- `VOICE_LAB_TRACE=1` logs every Deepgram event and stream close, for debugging a turn that was never heard.
