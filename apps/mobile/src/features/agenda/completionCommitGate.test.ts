import type { AgendaData, AgendaItem } from '@od/shared/types';
import { describe, expect, it, vi } from 'vitest';
import { CompletionCommitGate, completionTargetKey } from './completionCommitGate';

const item = (overrides: Partial<AgendaItem> = {}): AgendaItem => ({
  activityId: 'act_gate',
  type: 'task',
  title: 'Call the dentist',
  status: 'scheduled',
  time: '18:15',
  isRecurring: false,
  isSnoozed: false,
  hasCheckbox: true,
  capabilities: { complete: true, skip: false, snooze: true },
  participantAvatars: [],
  participantCount: 0,
  isPast: false,
  ...overrides,
});

const agenda = (...items: AgendaItem[]): AgendaData => ({
  days: [
    {
      date: '2026-08-20',
      schedule: items,
      anytime: [],
      earlier: [],
    },
  ],
  warnings: [],
});

describe('completion commit gate', () => {
  it('admits one write for repeated taps and unlocks only after the committed projection', () => {
    const gate = new CompletionCommitGate();
    const scheduled = item();

    expect(gate.begin(scheduled, true)).toBe(true);
    expect(gate.begin(scheduled, true)).toBe(false);
    expect(gate.isLocked(scheduled)).toBe(true);
    expect(gate.snapshotForKey(completionTargetKey(scheduled))).toBe('committing');

    gate.settle(scheduled, true, true);
    expect(gate.snapshotForKey(completionTargetKey(scheduled))).toBe('committed-checked');
    gate.reconcile(agenda(scheduled));
    expect(gate.isLocked(scheduled)).toBe(true);

    gate.reconcile(agenda(item({ status: 'completed' })));
    expect(gate.isLocked(scheduled)).toBe(false);
  });

  it('keys recurring occurrences independently', () => {
    const gate = new CompletionCommitGate();
    const first = item({ isRecurring: true, occurrenceDate: '2026-08-20' });
    const second = item({ isRecurring: true, occurrenceDate: '2026-08-21' });

    expect(completionTargetKey(first)).not.toBe(completionTargetKey(second));
    expect(gate.begin(first, true)).toBe(true);
    expect(gate.begin(second, true)).toBe(true);
    gate.settle(first, true, false);
    expect(gate.isLocked(first)).toBe(false);
    expect(gate.isLocked(second)).toBe(true);
  });

  it('allows a committed inverse before projection cleanup runs', () => {
    const gate = new CompletionCommitGate();
    const scheduled = item();

    expect(gate.begin(scheduled, true)).toBe(true);
    gate.settle(scheduled, true, true);
    expect(gate.begin(scheduled, false)).toBe(true);
    expect(gate.isLocked(scheduled)).toBe(true);
    expect(gate.snapshotForKey(completionTargetKey(scheduled))).toBe(
      'committing-from-checked',
    );

    gate.settle(scheduled, false, true);
    expect(gate.snapshotForKey(completionTargetKey(scheduled))).toBe(
      'committed-unchecked',
    );
  });

  it('restores the prior committed visual value when an inverse write is rejected', () => {
    const gate = new CompletionCommitGate();
    const scheduled = item();

    gate.begin(scheduled, true);
    gate.settle(scheduled, true, true);
    gate.begin(scheduled, false);
    gate.settle(scheduled, false, false);

    expect(gate.snapshotForKey(completionTargetKey(scheduled))).toBe('committed-checked');
    expect(gate.isLocked(scheduled)).toBe(true);
  });

  it('unlocks an accepted completion when the row leaves the current projection', () => {
    const gate = new CompletionCommitGate();
    const scheduled = item();

    gate.begin(scheduled, true);
    gate.settle(scheduled, true, true);
    gate.reconcile(agenda());

    expect(gate.isLocked(scheduled)).toBe(false);
  });

  it('releases only the override owned by a permanently failed outbox intent', () => {
    const gate = new CompletionCommitGate();
    const scheduled = item();

    gate.begin(scheduled, true, 'intent-complete');
    gate.settle(scheduled, true, true);
    gate.rejectIntent('intent-unrelated');
    expect(gate.isLocked(scheduled)).toBe(true);

    gate.rejectIntent('intent-complete');
    expect(gate.isLocked(scheduled)).toBe(false);
  });

  it('notifies only the affected occurrence', () => {
    const gate = new CompletionCommitGate();
    const first = item({ isRecurring: true, occurrenceDate: '2026-08-20' });
    const second = item({ isRecurring: true, occurrenceDate: '2026-08-21' });
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    gate.subscribe(completionTargetKey(first), firstListener);
    gate.subscribe(completionTargetKey(second), secondListener);

    gate.begin(first, true);

    expect(firstListener).toHaveBeenCalledOnce();
    expect(secondListener).not.toHaveBeenCalled();
  });
});
