# Voice parity — תוכנית ביצוע

ממשיכה את `HUMAN_CONVERSATION_PLAN.md` ואת `VOICE_PARITY_PLAN.md`.
אישור להתחלת עבודה: 30.10.2026. אין במסמך טענה שהיעדים כבר הושגו.

## P0 — מדידה וביטול לפני שינוי התנהגות

משלוח ראשון: מדדים שאפשר לבדוק אופליין, בלי ספק חדש ובלי שינוי ספי קול.

- [x] לתקן את בסיס הזמן בדוח: transcript receipt אינו סוף הדיבור בפועל;
  adoption של ספקולציה מתחיל מדידת transcript latency באישור, לא בפתיחת הניסיון.
- [x] לספור ניסיונות ספקולטיביים לפי מזהה שאלה: started/adopted/rolled back/unresolved.
- [x] למדוד לכל צעד מודל זמן עד text delta ראשון; לא לכנות זאת token latency של כלי או thinking.
- [x] לתעד אירועי Flux eager/confirmed/resumed ומרחק מהפריים האחרון שעבר own-voice gate.
  זהו אומדן בצד השרת, לא ground truth של מיקרופון המשתתף.
- [x] להציג חוסר נתונים במפורש; speculative rollback אינו שאלה שהמשתמש איבד.
- [x] להריץ בדיקות יחידה, typecheck ורגרסיות ספקולציה, writes, stale audio וקטיעות.
- [x] baseline חדש ב־voice lab: אותה רשימת תסריטים, אותה תצורה, warm/cold בנפרד.
  בנוסף ל־smoke על `solo-quick`, הושלמו 19 תורים זהים בשישה תרחישים בכל מצב.
- [ ] פגישות Meet בהסכמה: לאמת זמן שמיעה אצל המשתתף והפרעות אמיתיות.

ב־P0 כבר הושלמו IDs מפורשים שמקשרים audio playback, STT turn, question
ו־model step, וכן TTFA מסינתזה. first substantive content נמדד בנפרד מ־ack
ב־`meaningfulGap`; עוד נדרשים עלות ניסיון מבוטל וסיווג false stops ידני/מתויג. אין להסיק את
המדדים החסרים מן המדדים הזמינים היום.

## P1 — השוואת ספקים ו־ack מבוקר

1. ממשק SpeechOutputPort עם capabilities ו־openTurn/pushText/flush/cancel.
   adapter קיים נשמר כ־baseline. סדר PCM, backpressure וביטול הם חלק מהחוזה.
2. benchmark על אותן תשובות מול Aura וספקי ניסיון זמינים; טקסט קבוע בנפרד
   משיחה חיה. לתעד גרסה, אזור, latency distribution, איכות, עלות וכישלונות.
3. לבחור קול על סמך תוצאות. קטעי ack באותו קול; נכסים מופקים רק לאחר הבחירה.
4. ack הוא פריט של SpeechFloor עם question owner וביטול. הוא עוקף synthesis
   בלבד, נופל כשהתשובה מוכנה ואינו מתנגן בזמן שאדם מדבר.

יציאה: אין שמע אחרי ביטול, אין חפיפה בין owners, אין השהיה חדשה משמעותית
של תשובה מוכנה. בחירת ספק היא החלטה על סמך benchmark, לא טענת ביצועים במסמך.

## P2 — streaming ו־turn-taking

1. הזרמת phrases בממשק החדש; alignment אמיתי או אומדן מסומן ל־heard/unheard.
2. כיול eager threshold בנפרד מכל שינוי אחר; מכסת concurrency ותקציב ספקולציה.
3. Smart Turn תחילה כמדידה ב־shadow; benchmark CPU ותועלת מול Flux לפני שילוב.
4. מסווג backchannel בשני שלבים: acoustic onset ואז חלון קצר ל־interim.
   stop מפורש מקבל עדיפות; דיבור מתמשך עוצר גם כשהתמלול נכשל.
5. pronunciation/prosody לפי יכולות הספק. Fade מוגבל בתקציב interruption latency.

יעדים: p95 עצירה עד 300ms בצד המשתתף, false stops עד 2%, אפס חיתוך אדם
בסט הקבלה. זה אינו מבטיח אפס שגיאות בעולם; מדווחים גודל מדגם ורווחי סמך.

