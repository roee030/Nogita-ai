# לוח משימות: Claude ו-Codex

זה מקור האמת לשאלה מי עושה מה עכשיו. התוכנית עצמה, ולמה, נמצאות ב-[WORK_PLAN.md](WORK_PLAN.md).

## חוקי עבודה

1. **עובדים רק על משימה מהלוח, ורק על משימה שרשומה על שמך.** משימה חדשה נכנסת ללוח דרך רועי.
2. **כל סוכן עובד בתיקייה משלו.** שני סוכנים באותה תיקייה מחליפים branch אחד לשני מתחת לרגליים.
   - Claude: `D:\Nogita-ai`.
   - Codex: `D:\Nogita-ai-codex`, git worktree נפרד. יוצרים אותו פעם אחת:
     `git worktree add -b codex/<task-id>-<slug> ../Nogita-ai-codex origin/main`
3. **branch ו-PR לכל משימה. אף פעם לא commit ישיר ל-`main`.**
   - שם ה-branch: `claude/<task-id>-<slug>` או `codex/<task-id>-<slug>`, למשל `claude/P1-1-truncated-tool-calls`.
   - **פותחים draft PR מיד כשמתחילים**, עם ה-ID של המשימה בכותרת. ה-draft PR הפתוח הוא ה"נעילה": כך הסוכן השני רואה שהמשימה בעבודה.
   - רועי ממזג. סוכן לא ממזג.
4. **קבצים.** לכל משימה רשומים הקבצים שהיא נוגעת בהם.
   - לפני שמתחילים בודקים שאין draft PR פתוח שנוגע באותם קבצים: `gh pr list --state open`.
   - אם יש חפיפה, מחכים, או כותבים לרועי.
   - צריך לגעת בקובץ שלא רשום במשימה? כותבים את זה בתיאור ה-PR. אם הקובץ שייך למשימה פתוחה של הסוכן השני, עוצרים ושואלים את רועי.
5. **קבצים רגישים.** בכל רגע רק משימה פתוחה אחת נוגעת באחד מאלה: `src/core/engine.ts`, `src/core/agent.ts`, `src/core/agent-tools.ts`, `src/core/contracts.ts`, `src/app/server.ts`, `src/app/config.ts`, `package.json`.
6. **עדכון הלוח.**
   - כל סוכן מעדכן רק את השורות שלו, בתוך ה-PR של המשימה: סטטוס ל-`בבדיקה`, ושורה ב"הערות מסירה".
   - רועי מסמן `[x]` אחרי מיזוג.
   - כך ששני PRs לא משנים את אותה שורה, ו-git ממזג אותם בלי התנגשות.
7. **לפני שפותחים PR לבדיקה:** `npm test` ו-`npm run typecheck` עוברים, ושינוי התנהגות נכנס מאחורי flag כבוי, לפי הנוהג בריפו.
8. **בסוף משימה:** branch מעודכן מ-`main`, ו-PR מוכן לבדיקה עם מה השתנה, איך נבדק ומה לא נבדק.

## חלוקת תחומים

| | Claude | Codex |
|---|---|---|
| תחום | יכולות ה-agent: לולאה, כלים, מחקר, batch, Completion Gate, סט ההערכה | שיחה חיה וקול, תשתית, traces, readiness, voice lab |
| קבצים עיקריים | `src/core/agent*.ts`, `src/core/agent-tools.ts`, `src/adapters/github.ts`, `src/adapters/jira.ts`, `tests/eval/` | `src/core/speech-*.ts`, `src/app/attendee-*.ts`, `src/app/turn-log.ts`, `src/app/readiness.ts`, `tools/voice-lab/`, `docs/MEETING_READINESS.md` |

## סטטוסים

`פתוח` (אפשר להתחיל), `ממתין ל-<ID>`, `בעבודה` (draft PR פתוח), `בבדיקה` (PR מוכן), `[x]` (מוזג).

## שלב 1, שבוע 1

| | ID | משימה | באחריות | קבצים | סטטוס |
|---|---|---|---|---|---|
| [ ] | P1-0 | תוכנית העבודה ולוח המשימות | Claude | `docs/WORK_PLAN.md`, `docs/TASK_BOARD.md`, `AGENTS.md`, `CLAUDE.md` | בבדיקה |
| [ ] | P1-1 | לא לזרוק קריאות כלי שנקטעו ב-`max_tokens`; להגדיל את התקרה לצעדים עם כלים; להחזיר את סיבת העצירה של כל צעד ב-`AgentResult` | Claude | `src/core/agent.ts`, `src/core/engine.ts` (שורת התקציב), `tests/agent.test.ts` | פתוח |
| [ ] | P1-2 | `repo_activity` ו-`get_change`; היסטוריה מה-branch החי; אזור הזמן של הצוות ב-prompt של כל תורה | Claude | `src/adapters/github.ts`, `src/core/contracts.ts`, `src/core/agent-tools.ts`, `src/core/agent-prompt.ts`, `tests/` חדשים | ממתין ל-P1-1 |
| [ ] | P1-3 | סט הערכה: 15 מקרים ראשונים, כולל שני הכשלים החיים, וסקריפט `npm run eval` | Claude | `tests/eval/` חדש, `package.json` (סקריפט אחד) | ממתין ל-P1-2 |
| [ ] | P1-4 | `/version` שמחזיר את ה-SHA של הפריסה (ב-Render: `RENDER_GIT_COMMIT`) | Codex | `src/app/server.ts`, `tests/` | פתוח |
| [ ] | P1-5 | trace לכל תורה: כלים, קלטים מקוצרים, סיבות עצירה, קיטועים, צעדים, זמן לכל צעד ומודל, בלי טקסט תמלול | Codex | `src/app/turn-log.ts`, `tools/turn-report.ts`, `tests/` | ממתין ל-P1-1 (צריך את סיבות העצירה) |
| [ ] | P1-6 | עדכון `MEETING_READINESS.md` לפי הפגישה של 31.10 | Codex | `docs/MEETING_READINESS.md` | פתוח |
| [ ] | P1-7 | דיסק קבוע ב-Render, ו-readiness ירוק בלי עקיפות | רועי | (הגדרות Render) | פתוח |
| [ ] | P1-8 | פגישה חיה #2 עם תסריט קבוע: שני הכשלים וששת הממצאים | רועי | | ממתין ל-P1-1, P1-2 |

**מה רץ במקביל עכשיו:** Claude על P1-1, ו-Codex על P1-4 ועל P1-6. אין להם קבצים משותפים. P1-4 נוגע ב-`server.ts`, ש-Claude לא נוגע בו בשלב הזה.

## הערות מסירה

כל סוכן מוסיף כאן שורה כשמשימה שלו עוברת לבדיקה: מה נעשה, מה הסוכן השני צריך לדעת, ומה נשאר פתוח.

- P1-0 (Claude): נוצרו תוכנית העבודה, הלוח הזה, `AGENTS.md` ו-`CLAUDE.md`.
