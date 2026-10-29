/**
 * One voice for several open questions. All of Nogita's speech in a voice meeting goes through the floor, so
 * two answers never interleave, nothing new starts while a person is talking, and an answer a participant cut
 * off is kept and finished at the next opening instead of being lost.
 */
export type SpeakOutcome = 'spoken' | 'interrupted' | 'failed';
export type FloorOutcome = SpeakOutcome | 'dropped';
export type DropReason = 'stale' | 'cancelled' | 'no_opening';

interface Item {
  owner: number;
  text: string;
  /** A "let me check" before a lookup: skipped once it is stale or the answer is already waiting. */
  leadIn: boolean;
  queuedAt: number;
  /** Evaluated when the piece is spoken: a topic to name first ("About the login bug, "). */
  prefix?: () => string | undefined;
  resumed: boolean;
  resolve: (outcome: FloorOutcome) => void;
}

export interface SpeechFloorOptions {
  speak: (text: string) => Promise<SpeakOutcome>;
  now?: () => number;
  schedule?: (work: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  /** How long a person counts as still talking after their last recognized speech. */
  talkingMs?: number;
  /** After she was cut off: silence before she finishes the answer (time to hear what was said). */
  resumeAfterMs?: number;
  /** A lead-in older than this is skipped. */
  staleLeadInMs?: number;
  /** People talking this long without an opening: the waiting speech is dropped (every answer is also in chat). */
  maxWaitMs?: number;
  /** An owner that holds the floor but says nothing for this long lets others speak. */
  holdMs?: number;
  onDrop?: (owner: number, text: string, reason: DropReason) => void;
  onInterrupted?: (owner: number) => void;
  onResumed?: (owner: number) => void;
  /** An answer (not a lead-in) is ready but waits for people to stop talking, or no longer waits. */
  onWaiting?: (waiting: boolean) => void;
}

/** "About the login bug, " + "It is open." -> "About the login bug, it is open." (names keep their capital). */
function lead(prefix: string, text: string): string {
  return prefix + text.replace(/^(It|It's|Its|The|That|That's|This|There|There's|They|We|Yes|No|Sure|So|And|A|An|Both|Our|Your|Right|Okay|Still|Nothing|None)\b/,
    word => word.toLowerCase());
}

export class SpeechFloor {
  private readonly queue: Item[] = [];
  private readonly talking = new Map<string, number>();
  private holder?: number;
  private holderSince = 0;
  private speaking = false;
  private playing?: Item;
  private pausedUntil = 0;
  private blockedSince?: number;
  private interruptedOwner?: number;
  private heardSinceInterrupt = false;
  private timer?: unknown;
  private closed = false;
  private waitingReported = false;
  private readonly now: () => number;
  private readonly schedule: (work: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  constructor(private readonly options: SpeechFloorOptions) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((work, delayMs) => {
      const handle = setTimeout(work, delayMs);
      handle.unref?.();
      return handle;
    });
    this.cancel = options.cancel ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  say(owner: number, text: string, options: { leadIn?: boolean; prefix?: () => string | undefined } = {}): Promise<FloorOutcome> {
    if (this.closed) return Promise.resolve('dropped');
    return new Promise(resolve => {
      this.queue.push({ owner, text, leadIn: options.leadIn ?? false, queuedAt: this.now(), prefix: options.prefix,
        resumed: false, resolve });
      this.pump();
    });
  }

  /** The owner's stretch of speech ended (its lookup started, or its answer is complete): others may speak. */
  release(owner: number): void {
    if (this.holder === owner) this.holder = undefined;
    this.pump();
  }

  /** What the owner queued so far turned out to be a lead-in (a tool call followed it). */
  markLeadIns(owner: number): void {
    if (this.playing?.owner === owner) this.playing.leadIn = true;
    for (const item of this.queue) if (item.owner === owner && !item.resumed) item.leadIn = true;
  }

  /** Drops the owner's waiting speech; returns how many pieces were dropped. */
  drop(owner: number, reason: DropReason = 'cancelled'): number {
    let dropped = 0;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const item = this.queue[i]!;
      if (item.owner !== owner) continue;
      this.queue.splice(i, 1);
      this.finish(item, 'dropped', reason);
      dropped++;
    }
    if (this.holder === owner) this.holder = undefined;
    if (this.interruptedOwner === owner) this.interruptedOwner = undefined;
    this.pump();
    return dropped;
  }

  /** A person is talking (live recognition); `ended` when their turn reached Nogita. */
  noteTalking(speaker: string, ended = false): void {
    if (ended) this.talking.delete(speaker);
    else this.talking.set(speaker, this.now() + (this.options.talkingMs ?? 1_000));
    if (ended && this.interruptedOwner !== undefined) this.heardSinceInterrupt = true;
    this.pump();
  }

  /** Whose answer was cut off and is waiting to be finished, if any. */
  get interrupted(): number | undefined { return this.interruptedOwner; }
  /** The owner speaking now, or holding the floor between pieces of one answer. */
  get current(): number | undefined { return this.holder; }
  get busy(): boolean { return this.speaking || this.queue.length > 0; }
  owners(): number[] { return [...new Set(this.queue.map(item => item.owner))]; }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) this.cancel(this.timer);
    for (const item of this.queue.splice(0)) item.resolve('dropped');
  }

