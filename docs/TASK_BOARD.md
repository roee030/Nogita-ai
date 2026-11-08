# לוח משימות

הקובץ הזה אומר **מה** המשימות: מי אחראי, אילו קבצים, ומה תלוי במה. **איפה כל משימה עומדת** נקבע ב-GitHub, לא כאן:

| ב-GitHub | הסטטוס |
|---|---|
| PR של המשימה מוזג | בוצע |
| draft PR פתוח | בעבודה (תפוס) |
| PR פתוח ומוכן | מחכה למיזוג של רועי |
| אין PR, וכל התלויות בוצעו | אפשר להתחיל |
| אין PR, ויש תלות שלא בוצעה | ממתין |

`npm run board` מחשב את כל זה ומדפיס מה Claude עושה עכשיו. אף אחד לא צריך לזכור לעדכן סטטוס, ולכן אין סטטוס בקובץ. התוכנית ולמה נמצאות ב-[WORK_PLAN.md](WORK_PLAN.md).

## טייס אוטומטי: מה Claude עושה כשאומרים לו "תמשיך"

Claude הוא הסוכן היחיד בריפו. צ'אט אחד רץ על כל הלוח:

1. `git fetch origin`, ואז `npm run board`.
2. **"Fix first"**: אם ל-PR יש CI אדום, conflict עם `main` או בקשת שינויים, מתקנים אותו ב-branch שלו לפני כל דבר אחר.
3. **"Next"**:
   - **Continue**: עוברים ל-branch של המשימה הפתוחה וממשיכים.
   - **Start**: פותחים branch חדש מ-`origin/main` ומיד פותחים draft PR:
     ```
     git switch -c claude/<ID>-<slug> origin/main
     git commit --allow-empty -m "<ID>: start"
     git push -u origin HEAD
     gh pr create --draft --title "<ID>: <מה המשימה>" --body "Board task <ID>."
     ```
     אם הלוח מציין "Builds on", ממזגים את ה-branches האלה ל-branch החדש וכותבים ב-PR על מה הוא בנוי.
4. בסוף משימה:
   - `npm test` ו-`npm run typecheck` עוברים.
   - בתיאור ה-PR כותבים סעיף **Handoff**: מה השתנה ומה לא נבדק.
   - `gh pr ready`.
5. **ממשיכים עד שהלוח ריק.** אחרי `gh pr ready` חוזרים לשלב 1. PR שמחכה למיזוג נחשב גמור בשביל המשימות שתלויות בו, אז לא מחכים למיזוג. עוצרים רק כשהלוח אומר "Nothing to start". בסוף מדווחים ל-רועי את כל ה-PRs לפי סדר המיזוג (מהישן לחדש), שורה לכל אחד, ומה מחכה לו ("Waiting on Roee").

## חוקים

1. **עובדים רק על משימות מהלוח.** משימות חדשות נכנסות ללוח ב-PR. כשהלוח עומד להיגמר, Claude מוסיף את השלב הבא מתוך `WORK_PLAN.md`. הלוח נקרא מ-`origin/main`, אז משימות חדשות נראות רק אחרי שרועי ממזג.
2. **עובדים ב-`D:\Nogita-ai`.** מחליפים branch רק כשהתיקייה נקייה, אחרי commit.
3. **אף פעם לא commit ל-`main`, ואף פעם לא מיזוג.** רועי ממזג, לפי הסדר שבדוח.
4. **קבצים.** צריך לגעת בקובץ שלא רשום במשימה? כותבים את זה בתיאור ה-PR.
5. **שינוי התנהגות נכנס מאחורי flag כבוי**, לפי הנוהג בריפו.
6. **הלוח עצמו** משתנה רק כשמוסיפים או משנים משימות, לא בשביל סטטוס.

משימות שבוצעו בעבר על ידי Codex נשארות בטבלה עם השם שלו, כהיסטוריה.

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

### שלב 5, שבועות 8–10: פגישות אמיתיות בהיקף

**שערים:** פחות מ-2% שאלות שהולכות לאיבוד; לפחות 95% מהבקשות מקבלות תשובה או כישלון ברור; p95 של interruption-to-silence מתחת ל-500ms בצד המשתתף; אפס פעולות לא מורשות או כפולות; לפחות 4 מתוך 5 בבהירות. המשימות של Claude כאן סוגרות את הפערים שהרצת ה-missions הראשונה ב-eval חשפה (2 מתוך 10 עברו), ומכינות את המדידה של 30 הפגישות.

