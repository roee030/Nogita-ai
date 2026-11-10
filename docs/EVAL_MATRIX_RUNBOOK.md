# Eval matrix runbook (P9-15, partial)

What the offline work covers, and what still needs Roee: live checks, human labels, consent, or budget. Nothing here
changes production, a flag or a release gate. No score below is release evidence until a person has reviewed the
expected labels.

## What runs offline today (free, no network)

| Command | What it does |
|---|---|
| `npm test` | Includes `tests/eval-matrix.test.ts`: the cases are consistent, a perfect output scores right on every layer, each kind of error is caught on its own layer, the five new voice-lab scenarios are scoreable, and the generated docs are up to date |
| `npm run eval-matrix -- coverage` | Rewrites `docs/EVAL_COVERAGE.md`. Each cell is count/total of its source |
| `npm run eval-matrix -- review` | Rewrites `docs/EVAL_MATRIX_REVIEW.md`, the line-by-line review sheet |
| `npm run eval-matrix -- score --case <id> --file out.json` | Scores one system output against a case, layer by layer, with numerator/denominator. Only an unapproved write blocks |
| `npm run eval-matrix -- agreement --file ratings.json` | Judge vs human: exact agreement, Cohen's kappa, within one point, disagreements |
| `npm run voice-lab -- --list` | Lists the voice-lab scenarios. The five new ones are marked "only with --scenario" |

**Cases (all invented, none from a recording):** `daily-drift-he`, `approve-one-of-three`, `planning-he`, `one-to-one-he`,
`design-review-he`, `incident-he`, `retro-he`, in `tools/eval-matrix/cases.ts`. Voice-lab scenarios: `planning-sprint`,
`incident-live`, `one-to-one-checkin`, `design-review-options`, `retro-backchannel`, in `tools/voice-lab/scenarios.ts`
(`MEETING_TYPE_SCENARIOS`).

**Voice-lab language limitation:** the lab speaks with English Deepgram voices, so the five scenarios are English.
Hebrew and Hebrew with English terms exist only at transcript level. Hebrew audio through the voice path is a gap.

## What needs Roee

### 1. Human review (no cost)
- [ ] **The review sheet**, `docs/EVAL_MATRIX_REVIEW.md`: fill in the OK? column for each line, topic, link and action. The checklist is at the top of the sheet.
- [ ] **The two lines marked uncertain:**
  - `d05` "if nobody objects, we go with it" and nobody answers. Is that a decision, or still open?
  - `i09` "I can, if needed". Is that an owner, or only an offer?
- [ ] **The three meeting-type texts** rewritten in P9-6 (#6, #12, #25 in `docs/MEETING_PROFILE_REVIEW.md`).
- [ ] **P9-18:** label a sample by hand, to check the judge's reliability (`agreement.ts` is ready for the labels).

### 2. Decisions
- [ ] **One-to-one recaps:** should a one-to-one recap go to the team's Slack recap channel at all? Today the channel doesn't distinguish meeting types.
- [ ] **A spoken name:** may a name said aloud ("Avi, are you on it?") ever become the owner's name in a recap, or does it always stay a voice label until the call verifies it? The cases assume it stays a voice label.
- [ ] **Release thresholds:** none are set. You said to revisit them after there is a human-reviewed set covering Hebrew, topic drift and cross-talk. This set is the start of that.

### 3. Budget
- [ ] **A paid voice-lab run of the five new scenarios:** needs Deepgram (TTS and STT) and Anthropic, with the keys in `.env`. Run one scenario first. I haven't estimated the cost: no run has measured it.
  ```bash
  npm run voice-lab -- --scenario planning-sprint
  ```
  Then the rest:
  ```bash
  npm run voice-lab -- --scenario incident-live,one-to-one-checkin,design-review-options,retro-backchannel
  ```
  Until that run, the coverage report keeps these scenarios in "never run", and they don't count toward coverage.
- [ ] **P9-16:** a budget and a CI secret for a scheduled live-model eval (then P9-17).

### 4. Consent
- [ ] **Real transcripts or recordings:** none may enter a test set without consent and a retention decision. The two MP3s in the working folder weren't used and aren't committed.
- [ ] **A consented local set** for meeting types (`npm run meeting-profile -- --file x.json`, never committed) would test real early-meeting talk far better than invented cases.

### 5. Live checks (block the rest of P9-15)
- [ ] **P8-12**, the smoke test in Meet: tells us what a silent chat failure looks like, so it can be simulated.
- [ ] **P8-13**, screen reading in a real meeting: unblocks screen fixtures and the change gate (P9-14).
- [ ] **P9-4 → P8-5 → P9-9:** meeting types in real meetings. This closes the matrix's last blocked row.

## What closes P9-15
P9-15 leaves draft only after:
1. The rows waiting on P8-13 and P9-9 are filled.
2. A person has reviewed the expected labels.
3. The new voice-lab scenarios have run at least once, with a budget you approve.
