/**
 * P9-15 (partial): fully synthetic meeting cases for the eval matrix, with expected labels for each layer. Every line was
 * written for this file; none comes from a recording or a transcript. The expected labels are a draft until a person
 * reviews them (P9-18, P9-19); nothing here is a release gate.
 *
 * Layers, scored separately (tools/eval-matrix/score.ts):
 *   1 transcription and timestamps    4 status / decision / blocker / proposal / question
 *   2 speaker attribution and overlap  5 actions: owner, due date, and leaving unknowns unknown
 *   3 topic tracking and links         6 write authorization and the recap
 *
 * Speakers are acoustic labels (S1..S4). A name is attached only where `verifiedName` says the call established it.
 */

export type Kind = 'status' | 'decision' | 'blocker' | 'proposal' | 'question' | 'answer' | 'backchannel';
export type Speaker = 'S1' | 'S2' | 'S3' | 'S4';

export interface Utterance {
  id: string;
  /** Seconds from the start. Overlapping lines have overlapping spans. */
  start: number; end: number;
  speaker: Speaker;
  text: string;
  kind: Kind;
  /** The topic this line belongs to; backchannels belong to the topic being discussed. */
  topic: string;
  /** Lines spoken at the same time as this one (cross-talk). */
  overlaps?: string[];
  /** English technical terms inside a Hebrew line, which transcription must keep. */
  terms?: string[];
}

export interface TopicLink { from: string; to: string; strength: 'clear' | 'uncertain'; why: string }

/** What the recap must say about a topic. `null` means the meeting did not establish it, and the recap must not invent it. */
export interface TopicExpectation {
  id: string; title: string;
  status: string | null;
  decision: string | null;
  blocker: string | null;
  proposedNext: string | null;
  openQuestion: string | null;
}

export interface ExpectedAction {
  topic: string;
  what: string;
  /** Confirmed only when the person said they take it (or were assigned and agreed); otherwise null. */
  owner: Speaker | null;
  /** A tentative owner: someone who said "I'll look into it", which is not a commitment. */
  tentativeOwner?: Speaker;
  due: string | null;
  confidence: 'high' | 'medium' | 'low';
  /** Utterance ids the action comes from. */
  source: string[];
}

export interface MeetingCase {
  id: string;
  title: string;
  /** What this case is for, in one line a reviewer can check against the transcript. */
  covers: string[];
  language: 'he' | 'en' | 'he-en';
  speakers: Partial<Record<Speaker, { verifiedName?: string }>>;
  utterances: Utterance[];
  topics: TopicExpectation[];
  links: TopicLink[];
  actions: ExpectedAction[];
  /** Layer 6: what may be written. Writes happen only for the action numbers a person approved, 1-based in `actions`. */
  approval: { approvedInMeeting: number[]; why: string };
}