## P3 — talker/thinker מדורג

1. routing לפי צורך; אין שני מודלים לכל שאלה כברירת מחדל.
2. shadow mode ללא פלט נוסף וללא writes במסלול הניסוי.
3. acknowledgment-only לפני תוכן עובדתי.
4. תוכן עובדתי רק עם evidence, מקור, revision/TTL והרשאות לדובר ול־tenant.
   קיום evidence ID אינו הוכחה שהטענה נובעת ממנו; בודקים גם entailment ונכונות.
5. thinker יכול להחליף תוכן שעוד לא הושמע. אין לנחש מספר retries ולתקן אחר כך.
6. מעבר ל־mission שומר על אותה בקשה, בעלים והרשאות, ללא ביצוע כפול.

cache לפגישה וזיכרון בין פגישות הם החלטות שונות. אין להרחיב שמירה מתמשכת
או הרשאות כתוצאה מ־prefetch. עזיבת משתתף/שינוי הרשאות דורשים invalidation.

## P4 — השוואה ו־S2S ניסיוני

השוואת TTS על טקסט זהה והשוואת agent על שאלות זהות בנפרד. דירוג עיוור,
סדר אקראי, מאפייני הקלטה אחידים ומספר מאזינים/רווחי סמך מדווחים.
50% העדפה הם parity בלבד. מודל שופט הוא כלי אבחון, לא שער יחיד.
ניסוי S2S רק לאחר מדידת P0–P3 ותקציב מוגדר.

## שערים משותפים ו־rollback

- אפס כתיבות ואפס שמע ספקולטיבי לפני אישור בסט הבדיקות.
- TurnResumed, stop, cancel, ניתוק ועזיבה אינם משחררים עבודה ישנה.
- שני דוברים, רעש, echo, pause אחרי השם, follow-up ללא שם ותמלול מתוקן
  כלולים בסט הרגרסיה; המדיניות אינה "רק בשם" באופן מוחלט.
- כל ניסוי התנהגותי מקבל flag עצמאי כבוי כברירת מחדל; rollback לספק/מסלול הקיים.
- שינוי latency מתקבל רק ללא הרעה בנכונות, הרשאות, false stops ואיבוד שאלות.
- ריצות ספקים חיות עולות כסף; רישום לספק חדש, שינוי deployment ו־Meet עם אנשים
  מתבצעים כשיש גישה/תקציב/משתתפים מתאימים. בינתיים משלימים בדיקות מקומיות.

## הערות על הסקירה

`trackVoiceLevel` מסמן פעילות own-voice; לאחר 80ms רצופים הוא משהה playback
פעיל אחרי הפריים שכבר נשלח. interim של backchannel מחדש את התור; interim אחר
או דיבור רצוף ללא תמלול מבטלים אותו. לכן false-stop ו־backchannel הם שערי
שחרור מפורשים לפני rollout רחב. `unheard` הוא אומדן לפי זמן ותווים, לא alignment.
טענות ספקים, מחירים ויכולות ב־VOICE_PARITY_PLAN דורשות אימות תיעוד רשמי
בעת בחירת ספק; אינן בסיס לקבלת החלטה בשלב המדידה המקומי.

## תוצאת המשלוח הראשון — 30.10.2026

בוצעו השינויים המסומנים ב־P0; מדדי model_first_text ו־eot_timing מחוברים
גם ללאב. אין שינוי בספי EOT, בספק הקול או במדיניות מתן הרשאות.

- typecheck עבר. הסוויטה המלאה: 431/432 עברו, כולל ארבע בדיקות המדדים החדשות.
- הכישלון הקיים ב־repository-guardrails.test.ts: רשימת הקבצים המותרים מחריגה
  רק `.env.example`, בעוד `.env.control.example` כבר tracked. שני הקבצים הללו
  לא שונו במהלך העבודה. הסוויטה המלאה עדיין אינה ירוקה.
- smoke baseline חי: `solo-quick`, Flux EOT 0.8, eager 0.5, Haiku 5.5,
  Aura-2 Thalia, thinking off, writes intercepted. תוצאות 4/4; שלוש תשובות:
  1479, 1868, 2853ms. שלוש ספקולציות אומצו, אפס שאלות אבודות ואפס תחילות
  דיבור מעל אדם בסט זה. אין בו בדיקת barge-in ואין די מדגם לקביעת p95.
