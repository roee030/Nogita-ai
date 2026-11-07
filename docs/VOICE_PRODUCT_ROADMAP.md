# Voice product roadmap

How Nogita becomes a meeting assistant that product engineering teams would miss if it were gone, with a path to other
meeting types later.

**Status:** proposal for Roee to review. Repository state observed on 2026-11-07 at `origin/main` `a220941`. This
document changes no code, API, configuration, provider behavior or board task. Tasks marked **new** are not on the board.

## 1. The short version

1. **The next step is proof, not features.** Every task Claude can start is finished. The board says "Nothing to start",
   no PR is open, and the remaining gates need real meetings.
2. **Order:** real-meeting smoke check, then the five-meeting value gate, then meeting profiles and team context, then
   the screen experiment, then the wider test matrix and improvement loop.
3. **Screen understanding can stay within budget** if models see frames only on request. The unknown is not price but
   whether text survives Meet's compression, which has never been measured.
4. **"Self-improving" has a narrow meaning here.** Nogita learns team context inside an isolated workspace and proposes
   changes for offline evaluation. A person approves every change that reaches production.

### Seven findings that change the plan

Each comes from checking the repository while writing this. Later sections act on them.

| # | Finding | Why it matters | Source |
|---|---|---|---|
| 1 | All three scorecards predate the listen-first, recap and follow-up work. The meetings ran on 1 and 3 November; listen-first merged on 6 November. | They are a baseline. They say nothing yet about the current design. | [scorecards](scorecards/README.md), PR #92 |
| 2 | "0 corrections" is not yet evidence. Two of the three meetings produced no task, and the scorecard counts only edits to tasks, while the plan's test also covers recaps and decisions. No meeting recorded minutes saved, and they lasted 2 to 6 minutes. | A passing card could miss a wrong recap, and a 2-minute meeting cannot save 10 minutes. | [`score.ts`](../tools/scorecard/score.ts), [WORK_PLAN.md](WORK_PLAN.md) |
| 3 | The screen capture discards frames using the JPEG-size rule that this roadmap replaces. | A capture taken as P8-13 stands cannot calibrate a new gate: frames that rule dropped are gone. | [`screen-capture.ts`](../src/app/screen-capture.ts) |
| 4 | Nothing gives Nogita a meeting title or agenda. The join flow takes a session ID, a meeting URL and an optional owner. Calendar integration is explicitly postponed until after the pilot. | Profile inference must start from early conversation and an optional hint at join time. | [`server.ts`](../src/app/server.ts), [WORK_PLAN.md](WORK_PLAN.md) |
| 5 | Team memory is not yet workspace-scoped or durable on the current deployment. `FileMeetingMemory` has one directory per deployment, with no team key. Render's filesystem is ephemeral, and the persistent disk (P1-7) is deferred. | Learned context would vanish on redeploy, and all teams in one deployment would share it. | [`meeting-memory.ts`](../src/app/meeting-memory.ts), [SECURITY.md](SECURITY.md) |
| 6 | "$0.50 per hour" is an experiment gate, not a control. No vision call path exists in the server, and the session budget has no vision accounting. | Enforcement must be built with P8-8, before the first production vision call. | [SCREEN_SPIKE.md](SCREEN_SPIKE.md), [`session-usage.ts`](../src/app/session-usage.ts) |
| 7 | Recap, retro and design review have unit tests with a stand-in model, but no cases in the live-model eval, although their board tasks name eval as a regression. | The quality of the written output that the value gate depends on has not been measured offline. | [`cases.ts`](../tests/eval/cases.ts), `tests/meeting-recap.test.ts` |

## 2. Where the product stands

Evidence levels follow the project's own proof ladder: planned, in code, tested, voice lab, tried in a meeting, in
production. Simulation and replay are named separately, because neither proves meeting behavior.

Which flags are on in production cannot be confirmed from this repository. Roee sets them on Render, and the phase 8
flags are not listed in [`config/render-flags.env`](../config/render-flags.env), so nothing below claims production use.

