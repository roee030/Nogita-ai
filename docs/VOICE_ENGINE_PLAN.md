# תוכנית: שכבת קול שלא תלויה בספק

## למה

בפגישה ב-Meet ב-1 בנובמבר Nogita נכנסה לרועי באמצע משפט, ענתה על חצי משפט ודיברה מעליו. הסיבה מבנית. בשרשרת שלנו כל שלב הוא מערכת נפרדת:

1. Deepgram מחליט מתי הדובר סיים.
2. Claude חושב.
3. Aura מקריא.
4. קוד שלנו מנחש מתי לעצור.

אף חלק לא שומע טון, היסוס או "אממ". מודל שמקבל קול ומוציא קול, כמו Gemini Live או OpenAI Realtime, כן שומע.

**אבל Nogita לא נקשרת ל-Gemini.** שכבת הקול הופכת לממשק אחד, `VoiceEngine`. כל ספק הוא מתאם מאחוריו:
- **השרשרת של היום:** `CascadedVoiceEngine`.
- **הניסוי:** `GeminiLiveVoiceEngine`.
- **בעתיד:** ספקים אחרים, למשל OpenAI Realtime.

כל המתאמים נבדקים באותה מערכת בדיקה ומוחלפים בלי לגעת במנוע הפגישה.

**הסדר:**
1. קודם ניסוי קטן וזמני עם Gemini (P7-1) מול ספים שנקבעו מראש (שער A, P7-2).
2. רק אם הוא עובר, בונים את הממשק, המתאמים והנתב, בהדרגה.

שום דבר לא משתנה בייצור בלי פקודה של אדם.

## מה נשאר מחוץ לכל מתאם

המתאם רק שומע ומדבר. כל מה שקובע מי מבקש, מה מותר ומה נאמר נשאר בקוד של Nogita, אותו קוד לכל ספק:

- **זהות וקישור לתור.** מי אמר מה: `speakerId` ו-`turnId`.
- **policy והרשאות.**
- **בדיקת כוונת כתיבה** (P5-19).
- **speech guard.**
- **audit, rate limits וקבלות.**
- **הכלים** (Jira, GitHub, Slack, מחקר) ו-Claude שמפעיל אותם.

מתאם לא קורא לכלי, לא כותב, ולא מחליט מי ביקש. במקום זה הוא שולח אירוע מנורמל: "שמעתי כוונה", "נגמר תור", "קטעו אותי". הקוד של Nogita מחליט מה לעשות איתו.

## הממשק: `VoiceEngine`

```ts
interface VoiceEngine {
  readonly id: string;                         // 'cascaded' | 'gemini-live' | 'openai-realtime' | ...
  readonly capabilities: VoiceEngineCapabilities;
  startSession(config: VoiceSessionConfig, events: VoiceEventSink): Promise<VoiceSession>;
}

interface VoiceEngineCapabilities {
  languages: string[];                         // שפות שנבדקו, לא רק "נתמכות"
  perSpeakerTranscripts: boolean;              // מחזיר תמלול לכל משתתף (נדרש לזהות)
  controlledSpeech: boolean;                   // יכול לומר טקסט מאושר מילה במילה
  nativeTurnTaking: boolean;                   // מחליט על תורות בעצמו
  freeSpeech: boolean;                         // מדבר גם בלי טקסט מאושר (מילות שיחה)
  maxSessionMinutes?: number;
  dataRegion: string; trainsOnCustomerData: boolean;
}

interface VoiceSession {
  sendAudio(frame: { participantId: string; pcm16k: Buffer; at: number }): void;
  speakApprovedText(text: ApprovedText, trace: SpeechTrace): Promise<SpeechOutcome>;
  interrupt(cause: 'voice' | 'command'): void;
  stop(reason: string): Promise<void>;
  usage(): VoiceUsage;                         // דקות אודיו, תווים, טוקנים, הערכת USD
}
```

`ApprovedText` הוא טיפוס שרק ה-speech guard יכול ליצור. מתאם לא יכול לומר טקסט סמכותי שלא עבר בדיקה.

**אירועים מנורמלים** (`VoiceEventSink`):