- פירוק הלאב: endpointing p50 1034ms, engine/model עד משפט ראשון 485ms
  לאחר אישור התור, TTS/transport 207ms. אין לחבר אחוזונים כדי לשחזר אחוזון כולל.
- זמן עד text delta ראשון בשלוש הקריאות: 786, 706, 1140ms.
- אומדן own-voice ל־EOT היה גבוה מה־endpointing המתויג: סף העוצמה עשוי
  לא לזהות סיומות חלשות. המדד נשאר diagnostic ואינו בסיס לכיול סף לבדו.
- דוח הריצה: `.voice-lab/reports/2026-10-30T20-53-05-691Z/report.html`.

באותו שלב המשלוח הבא הוגדר כהשלמת קישור IDs ו־playback ו־baseline רחב; תוצאותיו
מופיעות להלן. baseline חוזר עם הפרדת warm/cold ובדיקת Meet עדיין לא בוצעו,
וכך גם בחירת ספק, נכסי ack ו־talker/thinker.

## תוצאת משלוח ההמשך — קטיעה, trace IDs ו־baseline רחב

הושלמו קישורי `inputTurnId → questionId → playbackId`, כולל TTFA מסינתזה,
אירועי playback מפורשים ואבחנה בין קטיעה אקוסטית ל־stop פקודי. ביטול עובד גם
בזמן handshake של TTS, ו־abort ספקולטיבי משחרר כתיבה שממתינה לאישור ואינו
מאפשר לכתיבה שנייה להתחיל אחרי ביטול.

- שער מקומי מלא: `npm test` עבר 450/450, `npm run typecheck` עבר. בדיקת
  repository guardrails עודכנה להכיר רק ב־`.env.control.example` כתבנית מותרת
  ולוודא ששדות סוד בה ריקים; אין עוד כשל ידוע בסוויטה.
- ריצת barge-in לאחר התיקון: 2/2, קטיעה אקוסטית 103ms, אפס resume בתוך אותו
  תור ואפס תחילות playback מעל אדם. הדוח:
  `.voice-lab/reports/2026-10-30T21-21-47-581Z/report.html`.
- שורש תקלת ה־resume היה lease של שנייה אחת: Flux השאיר 1.009s ללא אירוע
  פעילות בתוך אותו משפט מורכב, ולכן ה־floor חידש תשובה ישנה לפני final. ברירת
  המחדל היא כעת 3s (חלון ה־EOT); final משחרר מיד ולכן אינו מוסיף latency תקין.
- קטיעה אינה ממתינה עוד ל־round-trip של STT: own-voice gate של 100ms עוצר
  playback ישירות, ו־STT נשאר מסלול שני. בריצה החיה זמן הקטיעה ירד מ־333ms
  ל־103ms. זה עדיין אומדן בצד השרת; Meet אמיתי חייב לאמת אודיו שכבר נצבר אצל
  המשתתף ושיעור false-stop.
- baseline רחב עם אותה תצורה על 19 תורים: 17/19 בדוח המקורי, אפס שאלות אבודות,
  p50 2122ms ו־p90 3731ms. כשל אחד היה false negative במדד השם: התמלול הכיל
  `Nogita` אבל מילות רקע לפניו מנעו סיווג vocative. המדד תוקן למדוד זיהוי שם
  בנפרד מניתוב כוונה; הכשל האמיתי שנותר הוא wake word שנשמט ברעש משרדי.
  הדוח: `.voice-lab/reports/2026-10-30T21-23-35-809Z/report.html`.
- באותו baseline הייתה התחלת playback אחת בתוך `can you check … which file`.
  hold של 1.5s לא הספיק. לאחר צמצום המסווג כך ש־`how many open?` נשאר שאלה
  מלאה ומהירה, hold של 2.5s נתן 3/3, p50 1701ms, p90 1785ms ואפס דיבור מעל
  אדם: `.voice-lab/reports/2026-10-30T21-30-59-470Z/report.html`.
- ה־hold נשאר ניסוי כבוי כברירת מחדל. לפני הפעלה נדרשים עוד ניסויי false-hold
  על בקשות קצרות אמיתיות; הפעלה ב־canary תהיה `NOGITA_INCOMPLETE_TURN_HOLD_MS=2500`.
