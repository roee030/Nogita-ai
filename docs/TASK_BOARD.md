# לוח משימות: Claude ו-Codex

הקובץ הזה אומר **מה** המשימות: מי אחראי, אילו קבצים, ומה תלוי במה. **איפה כל משימה עומדת** נקבע ב-GitHub, לא כאן:

| ב-GitHub | הסטטוס |
|---|---|
| PR של המשימה מוזג | בוצע |
| draft PR פתוח | בעבודה (תפוס) |
| PR פתוח ומוכן | מחכה למיזוג של רועי |
| אין PR, וכל התלויות בוצעו | אפשר להתחיל |
| אין PR, ויש תלות שלא בוצעה | ממתין |

`npm run board -- --agent claude` (או `codex`) מחשב את כל זה ומדפיס מה הסוכן עושה עכשיו. אף אחד לא צריך לזכור לעדכן סטטוס, ולכן אין סטטוס בקובץ. התוכנית ולמה נמצאות ב-[WORK_PLAN.md](WORK_PLAN.md).

## טייס אוטומטי: מה סוכן עושה כשאומרים לו "תמשיך"

1. `git fetch origin`, ואז `npm run board -- --agent <claude|codex>`.
2. **"Fix first"**: אם ל-PR שלך יש CI אדום, conflict עם `main` או בקשת שינויים, מתקנים אותו ב-branch שלו לפני כל דבר אחר.
3. **"Next"**:
   - **Continue**: עוברים ל-branch של המשימה הפתוחה וממשיכים.
   - **Start**: פותחים branch חדש מ-`origin/main` ומיד פותחים draft PR. זו הנעילה:
     ```
     git switch -c <agent>/<ID>-<slug> origin/main
     git commit --allow-empty -m "<ID>: start"
     git push -u origin HEAD
     gh pr create --draft --title "<ID>: <מה המשימה>" --body "Board task <ID>."
     ```
4. בסוף משימה:
   - `npm test` ו-`npm run typecheck` עוברים.
   - בתיאור ה-PR כותבים סעיף **Handoff**: מה השתנה, מה הסוכן השני צריך לדעת, ומה לא נבדק.
   - `gh pr ready`.
5. **משימה אחת לכל צ'אט.** אחרי `gh pr ready` עוצרים. בסוף התשובה כותבים: הלינק ל-PR למיזוג, שורה אחת על מה הוא עושה, ומה הלוח מראה כמשימה הבאה (או שהיא מחכה למיזוג). רועי ממזג ופותח צ'אט חדש עם "תמשיך". תיקונים משלב 2 לא נחשבים משימה: מתקנים וממשיכים ל-"Next". אם הלוח אומר "Nothing to start", עוצרים ומדווחים מה מחכה לרועי ("Waiting on Roee"), עם לינקים.
   **כשסוכן עובד לבד (מצב שרשרת, `--chain`):** כרגע Codex מושהה, ו-Claude רץ עם `npm run board -- --agent claude --chain`. במצב הזה לא עוצרים אחרי משימה. אחרי `gh pr ready` חוזרים לשלב 1 וממשיכים עד שהלוח אומר "Nothing to start". PR של הסוכן שמחכה למיזוג נחשב גמור בשביל המשימות שתלויות בו. המשימה הבאה נפתחת מ-`origin/main`, ואחר כך ממזגים לתוכה את ה-branches שהלוח מציין תחת "Builds on", וכותבים ב-PR על מה הוא בנוי. בסוף מדווחים ל-רועי את כל ה-PRs לפי סדר המיזוג, שורה לכל אחד, ומה מחכה לו.

## חוקים