| Capability | Flag (off by default) | Strongest evidence today | Still missing |
|---|---|---|---|
| Meeting scorecard (P8-1) | none, a tool | Used on three real meetings. An unknown minutes-saved value can never pass | Recap and decision corrections; a meeting where minutes are actually recorded |
| Turn-taking v2 | `NOGITA_TURN_TAKING_V2` | Voice lab: stops in about 0.2 s against 1.3 s for legacy | Meet listener measurement; the P5-9 decision. Production ran legacy as of the [1 November decision data](TURN_TAKING_DECISION.md) |
| Listen-first (P8-2) | `NOGITA_LISTEN_FIRST` | Tests, voice lab, replay of real recordings | A scored real meeting |
| Recap with numbered approval (P8-3, P8-10) | `NOGITA_MEETING_RECAP`, `NOGITA_RECAP_CHANNEL` | Unit tests with a stand-in model | Live-model eval; smoke check P8-12 |
| Follow-up (P8-4) | `NOGITA_FOLLOW_UP` | Unit tests | Smoke check P8-12 |
| Design review opinion (P8-9) | `NOGITA_DESIGN_REVIEW` | Unit tests with a stand-in model | Live-model eval; a real design review |
| Retro (P8-11) | `NOGITA_RETRO` | Unit tests with simulated recaps | Live-model eval; a real retro |
| Screen capture and reading (P8-7) | `NOGITA_SCREEN_CAPTURE` | **Simulation only**: two synthetic IDE screens with no Meet compression | P8-13. One frame was checked by eye; the rest were not checked line by line |
| Conversation about the screen (P8-8) | `NOGITA_SCREEN_CONTEXT` (planned, not in code) | Planned; waits on P8-13 | Everything |
| Team memory | `NOGITA_MEETING_MEMORY=decisions` | In code and tested: decisions and action items, 90-day retention | Workspace scope; durable storage |
| Meeting profiles | none | Not started | Everything |

**Automated assets.** [`npm run eval`](../tests/eval/run.ts) has 106 cases in 18 groups, with deterministic checks and
real model calls. [`npm run voice-lab`](VOICE_LAB.md) has 36 scenarios, real audio through the production path and a
simulated meeting platform, plus an optional model judge. `mission-chaos` and `provider-outage` cover restarts and
provider failure. CI runs `npm test`, the typecheck and a Docker build. It does **not** run the live-model eval, although
the work plan calls for that nightly and on relevant PRs.

**Deferred, and staying deferred.** The voice-engine work (phase 7) and video experiments are frozen until the value gate
passes. Gemini Live [failed gate A](GEMINI_SPIKE.md). Those tasks remain marked as deferred on the board.

**Real-meeting record.** Latest three scorecards: 6, 3 and 2 interruptions, all failed. Their pattern is specific:
starting over someone, talking on for up to 7.8 s after "stop", answering unaddressed speech, and answering half a
sentence. That is why turn-taking and listen-first come before any new capability.

### Why this order

- A new capability multiplies whatever the base experience is. If Nogita interrupts, a smarter Nogita interrupts more
  expensively.
- Written output is the main value in listen-first mode. On 1 November Roee did not see Nogita's chat messages, and
  Attendee does not report that failure. If chat does not arrive, the value test cannot pass, so P8-12 comes first.
- Profiles change what Nogita prepares, so they are worth testing once the recap is trusted.
- Screen reading adds cost, privacy risk and a new injection surface, so it needs the most supervision.

## 3. Rules that hold at every stage

**Actions**
- Meeting actions keep the current authorization, approval and write-intent rules. A proposed task opens only on an
  explicit "approve".
- A meeting profile, team memory, on-screen text and retrieved content can never grant a permission or approve a write.
- No autonomous merge or deployment, as the work plan already states.

