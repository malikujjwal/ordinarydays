/**
 * Delivers the server-chosen completion follow-up to the native presenter (P3-44).
 *
 * Native completion is acknowledged by the serialized sync owner, not by the screen hook.
 * The hook registers a waiter for the intent it just accepted; settlement emits once, and a
 * follow-up never outlives the Undo toast it rides on.
 */
type CompletionFollowUpWaiter = (result: unknown) => void;

const waiters = new Map<string, CompletionFollowUpWaiter>();

export function waitForCompletionFollowUp(
  intentId: string,
  waiter: CompletionFollowUpWaiter,
): () => void {
  waiters.set(intentId, waiter);
  return () => {
    if (waiters.get(intentId) === waiter) waiters.delete(intentId);
  };
}

export function emitCompletionFollowUp(intentId: string, result: unknown): void {
  const waiter = waiters.get(intentId);
  if (waiter === undefined) return;
  waiters.delete(intentId);
  waiter(result);
}