1. **עובדים רק על משימה מהלוח שרשומה על שמך.** משימות חדשות נכנסות ללוח ב-PR. כשהלוח עומד להיגמר, Claude מוסיף את השלב הבא מתוך `WORK_PLAN.md`.
2. **צ'אט אחד לכל סוכן בכל רגע, ותיקייה משלו:** Claude ב-`D:\Nogita-ai`, ו-Codex ב-`D:\Nogita-ai-codex`. מחליפים branch רק כשהתיקייה נקייה, אחרי commit.
3. **אף פעם לא commit ל-`main`, ואף פעם לא מיזוג.** רועי ממזג.
4. **קבצים.** משימה ש"מוכנה" אבל חולקת קובץ עם PR פתוח מופיעה כ-"Held back", והלוח מציע את המשימה הבאה. צריך לגעת בקובץ שלא רשום במשימה? כותבים את זה בתיאור ה-PR. אם הקובץ שייך ל-PR פתוח של הסוכן השני, עוצרים ושואלים את רועי.
5. **שינוי התנהגות נכנס מאחורי flag כבוי**, לפי הנוהג בריפו.
6. **הלוח עצמו** משתנה רק כשמוסיפים או משנים משימות, לא בשביל סטטוס. ככה PRs של משימות לא מתנגשים עליו.

## תחומים

| | Claude | Codex |
|---|---|---|
| תחום | יכולות ה-agent: לולאה, כלים, מחקר, batch, Completion Gate, סט ההערכה, תכנון הלוח | שיחה חיה וקול, תשתית, traces, readiness, voice lab |
| קבצים עיקריים | `src/core/agent*.ts`, `src/core/agent-tools.ts`, `src/adapters/github.ts`, `src/adapters/jira.ts`, `tests/eval/` | `src/core/speech-*.ts`, `src/app/attendee-*.ts`, `src/app/turn-log.ts`, `src/app/readiness.ts`, `tools/voice-lab/`, `docs/MEETING_READINESS.md` |

## משימות

הטבלה נקראת על ידי `tools/board.ts`: בעמודת הקבצים רק נתיבים בתוך backticks נספרים, ובעמודת התלויות רק IDs. את `[x]` מסמן רועי ביד, רק למשימות שנעשו בלי PR, כמו המשימות שלו. `[-]` אומר שרועי דחה את המשימה: היא וכל מה שתלוי בה מסומנים "deferred", ולא מופיעים כמשהו שמחכה לו. כשהוא חוזר אליה, מחזירים ל-`[ ]`.

### שלב 1, שבוע 1

| | ID | משימה | באחריות | קבצים | תלוי ב |
|---|---|---|---|---|---|
| [ ] | P1-0 | תוכנית העבודה ולוח המשימות | Claude | `docs/WORK_PLAN.md`, `AGENTS.md`, `CLAUDE.md` | - |
| [ ] | P1-1 | לא לזרוק קריאות כלי שנקטעו ב-`max_tokens`; להגדיל את התקרה לצעדים עם כלים; להחזיר את סיבת העצירה של כל צעד ב-`AgentResult` | Claude | `src/core/agent.ts`, `src/core/engine.ts`, `tests/agent.test.ts` | - |
| [ ] | P1-2 | `repo_activity` ו-`get_change`; היסטוריה מה-branch החי; אזור הזמן של הצוות ב-prompt של כל תורה | Claude | `src/adapters/github.ts`, `src/core/contracts.ts`, `src/core/agent-tools.ts`, `src/core/agent-prompt.ts`, `tests/repo-activity.test.ts` | P1-1 |
| [ ] | P1-3 | סט הערכה: 15 מקרים ראשונים, כולל שני הכשלים החיים, וסקריפט `npm run eval` | Claude | `tests/eval/`, `package.json` | P1-2, P1-9 |
| [ ] | P1-4 | `/version` שמחזיר את ה-SHA של הפריסה (ב-Render: `RENDER_GIT_COMMIT`) | Codex | `src/app/server.ts`, `tests/server-version.test.ts` | - |
| [ ] | P1-5 | trace לכל תורה: כלים, קלטים מקוצרים, סיבות עצירה (`AgentResult.stops`), קיטועים, צעדים, זמן לכל צעד ומודל, בלי טקסט תמלול | Codex | `src/app/turn-log.ts`, `tools/turn-report.ts`, `tests/turn-trace.test.ts` | P1-1 |
| [ ] | P1-6 | עדכון `MEETING_READINESS.md` לפי הפגישה של 31.10 | Codex | `docs/MEETING_READINESS.md` | - |
| [-] | P1-7 | דיסק קבוע ב-Render, ו-readiness ירוק בלי עקיפות | רועי | (הגדרות Render) | - |
| [-] | P1-8 | פגישה חיה #2 עם תסריט קבוע: שני הכשלים וששת הממצאים | רועי | | P1-1, P1-2 |
| [ ] | P1-9 | טייס אוטומטי: `npm run board` מחשב סטטוס מ-GitHub, והלוח בלי סטטוסים ידניים | Claude | `tools/board.ts`, `tests/board.test.ts`, `docs/TASK_BOARD.md`, `package.json` | - |
| [ ] | P1-10 | משימה אחת לכל צ'אט: הסוכן עוצר אחרי PR מוכן ומחזיר לינק למיזוג | Claude | `AGENTS.md`, `CLAUDE.md`, `docs/TASK_BOARD.md` | - |

