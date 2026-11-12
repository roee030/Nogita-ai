/**
 * NOGITA_CONTINUE_REQUEST (P9-26): a live recognition hypothesis from the person she is answering stops her at once,
 * before their turn ends. The level gate alone misses it, since Meet's echo cancellation turns them down while she talks.
 * The server wires the audio hub's interim hook through here, and the tests run this same function.
 */
export interface YieldingEngine {
  yieldsTo(sessionId: string, speakerKey: string, words: string): boolean;
  /** Told after she was stopped, for the turn log (P10-3). */
  yielded?(sessionId: string, speakerKey: string): void;
}
export interface InterruptibleAudio { interruptSpeech(sessionId: string, cause?: 'voice' | 'command'): boolean }

export function continueOnInterim(engine: YieldingEngine, audio: () => InterruptibleAudio | undefined) {
  return (sessionId: string, participantUuid: string, text: string): boolean => {
    if (!engine.yieldsTo(sessionId, participantUuid, text) || !(audio()?.interruptSpeech(sessionId, 'voice') ?? false)) return false;
    engine.yielded?.(sessionId, participantUuid);
    return true;
  };
}
