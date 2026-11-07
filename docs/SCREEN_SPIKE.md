# Screen reading spike (P8-7)

Can she read what people share in a design review, and what does it cost? Gate, set before measuring: at least 90% of table and column names read correctly, and at most $0.50 per hour on vision.

**Status: the real meeting (P8-13) has not happened. The numbers below come from a simulation.** Reading looks fine, but the simulation has none of Meet's video compression, which is the main risk.

## How the screen reaches us

Attendee sends the shared screen over a websocket (`websocket_settings.per_participant_video`) as JPEG frames: 1 per second at 720p (JPEG quality 60) or 1080p (quality 50). The address has to be public, so capture runs in the server behind `NOGITA_SCREEN_CAPTURE`:
- Frames are held in memory only and wiped when the session ends.
- They are readable only with the admin token.
- No model sees them on the server.
- Only frames where the screen changed are kept. That is judged by the JPEG's size (at least 3% different), plus one frame every 30 seconds to catch a change that keeps the size. A hash can't work, because each frame is re-encoded.

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