### שלב 2, שבועות 2–3: אמינות הבקשה

**שער:** "פתחי חמש משימות" יוצרת בדיוק חמש, או מסבירה בדיוק מה חסר, ב-10 מתוך 10 ניסיונות. אין כפילויות.

| | ID | משימה | באחריות | קבצים | תלוי ב |
|---|---|---|---|---|---|
| [ ] | P2-0 | שלב 2 בלוח המשימות | Claude | `docs/TASK_BOARD.md` | - |
| [ ] | P2-1 | `create_tasks` ו-`update_tasks`: מערך של עד 10 פריטים, בדיקת הרשאה אחת, מפתח idempotency לכל פריט, כתיבות אחת אחרי השנייה, וקבלה אחת בצ'אט | Claude | `src/core/agent-tools.ts`, `tests/batch-tasks.test.ts` | - |
| [ ] | P2-2 | idempotency ששורד retry ו-restart: פעולה שהצליחה לא רצה שוב (היום `completed` ב-`engine.ts` חי רק בזיכרון) | Claude | `src/core/engine.ts`, `src/app/action-receipts.ts`, `tests/idempotency.test.ts` | P2-1 |
| [ ] | P2-3 | Completion Gate: בסוף התורה משווים את הפעולות שהתבקשו לתוצאות הכלים, בלי קריאת מודל נוספת; תורה שחסרה בה פעולה לא מסומנת כהצלחה | Claude | `src/core/agent.ts`, `src/core/completion-gate.ts`, `tests/completion-gate.test.ts` | P2-1 |
| [ ] | P2-4 | הצלחה חלקית ותשובה כנה: "פתחתי שתיים משלוש, השלישית לא נפתחה כי...", וכשתורה נקטעת (deadline, תקרת צעדים, כלי שנכשל) אומרים מה חסר ומציעים להמשיך | Claude | `src/core/agent.ts`, `src/core/agent-prompt.ts`, `tests/partial-success.test.ts` | P2-3 |
| [ ] | P2-5 | סט ההערכה מגיע ל-40 מקרים, כולל בקשות של 2 עד 10 פעולות, בקשה עם בעלים שלא קיים, ובקשה שחוזרת אחרי retry | Claude | `tests/eval/` | - |
| [ ] | P2-6 | מדידה בצד המאזין: הקלטה ממשתתף שני ב-Meet, זמן משאלה עד צליל ומ-"wait" עד שקט, ודוח שאפשר להשוות בין פגישות | Codex | `tools/listener-probe/`, `tests/listener-probe.test.ts` | - |
| [ ] | P2-7 | תיקון "wait" ועצירה כשמישהו מתחיל לדבר, לפי מה שפגישה #2 והמדידה בצד המאזין חשפו | Claude | `src/core/speech-floor.ts`, `src/core/speech-guard.ts`, `src/app/attendee-realtime-audio.ts` | P1-8, P2-6 |
| [ ] | P2-8 | פגישה חיה #3 עם תסריט השער: "פתחי חמש משימות" 10 פעמים, בעלים שלא קיים, ו-"wait" באמצע תשובה | רועי | | P2-2, P2-4, P2-7 |
| [ ] | P2-9 | הלוח נקרא מ-`origin/main` ולא מהעותק המקומי; סטטוס `[-]` למשימה שרועי דחה, שמעכב גם את מה שתלוי בה; משימות ל-Codex בזמן שהפגישה והדיסק נדחו | Claude | `tools/board.ts`, `tests/board.test.ts`, `docs/TASK_BOARD.md` | - |
| [ ] | P2-10 | readiness שבודק יכולת אמיתית ולא רק שקיים מפתח: קריאה קלה לכל ספק (GitHub, Jira, Slack, Anthropic, Deepgram, Attendee) עם זמן תגובה, ותוצאה ברורה לכל אחד | Codex | `src/app/readiness.ts`, `src/app/connection-probes.ts`, `tests/readiness.test.ts`, `tests/connection-probes.test.ts` | - |
| [ ] | P2-11 | תרחישי voice lab לכמה דוברים: שתי שאלות ברצף מאנשים שונים, שיחה בין שני אנשים אחרים, ו"לא, התכוונתי ל..."; הדוח סופר שאלות שאבדו ותשובות לשיחה שלא הייתה שלה | Codex | `tools/voice-lab/scenarios.ts`, `tools/voice-lab/score.ts`, `tools/voice-lab/report.ts`, `tests/voice-lab.test.ts` | - |
| [ ] | P2-12 | תקציב לכל פגישה: תקרת קריאות מודל ועלות לשעת פגישה, אזהרה ב-log כשמתקרבים, ועצירה מסודרת של עבודת רקע כשעוברים; flag כבוי | Codex | `src/app/session-usage.ts`, `tests/session-usage.test.ts` | - |