| אירוע | שדות | מי משתמש |
|---|---|---|
| `transcript` | `participantId?`, `turnId`, `text`, `final`, `startedAt`, `endedAt`, `confidence` | זהות, קישור לתור, turn log |
| `turn_end` | `turnId`, `participantId?`, `confidence` | מתי מותר לענות |
| `tool_intent` | `intentText`, `heardText`, `at` | הגשר: מקשר לתור ומפעיל את Nogita |
| `speech` | `utteranceId`, `phase` (`started`/`ended`), `outcome`, `playedMs`, `approved` | מדידה, audit |
| `free_speech` | `text` (תמלול הפלט), `at` | audit בלבד: "טענות מדוברות בלי מקור" |
| `interrupted` | `latencyMs`, `cause` | מדידה, ביטול תשובה |
| `error` | `code`, `recoverable` | בריאות ספק, fallback |
| `usage` | `VoiceUsage` | עלות ותקרה |

**איך כל מתאם ממלא את הממשק:**
- **`CascadedVoiceEngine`:** עוטף את `AttendeeRealtimeAudioHub` ואת ה-router הקיים, בלי שינוי התנהגות.
  - `tool_intent` = תור סופי שפונה אליה.
  - `controlledSpeech` = כן.
  - `nativeTurnTaking` = לא.
  - `freeSpeech` = לא.
- **`GeminiLiveVoiceEngine`:** פונקציה אחת ב-Gemini שמייצרת `tool_intent`.
  - תשובות סמכותיות נאמרות דרך `speakApprovedText`: TTS נשלט באותו קול. Gemini מקריא בעצמו רק אם הוכח שהוא לא משנה ולא מוסיף.
  - `freeSpeech` = כן, רק למילות שיחה ("רגע", "כן?").
  - זהות: Deepgram לכל משתתף, במקביל, כי ל-Gemini אין זהות דוברים.

## הגשר: `MeetingVoiceBridge` (זהה לכל ספק)

1. **`tool_intent` נקשר לתור** לפי חלון הזמן ולפי הדמיון בין `heardText` לתמלול לכל משתתף. כך מקבלים `speakerId`, `turnId`, את התמלול המקורי, `overlapDetected` ו-`attributionConfidence`.
2. **מתי לא מבצעים:**
   - **אין התאמה חד-משמעית:** לא מבצעים כלום, גם לא קריאה.
   - **כתיבה עם חפיפה או ביטחון נמוך:** צריך אישור מפורש מחדש מהדובר המורשה. "מי שדיבר אחרון" לעולם לא מספיק.
3. **ה-engine מקבל את התמלול המקורי ואת הזהות.** הכוונה של הספק היא רק רמז.
4. **התשובה עוברת speech guard**, והופכת ל-`ApprovedText` שנשלח ל-`speakApprovedText`. הפרטים הולכים לצ'אט.

## הנתב: `VoiceEngineRouter`

**דטרמיניסטי, ובוחר פעם אחת בתחילת פגישה.** אף LLM לא בוחר ספק, ולא מחליפים ספק באמצע תור.

**שלב ראשון:** ברירת מחדל של ה-workspace, ו-override מפורש בבקשה (`voiceEngine` ב-`POST /api/sessions`). ה-override חייב להיות ברשימת המותרים של ה-workspace.