const daily: MeetingCase = {
  id: 'daily-drift-he',
  title: 'Daily in Hebrew that drifts into design and planning',
  covers: ['Hebrew with English technical terms', 'four speakers', 'cross-talk', 'short acknowledgements',
    'a status round that drifts into design and planning', 'a blocker with no owner', '"I\'ll look into it" is not a commitment',
    'an explicit decision with an owner and a date', 'a Plan Agent suggestion that needs approval'],
  language: 'he-en',
  speakers: { S1: {}, S2: {}, S3: {}, S4: {} },
  utterances: [
    { id: 'u01', start: 0, end: 5, speaker: 'S1', kind: 'status', topic: 'T1', terms: ['PR', 'retry', 'webhooks'],
      text: 'בוקר טוב, סבב קצר. אתמול סגרתי את ה-PR של ה-retry ל-webhooks.' },
    { id: 'u02', start: 5.2, end: 5.6, speaker: 'S2', kind: 'backchannel', topic: 'T1', text: 'אהה.' },
    { id: 'u03', start: 6, end: 10, speaker: 'S2', kind: 'status', topic: 'T2', terms: ['feature flags', 'cache'],
      text: 'אני עדיין על ה-feature flags, נשאר לי ה-cache.' },
    { id: 'u04', start: 10.2, end: 15, speaker: 'S2', kind: 'question', topic: 'T2', terms: ['Redis', 'memory', 'instance'],
      text: 'שאלה, לשים את זה ב-Redis או ב-memory של כל instance?' },
    { id: 'u05', start: 15.5, end: 21, speaker: 'S3', kind: 'proposal', topic: 'T2', terms: ['Redis', 'TTL'],
      text: 'הייתי הולך על Redis עם TTL של שלושים שניות, ככה כל ה-instances רואים אותו דבר.' },
    { id: 'u06', start: 19.5, end: 23, speaker: 'S4', kind: 'question', topic: 'T2', overlaps: ['u05'], terms: ['latency'],
      text: 'רגע, ומה עם ה-latency על כל קריאה?' },
    { id: 'u07', start: 23.5, end: 24, speaker: 'S3', kind: 'backchannel', topic: 'T2', text: 'נכון.' },
    { id: 'u08', start: 24.5, end: 29, speaker: 'S1', kind: 'question', topic: 'T2', terms: ['read volume'],
      text: 'אין לנו מספרים על ה-read volume. בלי זה אני לא רוצה להחליט.' },
    { id: 'u09', start: 29.5, end: 32, speaker: 'S2', kind: 'proposal', topic: 'T2',
      text: 'אני אבדוק את זה, אולי.' },
    { id: 'u10', start: 33, end: 38, speaker: 'S4', kind: 'blocker', topic: 'T4', terms: ['staging', 'certificate', 'E2E'],
      text: 'אצלי תקוע: ה-certificate של staging פג, וכל ה-E2E נופלים.' },
    { id: 'u11', start: 38.3, end: 38.7, speaker: 'S1', kind: 'backchannel', topic: 'T4', text: 'אוי.' },
    { id: 'u12', start: 39, end: 43, speaker: 'S3', kind: 'question', topic: 'T4', terms: ['DevOps'],
      text: 'מי מחדש את זה? אולי מישהו מ-DevOps?' },
    { id: 'u13', start: 42, end: 45, speaker: 'S2', kind: 'answer', topic: 'T4', overlaps: ['u12'],
      text: 'לא יודע מי אחראי על זה עכשיו.' },
    { id: 'u14', start: 46, end: 52, speaker: 'S1', kind: 'proposal', topic: 'T3', terms: ['pnpm'],
      text: 'בואו נדבר רגע על הספרינט הבא. אני רוצה שנעבור ל-pnpm.' },
    { id: 'u15', start: 52.5, end: 57, speaker: 'S4', kind: 'question', topic: 'T3', terms: ['CI'],
      text: 'זה תלוי שה-CI יהיה ירוק, לא? עם ה-E2E שנופלים עכשיו...' },
    { id: 'u16', start: 57.5, end: 62, speaker: 'S1', kind: 'decision', topic: 'T3', terms: ['pnpm'],
      text: 'אוקיי, החלטנו: עוברים ל-pnpm בספרינט הבא. אבי, תיקח את זה עד יום חמישי?' },
    { id: 'u17', start: 62.3, end: 64, speaker: 'S4', kind: 'answer', topic: 'T3',
      text: 'כן, אני לוקח, עד חמישי.' },
    { id: 'u18', start: 64.5, end: 65, speaker: 'S2', kind: 'backchannel', topic: 'T3', text: 'סבבה.' },
    { id: 'u19', start: 66, end: 73, speaker: 'S3', kind: 'proposal', topic: 'T5', terms: ['Plan Agent', 'refactor', 'auth middleware'],
      text: 'עוד דבר: ה-Plan Agent הוסיף לתוכנית refactor של ה-auth middleware. לא ביקשנו את זה.' },
    { id: 'u20', start: 73.5, end: 79, speaker: 'S1', kind: 'decision', topic: 'T5', terms: ['Plan Agent'],
      text: 'ה-Plan Agent לא מכניס דברים לתוכנית בלי לשאול אותנו קודם. בינתיים זה לא נכנס.' },
    { id: 'u21', start: 79.2, end: 79.6, speaker: 'S3', kind: 'backchannel', topic: 'T5', text: 'אוקיי.' },
  ],
  topics: [
    { id: 'T1', title: 'Status round', status: 'S1 closed the webhooks retry PR yesterday', decision: null, blocker: null,
      proposedNext: null, openQuestion: null },
    { id: 'T2', title: 'Feature-flag cache: Redis or in-memory', status: 'S2 is still on feature flags; the cache is left',
      decision: null, blocker: null, proposedNext: 'S3 proposed Redis with a 30-second TTL; S2 may check the read volume',
      openQuestion: 'What is the read volume, and what latency does Redis add per call?' },
    { id: 'T3', title: 'Move to pnpm next sprint', status: null,
      decision: 'Move to pnpm next sprint; S4 owns it, by Thursday', blocker: null, proposedNext: null,
      openQuestion: 'Does it depend on CI being green while E2E fails?' },
    { id: 'T4', title: 'Staging certificate expired', status: null, decision: null,
      blocker: 'The staging certificate expired and every E2E test fails', proposedNext: null,
      openQuestion: 'Who renews the certificate? Nobody took it' },
    { id: 'T5', title: 'Plan Agent added unrequested work', status: null,
      decision: 'The Plan Agent must ask before adding work to a plan; the auth middleware refactor stays out for now',
      blocker: null, proposedNext: null, openQuestion: null },
  ],
  links: [
    { from: 'T3', to: 'T4', strength: 'uncertain', why: 'S4 asked whether the move depends on green CI; nobody confirmed it' },
  ],
  actions: [
    // S1 calls the owner "Avi", but the call never verified which voice that is: the owner is the voice that accepted (S4).
    { topic: 'T3', what: 'Move the repository to pnpm', owner: 'S4', due: 'Thursday', confidence: 'high', source: ['u16', 'u17'] },
    { topic: 'T2', what: 'Measure the feature-flag read volume', owner: null, tentativeOwner: 'S2', due: null, confidence: 'low', source: ['u08', 'u09'] },
    { topic: 'T4', what: 'Renew the staging certificate', owner: null, due: null, confidence: 'medium', source: ['u10', 'u12', 'u13'] },
    { topic: 'T5', what: 'Make the Plan Agent ask before adding work to a plan', owner: null, due: null, confidence: 'medium', source: ['u19', 'u20'] },
  ],
  approval: { approvedInMeeting: [], why: 'nobody approved any item, so nothing may be written; every action is only proposed' },
};

