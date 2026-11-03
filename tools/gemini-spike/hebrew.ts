/**
 * P7-1: Hebrew and mixed Hebrew-English turns for gate A. Spoken by Gemini TTS voices (Aura has no Hebrew), with the
 * same expectations as the English scenarios: answer when addressed, stay silent otherwise, wait out a pause.
 */
import type { Participant, Scenario } from '../voice-lab/scenarios.ts';

const roee: Participant = { id: 'roee', name: 'Roee', voice: 'Charon', authorized: true, mic: 'open' };
const dana: Participant = { id: 'dana', name: 'Dana', voice: 'Aoede', authorized: true, mic: 'open' };

export const HEBREW_SCENARIOS: Scenario[] = [
  {
    name: 'he-questions', title: 'Hebrew: questions to her, and talk between people', noise: { kind: 'quiet', snrDb: 60 },
    participants: [roee, dana],
    turns: [
      { speaker: 'roee', say: 'נוגיטה, מה בעצם הפרויקט הזה עושה, במשפט אחד?', expect: { respond: 'speak' } },
      { speaker: 'dana', say: 'רועי, אתה מגיע לסטנדאפ מחר בבוקר?', gapMs: 1500, expect: { respond: 'silent' } },
      { speaker: 'roee', say: 'כן, אני אגיע. רק תזכירי לי את השעה.', gapMs: 600, expect: { respond: 'silent' } },
      { speaker: 'dana', say: 'נוגיטה, מה ההבדל בין משימה פתוחה למשימה סגורה?', gapMs: 1200, expect: { respond: 'speak' } },
    ],
  },
  {
    name: 'he-half-sentence', title: 'Hebrew: a long pause in the middle of a request', noise: { kind: 'keyboard', snrDb: 25 },
    participants: [roee],
    turns: [
      { speaker: 'roee', say: ['נוגיטה, אני רוצה לדעת', 'כמה משימות פתוחות יש לנו כרגע בלוח'], pauseMs: 1800, expect: { respond: 'speak' } },
      { speaker: 'roee', say: ['אז בעצם', 'תסבירי לי מה זה turn taking'], pauseMs: 1500, gapMs: 1500, expect: { respond: 'speak' } },
    ],
  },
  {
    name: 'he-mixed', title: 'Mixed Hebrew and English in one sentence', noise: { kind: 'pink', snrDb: 30 },
    participants: [roee, dana],
    turns: [
      { speaker: 'roee', say: 'נוגיטה, תגידי לי מה זה cache invalidation, בקצרה', expect: { respond: 'speak' } },
      { speaker: 'dana', say: 'נוגיטה, ה-build על main עבר את ה-CI?', gapMs: 1200, expect: { respond: 'speak' } },
      { speaker: 'roee', say: 'דנה, את עושה את ה-code review היום או מחר?', gapMs: 1500, expect: { respond: 'silent' } },
    ],
  },
  {
    name: 'he-barge-in', title: 'Hebrew: stopping her mid-answer', noise: { kind: 'pink', snrDb: 25 },
    participants: [roee],
    turns: [
      { speaker: 'roee', say: 'נוגיטה, תסבירי לי בפירוט איך עובדת מערכת של בקשות משיכה, מההתחלה ועד המיזוג.', expect: { respond: 'speak' } },
      { speaker: 'roee', say: 'רגע, עצרי.', bargeIn: { afterAudioMs: 2500, kind: 'interrupt' }, expect: { respond: 'any' } },
      { speaker: 'roee', say: 'נוגיטה, רק תגידי לי כמה שלבים יש בתהליך.', gapMs: 1200, expect: { respond: 'speak' } },
    ],
  },
];