### שלב 3, שבועות 4–5: מנוע מחקר

**שער:** דוח מלא ומבוסס מקורות על פעילות של יום ושל שבוע, תוך 60 שניות. לפחות 90% מהטענות מגובות במקור.

| | ID | משימה | באחריות | קבצים | תלוי ב |
|---|---|---|---|---|---|
| [ ] | P3-0 | שלב 3 בלוח המשימות | Claude | `docs/TASK_BOARD.md` | - |
| [ ] | P3-1 | `ci_status`: ריצות ה-CI האחרונות ל-branch, SHA או PR (סטטוס, ה-job שנכשל, קישור), וה-SHA שרץ בפריסה; flag כבוי | Claude | `src/adapters/github.ts`, `src/core/contracts.ts`, `src/core/agent-tools.ts`, `tests/ci-status.test.ts` | - |
| [ ] | P3-2 | תקציר מובנה של תוצאה גדולה במקום חיתוך ב-14,000 תווים: ספירות, קבוצות ופריטים מובילים, והמודל מבקש את ההמשך אם צריך; flag כבוי | Claude | `src/core/agent.ts`, `src/core/result-digest.ts`, `tests/result-digest.test.ts` | - |
| [ ] | P3-3 | Evidence Ledger: כל תוצאת כלי נרשמת כמקור (commit, קובץ ושורות, ריצת CI, Jira issue, הודעת Slack), התשובה בצ'אט מקשרת למקורות, וה-ledger חוזר ב-`AgentResult` | Claude | `src/core/agent.ts`, `src/core/evidence.ts`, `tests/evidence.test.ts` | P3-2 |
| [ ] | P3-4 | רמות הוכחה בצ'אט: כתוב בתוכנית, קיים בקוד, עבר בדיקה, עבר voice lab, נוסה בפגישה, פועל בייצור; "עובד בייצור" רק עם ראיה, ולא נאמר בקול | Claude | `src/core/evidence.ts`, `src/core/agent-prompt.ts`, `tests/proof-levels.test.ts` | P3-3 |
| [ ] | P3-5 | תבניות מחקר לשאלות שחוזרות: מה השתנה היום או השבוע, מצב של feature, למה תקלה קרתה, משימות פתוחות בנושא, ההבדל בין שתי גרסאות; כולל שאלות שחוצות GitHub, Jira ו-Slack | Claude | `src/core/research-templates.ts`, `src/core/agent-prompt.ts`, `tests/research-templates.test.ts` | P3-4 |
| [ ] | P3-6 | סט ההערכה מגיע ל-70 מקרים: שאלות מחקר, שאלות שחוצות שלושה מקורות, סטטוס CI; הציון בודק שלכל טענה יש מקור ב-ledger | Claude | `tests/eval/` | P3-1, P3-3 |
| [ ] | P3-7 | רענון אינדקס הקוד: webhook של push מ-GitHub מרענן את ה-snapshot מיד, ו-readiness מראה את ה-SHA של האינדקס מול ה-head של ה-branch | Codex | `src/app/server.ts`, `src/app/github-webhook.ts`, `src/adapters/github.ts`, `tests/github-webhook.test.ts` | P3-1 |
| [ ] | P3-8 | מדידת שער המחקר: "מה נכנס היום" ו-"מה נכנס השבוע" דרך לולאת ה-agent מול ריפו אמיתי, זמן עד תשובה מלאה, ובדיקה שכל commit ו-PR מ-`git log` של התקופה מופיע | Codex | `tools/research-bench/`, `tests/research-bench.test.ts`, `package.json` | - |
| [ ] | P3-9 | trace למחקר: מקורות לכל תשובה, אילו תוצאות קוצרו וכמה פריטים נשארו בחוץ, ו-`turn-report` מראה כמה מהטענות מגובות במקור | Codex | `src/app/turn-log.ts`, `tools/turn-report.ts`, `tests/turn-trace.test.ts` | P3-3 |
| [ ] | P3-10 | פגישה חיה #4 עם תסריט שער המחקר: "מה נכנס היום", "מה נכנס השבוע", "ה-CI על main עבר?", ושאלה שחוצה Jira ו-Slack | רועי | | P3-5, P3-8, P3-16 |
| [ ] | P3-11 | voice lab לחדר ישיבות: כמה אנשים על מיקרופון אחד, אנשים שנקטעים באמצע מילה, דיבור אחד על השני (גם על אותו מיקרופון), ועצירות ארוכות באמצע שאלה | Claude | `tools/voice-lab/`, `tests/voice-lab.test.ts`, `docs/VOICE_LAB.md` | - |
| [ ] | P3-12 | לא לדבר על אנשים: כשמשתתף אחר מדבר, כל תשובה (גם שאלת הבהרה על קטע שנקטע) מחכה שהוא יסיים; קטע שמישהו קטע לא מקבל הבהרה בקול בזמן שהשני מדבר; flag כבוי; השער: `cut-off` ו-`meeting-room` ב-voice lab בלי "spoke over someone" | Codex | `src/core/speech-floor.ts`, `src/app/attendee-command-router.ts`, `tests/speech-floor.test.ts`, `tests/attendee-command-router.test.ts` | P3-11 |
| [ ] | P3-16 | לחבר את שלב 3 למנוע: `ci_status`, תקציר תוצאות, Evidence Ledger, רמות הוכחה ותבניות מחקר מגיעים מ-env (`NOGITA_CI_STATUS`, `NOGITA_RESULT_DIGEST`, `NOGITA_EVIDENCE_LEDGER`, `NOGITA_PROOF_LEVELS`, `NOGITA_RESEARCH_TEMPLATES`) דרך config ו-engine לכל תורה, בצ'אט ובקול; `npm run eval` ו-voice lab מדליקים אותם עם דגל; כבויים כברירת מחדל; השער: 8 מקרי ה-CI ב-eval עוברים | Claude | `src/app/config.ts`, `src/core/engine.ts`, `src/app/server.ts`, `.env.example`, `tests/research-wiring.test.ts` | - |
| [ ] | P3-13 | לא לענות לרעש ולשיחות צד: תמלול מקוטע או מעורבב (דיבור רקע, שני קולות על מיקרופון אחד) בלי פנייה אליה לא מקבל תשובה בקול, וחלון ה-follow-up לא תופס שאלה שאדם בחדר שאל אדם אחר; flag כבוי; השער: תורות ה-silent ב-`meeting-room` ו-`room-crosstalk` עוברות | Claude | `src/core/policy.ts`, `src/core/speech-guard.ts`, `tests/addressing.test.ts`, `tests/speech-guard.test.ts` | P3-11 |
| [ ] | P3-14 | שאלה שנבלעה חוזרת מהר: כשנשמע השם שלה אבל השאלה מקוטעת או אבדה בדיבור חופף, היא שואלת קצר תוך כמה שניות ("מישהו שאל אותי משהו?") ולא נזכרת 25 שניות אחר כך; flag כבוי; השער: `room-crosstalk` ו-`meeting-room` בלי שאלה שנענתה אחרי שהנושא נסגר | Claude | `src/core/engine.ts`, `tests/engine.test.ts` | P3-13 |
| [ ] | P3-15 | תיקון ניקוד ב-voice lab: תמלול שמגיע אחרי שהדובר הבא התחיל משויך לתור של מי שאמר אותו, ולא נכשל ב-"no transcript" | Codex | `tools/voice-lab/conversation.ts`, `tests/voice-lab.test.ts` | P3-11 |