- `report.json` שומר כעת גם את זרם האירועים המלא של התרחיש, לצד חלונות האירועים
  היחסיים לכל תור, כך שאפשר לשחזר ולבקר מדדי overlap ולא רק לראות את הציון.

ה־baseline עדיין אינו מסמן את שער P0 כמושלם: לא בוצעה הפרדה שיטתית cold/warm,
אין מדידת client playback מתוך Meet, ואין מדגם מספיק לרווח סמך של false stops.

## תוצאת משלוח ההמשך — warm/cold, backchannels ו־TTS benchmark

נוסף מצב `--warmup=production|cold`. מצב cold מבטל גם את חימום prompt cache
של המודל וגם פתיחת חיבור TTS יזומה; הוא אינו מתיימר למחוק cache בצד הספק.
ב־`solo-quick` התקבלו 3/4 ב־cold (first 3284ms, p50 1892ms, p90 3284ms)
ו־4/4 ב־production (first 1450ms, p50 1814ms, p90 2556ms). זו הוכחת smoke
מקומית בלבד; ה־baseline הרחב והזהה בשני המצבים עדיין פתוח.

מדיניות הקטיעה הופרדה מ־backchannel: own-voice מזוהה אחרי 100ms, חלון קצר
מאפשר ל־interim STT לזהות acknowledgement, ודיבור רצוף עוצר ב־220ms גם בלי
תמלול. לאחר מדידת server-side חיה של 298ms הסף הוקשח ל־220ms כדי להשאיר
מרווח transport; `no`, `wait`, `stop`, `actually`, `hold on` ודיבור מתמשך לעולם אינם
מסווגים כ־backchannel. תרחיש חי עבר 8/8, שמר 4/4 acknowledgements עם אפס
false stops, אפס שאלות אבודות ואפס spoke-over starts. עם n=4 הגבול העליון
של Wilson 95% הוא 48.99%, ולכן שער <=2% עדיין לא הושג ונדרש מדגם גדול.

ריצת המשך הראתה שסף לפי כמות PCM שהגיעה אינו שומר תקציב wall-clock תחת jitter:
למרות 220ms התקבלה עצירה של 304ms. המדידה הוחלפה לדדליין מזמן acoustic onset;
הריצה הבאה עצרה ב־174ms ועברה 2/2. `backchannels` עבר שוב 8/8 ושמר 4/4 ללא
false stop. עם זאת נרשמה התחלת playback אחת 36ms לפני שה־own-voice gate אותת,
אחרי שהדובר כבר התחיל בפועל; לכן שער "אפס חיתוך אדם" ו־Meet אמיתי עדיין פתוחים.

נבנה benchmark עיוור בר־שחזור ל־Deepgram Aura-2 Thalia ול־Cartesia Sonic 3.6:
20 טקסטים קבועים, cold/warm בנפרד, WAV בשמות אקראיים, manifest פרטי, כשלים
ומדדי latency. הריצה החיה השלימה 40/40:

| ספק | מצב | TTFA p50/p90 | completion p50/p90 |
| --- | --- | --- | --- |
| Cartesia Sonic 3.6 | cold | 751/811ms | 1730/1800ms |
| Cartesia Sonic 3.6 | warm | 183/191ms | 1148/1202ms |
| Deepgram Aura-2 Thalia | cold | 742/908ms | 4806/5228ms |
| Deepgram Aura-2 Thalia | warm | 212/270ms | 4025/4879ms |

הנתונים מוכיחים latency וכשלים בלבד. אין עדיין בחירת ספק: נדרשים ציוני האזנה
עיוורים לטבעיות, הגייה, קצב ועייפות קולית, וכן תיעוד עלות ואזור. כתוצאה מכך
גם נכסי ack והחלפת ספק production נשארים חסומים בכוונה.

