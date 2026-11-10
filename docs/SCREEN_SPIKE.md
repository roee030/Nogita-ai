# Screen reading spike (P8-7)

Can she read what people share in a design review, and what does it cost? Gate, set before measuring: at least 90% of table and column names read correctly, and at most $0.50 per hour on vision.

**Status: the real meeting (P8-13) has not happened. The numbers below come from a simulation.** Reading looks fine, but the simulation has none of Meet's video compression, which is the main risk.

## How the screen reaches us

Attendee sends the shared screen over a websocket (`websocket_settings.per_participant_video`) as JPEG frames: 1 per second at 720p (JPEG quality 60) or 1080p (quality 50). The address has to be public, so capture runs in the server behind `NOGITA_SCREEN_CAPTURE`:
- Frames are held in memory only and wiped when the session ends.
- They are readable only with the admin token.
- No model sees them on the server.
- Only frames where the screen changed are kept. That is judged by the JPEG's size (at least 3% different), plus one frame every 30 seconds to catch a change that keeps the size. A hash can't work, because each frame is re-encoded.

## What Attendee's public docs say (10 November 2026, before asking Attendee)

This is preparation for P9-12, not its answer: P9-12 stays open until Attendee confirms the points marked unverified.

| Question | Public docs | Source |
|---|---|---|
| Are `per_participant_video` frames stored? | Not stated. The docs describe delivery only (base64 JPEG, `realtime_video.per_participant`, 1 FPS at 720p/1080p). **Unverified.** | [realtime_video.md](https://github.com/attendee-labs/attendee/blob/main/docs/realtime_video.md) |
| Does the bot record video? | **Yes, by default:** `recording_settings` defaults to `mp4`, `speaker_view`, 1080p. Whether a shared screen appears in it is not stated. **Unverified.** | [create bot](https://docs.attendee.dev/api-reference/tag/bots/post/api/v1/bots) |
| Can recording be turned off? | `recording_settings.format` accepts `mp4`, `mp3` and `none`. That `none` stops all recording is implied by the name, not stated. Whether transcription still works without a recording is not stated either. **Unverified.** | create bot; `bots/serializers.py` |
| How long is data kept? | No retention period and no retention setting. The recording link is a short-lived S3 URL, which is the link's lifetime, not retention. **Unverified.** | [openapi.yml](https://github.com/attendee-labs/attendee/blob/main/docs/openapi.yml) |
| What does `delete_data` delete? | `POST /api/v1/bots/{id}/delete_data`: "all data associated with this bot, including recordings, transcripts, and participant information. Metadata is not deleted." Chat messages and video frames are not named. | openapi.yml |
| Does video change the price? | One price: 5 hours free, then $0.50 per bot hour (down to $0.35). Video is not priced separately. **Unverified.** | [pricing](https://attendee.dev/pricing) |

**Finding for the code:** Nogita does not send `recording_settings` (`src/adapters/attendee.ts`), so every bot today makes Attendee's default 1080p MP4 recording, with screen capture or without it. If Attendee confirms that the recording includes a shared screen, a code task is needed: send `format: 'mp3'` or `'none'` behind a flag that is off by default, after checking that transcripts and the scorecard (`tools/scorecard/run.ts`) still work.

**Still to ask Attendee:** the points marked unverified, plus whether `delete_data` covers chat and anything kept from the video websocket.

## Simulation, 6 November 2026

Two simulated IDE screens (a SQL schema, and a TypeScript file with a file tree): Consolas 14 px on 1920x1080, scaled and saved at Attendee's settings, read once by each model.

| | 720p, quality 60 | 1080p, quality 50 |
|---|---|---|
| Frame size | 33–53 KB | 64–95 KB |
| Haiku 5.5, per frame | $0.0006 | $0.0007 |
| Sonnet 5.5, per frame | $0.012 | $0.014 |
| Haiku, 30 frames an hour | $0.02 | $0.02 |
| Sonnet, 30 frames an hour | $0.36 | $0.42 |

- **Legibility:** Haiku at 720p transcribed the whole schema with no error, including the last comment line. I compared that frame by eye; the other frames' transcriptions are in the local reports and were not checked line by line.
- **Costs here are an upper bound for reading:** each call transcribes the whole screen, up to 1,000 tokens of output, which is most of Sonnet's cost. Prices are the rates listed in the Claude API docs bundled with Claude Code, cached 2026-10-06.
- **Not measured:** Meet's compression, a real screen's distinct frames per hour, traffic to Render, and whether Attendee charges more for video.

## What to do in the real meeting (P8-13)

0. Before anything else, get Attendee's answers on storing and deleting frames (P9-12) and write them here.
1. On Render, set `NOGITA_SCREEN_CAPTURE=720p` and `NOGITA_SCREEN_CAPTURE_ALL=true`, which keeps every frame so the change gate can be calibrated later. Tell the participants the screen is being captured and read.
2. Bring her in, and share a schema or SQL file and a code file at your usual font size for 10 minutes. Scroll, and change tabs.
3. During the meeting run `npm run screen-spike -- collect --session <id>`, then `npm run screen-spike -- analyze`.
4. Compare `report.md` with what was on screen, against the gate. If 720p isn't enough, try `1080p`. `analyze` reads an evenly spaced sample of at most 20 frames (`--max-frames`), never every frame.
5. When calibration (P9-14) has what it needs, delete the local frames in `.voice-lab/screen-spike/<id>` and note it here.