### שלב 4, שבועות 6–7: עבודה ברקע והמשכיות

**שער:** משימה מורכבת נמשכת כמה דקות או עוברת ערוץ בלי לאבד מצב. "מה נשאר מהבקשה הקודמת?" מקבלת תשובה מדויקת.

| | ID | משימה | באחריות | קבצים | תלוי ב |
|---|---|---|---|---|---|
| [ ] | P4-0 | שלב 4 בלוח המשימות, ומשימת החיבור P3-16 | Claude | `docs/TASK_BOARD.md` | - |
| [ ] | P4-1 | ניתוב מודלים: שאלת מחקר או בקשה של כמה פעולות עוברת למודל חזק (Sonnet), תשובה קולית מהירה נשארת ב-Haiku; הבחירה לפי צעד, בתוך תקציב הפגישה, וה-trace מראה איזה מודל ולמה; flag כבוי | Codex | `src/adapters/anthropic.ts`, `src/app/connection-probes.ts`, `tests/model-routing.test.ts` | - |
| [ ] | P4-2 | תשובה בשתי מהירויות: בקול, שאלה שצריכה מחקר מקבלת מיד תשובה קצרה ("בודקת את ה-commits של היום"), ממשיכה כ-mission ברקע, והתשובה המלאה נאמרת כשהחדר שקט או נשלחת לצ'אט; flag כבוי | Claude | `src/core/engine.ts`, `src/core/missions.ts`, `tests/two-speed.test.ts` | P3-16 |
| [ ] | P4-3 | resume אחרי restart: missions פתוחות נשמרות ב-state dir, ובעלייה הן ממשיכות או מדווחות בצ'אט מה אבד; בלי דיסק קבוע זה עובד מקומית ובדיקה מראה את זה | Codex | `src/app/mission-store.ts`, `src/app/state-storage.ts`, `tests/mission-store.test.ts` | - |
| [ ] | P4-4 | "מה נשאר מהבקשה הקודמת?": כלי `mission_status` שעונה מה-mission store, מה בוצע, מה נכשל ומה עוד רץ, עם מקורות מה-ledger | Claude | `src/core/agent-tools.ts`, `src/core/missions.ts`, `tests/mission-status.test.ts` | P4-2 |
| [ ] | P4-5 | מעבר מפגישה ל-Slack: mission שהתחילה בפגישה ממשיכה ב-thread של Slack, התוצאה נשלחת לשם, ותגובה ב-thread מגיעה לאותה mission | Codex | `src/app/slack-conversations.ts`, `src/app/slack-socket-events.ts`, `tests/slack-handoff.test.ts` | P4-3 |
| [ ] | P4-6 | בדיקת כאוס ל-missions: הורגים את התהליך באמצע mission עם כתיבות, מעלים מחדש, ובודקים אפס כתיבות כפולות ואפס פעולות שאבדו בלי דיווח | Claude | `tools/mission-chaos/`, `tests/mission-chaos.test.ts` | P4-2, P4-3 |
| [ ] | P4-7 | סט ההערכה מגיע ל-80 מקרים: mission ארוכה, "מה נשאר", מעבר ערוץ, שאלה אחרי restart; כולל הרצה עם ניתוב מודלים מול בלי | Claude | `tests/eval/` | P4-1, P4-4, P4-5 |
| [ ] | P4-8 | תרחישי voice lab לשתי מהירויות: זמן עד התשובה הקצרה, זמן עד התשובה המלאה, ותשובה מלאה שלא נאמרת מעל אנשים | Claude | `tools/voice-lab/scenarios.ts`, `tools/voice-lab/score.ts`, `tests/voice-lab.test.ts` | P4-2 |
| [ ] | P4-9 | פגישה חיה #5 עם תסריט שער שלב 4: מחקר ארוך באמצע פגישה, "מה נשאר?", המשך ב-Slack | רועי | | P4-7, P4-8 |

