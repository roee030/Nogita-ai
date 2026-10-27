import type { EventClaim, FileEventLedger } from './event-ledger.ts';

export type ClaimedEventResult = 'processed' | 'active' | 'completed';

export async function finishEventClaim(claim: EventClaim, work: () => Promise<void>): Promise<void> {
  try {
    await work();
    await claim.complete();
  } catch (error) {
    try { await claim.abandon(); } catch { /* Preserve the work error. */ }
    throw error;
  }
}

/** Runs work behind an atomic hash-only claim and releases failed work for retry. */
export async function runClaimedEvent(
  ledger: FileEventLedger,
  namespace: string,
  eventId: string,
  work: () => Promise<void>,
): Promise<ClaimedEventResult> {
  const result = await ledger.begin(namespace, eventId);
  if (result.status !== 'started') return result.status;
  await finishEventClaim(result.claim, work);
  return 'processed';
}