  private finish(item: Item, outcome: FloorOutcome, reason?: DropReason): void {
    if (outcome === 'dropped') this.options.onDrop?.(item.owner, item.text, reason ?? 'cancelled');
    item.resolve(outcome);
  }

  private reportWaiting(waiting: boolean): void {
    if (waiting === this.waitingReported) return;
    this.waitingReported = waiting;
    this.options.onWaiting?.(waiting);
  }

  private pump(): void {
    if (this.speaking || this.closed || !this.queue.length) { if (!this.queue.length) this.reportWaiting(false); return; }
    if (this.timer !== undefined) { this.cancel(this.timer); this.timer = undefined; }
    const now = this.now();
    let openingAt = this.pausedUntil;
    for (const [speaker, until] of this.talking) {
      if (until <= now) this.talking.delete(speaker);
      else openingAt = Math.max(openingAt, until);
    }
    if (openingAt > now) {
      this.blockedSince ??= now;
      this.reportWaiting(this.queue.some(item => !item.leadIn));
      if (now - this.blockedSince >= (this.options.maxWaitMs ?? 25_000)) {
        // The room moved on; the answers are in chat.
        for (const item of this.queue.splice(0)) this.finish(item, 'dropped', 'no_opening');
        this.holder = undefined;
        this.interruptedOwner = undefined;
        this.blockedSince = undefined;
        this.reportWaiting(false);
        return;
      }
      this.timer = this.schedule(() => { this.timer = undefined; this.pump(); }, Math.min(openingAt - now, 1_000));
      return;
    }
    this.blockedSince = undefined;
    this.reportWaiting(false);
    // An answer in progress keeps the floor until it ends, so two answers never interleave.
    if (this.holder !== undefined && !this.queue.some(item => item.owner === this.holder)) {
      const holdMs = this.options.holdMs ?? 6_000;
      if (now - this.holderSince < holdMs) {
        this.timer = this.schedule(() => { this.timer = undefined; this.pump(); }, holdMs - (now - this.holderSince));
        return;
      }
      this.holder = undefined;
    }
    // A cut-off answer is finished first.
    const owner = this.holder ?? this.interruptedOwner;
    const index = owner === undefined ? 0 : Math.max(0, this.queue.findIndex(item => item.owner === owner));
    const item = this.queue[index]!;
    if (item.leadIn && !item.resumed && (now - item.queuedAt > (this.options.staleLeadInMs ?? 3_000) ||
        this.queue.some(other => other !== item && other.owner === item.owner && !other.leadIn))) {
      this.queue.splice(index, 1);
      this.finish(item, 'dropped', 'stale');
      this.pump();
      return;
    }
    this.queue.splice(index, 1);
    // A lead-in does not claim the floor: another answer may follow it while the lookup runs.
    if (!item.leadIn) {
      if (this.holder !== item.owner) this.holderSince = now;
      this.holder = item.owner;
    }
    this.speaking = true;
    this.playing = item;
    let text = item.text;
    if (item.resumed && this.interruptedOwner === item.owner) {
      if (this.heardSinceInterrupt) text = lead('As I was saying, ', text);
      this.interruptedOwner = undefined;
      this.options.onResumed?.(item.owner);
    } else {
      const prefix = item.prefix?.();
      if (prefix) text = lead(prefix, text);
    }
    void this.options.speak(text).catch((): SpeakOutcome => 'failed').then(outcome => {
      this.speaking = false;
      this.holderSince = this.now();
      this.playing = undefined;
      // A cut-off lead-in ("Checking the board.") is not worth repeating; the answer follows anyway.
      if (outcome === 'interrupted' && !this.closed && !item.leadIn) {
        // Kept: finished at the next opening, unless someone cancels it first.
        item.resumed = true;
        this.queue.unshift(item);
        this.interruptedOwner = item.owner;
        this.heardSinceInterrupt = false;
        this.holder = undefined;
        this.pausedUntil = this.now() + (this.options.resumeAfterMs ?? 1_800);
        this.options.onInterrupted?.(item.owner);
      } else {
        this.finish(item, outcome);
      }
      this.pump();
    });
  }
}