### שלב 6 (מוקדם), שבועות 11–12: מוכנות לפיילוט

**שער:** צוות חיצוני מחובר ומשתמש בלי שינוי ידני בקוד. המשימות כאן לא תלויות בשלב 4 ובשלב 5, ולכן נכנסות מוקדם, כדי ש-Codex לא יחכה ל-P4-2.

| | ID | משימה | באחריות | קבצים | תלוי ב |
|---|---|---|---|---|---|
| [ ] | P6-0 | משימות מוקדמות של שלב 6, ו-P3-15 עובר ל-Codex | Claude | `docs/TASK_BOARD.md` | - |
| [ ] | P6-1 | audit log: כל כתיבה (Jira, Slack, GitHub) נרשמת עם מי ביקש, מאיזו פגישה או ערוץ, מה נשלח והתוצאה; קובץ append-only ב-state dir ו-endpoint מוגן לקריאה | Claude | `src/app/audit-log.ts`, `src/app/action-receipts.ts`, `src/app/server.ts`, `tests/audit-log.test.ts` | - |
| [ ] | P6-2 | התנהגות כשספק נופל: כש-Jira, GitHub, Slack, Anthropic או Deepgram נכשלים או איטיים, היא אומרת בקצרה מה לא זמין, בלי סערת retries (circuit breaker לכל ספק), וחוזרת לבד כשהספק חוזר; flag כבוי | Claude | `src/core/provider-health.ts`, `src/app/config.ts`, `tests/provider-outage.test.ts` | - |
| [ ] | P6-3 | rate limits: תקרה לכל אדם ולכל פגישה על כתיבות ועל קריאות מודל, הודעה ברורה כשמגיעים אליה, ומונה ב-readiness; flag כבוי | Claude | `src/app/rate-limits.ts`, `src/app/session-usage.ts`, `tests/rate-limits.test.ts` | - |
| [ ] | P6-4 | dashboard לאיכות ולשימוש: `npm run dashboard` בונה HTML מ-turn logs ומדוחות voice lab ו-eval: שאלות שאבדו, זמני תגובה p50/p95, טענות מגובות במקור, עלות לפגישה, ומגמה בין ריצות | Claude | `tools/dashboard/`, `tests/dashboard.test.ts`, `package.json` | - |
| [ ] | P6-5 | Claude לבד בזמן ש-Codex מושהה: המשימות הפתוחות של Codex עוברות ל-Claude, ו-`npm run board -- --agent claude --chain` בונה על PRs שמחכים למיזוג, כך שצ'אט אחד רץ עד שהלוח ריק | Claude | `tools/board.ts`, `tests/board.test.ts`, `CLAUDE.md`, `docs/TASK_BOARD.md` | - |