| | ID | משימה | באחריות | קבצים | תלוי ב |
|---|---|---|---|---|---|
| [ ] | P5-0 | שלב 5 בלוח המשימות, ושתי המשימות שנשארו משלב 6 | Claude | `docs/TASK_BOARD.md` | - |
| [ ] | P5-1 | "תאשרי" אחרי restart או ב-thread חדש: החלטה שמחכה נמצאת ב-mission store והכלי `decide_mission` נקרא, במקום "אין מה לאשר"; flag כבוי | Claude | `src/core/missions.ts`, `src/core/agent-tools.ts`, `tests/mission-approval.test.ts` | - |
| [ ] | P5-2 | "מה נשאר?" רואה גם בקשות שבוצעו ישירות בתורה (ה-receipts של התורה), לא רק missions, ועונה מה בוצע, מה נכשל ומה עוד רץ; flag כבוי | Claude | `src/core/agent-tools.ts`, `src/core/missions.ts`, `tests/mission-status.test.ts` | P5-1 |
| [ ] | P5-3 | תוצאה של mission בקול קצרה: `announce` ותשובת `mission_status` אומרות משפט או שניים, והפירוט המלא הולך לצ'אט; flag כבוי | Claude | `src/core/engine.ts`, `src/core/spoken.ts`, `tests/mission-announce.test.ts` | - |
| [ ] | P5-4 | כתיבה שנחתה לפני שהתוצאה נשמרה (הפער מבדיקת הכאוס): `missionReport` מראה אותה כ"לא ידוע, לבדוק" ולא מריץ אותה שוב | Claude | `src/core/missions.ts`, `tools/mission-chaos/`, `tests/mission-chaos.test.ts` | P5-2 |
| [ ] | P5-5 | סט ההערכה מגיע ל-100 מקרים: מקרה רגרסיה לכל אחד מ-P5-1 עד P5-4, בקשות מתמלול רועש וכמה דוברים, ו-`npm run eval` שומר JSON ב-`.eval/` כברירת מחדל כדי שה-dashboard יראה מגמה | Claude | `tests/eval/` | P5-1, P5-2, P5-3, P5-4, P6-4 |
| [ ] | P5-6 | נתונים להחלטה על turn-taking v2 מול legacy: כל תרחישי voice lab בשני המצבים, כמה חזרות, ודוח עם המספרים והמלצה ב-`docs/TURN_TAKING_DECISION.md` | Claude | `tools/voice-lab/run.ts`, `docs/TURN_TAKING_DECISION.md` | - |
| [ ] | P5-7 | שערי שלב 5 ב-dashboard: לכל שער עובר או לא עובר מהנתונים (שאלות שאבדו, תשובה או כישלון ברור, interruption p95, כתיבות כפולות או לא מורשות מה-audit log), וכמה פגישות ו-turns נאספו מתוך 30 ו-500 | Claude | `tools/dashboard/`, `tests/dashboard.test.ts` | P6-4 |
| [ ] | P5-8 | 30 פגישות ו-500 turns, כולל אנשים שלא מכירים את המערכת, רעש, הפרעות וכמה דוברים; turn logs עם `NOGITA_USAGE_LOG=true`, וכל כשל עובר ל-Claude כמשימת תיקון עם בדיקת רגרסיה | רועי | | P5-5, P5-7 |
| [ ] | P5-9 | אימות: החלטה סופית על turn-taking v2 מול legacy, אחרי סקירת מדידות הניסוי (עצירה בהפרעה והשהיות שווא, P9-3). החלטת ביניים של רועי מ-7.11: v2 בניסוי מבוקר בלבד מאחורי הדגל הקיים, ולא ברירת מחדל לכולם לפני הסקירה | רועי | | P5-6, P8-12 |
| [ ] | P5-10 | שני תיקונים מסט ההערכה של 100 המקרים בלוח המשימות | Claude | `docs/TASK_BOARD.md` | - |
| [ ] | P5-11 | "פתחי משימה על X" פותחת משימה: כשהנושא נאמר, היא פותחת עם מה שנאמר ולא שואלת "מה המשימה צריכה להגיד?"; שואלת רק כשאין נושא בכלל; flag כבוי; רגרסיה: בדיקה דטרמיניסטית, ומקרי ה-eval `dana-for-me-task`, `two-people-two-tasks`, `noisy-two-tasks-fillers` ו-`noisy-mixed-hebrew` עוברים | Claude | `src/core/agent-prompt.ts`, `src/core/agent-tools.ts`, `tests/task-from-topic.test.ts`, `tests/eval/` | - |
| [ ] | P5-12 | מילה שנשמעה לא נכון לא חוסמת כתיבה: "open three tusks" (טעות תמלול של tasks) עובר את בדיקת הבקשה המפורשת ב-`requestsTaskWrite`, בלי לפתוח כתיבה לבקשות שלא ביקשו; flag כבוי; רגרסיה: בדיקה דטרמיניסטית לטעויות תמלול ולמשפטים שאסור שיעברו, ומקרה ה-eval `noisy-three-tasks-asr` עובר | Claude | `src/core/agent-tools.ts`, `tests/task-write-request.test.ts`, `tests/eval/` | P5-11 |
| [ ] | P5-13 | משימות מפגישת Meet של 1 בנובמבר: לא נכנסת באמצע משפט, "כן, תעשי" פותח, בלי חשיבה בקול, וידאו חד, מדברת רק על הוראה ברורה, וכתיבה לפי הבנה | Claude | `docs/TASK_BOARD.md` | - |
| [ ] | P5-14 | לא עונה על חצי משפט: תור קצר בלי בקשה שלמה ("So, I'm wondering?", "You need to combine.", "All the PR that we pushed today.") מחכה, ואם הדובר ממשיך התשובה מתבטלת לפני שנשמעת; בקשה קצרה ושלמה ("what landed today?") עדיין נענית מהר; flag כבוי; רגרסיה: המשפטים מהפגישה כבדיקה דטרמיניסטית, ו-voice lab `cut-off` ו-`false-pause` לא יורדים | Claude | `src/app/attendee-command-router.ts`, `tests/incomplete-turn.test.ts` | - |
| [ ] | P5-15 | "כן" להצעה שלה פותח את מה שהציעה: אחרי "Want me to create one task covering today's merged PRs?" תשובה "Yeah, do it" של דובר מורשה מאשרת בדיוק את הכתיבה שהוצעה, לא יותר; גם "turn them into Jira tasks" ו-"combine the PRs into tasks" נחשבים בקשה מפורשת; flag כבוי; רגרסיה: השורות מהפגישה, ו-"yes" בלי הצעה קודמת לא פותח כתיבה | Claude | `src/core/agent-tools.ts`, `src/core/engine.ts`, `tests/task-write-request.test.ts` | P5-12 |
| [ ] | P5-16 | בלי חשיבה בקול ובלי "in the chat" ריק: משפטים כמו "Roy wants the full list", "I'll answer with the count", "the spoken answer should be short" לא נאמרים; "The rest is in the chat" נאמר רק אם באותו תור באמת נשלחה הודעה לצ'אט; flag כבוי; רגרסיה: המשפטים מהפגישה ב-`tests/speech-guard.test.ts` | Claude | `src/core/speech-guard.ts`, `src/core/engine.ts`, `tests/speech-guard.test.ts` | - |
| [ ] | P5-17 | וידאו חד של Nogita ב-Meet: למדוד באיזו רזולוציה Attendee שולח את דף ה-presence במצב camera ובמצב screenshare, לבחור את החד יותר, ולהתאים את הדף לרזולוציה הזו (טקסט גדול ועבה יותר, בלי קווים דקים וטשטוש שנמרחים בדחיסה); בדיקה: צילום מסך של ה-tile בפגישה אמיתית לפני ואחרי, ב-PR | Claude | `src/app/presence-page.html`, `src/app/presence.ts`, `src/adapters/attendee.ts`, `tests/presence.test.ts` | - |
| [-] | P5-18 | לא נחוצה כרגע: מצב "הקשבה קודם" (P8-2) נותן את זה. מדברת רק על הוראה ברורה: עד שיש תור שפונה אליה (בשם, או המשך ישיר של שיחה איתה) ושהוא הוראה או שאלה שלמה, היא שותקת; חצי משפט, חשיבה בקול של הדובר ושיחת צד לא מקבלים תשובה, גם לא "Go ahead"; כשלא ברור אם סיים, ממתינה ולא נכנסת; flag כבוי; רגרסיה: השורות מפגישת 1 בנובמבר, ו-voice lab `meeting-room`, `crosstalk` ו-`quiet-standup` בלי שאלות שאבדו ובלי דיבור מעל אנשים | Claude | `src/app/attendee-command-router.ts`, `src/core/engine.ts`, `tests/clear-instruction.test.ts` | P5-14 |
| [ ] | P5-19 | כוונת כתיבה לפי הבנה ולא לפי ניסוח: לכל פעולת כתיבה (יצירת משימה, עדכון, סטטוס, שיוך, תגובה, הודעה ל-Slack, draft PR) ההחלטה אם ביקשו אותה נעשית מהבקשה ומהשיחה, כולל ההצעה האחרונה שלה, ולא מרשימת ביטויים; הביטויים נשארים כמסלול מהיר; נשאר: רק דובר מורשה, רק מה שביקשו (כמות ויעד), ובקשה עמומה מקבלת שאלת אישור אחת קצרה ("Open one task for the 36 PRs?") ש"כן" עליה מבצע; flag כבוי; רגרסיה: מקרי eval לכל כלי כתיבה, וסט "אסור לכתוב" (שאלות, "what are the open tasks", שיחת צד) נשאר ב-0 כתיבות לא מבוקשות | Claude | `src/core/write-intent.ts`, `src/core/agent-tools.ts`, `tests/write-intent.test.ts`, `tests/eval/` | P5-15 |
| [ ] | P5-20 | משימות מפגישת Meet של 3 בנובמבר: עצירה כשמילת עצירה בסוף המשפט, v2 לא חוזר לדבר על timeout, ו-Jira שמודה שהחיבור שבור | Claude | `docs/TASK_BOARD.md` | - |
| [ ] | P5-21 | מילת עצירה בכל מקום במשפט שנאמר מעליה: "I told you wait a second stop" עוצר אותה כמו "Stop." (stop, wait, hold on, hang on, enough גם באמצע או בסוף), ו-"don't stop" או "the bus stop" לא; flag כבוי; רגרסיה: השורה מהפגישה, ושורות שאסור שיעצרו | Claude | `src/core/engine.ts`, `tests/stop-anywhere.test.ts` | - |
| [ ] | P5-22 | v2 לא חוזר לדבר כשמישהו באמת מדבר: אחרי pause, אם הזיהוי שמע מילים, היא לא חוזרת על timeout של 1.5 שניות אלא מחכה לתמלול (עד 4 שניות) וחוזרת רק אם זה backchannel ("mm-hm"); דיבור אמיתי מבטל את התשובה; flag כבוי; רגרסיה: משפט קטיעה ארוך עם הפסקות קצרות בין המילים, ו-voice lab `barge-in`, `backchannels`, `false-pause` לא יורדים | Claude | `src/app/attendee-realtime-audio.ts`, `tests/attendee-realtime-audio.test.ts` | - |
| [ ] | P5-23 | Jira שבור נאמר בכנות: readiness בודק שהטוקן עובד (`GET /rest/api/3/myself`, 401 = חסום), חיפוש ריק בלי משתמש מחובר לא נקרא "הלוח ריק", ו-400 "project doesn't exist or you don't have permission" נאמר "החיבור ל-Jira לא עובד (הרשאה או טוקן)"; רגרסיה: טוקן שפג (Jira עונה כאנונימי) בבדיקות ה-adapter וה-readiness | Claude | `src/adapters/jira.ts`, `src/app/readiness.ts`, `tests/jira-auth.test.ts` | - |