**בהמשך: בחירה לפי מדיניות.** מסננים לפי הסדר, ומכל מה שנשאר בוחרים לפי סדר העדיפות של ה-workspace:
1. **רשימת מותרים** של ה-workspace.
2. **שפות נדרשות:** רק מנוע שנבדק בהן.
3. **יכולות נדרשות:** `perSpeakerTranscripts` (או זהות משולבת) ו-`controlledSpeech`. בלי שניהם אין כתיבה, ולכן המנוע לא נבחר לפגישה עם כלים.
4. **בריאות ספק:** circuit breaker פתוח, המנוע לא נבחר.
5. **פרטיות ואזור נתונים:** דגל review לכל ספק (`GEMINI_PRIVACY_REVIEWED` וכו') ואזור מותר.
6. **עלות מקסימלית:** לפי העלות בבנצ'מרק המאושר האחרון.
7. **בנצ'מרק מאושר:** רק מנוע שיש לו תוצאה שאדם אישר (`docs/voice-benchmarks/approved.json`).

הבחירה והסיבה נרשמות ב-turn log וב-audit.

**fallback, רק בגבול בטוח.** כשמנוע נכשל באופן שאי אפשר לשחזר (שגיאה לא recoverable או circuit breaker):
1. עוצרים פלט.
2. רושמים את הכשל.
3. כותבים בצ'אט של הפגישה שהקול מתחלף.
4. מפעילים את מנוע ה-fallback.
5. ממשיכים עם סיכום מאושר של השיחה עד כאן, מהתמלול שלנו.

אף פעם לא מחליפים באמצע תור רגיל, ואף פעם לא כדי "לנסות מנוע אחר".

## מערכת הבדיקה: `voice-bench` (אחת לכל ספק)

אותם חמישה סוגי בדיקות רצים על כל `VoiceEngine`:

| סוג | מה |
|---|---|
| **contract** | כל מתאם מקיים את הממשק: אירועים בפורמט, `interrupt` משתיק, `stop` סוגר, `usage` מדווח, `speakApprovedText` אומר בדיוק את הטקסט |
| **תרחישים מוקלטים** | תרחישי ה-voice lab, הקלטות Attendee של פגישות אמיתיות, ותרחישים בעברית ובעברית ואנגלית מעורבות |
| **בטיחות** | אדם לא מורשה מבקש, אדם אחר אומר "כן", שני דוברים יחד, שיחה לא מופנית, חצי משפט |
| **זמנים** | קטיעה עד שקט, סוף דיבור עד צליל ראשון |
| **עלות** | `usage()` של המנוע ו-`/api/sessions/:id/usage`, מנורמל לשעת פגישה |

**תוצאה מנורמלת אחת לכל מנוע** (`docs/voice-benchmarks/<engine>-<date>.json`):

| מדד | |
|---|---|
| `wrongSpeakerAttributions` | פעולה שיוחסה לדובר הלא נכון |
| `unauthorizedWrites` | כתיבה שלא ביקשו, או של דובר לא מורשה |
| `ungroundedSpokenClaims` | טענה מדוברת שלא הגיעה מ-`ApprovedText` |
| `responsesToNonAddressed` | ענתה לשיחה שלא הופנתה אליה |
| `prematureResponses` | ענתה לחצי משפט, או לפני שהדובר סיים |
| `lostQuestions` | שאלה שהופנתה אליה ולא נענתה |
| `taskSuccessRate` | בקשות שהושלמו נכון מתוך כל הבקשות |
| `interruptionMs` p50/p95 | מקטיעה עד שקט |
| `firstAudibleMs` p50/p95 | מסוף דיבור עד צליל ראשון |
| `hebrewQuality` | ממוצע דירוג אנושי, הבנה וטבעיות, 1-5 |
| `usdPerMeetingHour` | מוערך ובפועל |

**המלצה, לא החלטה.** הבנצ'מרק מחזיר `PROMOTE`, `KEEP` או `REJECT` מול הבנצ'מרק המאושר האחרון, לפי השערים. הוא לא משנה שום דבר בייצור. קידום מנוע הוא שינוי מפורש של אדם: ברירת המחדל של ה-workspace או `approved.json`.

## עלות

- **baseline קפוא של v2:** נמדד דרך `/api/sessions/:id/usage` על סשנים שרצים עם `NOGITA_TURN_TAKING_V2=true` על commit קבוע, ונשמר ב-`docs/voice-benchmarks/v2-baseline.json`.
- **למה עוד אין מספר:** ניסיון ב-3 בנובמבר לקרוא את הסשנים מ-1 בנובמבר החזיר 404. ה-usage נשמר בזיכרון השרת ואבד בהפעלה מחדש. לכן הוא נמדד מחדש בתחילת P7-1.
- **שער מועדף:** עד פי 1.5 מה-baseline של v2 לשעת פגישה.
- **עצירה קשיחה:** $3 לשעת פגישה, הכול כלול. מנוע שעובר אותה נעצר, לא משנה מה התוצאות האחרות.
- **תקרה לכל ניסוי P7-1:** $25.

## השלבים

| שלב | מה | נשאר אחרי השער? |
|---|---|---|
| P7-1 | **ניסוי Gemini זמני** ב-`tools/gemini-spike/`, בלי reconnect, בלי Nogita ובלי הממשק. מודד את ה-baseline הקפוא של v2. מריץ את תרחישי שער A על Gemini ועל v2. מוציא תוצאה מנורמלת לכל אחד, לפי סכמה שנשמרת ב-`tools/voice-bench/result.ts` | רק הסכמה והתוצאות. קוד הניסוי נזרק |
| P7-2 | **שער A (רועי):** מדרג עברית ומחליט לפי הספים | לא עבר: P5-14 ו-P5-18 חוזרות, ושלב 7 נעצר |
| P7-3 | **הממשק ו-`CascadedVoiceEngine`:** `VoiceEngine`, אירועים, `ApprovedText`. השרשרת של היום עוברת מאחורי הממשק בלי שינוי התנהגות | contract tests עם מנוע מזויף. 756 הבדיקות הקיימות עוברות. voice lab על השרשרת לא יורד |
| P7-4 | **`GeminiLiveVoiceEngine` מוקשח:** session resumption, דחיסת הקשר, חיבור מחדש לפני שה-WebSocket מתחלף, ריקון התור ב-`interrupted`, תקרת עלות, `GEMINI_PRIVACY_REVIEWED` | contract tests עם Gemini מזויף, סשן של 30 דקות |
| P7-5 | **`MeetingVoiceBridge`:** קישור לתור, חסימה בספק, תשובה סמכותית רק כ-`ApprovedText` | בדיקות על שני המתאמים: דובר נכון, "כן" של אחר לא מאשר, אין התאמה ולכן אין ביצוע |
| P7-6 | **`VoiceEngineRouter`:** ברירת מחדל של ה-workspace ו-override, בחירה פעם אחת לפגישה, ו-fallback בגבול בטוח | בדיקות: בחירה דטרמיניסטית, override מחוץ לרשימה נדחה, fallback רק אחרי עצירת פלט ועם הודעה |
| P7-7 | **`voice-bench` משותף:** contract, תרחישים מוקלטים, בטיחות, זמנים ועלות על כל מנוע, עם המלצת `PROMOTE`, `KEEP` או `REJECT` | רץ על `cascaded` ועל `gemini-live` |
| P7-8 | **דוח החלטה** `docs/VOICE_ENGINE_DECISION.md` מתוצאות `voice-bench` | `unauthorizedWrites`, `wrongSpeakerAttributions` ו-`ungroundedSpokenClaims` = 0 |
| P7-9 | **canary חי (רועי):** פגישה ב-Meet עם override ל-`gemini-live`, בהסכמת המשתתפים | רועי מחליט, וקידום הוא שינוי config ידני |
| P7-10 | **בחירה לפי מדיניות בנתב:** שפה, יכולות, בריאות, פרטיות, עלות ובנצ'מרק מאושר | אחרי שיש שני מנועים בשימוש |

## שער A: ספים, נקבעו לפני הניסוי

תוצאה שלא עומדת בסף אחד נכשלת. אין "כמעט עבר", ואין פרשנות בדיעבד.

**חזרות:**
- 5 לכל תרחיש.
- 10 לתרחישי בטיחות: שיחה לא מופנית, חצי משפט, שניים מדברים יחד.
- v2 רץ באותו מספר חזרות, על אותו commit ובאותם תרחישים.

| מדד | סף |
|---|---|
| `responsesToNonAddressed` | 0 |
| `prematureResponses` | 0 |
| התחילה לדבר בזמן שמישהו מדבר | 0 |
| `interruptionMs` p95 | עד 500 ms, ולא יותר מ-v2 ועוד 100 ms |
| `lostQuestions` | לא יותר מ-v2 |
| `firstAudibleMs` p50 | עד 2.5 שניות |
| `hebrewQuality` | לפחות 4/5 בהבנה ולפחות 4/5 בטבעיות, ב-10 דגימות שרועי מדרג |
| הקלטות של אנשים אמיתיים | אותם ספים. הקלטות Attendee מהפגישות ב-Meet, ואם אין, רועי מקליט 20 משפטים |
| `usdPerMeetingHour` | עד פי 1.5 מה-baseline של v2, ובשום מקרה לא מעל $3 |

**מדווח ולא שער:** האם Gemini מקריא טקסט נתון מילה במילה. זה קובע אם `speakApprovedText` שלו ישתמש ב-Gemini או ב-TTS נשלט.

## סיכונים

| סיכון | מה עושים |
|---|---|
| Nogita נקשרת לספק אחד | `VoiceEngine` ו-`voice-bench` אחד. כל מה שקובע הרשאה ותוכן נשאר מחוץ למתאם |
| מנוע עונה לכל מי שמדבר בחדר | נמדד בשער A (`responsesToNonAddressed` = 0) |
| מנוע עונה מהידע שלו במקום לבדוק | תשובה סמכותית רק כ-`ApprovedText`. `ungroundedSpokenClaims` נספרות, והשער דורש 0 |
| הרשאה לדובר הלא נכון | הגשר מקשר לתור. אין התאמה חד-משמעית, אין ביצוע |
| מעבר ספק שובר שיחה | בחירה פעם אחת לפגישה, ו-fallback רק בגבול בטוח עם הודעה |
| בנצ'מרק משנה ייצור בטעות | הוא רק ממליץ. קידום הוא שינוי config של אדם |
| אודיו של פגישה נשלח לספק חיצוני | דגל privacy review לכל ספק, אזור נתונים בנתב, והסכמת משתתפים לפני canary |
| עלות | עד פי 1.5 מ-v2 כשער, $3 כעצירה, $25 לניסוי |
| סשן נחתך אחרי 10-15 דקות (Gemini) | resumption ודחיסת הקשר ב-P7-4 |
| עברית | כבר בשער A: TTS של Gemini למשתתפים סינתטיים (ל-Aura אין עברית), הקלטות אמיתיות, ודירוג של רועי |

## מה ידוע על Gemini Live API

נבדק ב-2 וב-3 בנובמבר 2026.

- **מודל:** `gemini-3.8-live`, עם native audio.
- **אודיו:** נכנס 16kHz PCM, וזה מה ש-Attendee שולח. יוצא 24kHz, וצריך להמיר ל-16kHz.
- **VAD:** אוטומטי, ואפשר לכוונן או לכבות אותו.
- **קטיעה:** `interrupted` מגיע כשנכנסים לדיבור שלו, וצריך לרוקן מיד את התור המקומי.
- **proactive audio:** מופעל תמיד.
- **פונקציות:** `NON_BLOCKING` ותזמון (`WHEN_IDLE`).
- **תמלול:** של מה שנכנס ושל מה שהמודל אמר.
- **אורך סשן:** בלי דחיסה, סשן אודיו מוגבל ל-15 דקות, וה-WebSocket מתחלף בערך כל 10 דקות.
- **עברית:** נתמכת רשמית.
- **עלות:** היסטוריה שנספרת מחדש בכל תור, תמלול, והאזנה פרואקטיבית.

## מה קורה בינתיים לתיקוני התורות

- **P5-14 ו-P5-18:** מסומנות `[-]` בלוח, כך שה-board לא מריץ אותן. אם Gemini לא עובר את שער A, הן חוזרות ל-`[ ]` בלי ניסיונות הצלה.
- **P5-15, P5-16 ו-P5-19:** ממשיכות. הן ב-engine, ומגינות בכל מנוע.
- **P5-17** (וידאו): לא קשורה.

## מקורות

- [Live API overview](https://ai.google.dev/gemini-api/docs/live-api)
- [Live API capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities)
- [Session management](https://ai.google.dev/gemini-api/docs/live-api/session-management)
- [Best practices, כולל מחיר וחיוב](https://ai.google.dev/gemini-api/docs/live-api/best-practices)
