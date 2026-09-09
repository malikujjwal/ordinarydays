import { describe, expect, it } from 'vitest';
import { emitCompletionFollowUp, waitForCompletionFollowUp } from './completionFollowUp';

describe('completion follow-up delivery', () => {
  it('delivers one result to the waiter for that intent and no other', () => {
    const seen: unknown[] = [];
    const stop = waitForCompletionFollowUp('intent-a', (result) => seen.push(result));
    emitCompletionFollowUp('intent-b', { followUp: { kind: 'open_prep' } });
    emitCompletionFollowUp('intent-a', { followUp: { kind: 'meal_ingredients' } });
    emitCompletionFollowUp('intent-a', { followUp: { kind: 'open_prep' } });
    stop();
    expect(seen).toEqual([{ followUp: { kind: 'meal_ingredients' } }]);
  });
});