### שלב 6 (מוקדם), שבועות 11–12: מוכנות לפיילוט

**שער:** צוות חיצוני מחובר ומשתמש בלי שינוי ידני בקוד. המשימות כאן לא תלויות בשלב 4 ובשלב 5, ולכן נכנסו מוקדם.

| | ID | משימה | באחריות | קבצים | תלוי ב |
|---|---|---|---|---|---|
| [ ] | P6-0 | משימות מוקדמות של שלב 6, ו-P3-15 עובר ל-Codex | Claude | `docs/TASK_BOARD.md` | - |
| [ ] | P6-1 | audit log: כל כתיבה (Jira, Slack, GitHub) נרשמת עם מי ביקש, מאיזו פגישה או ערוץ, מה נשלח והתוצאה; קובץ append-only ב-state dir ו-endpoint מוגן לקריאה | Claude | `src/app/audit-log.ts`, `src/app/action-receipts.ts`, `src/app/server.ts`, `tests/audit-log.test.ts` | - |
| [ ] | P6-2 | התנהגות כשספק נופל: כש-Jira, GitHub, Slack, Anthropic או Deepgram נכשלים או איטיים, היא אומרת בקצרה מה לא זמין, בלי סערת retries (circuit breaker לכל ספק), וחוזרת לבד כשהספק חוזר; flag כבוי | Claude | `src/core/provider-health.ts`, `src/app/config.ts`, `tests/provider-outage.test.ts` | - |
| [ ] | P6-3 | rate limits: תקרה לכל אדם ולכל פגישה על כתיבות ועל קריאות מודל, הודעה ברורה כשמגיעים אליה, ומונה ב-readiness; flag כבוי | Claude | `src/app/rate-limits.ts`, `src/app/session-usage.ts`, `tests/rate-limits.test.ts` | - |
| [ ] | P6-4 | dashboard לאיכות ולשימוש: `npm run dashboard` בונה HTML מ-turn logs ומדוחות voice lab ו-eval: שאלות שאבדו, זמני תגובה p50/p95, טענות מגובות במקור, עלות לפגישה, ומגמה בין ריצות | Claude | `tools/dashboard/`, `tests/dashboard.test.ts`, `package.json` | - |
| [ ] | P6-5 | Claude לבד בזמן ש-Codex מושהה: המשימות הפתוחות של Codex עוברות ל-Claude, ו-`npm run board -- --agent claude --chain` בונה על PRs שמחכים למיזוג, כך שצ'אט אחד רץ עד שהלוח ריק | Claude | `tools/board.ts`, `tests/board.test.ts`, `CLAUDE.md`, `docs/TASK_BOARD.md` | - |
| [ ] | P6-6 | Claude הוא הסוכן היחיד: בלי AGENTS.md ובלי חלוקת תחומים, `npm run board` רץ כברירת מחדל ל-Claude במצב שרשרת, וההוראות ב-CLAUDE.md ובלוח בהתאם | Claude | `CLAUDE.md`, `AGENTS.md`, `docs/TASK_BOARD.md`, `docs/WORK_PLAN.md`, `tools/board.ts` | - |
| [ ] | P6-7 | onboarding לצוות פיילוט בלי שינוי בקוד: `npm run onboard` בודק קובץ tenant config, מחבר את הספקים דרך readiness ומדפיס מה חסר, עם מדריך קצר ב-`docs/ONBOARDING.md` | Claude | `tools/onboard.ts`, `src/app/tenant-config.ts`, `docs/ONBOARDING.md`, `tests/onboarding.test.ts` | - |
| [ ] | P6-8 | צוות חיצוני אחד מחובר ומשתמש, מלווה ידנית, לפי `docs/ONBOARDING.md` (שער שלב 6) | רועי | | P6-7, P5-8 |