**Privacy**
- Shared-screen frames are opt-in, session-scoped and memory-only on the Nogita server. Participants are told first.
- Vision calls happen on request or for a specific workflow, never continuously.
- No transcript archive by default. Full turn logs (`NOGITA_TURN_LOG=full`) are for consented test meetings only.
- Team memory stays within a workspace, opt-in and subject to retention limits.
- Sending frames to a model provider is a disclosure to that provider. It belongs in the participant notice and in the
  provider review that [SECURITY.md](SECURITY.md) already lists as a blocker.

**Two limits of "memory-only" that must be stated plainly**
- `npm run screen-spike -- collect` writes frames to the operator's disk under the git-ignored `.voice-lab/`. That is
  acceptable for a consented experiment. The frames should be deleted once the report is checked (**new**: record the
  deletion in the experiment notes).
- The rule covers Nogita's server, not the meeting vendor. The 6 November replay work downloaded recordings that Attendee
  keeps for bots, the code requests no change to that, and nothing calls Attendee's
  [`delete_data`](https://docs.attendee.dev/) endpoint. Whether those recordings include shared screens is unverified.
  **Resolve this before P8-13**, and review the existing `ATTENDEE_PRIVACY_REVIEWED` setting against the answer.

**Known blocker that affects the design.** A verified questioner may share a meeting with people who should not see the
answer ([SECURITY.md](SECURITY.md), audience-level authorization). Richer context makes this worse, so team memory and
screen-derived answers must not widen what the meeting can hear.

**Cost.** Screen analysis stays at or below $0.50 per hour. The existing per-session budget (`NOGITA_SESSION_BUDGET`)
remains in place for model calls.

## 4. Meeting understanding and useful context

### Profiles

A profile answers four questions: what to listen for, what evidence to gather, what to prepare, and when to speak. It
changes nothing about permissions.

| Profile | Listen for | Evidence to gather | Output | Speaking |
|---|---|---|---|---|
| **Stand-up** | Status, blockers, owners, dates | Board state, recent commits, last follow-up | Blockers and owners; change since last time | Only when named |
| **Planning** | Scope, estimates, commitments, dependencies | Backlog, open tasks, previous decisions | Commitments and numbered proposed tasks | Only when named |
| **Design review** | Options, constraints, open questions | Code and schema, on-screen context once allowed (P8-8) | 2 or 3 options with trade-offs and sources (P8-9) | One-sentence recommendation when named |
| **Incident / triage** | Symptoms, timeline, actions, owners | CI status, deployed SHA, recent changes | Timeline, actions and open unknowns, marking fact against guess | When named, and shortest of all |
| **Retrospective** | Themes, repeated problems, commitments | Recap archive, Jira, git (P8-11) | What was planned, closed, stuck and repeated | Only when named |
| **One-to-one** | Agreed actions only | Only what was explicitly requested | Private action list; no shared archive by default | Conversational; existing alone-with-Nogita behavior |
| **General** | Decisions, actions, open questions | On request | Standard recap | Only when named |
| **Uncertain** | Same as general | On request | Standard recap, noting the type was unclear | Only when named |

One-to-ones get stricter defaults than the rest because they may touch personal matters: nothing goes to shared memory or
a recap channel unless both people ask for it.

### Inference

1. **Signals, strongest first:** a person's correction; a hint given at join time (**new**, an optional field); the
   meeting title if one is ever supplied; early conversation. Calendar access remains postponed, as in the work plan.
2. **Decide late and cheaply.** Run on a bounded window of early transcript and re-check once as more arrives. Reuse the
   small model tier.
3. **Show uncertainty.** Below the confidence threshold the profile stays `uncertain`, which behaves like `general`. A
   wrong guess costs more than no guess.
4. **Let people correct it.** The recap states the type in one line, and "Nogita, this is a retro" or a chat reply changes
   it. Corrections become labeled test cases (section 6).
5. **Stay silent about it.** Announcing the type aloud would add the interruption the product is trying to remove.

**Proposed measurements, to be fixed before evaluation begins:** on a reviewed, labeled set, at least 85% correct when a
type is asserted, at most 25% `uncertain`, and zero change in permissions or write attempts compared with having no
profile.

### Team context

Useful context is small and specific: project vocabulary and misheard names, who owns which area, which repository and
board apply, decisions already made, recurring problems. Building on `MeetingRecord` means storing only an allowlist of
those fields, never a transcript.

Requirements before any of this ships:

| Requirement | Today | Needed |
|---|---|---|
| Workspace isolation | One deployment-wide directory; per-company cells have their own disk ([`cell.ts`](../src/control/cell.ts)) | A workspace key on every record, with a read check; cross-team access tests |
| Durability | Ephemeral on Render | P1-7 or another durable store. Slack and Jira can carry recaps and tasks, as P8-4 and P8-10 do, but not new learned facts |
| Consent | "Tell participants before turning it on" | A recorded team-level opt-in and a notice at join |
| Retention | `NOGITA_MEETING_MEMORY_DAYS`, default 90 | Same limit applied to learned facts, plus deletion on request |
| Transparency | None for learned facts | "What do you remember about X?" and "forget that", with the source of each fact |
| Trust | Retrieved text is marked untrusted | Memory is treated the same way: it informs answers but cannot instruct or approve |

## 5. Affordable screen understanding

### What exists

Attendee delivers one JPEG per second. The hub keeps a frame when its size differs by at least 3% from the last kept
frame, or every 30 seconds, up to 40 frames in memory.

Size comparison is cheap but blind: changing a word can keep the size, and noise can change it. At the simulated sizes the
stream is roughly 120 to 340 MB per hour, and the frame-size cap allows the buffer to reach 80 MB per session in the worst
case, so a byte limit is worth adding.

### Local change gate

No model is involved, and this extends what P8-8 already specifies.

1. **Decode and normalize.** Decode the JPEG and convert it to luminance at a fixed working size. The repository has no
   image decoder today, so this adds a dependency to review or a small decoder. OpenCV is not required.
2. **Cheap pass.** Divide the frame into tiles and compute a per-tile pixel difference. OpenCV's tutorial describes this
   family of pixel measures (PSNR) as easy and fast, but not always consistent with human perception.
3. **Structural pass.** Compute SSIM only on tiles that the cheap pass flagged. The same tutorial explains that SSIM's
   Gaussian blurring is costly compared with PSNR, which is why it is not the first pass. At one frame per second the
   budget is far looser than the tutorial's video case, but CPU per session must still be measured.
4. **Filter noise.** Compare against a noise floor measured on still screens, and require a change to persist across
   consecutive frames. This removes compression flicker and a moving cursor.
5. **Keep a keyframe** when enough tiles have changed and settled. Record which tiles changed, so a later crop knows where
   to look. During scrolling or video playback, hold until the screen settles and rate-limit.
6. **Keep a sparse fallback keyframe** on a timer, in case the gate misses a change.
7. **Bound the buffer** by both frame count and bytes, and wipe it at session end as today.

**Rule that limits the damage of a bad threshold:** when someone asks about the screen, use the most recent frame received
whether or not the gate kept it. The gate decides what history is retained, never what the current answer sees.

**Main technical risk:** downsampling hides small edits. A one-identifier change in 14 px code may vanish at a low working
size. Calibration must test exactly this, and the working size may need to stay well above a thumbnail.

### Calibration

Every threshold above is a value to measure, not to assume.

- Simulated frames lack Meet's compression, so they can test the code but cannot set thresholds.
- Calibration needs **unfiltered** consecutive frames from a consented Meet session (**new**: a capture option behind the
  existing flag, see stage 3). Finding 3 explains why the current capture is not enough.
- Label events in the capture: tab change, scroll, one-line edit, cursor only, presenter idle, video in the shared window.
- Replay the gate offline at several settings, and record kept frames per hour, missed changes and CPU per frame.

**Proposed measurements, to be fixed before calibration begins:** at least 95% of labeled meaningful changes retained
within 3 seconds (tab and scroll events must all be retained), no more than 5% of frames kept on a still screen, and no
measurable effect on voice latency in the same process.

### When a model sees a frame

Frames go to a model only when someone asks about the screen, or when a workflow needs it (for example, a design review
recap citing the shown schema). A static screen with nobody asking sends nothing.

| Step | Rule |
|---|---|
| 1. Select | Latest frame, plus up to two earlier changed frames, as P8-8 specifies |
| 2. Crop | Crop when a changed region clearly holds the subject. Keep enough context to read it, and send the whole frame when unsure |
| 3. Ask narrowly | Ask for the names or lines that the question needs, not a full transcription |
| 4. Low-cost model first | Haiku first. Move to a stronger model only if the first reply marks needed text `[unreadable]` or the workflow requires judgment |
| 5. Check the budget | Refuse and say so if the session would exceed the ceiling |
| 6. Treat as untrusted | Text on screen is data. An on-screen instruction cannot trigger a write |

**Cost.** From the [spike's simulated upper bounds](SCREEN_SPIKE.md), where each call transcribes a full screen with up to
1,000 output tokens:

| Frames allowed by $0.50 | Haiku 5.5 | Sonnet 5.5 |
|---|---|---|
| 720p | about 830 per hour ($0.0006 each) | about 41 per hour ($0.012 each) |
| 1080p | about 710 per hour ($0.0007 each) | about 35 per hour ($0.014 each) |

The rates in the spike match the current [pricing page](https://platform.claude.com/docs/en/about-claude/pricing). Two
consequences:

- **Output dominates the cost.** Using the [vision docs' token formula](https://platform.claude.com/docs/en/build-with-claude/vision),
  a 720p frame is about 1,200 input tokens, or $0.0024 on Sonnet, against up to $0.01 for 1,000 output tokens. Narrow
  questions therefore save more money than crops. Crops mainly help legibility and focus.
- **Sending every kept frame is the wrong design** even when affordable, because of privacy, not price. The ceiling is a
  backstop, not an allowance.

**Enforcement to build with P8-8:** count estimated vision spend per session, stop at the prorated ceiling with a small
burst allowance, log refusals without pixels, and report actual cost per hour on the scorecard.

**Separate unknown:** the [vendor's price](https://attendee.dev/pricing) is listed per bot hour, and that page does not say
whether video changes it. P8-13 must answer this, and also measure traffic to Render.

### Gate for going further

The existing gate is unchanged: **at least 90% of table and column names read correctly, and at most $0.50 per hour on
vision**, in a real meeting. To make the 90% repeatable (**proposed**), share a known source file and score the output
against the names in that file, instead of comparing by eye.

If legibility fails at 720p, try 1080p. If 1080p fails too, stop P8-8 and offer a text alternative, such as pasting a link
or a file path. Reading the actual code from the repository is often better than reading it off a screen.

## 6. Automated test and improvement loop

### One matrix across existing tools

The goal is one view of what is covered, not a new test framework.

| Dimension | Values | Covered today | Gap |
|---|---|---|---|
| Meeting type | The 8 profiles | Stand-up and team discussion in the voice lab | Design review, retro, planning, incident and one-to-one flows; profile inference |
| Language | English; Hebrew and mixed | English; some Hebrew in eval | Hebrew audio in the voice lab. Remains exploratory, as the plan does not promise full Hebrew |
| Noise | `quiet` through `street`, by SNR | Strong (voice lab) | Real Meet audio |
| Speakers | 1, 2, 3+, shared mic | Strong (voice lab) | Listeners who do not know the system |
| Interruption | Barge-in, backchannel, "stop", cut-off | Strong (voice lab) | Meet playback buffering |
| Screen | Schema, code, tabs, scrolling, idle, injected text | Two synthetic screens | Compressed fixtures; change-gate cases; reading accuracy |
| Provider failure | STT, TTS, model, board, vendor, chat | `provider-outage`, `mission-chaos` | Screen stream loss; silent chat failure |

**Run a selection, not the full product.** All combinations would be slow and costly. Proposed tiers:
1. **Every PR:** existing `npm test` and typecheck, plus deterministic change-gate fixtures.
2. **Nightly or on relevant PRs:** the live-model eval and a priority set of risky pairs, within a fixed budget. This
   closes the gap with the work plan.
3. **Before promotion:** the full selected set with repeats.
4. **Real meetings:** scorecards, which nothing above replaces.

### Inputs and grading

**Inputs** are synthetic or consented only. Redacted turn logs contain no words, so a real failure becomes a test case
through a written reconstruction or a consented transcript.

| What is being checked | How to grade |
|---|---|
| Unauthorized or duplicate writes, approval scope, stayed silent, tool used, cost | Deterministic code. **Any failure blocks** |
| Latency and interruption | Measured timings with confidence bounds, as the voice lab already does |
| Reading accuracy | Compared with known source text |
| Answer quality, recap usefulness, naturalness | Model judge with a written rubric, on a different model from the one being tested |
| Value | People: scorecards and listeners |

This follows [Anthropic's evaluation guidance](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests):
specific measurable criteria, cases that mirror real use including edge cases, the fastest reliable grading method, and
checking a model grader's reliability before scaling it. Therefore (**new**) sample judge scores against human labels
before they influence a decision. [OpenAI's evals guide](https://developers.openai.com/api/docs/guides/evals) describes the
same describe, run, analyze and iterate cycle against labeled data. It is cited for the method only, because that page says
the platform shuts down on 30 November 2026, and this roadmap depends on no vendor's eval product.

### From failure to improvement

```text
failure or correction -> reviewed regression case -> candidate change (offline)
  -> full replay against baseline -> human approval -> behind flag -> real meetings -> keep or roll back
```

1. **Intake.** Scorecard failures, chat corrections, profile corrections and missed screen reads each become a proposed
   case. A person confirms the expected outcome, so a model cannot define its own success. The work plan already requires
   this within a day of a live failure.
2. **Candidates.** A generator may propose prompt text, thresholds and rule or configuration values, each with its reason
   and the failures it targets.
3. **Out of bounds for generated changes:** authorization and approval rules, write gates, privacy and retention settings,
   budget ceilings, and the test cases and grading code that judge the candidate.
4. **Replay.** Run candidate and baseline on the same inputs, with repeats, because model output varies. Part of the suite
   stays held out from the generator, to catch changes that fit only the known failures.
5. **Decision.** A person reviews one packet: the diff, what improved, what got worse, cost, and the failures it targets.

### How a change earns promotion

Numeric margins are **proposed** and must be fixed before the comparison runs.

| Result | Condition |
|---|---|
| **Rejected at once** | Any unauthorized or duplicate write, any privacy or approval failure, any budget breach, or a previously passing locked regression case now failing |
| **Rejected** | The targeted failures do not improve; or held-out quality falls by more than 2 percentage points; or p90 response time rises by more than 10%; or cost per meeting rises by more than 10% without a person accepting that trade |
| **Inconclusive, no rollout** | The difference is within the noise of repeated runs |
| **Eligible** | Hard checks clean, targeted failures improve, held-out cases hold, cost within budget |
| **Rolled out** | Roee approves; ships behind a flag that is off by default; PR and CI as usual |
| **Kept** | Later real-meeting scorecards are no worse. Otherwise the flag goes off and the failure returns to intake |

Production behavior never rewrites itself. Team context learned at runtime (section 4) is data inside a workspace. It is
visible, deletable and unable to change prompts, rules or permissions.

## 7. Roadmap

Owners are Roee and Claude. Roee runs meetings and sets production configuration; Claude builds and analyzes. **New**
tasks reach the board through a separate PR, after Roee accepts this roadmap.

### Stage 0: make real meetings measurable (now)

| Task | Owner | Board |
|---|---|---|
| Decide turn-taking v2 or legacy. The data [recommends v2](TURN_TAKING_DECISION.md) | Roee | P5-9 |
| Set and confirm the phase 8 flags on Render: `NOGITA_LISTEN_FIRST`, `NOGITA_MEETING_RECAP`, `NOGITA_FOLLOW_UP`, `NOGITA_RECAP_CHANNEL` | Roee | part of P8-12 |
| Smoke check in Meet: chat messages visible, recap, "approve", follow-up, Slack recap when a meeting ends by itself | Roee | P8-12 |
| Count recap and decision corrections on the scorecard | Claude | **new** |
| Add recap, retro and design review cases to the live-model eval, so a weak recap is caught before it costs a meeting | Claude | **new** |

**Exit:** all smoke items pass in one real meeting. **If chat does not appear,** stop and fix it first, since it carries
most of the value in listen-first mode.

### Stage 1: pass the product-value gate

| Task | Owner | Board |
|---|---|---|
| Run real meetings with a scorecard for each | Roee | P8-5 |
| Turn each failure into a regression case and a fix | Claude | existing rule |

**Exit, unchanged:** five consecutive meetings with zero interruptions, zero corrections and at least ten minutes saved in
each. No new capability ships before this, as the work plan requires.

**Proposed rules for reading the gate, to be fixed before the first counted meeting:**
- Only real working meetings count. Scripted gate runs (P3-10, P4-9) are useful but do not count toward the five.
- If ten counted meetings pass without five in a row, stop and review the product idea, rather than continuing to tune.
- These meetings also count toward the larger P5-8 sample.

### Stage 2: meeting profiles and workspace context

| Task | Owner | Board | When |
|---|---|---|---|
| Build a labeled set from synthetic and consented transcripts | Claude, Roee reviews | **new** | Can start during stage 1: measurement only |
| Profile inference in shadow mode: logged, changes nothing | Claude | **new** | Can start during stage 1 |
| Decide durable storage for team context | Roee | P1-7 or **new** | Before workspace memory |
| Profiles drive evidence and output, behind a flag, with correction | Claude | **new** | After stage 1 |
| Workspace-scoped memory with consent, deletion and "what do you remember?" | Claude | **new** | After the storage decision |

**Exit:** the proposed profile targets from section 4 are met, cross-workspace tests show no leakage, and the value gate
still holds in three further real meetings (**proposed**) with profiles on. Profiles must show a benefit in the recap. If
people do not prefer the result, remove them.

### Stage 3: screen reading in a real meeting

| Task | Owner | Board |
|---|---|---|
| Resolve whether Attendee retains shared-screen video, and how to remove it | Roee, Claude helps | **new**, before P8-13 |
| Add unfiltered capture for calibration, behind `NOGITA_SCREEN_CAPTURE` | Claude | **new** |
| Run the 10-minute experiment with participants' consent, on a known source file; delete local frames afterward | Roee | P8-13 |
| Score reading accuracy, cost, traffic and vendor billing | Claude | part of P8-13 |
| Build and calibrate the local change gate offline | Claude | part of P8-8 |
| Conversation about the screen, with budget enforcement and injection tests | Claude | P8-8 |

**Exit:** at least 90% of table and column names read correctly and at most $0.50 per hour, in a real meeting; proposed
gate targets from section 5 met; a static screen sends nothing to any model; on-screen instructions trigger nothing.

**Note on order.** P8-13 is marked ready on the board and is a measurement, so a suitable meeting may run it early, once
the retention question and calibration capture are done. Building P8-8 still waits for the stage 1 gate.

### Stage 4: scenario matrix and controlled improvement

| Task | Owner | Board |
|---|---|---|
| Publish the matrix as a coverage report over the existing tools | Claude | **new** |
| Add missing scenarios: planning, incident, one-to-one, design review and retro by voice, screen fixtures, chat failure | Claude | **new** |
| Run the live-model eval on a schedule with a fixed budget | Claude; Roee provides the CI secret and budget | **new** |
| Check the model judge against human labels | Claude, Roee labels | **new** |
| Offline candidate generation, with held-out cases and a decision packet | Claude | **new** |

Failure intake does not wait for this stage. It already applies today. The candidate generator comes last because it is
only as trustworthy as the cases and grading around it.

**Exit:** one candidate has gone through the whole path and been accepted or rejected on evidence, and a deliberately bad
candidate (an unauthorized write) is rejected automatically.

### Stage 5: wider meeting types and pilot

After the stages above, return to the pilot path: P5-8 (30 meetings and 500 turns, including people new to the system) and
the outside-team gate. Add a new meeting type only when real demand exists, it has its own profile and cases, and it passes
the same gates. Sales or customer meetings would need new integrations and a fresh consent review, since the current tools
center on GitHub and Jira.

## 8. Decisions needed from Roee

1. **Accept or change this order.** Everything marked **new** waits on this.
2. **Turn-taking (P5-9):** the first real scored meetings should not start until this is decided.
3. **Storage for team context:** a persistent disk (P1-7) or another store.
4. **Attendee retention:** what may remain with the vendor, and for how long.
5. **Proposed numbers:** confirm or replace them before each measurement starts.

## 9. Main risks

| Risk | Response |
|---|---|
| The gate is never reached | The proposed stop rule forces a product review instead of endless tuning |
| Too few real meetings | Already a known need in the work plan: recruit people from outside. Replay helps but cannot test Meet chat, echo or screen reading |
| Silent chat failure | Stage 0 tests it. Add a visible check, such as confirming with the owner at join |
| Offline scores improve but meetings do not | Real scorecards decide; offline results alone never count as proof |
| Overfitting to the test set | Held-out cases, and generated changes cannot edit tests or grading |
| Context leaks between teams or to the wrong audience | Workspace key, access tests, and answers limited by the existing audience rules |
| Prompt injection through screens or memory | Treated as untrusted data; regression tests; writes stay behind approval |
| Vision cost grows quietly | Enforced ceiling, on-request calls, spend on the scorecard |

## 10. Sources

**Project:** [WORK_PLAN.md](WORK_PLAN.md), [TASK_BOARD.md](TASK_BOARD.md), [VOICE_LAB.md](VOICE_LAB.md),
[SCREEN_SPIKE.md](SCREEN_SPIKE.md), [scorecards](scorecards/README.md), [SECURITY.md](SECURITY.md),
[TURN_TAKING_DECISION.md](TURN_TAKING_DECISION.md), [GEMINI_SPIKE.md](GEMINI_SPIKE.md),
[MEETING_READINESS.md](MEETING_READINESS.md).

**Code:** [`screen-capture.ts`](../src/app/screen-capture.ts), [`screen-spike`](../tools/screen-spike/run.ts),
[`meeting-memory.ts`](../src/app/meeting-memory.ts), [`session-usage.ts`](../src/app/session-usage.ts),
[`attendee.ts`](../src/adapters/attendee.ts), [`scorecard`](../tools/scorecard/score.ts),
[eval cases](../tests/eval/cases.ts), [voice-lab scenarios](../tools/voice-lab/scenarios.ts).

**External, read on 2026-11-07:**
- [OpenCV: video input, PSNR and SSIM](https://docs.opencv.org/4.13.0/d5/dc4/tutorial_video_input_psnr_ssim.html). The site
  refused automated fetching, so the content was checked against the
  [same tutorial's source in the OpenCV repository](https://github.com/opencv/opencv/blob/4.x/doc/tutorials/app/video_input_psnr_ssim.markdown).
- [Anthropic: define tests and evaluate](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests).
- [OpenAI: evals guide](https://developers.openai.com/api/docs/guides/evals), including its deprecation notice.
- [Claude vision](https://platform.claude.com/docs/en/build-with-claude/vision) and
  [pricing](https://platform.claude.com/docs/en/about-claude/pricing).
- [Attendee docs](https://docs.attendee.dev/) and [pricing](https://attendee.dev/pricing). The realtime video page could not
  be located, so frame rate and settings come from the project's [spike notes](SCREEN_SPIKE.md) and code.