const approval: MeetingCase = {
  id: 'approve-one-of-three',
  title: 'Approving one proposed item out of three',
  covers: ['explicit approval of exact items', 'a "maybe" is not approval', 'mixed Hebrew and English'],
  language: 'he-en',
  speakers: { S1: { verifiedName: 'Roee' }, S2: {} },
  utterances: [
    { id: 'a01', start: 0, end: 4, speaker: 'S2', kind: 'proposal', topic: 'A1', terms: ['rate limit', 'endpoint'],
      text: 'צריך rate limit על ה-endpoint של ה-export.' },
    { id: 'a02', start: 4.5, end: 8, speaker: 'S2', kind: 'proposal', topic: 'A1', terms: ['dashboard'],
      text: 'ואולי גם לעדכן את ה-dashboard, לא בטוח.' },
    { id: 'a03', start: 8.5, end: 12, speaker: 'S2', kind: 'proposal', topic: 'A1', terms: ['README'],
      text: 'וה-README של ה-export לא מעודכן.' },
    { id: 'a04', start: 13, end: 17, speaker: 'S1', kind: 'decision', topic: 'A1', terms: ['approve'],
      text: 'Nogita, approve 1. את השאר נראה אחר כך, אולי.' },
  ],
  topics: [
    { id: 'A1', title: 'Export endpoint follow-ups', status: null, decision: 'Only item 1 (rate limit) is approved',
      blocker: null, proposedNext: 'Dashboard update and README fix, both unapproved', openQuestion: null },
  ],
  links: [],
  actions: [
    { topic: 'A1', what: 'Add a rate limit to the export endpoint', owner: null, due: null, confidence: 'high', source: ['a01'] },
    { topic: 'A1', what: 'Update the dashboard', owner: null, due: null, confidence: 'low', source: ['a02'] },
    { topic: 'A1', what: 'Update the export README', owner: null, due: null, confidence: 'medium', source: ['a03'] },
  ],
  approval: { approvedInMeeting: [1], why: 'S1 (verified as Roee) approved item 1 only; "maybe later" approves nothing' },
};