ה־endpoint שנמדד הוא global/default בשני הספקים ולא region-pinned. המחיר שנבדק
ב־31.10.2026: Aura-2 הוא $0.030 לאלף תווים ב־pay-as-you-go; Cartesia מחייבת
credit אחד לתו, אך מחיר ה־credit תלוי בתוכנית וב־overage. ה־corpus כולל 2,975
תווים לכל ספק, כלומר כ־$0.089 ל־Deepgram; עלות Cartesia תחושב לפי tier החשבון.
לפני rollout נדרש גם review של residency/retention: Deepgram global אינו התחייבות
אזורית, ו־Cartesia מציעה ZDR/VPC לפי תנאי Enterprise ולא כברירת מחדל שהוכחה כאן.
בעקבות הבדיקה, חיבורי Deepgram STT/TTS של production שולחים כעת
`mip_opt_out=true` כברירת מחדל (`DEEPGRAM_MIP_OPT_OUT=false` הוא opt-in מפורש
לתוכנית השיפור). הדבר מונע שמירת תוכן המפגש לצורכי אימון, אך אינו הופך endpoint
גלובלי להתחייבות residency אזורית.

ארטיפקטים מקומיים: `.voice-lab/reports/2026-10-31-backchannels-wall-clock/`,
`.voice-lab/reports/2026-10-31-barge-in-wall-clock/` ו־
`.voice-lab/tts-benchmarks/2026-10-31-deepgram-cartesia/`.

## תוצאת האימות הסופי — pause/resume ו־baseline זהה

המדיניות הקודמת של ביטול ב־220ms יצרה סתירה: STT חי מגיע מאוחר מכדי לדעת אם
ההברה הקצרה היא `right`, אבל אי אפשר להמשיך להשמיע עד אז. הפתרון מפריד כעת בין
עצירת output לבין ביטול התשובה:

- אחרי 80ms של own-voice, אין נשלחים עוד פריימים אחרי הפריים שכבר בקצב playback;
  התור נשמר זמנית.
- interim לא־ריק שמסווג כ־backchannel מחדש מיד; אירוע Flux ריק אינו מבטל.
- interim עם תוכן אחר מבטל; אם אין תמלול כלל, דיבור רצוף מבטל אחרי 1.5s, בזמן
  שהשמע נשאר מושהה כל הזמן.
- מדד הקבלה כולל את סוף הפריים שכבר נשלח, ולא רק את רגע החלטת השרת. trimming
  של קלט TTS משתמש ב־RMS של פריימי 20ms כדי שרעש סינתזה חלש לא יקדים את onset.

בריצה החיה `.voice-lab/reports/2026-10-31-turn-taking-verified/` התקבל barge-in
של 229ms מה־onset האקוסטי עד סוף ה־PCM האחרון, 4/4 backchannels נשמרו, אפס
false stops ואפס התחלת playback מעל אדם. הריצה עברה 9/10: הכשל היחיד היה
תמלול `Nogita, explain` כ־`Nogita explained`, ולכן בקשה אחת לא נותבה. זהו כשל
STT נפרד ולא false stop. ריצה קודמת חשפה ש־Flux `StartOfTurn` ריק ביטל בטעות
`right`; נוספה רגרסיה והביטול דורש כעת hypothesis לא־ריק.

ה־baseline הרחב הזהה הושלם על `office-chatter,crosstalk,stalled-speaker,
rapid-questions,interrupt-resume,cancel-stop` (19 תורים, writes intercepted):

| מצב | עבר | response gap p50/p90 | lost | spoke-over starts |
| --- | ---: | ---: | ---: | ---: |
| cold | 17/19 | 2663/4073ms | 0 | 2 |
| production warm | 16/19 | 2014/3960ms | 0 | 1 |

ה־warm path שיפר p50 ב־649ms במדגם הזה, אך לא שיפר נכונות: נפילות wake word,
chat-only תחת interruption ושונות של ספק נשארו. ריצת production חשפה את
`Lukita` כווריאנט wake word נוסף; הוא נוסף למסווג עם בדיקת רגרסיה ממוקדת.
הדוחות: `.voice-lab/reports/2026-10-31-broad-cold/` ו־
`.voice-lab/reports/2026-10-31-broad-production/`.

העבודה המקומית של P0 הושלמה. שערי השחרור החיצוניים עדיין פתוחים במכוון:
מדידת playback בפגישת Meet בהסכמה, מדגם false-stop שמצמצם את Wilson upper bound
ליעד, ודירוג האזנה עיוור לפני בחירת ספק. בלי שלושת אלה אין בסיס מקצועי לסמן
את יעד p95 אצל המשתתף, <=2% false stops או בחירת TTS כ"הושגו".