### שלב 7 (ניסוי): שכבת קול שלא תלויה בספק

התוכנית ב-`docs/VOICE_ENGINE_PLAN.md`. ניסוי Gemini זמני ושער A קודמים לכל בנייה. אחרי השער: ממשק `VoiceEngine`, מתאמים, גשר, נתב ו-`voice-bench` אחד לכל ספק. בנצ'מרק רק ממליץ, וקידום מנוע הוא שינוי config של רועי.

| | ID | משימה | באחריות | קבצים | תלוי ב |
|---|---|---|---|---|---|
| [ ] | P7-0 | תוכנית שכבת קול שלא תלויה בספק (`VoiceEngine`, נתב, `voice-bench`), ומשימות שלב 7 בלוח | Claude | `docs/VOICE_ENGINE_PLAN.md`, `docs/TASK_BOARD.md` | - |
| [ ] | P7-1 | ניסוי Gemini זמני: מתאם מינימלי ל-`gemini-3.8-live` בלי reconnect, בלי Nogita ובלי הממשק; קודם baseline קפוא של v2 דרך `/api/sessions/:id/usage` ב-`docs/voice-benchmarks/v2-baseline.json`; תרחישי שער A על Gemini ועל v2 (5 חזרות, 10 לבטיחות), הקלטות Attendee אמיתיות, תקרה $25; תוצאה מנורמלת לכל מנוע לפי `tools/voice-bench/result.ts` ודוח ב-`docs/GEMINI_SPIKE.md` עם כל מדד מול הסף ודגימות עברית | Claude | `tools/gemini-spike/`, `tools/voice-bench/result.ts`, `docs/voice-benchmarks/`, `docs/GEMINI_SPIKE.md` | - |
| [ ] | P7-2 | שער A: מדרג את דגימות העברית ומחליט לפי הספים שנקבעו מראש (עלות: עד פי 1.5 מ-v2, עצירה ב-$3); עובר: P7-3; לא עובר: P5-14 ו-P5-18 חוזרות ל-`[ ]` ושלב 7 נעצר | רועי | | P7-1 |
| [-] | P7-3 | מוקפא (שלב 8: קודם להוכיח ערך). ממשק `VoiceEngine` (capabilities, `startSession`, `sendAudio`, `speakApprovedText`, `interrupt`, `stop`, `usage`, אירועים מנורמלים, `ApprovedText`) ו-`CascadedVoiceEngine` שעוטף את השרשרת של היום בלי שינוי התנהגות; contract tests עם מנוע מזויף; כל הבדיקות הקיימות עוברות | Claude | `src/voice/engine.ts`, `src/voice/cascaded.ts`, `tests/voice-engine-contract.test.ts` | P7-2 |
| [-] | P7-4 | מוקפא (שלב 8: קודם להוכיח ערך). `GeminiLiveVoiceEngine` מוקשח: session resumption, דחיסת הקשר, חיבור מחדש לפני שה-WebSocket מתחלף, ריקון התור ב-`interrupted`, תקרת עלות, `GEMINI_PRIVACY_REVIEWED=true` חובה; עובר את אותם contract tests; סשן של 30 דקות עם Gemini מזויף | Claude | `src/voice/gemini-live.ts`, `tests/voice-gemini-live.test.ts`, `.env.example` | P7-3 |
| [-] | P7-5 | מוקפא (שלב 8: קודם להוכיח ערך). `MeetingVoiceBridge` זהה לכל מנוע: `tool_intent` מקושר לתור (`speakerId`, `turnId`, תמלול, חפיפה, ביטחון), אין התאמה חד-משמעית: לא מבצעים, כתיבה בספק: אישור מחדש, תשובה סמכותית רק כ-`ApprovedText`; בדיקות על שני המתאמים | Claude | `src/voice/bridge.ts`, `tests/voice-bridge.test.ts` | P7-3 |
| [-] | P7-6 | מוקפא (שלב 8: קודם להוכיח ערך). `VoiceEngineRouter` דטרמיניסטי, פעם אחת בתחילת פגישה: ברירת מחדל של workspace ו-override מפורש (`voiceEngine` ב-`POST /api/sessions`, רק מתוך רשימת המותרים); fallback רק בגבול בטוח (עוצרים פלט, רושמים, מודיעים בצ'אט, מפעילים את ה-fallback, ממשיכים מסיכום מאושר); אף LLM לא בוחר ספק | Claude | `src/voice/router.ts`, `src/app/server.ts`, `tests/voice-router.test.ts` | P7-4, P7-5 |
| [-] | P7-7 | מוקפא (שלב 8: קודם להוכיח ערך). `voice-bench` משותף: contract, תרחישים מוקלטים, בטיחות, זמנים ועלות על כל `VoiceEngine`; תוצאה מנורמלת אחת לכל מנוע (שיוך דובר שגוי, כתיבות לא מורשות, טענות בלי מקור, תגובה ללא מופנה, תגובה מוקדמת, שאלות שאבדו, הצלחת משימות, קטיעה ותגובה p50/p95, עברית, USD לשעה); המלצת PROMOTE, KEEP או REJECT בלי לשנות ייצור | Claude | `tools/voice-bench/`, `tests/voice-bench.test.ts`, `package.json` | P7-6 |
| [-] | P7-8 | מוקפא (שלב 8: קודם להוכיח ערך). דוח החלטה ב-`docs/VOICE_ENGINE_DECISION.md` מתוצאות `voice-bench` על `cascaded` ו-`gemini-live`; כתיבות לא מורשות, שיוך שגוי וטענות בלי מקור חייבים 0 | Claude | `docs/VOICE_ENGINE_DECISION.md`, `docs/voice-benchmarks/` | P7-7 |
| [-] | P7-9 | מוקפא (שלב 8: קודם להוכיח ערך). canary חי: פגישה ב-Meet עם override ל-`gemini-live` בהסכמת המשתתפים, והחלטה; קידום הוא שינוי ידני של ברירת המחדל או של `approved.json` | רועי | | P7-8 |
| [-] | P7-10 | מוקפא (שלב 8: קודם להוכיח ערך). בחירה לפי מדיניות בנתב: שפות נדרשות, יכולות (זהות ודיבור נשלט), בריאות ספק, פרטיות ואזור נתונים, עלות מקסימלית ובנצ'מרק מאושר אחרון; עדיין פעם אחת לפגישה ובלי LLM | Claude | `src/voice/router.ts`, `tests/voice-router.test.ts` | P7-9 |

### שלב 8: להוכיח ערך לפני יכולות חדשות

התוכנית ב-`docs/WORK_PLAN.md`. מבחן המוצר: אחרי כל פגישה, 0 הפרעות, 0 תיקונים בתוצרים שלה, ולפחות 10 דקות שנחסכו. השער: 5 פגישות אמיתיות ברצף. שלב 7 (אחרי P7-2) והווידאו מוקפאים.

| | ID | משימה | באחריות | קבצים | תלוי ב |
|---|---|---|---|---|---|
| [ ] | P8-0 | שלב 8 בתוכנית ובלוח, ושלב 7 מוקפא אחרי P7-2 | Claude | `docs/WORK_PLAN.md`, `docs/TASK_BOARD.md` | - |
| [ ] | P8-1 | כרטיס לכל פגישה: `npm run scorecard -- <session>` מחשב הפרעות (התחילה לדבר כשמישהו דיבר, ענתה כשלא פנו אליה) מתמלול Attendee ומה-turn log, תיקונים (משימות שהיא פתחה ונערכו, הועברו או נמחקו ב-24 השעות שאחרי, מהיסטוריית Jira), ודקות שנחסכו (שאלה אחת בצ'אט בסוף הפגישה, והתשובה נרשמת); כותב `docs/scorecards/<date>-<session>.md` ושורה בטבלה המצטברת | Claude | `tools/scorecard/`, `tests/scorecard.test.ts`, `package.json` | - |
| [ ] | P8-2 | מצב "הקשבה קודם" (`NOGITA_LISTEN_FIRST`, כבוי): מדברת רק כשהתור הזה פונה אליה בשם (או עונה לשאלה שהיא עצמה שאלה עכשיו), בתשובה של משפט אחד והפרטים בצ'אט; בלי יד מורמת, בלי "שאלתם אותי?", בלי מילוי שקט; רגרסיה: voice lab `meeting-room`, `other-people-conversation`, `long-pauses` עם 0 תשובות לא מופנות | Claude | `src/core/engine.ts`, `src/app/config.ts`, `tests/listen-first.test.ts` | - |
| [ ] | P8-3 | סיכום בסוף פגישה (`NOGITA_MEETING_RECAP`, כבוי): כשהפגישה נגמרת או כשמבקשים "summarize", הודעה אחת בצ'אט: החלטות, משימות עם בעלים ותאריך כפי שנאמרו, שאלות פתוחות, ומשימות מוצעות ממוספרות; שום דבר לא נכתב בלי אישור: "approve 1, 3" (בצ'אט או בקול) פותח בדיוק את אלה; רגרסיה: תמלולי 1 ו-3 בנובמבר, ו-eval שבו סיכום בלי אישור פותח 0 משימות | Claude | `src/core/recap.ts`, `src/core/engine.ts`, `tests/meeting-recap.test.ts`, `tests/eval/` | P8-2 |
| [ ] | P8-4 | סגירת מעגל (`NOGITA_FOLLOW_UP`, כבוי): בתחילת הפגישה הבאה של אותו צוות, או בהודעה ב-Slack אחרי יום, מה מהמשימות שאושרו נסגר, מה זז ומה תקוע, מתוך Jira, עם קישורים; רגרסיה: שתי פגישות רצופות בזיכרון הפגישות | Claude | `src/core/follow-up.ts`, `src/core/engine.ts`, `tests/follow-up.test.ts` | P8-3 |
| [ ] | P8-5 | 5 פגישות אמיתיות עם `NOGITA_LISTEN_FIRST`, `NOGITA_MEETING_RECAP` ו-`NOGITA_FOLLOW_UP` דלוקים, כרטיס לכל אחת; השער: 5 ברצף עם 0 הפרעות, 0 תיקונים ולפחות 10 דקות שנחסכו | רועי | | P8-1, P8-4, P8-12, P9-1, P9-2 |
| [ ] | P8-6 | משימות design review ו-retro בתוכנית ובלוח | Claude | `docs/WORK_PLAN.md`, `docs/TASK_BOARD.md` | - |
| [ ] | P8-7 | כלי לניסוי קריאת מסך: קליטת המסך בשרת מאחורי `NOGITA_SCREEN_CAPTURE` (בזיכרון בלבד, נמחק בסוף הסשן), `npm run screen-spike` שאוסף ומנתח ב-Haiku וב-Sonnet, ותוצאה מסימולציה ב-`docs/SCREEN_SPIKE.md` | Claude | `src/app/screen-capture.ts`, `tools/screen-spike/`, `docs/SCREEN_SPIKE.md`, `tests/screen-capture.test.ts` | - |
| [ ] | P8-13 | אימות: ניסוי קריאת מסך בפגישה אמיתית (10 דקות, לפי `docs/SCREEN_SPIKE.md`), בהסכמת המשתתפים: קודם אוספים ומודדים פריימים, משתפים סכמה וקוד בגודל רגיל מקובץ מקור ידוע, וקריאת הפריימים היא ניתוח offline מוגבל ולא ניתוח רציף; ספים: לפחות 90% משמות הטבלאות והעמודות נקראים נכון, ועד $0.50 לשעה על ראייה; גם: האם Attendee מחייב על וידאו; הפריימים המקומיים נמחקים בסוף | רועי | | P8-7, P9-12, P9-13 |
| [ ] | P8-8 | שיחה על מה שעל המסך (`NOGITA_SCREEN_CONTEXT`, כבוי): פריימים נשמרים בזיכרון בלבד וזיהוי שינוי נעשה בלי מודל; השוואה של תמונה מוקטנת אחרי פענוח, כי כל פריים מקודד מחדש ו-hash של ה-JPEG משתנה תמיד; שום פריים לא נשלח למודל עד שפונים אליה ("what do you think about this?"), ואז נשלחים רק האחרון ועוד שניים שהשתנו לפניו; בלי ניתוח ראייה רציף; אכיפה של עד $0.50 לשעה על ראייה, שנספרת בתקציב הפגישה; טקסט על המסך הוא נתון לא מהימן ולא יכול לאשר כתיבה; רגרסיה: מסך סטטי לא שולח כלום, הוראה כתובה על המסך לא מפעילה כתיבה | Claude | `src/app/screen-context.ts`, `src/adapters/attendee.ts`, `src/app/server.ts`, `tests/screen-context.test.ts` | P8-13, P8-5, P9-14 |
| [ ] | P8-9 | חוות דעת ב-design review (`NOGITA_DESIGN_REVIEW`, כבוי): על "what do you think?" אומרת שהיא בודקת, עוברת למודל חזק יותר מזה של השיחה המהירה, וקוראת מהריפו את הקוד הרלוונטי (סכמה, שאילתות, מי משתמש בשדה), כולל הקבצים שמופיעים על המסך, ונותנת בצ'אט 2–3 חלופות עם יתרונות, חסרונות ומקורות, ובקול המלצה במשפט אחד; כשאין תשובה אחת נכונה אומרת במה ההחלטה תלויה; רגרסיה: eval עם שאלות אמיתיות על הקוד, שרועי שופט אם התשובה הייתה עוזרת לו בפגישה | Claude | `src/core/agent-prompt.ts`, `src/core/engine.ts`, `tests/design-review.test.ts`, `tests/eval/` | P8-2 |
| [ ] | P8-10 | הסיכום מגיע לאנשים: כל סיכום בסוף פגישה, גם כשהפגישה נגמרה מעצמה, נשמר בערוץ Slack ייעודי (`NOGITA_RECAP_CHANNEL`, ריק = כבוי), בלי תלות בדיסק; רגרסיה: כשהערוץ לא זמין הפגישה לא נכשלת והכשל נאמר בצ'אט | Claude | `src/core/engine.ts`, `tests/recap-archive.test.ts` | P8-3 |
| [ ] | P8-12 | בדיקת עשן אחת ב-Meet לפני שער 5 הפגישות: האם הודעות `send_chat_message` באמת מופיעות בצ'אט (ב-1 בנובמבר רועי לא ראה אותן, ו-Attendee לא מדווח על כישלון), סיכום, "approve", מעקב, שסיכום מגיע ל-Slack כשהפגישה נגמרת מעצמה, ושהמשתתפים רואים בצ'אט שהסיכום נשמר ב-Slack. גם מי בשיחה (P9-23): קודם עם `NOGITA_ROOM_AWARE` כבוי, ב-turn log, האם Attendee מדווח הצטרפות גם על מי שכבר היה בשיחה כשהבוט נכנס, והאם ה-`member` בשורת `heard` שווה ל-`member` בשורת `participant`; אחר כך מדליקים את הדגל רק לחלק הזה ובודקים: שאלה בלי שם כשרועי לבד מקבלת תשובה, שאלה בלי שם או לעמית בקבוצה מקבלת שקט, ואחרי הפעלה מחדש של השירות באמצע פגישה (רשימת המשתתפים לא ידועה) שאלה בלי שם מקבלת שקט ושאלה עם השם מקבלת תשובה; בסוף מכבים את הדגל, והוא נכנס ל-`config/render-flags.env` רק אם הכול עבר | רועי | | P8-10, P9-4, P9-23 |
| [ ] | P8-11 | Retro (`NOGITA_RETRO`, כבוי): "Nogita, prepare the retro" מצליבה לתקופה שנבחרה את הסיכומים מהארכיון עם Jira ו-git: מה תוכנן, מה נסגר, מה נתקע, ומה חזר בכמה פגישות; כל טענה עם מקור, ופלט בצ'אט; רגרסיה: eval על dailies מדומים, ובלי סיכומים היא אומרת שאין לה נתונים ולא ממציאה | Claude | `src/core/retro.ts`, `src/core/engine.ts`, `tests/retro.test.ts`, `tests/eval/` | P8-10 |

### שלב 9: סדר העבודה מ-`docs/VOICE_PRODUCT_ROADMAP.md`

רועי אישר את הסדר ואת המיקוד בצוותי פיתוח מוצר ב-7.11. כל משימה מסומנת **אימות** או **פיתוח**. השערים הקיימים לא משתנים, ומספר חדש הוא הצעה שלא משמשת לשחרור עד שרועי מאשר אותו מראש. כל שינוי התנהגות נכנס מאחורי flag כבוי, עובר בדיקות ואישור לפני ייצור.

| | ID | משימה | באחריות | קבצים | תלוי ב |
|---|---|---|---|---|---|
| [ ] | P9-0 | פיתוח: שלב 9 בתוכנית ובלוח, והתלויות החדשות של P5-9, P8-5, P8-8, P8-12 ו-P8-13 | Claude | `docs/WORK_PLAN.md`, `docs/TASK_BOARD.md` | - |
| [ ] | P9-1 | פיתוח: מקרי סיכום, retro ו-design review ב-eval מול מודל אמיתי, כדי לתפוס תוצר שגוי לפני שהוא עולה לפגישה; בלי שינוי התנהגות | Claude | `tests/eval/cases.ts`, `tests/eval/world.ts` | P9-0 |
| [ ] | P9-2 | פיתוח: הכרטיס סופר גם תיקונים לסיכום ולהחלטות ולא רק למשימות, כפי שמבחן המוצר מגדיר; השער עצמו לא משתנה | Claude | `tools/scorecard/`, `tests/scorecard.test.ts` | P9-0 |
| [ ] | P9-3 | פיתוח: דוח לכל פגישה על עצירה בהפרעה ועל השהיות שווא של v2 מתוך ה-turn log; דגלי הניסוי ושלב 8 נרשמים ב-`config/render-flags.env`; ברירת המחדל בקוד נשארת legacy | Claude | `tools/turn-report.ts`, `config/render-flags.env`, `tests/` | P9-0 |
| [ ] | P9-4 | אימות: להדליק ב-Render את ניסוי v2 ואת דגלי שלב 8 לפי `config/render-flags.env`, ולאשר ש-`NOGITA_MEETING_MEMORY` כבוי | רועי | (הגדרות Render) | P9-3, P9-22 |
| [ ] | P9-5 | פיתוח: סט מתויג של סוגי פגישות מתמלולים סינתטיים ובהסכמה, ובדיקת זיהוי offline; היעדים הם הצעות | Claude | `tools/meeting-profile/`, `tests/meeting-profile.test.ts` | P9-0 |
| [ ] | P9-6 | אימות: לסקור את התיוגים, ולאשר או להחליף את יעדי הזיהוי לפני מצב צל | רועי | | P9-5 |
| [ ] | P9-7 | פיתוח: זיהוי סוג פגישה במצב צל (`NOGITA_MEETING_PROFILE=shadow`, כבוי): נרשם ביומן בלי מילים, נשמר לפגישה בלבד, ולא משנה שום התנהגות או הרשאה; רגרסיה: אותן תורות ואותן כתיבות עם הדגל ובלעדיו | Claude | `src/core/meeting-profile.ts`, `src/app/config.ts`, `tests/meeting-profile.test.ts` | P9-6 |
| [ ] | P9-8 | פיתוח: סוג הפגישה מכוון מה לאסוף ומה להכין (`NOGITA_MEETING_PROFILE=on`, כבוי), עם `uncertain` כשלא ברור ותיקון על ידי אנשים; זיכרון לפגישה בלבד; לא נותן הרשאה ולא מאשר כתיבה | Claude | `src/core/meeting-profile.ts`, `src/core/engine.ts`, `tests/meeting-profile.test.ts` | P8-5, P9-7 |
| [ ] | P9-9 | אימות: פגישות אמיתיות עם סוגי פגישה דלוקים, באותם שערים של P8-5; מספר הפגישות הוא הצעה לאישור מראש | רועי | | P9-8 |
| [ ] | P9-10 | אימות: החלטה על זיכרון צוותי מתמשך: בידוד בין צוותים, מחיקה, שמירה ואחסון עמיד (כולל P1-7) | רועי | | P9-9 |
| [ ] | P9-11 | פיתוח: זיכרון צוותי מתמשך לפי החלטת P9-10 בלבד (flag כבוי): מפתח workspace לכל רשומה, הסכמה, מחיקה ו-"what do you remember?"; רגרסיה: אין דליפה בין צוותים | Claude | `src/app/meeting-memory.ts`, `src/core/contracts.ts`, `tests/meeting-memory.test.ts` | P9-10 |
| [ ] | P9-12 | אימות: לברר עם Attendee: האם פריימים והקלטות שומרים מסך משותף, לכמה זמן, איך מוחקים, האם `delete_data` מכסה הכול, האם אפשר לכבות הקלטה והאם וידאו משנה מחיר; התשובות נרשמות ב-`docs/SCREEN_SPIKE.md`; אם צריך שינוי בקוד, Claude מקבל משימה | רועי | `docs/SCREEN_SPIKE.md` | P9-0 |
| [ ] | P9-13 | פיתוח: לכידה בלי סינון לכיול, מאחורי `NOGITA_SCREEN_CAPTURE`: פריימים רצופים בהסכמה, בגבול זיכרון בבתים, ובלי שום קריאת מודל בשרת | Claude | `src/app/screen-capture.ts`, `tools/screen-spike/`, `tests/screen-capture.test.ts` | P9-0 |
| [ ] | P9-14 | פיתוח: שער שינוי מקומי offline על הפריימים מ-P8-13: פענוח, בהירות מוקטנת, הפרש ו-SSIM לפי אזורים, סינון רעש ופריים גיבוי; הספים נמדדים והיעדים הם הצעות; בלי מודל ובלי שינוי בייצור | Claude | `tools/screen-spike/`, `src/app/screen-change.ts`, `tests/screen-change.test.ts` | P8-13 |
| [ ] | P9-15 | פיתוח: דוח כיסוי של המטריצה מעל הכלים הקיימים, ותרחישים חסרים: planning, incident, one-to-one, design review ו-retro בקול, מסך וכשל צ'אט; כלי להשוואת ציוני השופט לתיוג אנושי | Claude | `tools/voice-lab/scenarios.ts`, `tests/eval/cases.ts`, `tools/eval-matrix/` | P8-13, P9-9 |
| [ ] | P9-16 | אימות: להחליט על תקציב ולספק סוד ב-CI להרצת eval מתוזמנת | רועי | (הגדרות GitHub) | P9-15 |
| [ ] | P9-17 | פיתוח: הרצת eval מול מודל אמיתי בתזמון ובתקציב שאושר | Claude | `.github/workflows/` | P9-16 |
| [ ] | P9-18 | אימות: לתייג ידנית מדגם, כדי לבדוק את אמינות השופט לפני שהציון שלו משפיע על החלטה | רועי | | P9-15 |
| [ ] | P9-19 | פיתוח: כשלים ותיקונים הופכים להצעות למקרי רגרסיה, מקלט סינתטי או בהסכמה בלבד; אדם מאשר את התוצאה הצפויה לפני שהמקרה נכנס לסט | Claude | `tools/eval-matrix/`, `tests/eval/` | P9-15 |
| [ ] | P9-20 | פיתוח: הצעות שינוי offline לפרומפט, לספים ולהגדרות, עם מקרים מוחזקים בצד וחבילת החלטה; אסור להן לגעת בהרשאות, אישורים, כתיבה, פרטיות, תקציב או בבדיקות עצמן; שום דבר לא מתעדכן לבד בייצור | Claude | `tools/eval-matrix/`, `tests/eval/` | P9-17, P9-18, P9-19 |
| [ ] | P9-22 | פיתוח: גבול ערוץ הסיכומים לפי החלטת רועי: השליחה כבויה בלי ערוץ מוגדר, נשלח רק סיכום ולא הקלטה או תמלול, הודעה למשתתפים שהסיכום נשמר ב-Slack, וסיכומים קודמים נקראים רק על ידי Retro דלוק ולא נכנסים להקשר של פגישה חדשה (גם לא דרך כלי הקריאה של Slack); רגרסיה: זיכרון פגישות כבוי לא מבטל את שליחת הסיכום | Claude | `src/core/engine.ts`, `src/core/agent-tools.ts`, `src/core/recap.ts`, `tests/recap-boundary.test.ts`, `.env.example`, `docs/SECURITY.md` | P9-0 |
| [ ] | P9-23 | פיתוח: הדובר הראשון בפגישה קבוצתית לא נחשב לבד עם Nogita (`NOGITA_ROOM_AWARE`, כבוי): בלי שם היא עונה רק כשהשיחה מדווחת על הדובר כמשתתף היחיד, ובלי דיווח או אחרי הפעלה מחדש היא מחכה לשם; הצטרפות ועזיבה נרשמות ב-turn log במזהים מגובבים לכל פגישה, בלי שמות; הדגל נשאר כבוי עד P8-12; רגרסיה: דובר ראשון שפונה לעמית מקבל שקט, ופנייה אליה בשם מקבלת תשובה | Claude | `src/core/engine.ts`, `src/app/server.ts`, `src/app/attendee-webhook.ts`, `tests/first-speaker.test.ts`, `.env.example` | P9-22 |
| [ ] | P9-21 | אימות: הצעה אחת עוברת את כל המסלול עד החלטה של רועי, והצעה גרועה בכוונה (כתיבה לא מורשית) נדחית אוטומטית | רועי | | P9-20 |