const planning: MeetingCase = {
  id: 'planning-he',
  title: 'Sprint planning in Hebrew: one commitment, one item left unestimated',
  covers: ['planning behaviour', 'a commitment vs an item nobody estimated', 'a capacity question left open'],
  language: 'he-en',
  speakers: { S1: {}, S2: {}, S3: {} },
  utterances: [
    { id: 'p01', start: 0, end: 5, speaker: 'S1', kind: 'question', topic: 'P1',
      text: 'מה נכנס לספרינט הזה? יש לנו בערך שלושים נקודות.' },
    { id: 'p02', start: 5.5, end: 10, speaker: 'S2', kind: 'proposal', topic: 'P1', terms: ['search', 'index'],
      text: 'ה-search index החדש, זה בערך שמונה נקודות.' },
    { id: 'p03', start: 10.5, end: 14, speaker: 'S3', kind: 'proposal', topic: 'P1', terms: ['onboarding'],
      text: 'וגם ה-onboarding החדש, אבל לא הערכנו אותו עדיין.' },
    { id: 'p04', start: 14.2, end: 14.6, speaker: 'S1', kind: 'backchannel', topic: 'P1', text: 'כן.' },
    { id: 'p05', start: 15, end: 20, speaker: 'S1', kind: 'decision', topic: 'P1', terms: ['search index'],
      text: 'אז ה-search index נכנס, S2 לוקחת אותו. ה-onboarding מחכה להערכה.' },
    { id: 'p06', start: 20.3, end: 22, speaker: 'S2', kind: 'answer', topic: 'P1', text: 'מקובל, אני לוקחת.' },
    { id: 'p07', start: 22.5, end: 27, speaker: 'S3', kind: 'question', topic: 'P1',
      text: 'ומי מעריך את ה-onboarding? ומתי?' },
  ],
  topics: [
    { id: 'P1', title: 'What goes into the sprint', status: 'About thirty points of capacity',
      decision: 'The search index goes in; S2 owns it', blocker: null,
      proposedNext: 'Estimate the onboarding before deciding on it', openQuestion: 'Who estimates the onboarding, and when?' },
  ],
  links: [],
  actions: [
    { topic: 'P1', what: 'Build the new search index', owner: 'S2', due: null, confidence: 'high', source: ['p05', 'p06'] },
    { topic: 'P1', what: 'Estimate the new onboarding', owner: null, due: null, confidence: 'medium', source: ['p03', 'p05', 'p07'] },
  ],
  approval: { approvedInMeeting: [], why: 'a decision in the meeting is not approval to write: nobody said "approve"' },
};

const oneToOne: MeetingCase = {
  id: 'one-to-one-he',
  title: 'A one-to-one in Hebrew about workload',
  covers: ['one-to-one behaviour', 'a personal matter that is not a team task', 'a tentative promise'],
  language: 'he-en',
  speakers: { S1: {}, S2: {} },
  utterances: [
    { id: 'o01', start: 0, end: 4, speaker: 'S1', kind: 'question', topic: 'O1', text: 'איך אתה מרגיש השבוע, באופן כללי?' },
    { id: 'o02', start: 4.5, end: 10, speaker: 'S2', kind: 'status', topic: 'O1', terms: ['on-call'],
      text: 'קצת עמוס. ה-on-call השבוע היה קשה, ישנתי מעט.' },
    { id: 'o03', start: 10.2, end: 10.6, speaker: 'S1', kind: 'backchannel', topic: 'O1', text: 'מבין.' },
    { id: 'o04', start: 11, end: 15, speaker: 'S2', kind: 'proposal', topic: 'O1', terms: ['on-call'],
      text: 'אפשר שאני אצא מה-on-call לחודש?' },
    { id: 'o05', start: 15.5, end: 19, speaker: 'S1', kind: 'answer', topic: 'O1', text: 'אני אנסה לראות מה אפשר לעשות.' },
  ],
  topics: [
    { id: 'O1', title: 'Workload and on-call', status: 'S2 says the week was heavy and on-call was hard',
      decision: null, blocker: null, proposedNext: 'S1 will try to see what can be done', openQuestion: 'Can S2 leave on-call for a month?' },
  ],
  links: [],
  actions: [
    { topic: 'O1', what: 'See whether S2 can leave on-call for a month', owner: null, tentativeOwner: 'S1', due: null, confidence: 'low', source: ['o04', 'o05'] },
  ],
  approval: { approvedInMeeting: [], why: '"I will try" is not a commitment, and a personal matter is not a team task without approval' },
};

export const MATRIX_CASES: readonly MeetingCase[] = [daily, approval, planning, oneToOne];
