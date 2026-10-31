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

הטבלה נקראת על ידי `tools/board.ts`: בעמודת הקבצים רק נתיבים בתוך backticks נספרים, ובעמודת התלויות רק IDs. את `[x]` מסמן רועי ביד, רק למשימות שנעשו בלי PR, כמו המשימות שלו.

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
| [ ] | P1-7 | דיסק קבוע ב-Render, ו-readiness ירוק בלי עקיפות | רועי | (הגדרות Render) | - |
| [ ] | P1-8 | פגישה חיה #2 עם תסריט קבוע: שני הכשלים וששת הממצאים | רועי | | P1-1, P1-2 |
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
| [ ] | P2-7 | תיקון "wait" ועצירה כשמישהו מתחיל לדבר, לפי מה שפגישה #2 והמדידה בצד המאזין חשפו | Codex | `src/core/speech-floor.ts`, `src/core/speech-guard.ts`, `src/app/attendee-realtime-audio.ts` | P1-8, P2-6 |
| [ ] | P2-8 | פגישה חיה #3 עם תסריט השער: "פתחי חמש משימות" 10 פעמים, בעלים שלא קיים, ו-"wait" באמצע תשובה | רועי | | P2-2, P2-4, P2-7 |
