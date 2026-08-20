import type { AgendaData, AgendaItem } from '@od/shared/types';

interface CommittedCompletion {
  readonly checked: boolean;
  readonly phase: 'committed';
  readonly intentId: string | undefined;
}

type CompletionCommit =
  | {
      readonly checked: boolean;
      readonly phase: 'committing';
      /** Keeps the last durable visual state while an inverse write is still in flight. */
      readonly previousCommitted: CommittedCompletion | undefined;
      readonly intentId: string | undefined;
    }
  | CommittedCompletion;

export type CompletionCommitSnapshot =
  | 'idle'
  | 'committing'
  | 'committing-from-checked'
  | 'committing-from-unchecked'
  | 'committed-checked'
  | 'committed-unchecked';

const COMPLETED = new Set<AgendaItem['status']>(['completed', 'completed_occurrence']);

export function completionTargetKey(
  target: Pick<AgendaItem, 'activityId' | 'occurrenceDate'>,
): string {
  return JSON.stringify([target.activityId, target.occurrenceDate ?? null]);
}

function projectedItem(data: AgendaData, key: string): AgendaItem | undefined {
  for (const day of data.days) {
    const items = [
      ...(day.upNext === undefined ? [] : [day.upNext]),
      ...day.schedule,
      ...day.anytime,
      ...day.earlier,
    ];
    const item = items.find((candidate) => completionTargetKey(candidate) === key);
    if (item !== undefined) return item;
  }
  return undefined;
}

/**
 * Per-native-session completion gate. Its keyed listeners update only the affected row instead
 * of re-rendering an entire Agenda when a checkbox locks or unlocks.
 */
export class CompletionCommitGate {
  private readonly commits = new Map<string, CompletionCommit>();
  private readonly listeners = new Map<string, Set<() => void>>();

  begin(item: AgendaItem, checked: boolean, intentId?: string): boolean {
    const key = completionTargetKey(item);
    const current = this.commits.get(key);
    if (
      current !== undefined &&
      (current.phase === 'committing' || current.checked === checked)
    ) {
      return false;
    }
    this.commits.set(key, {
      checked,
      phase: 'committing',
      previousCommitted: current?.phase === 'committed' ? current : undefined,
      intentId,
    });
    this.publish(key);
    return true;
  }

  settle(item: AgendaItem, checked: boolean, accepted: boolean): void {
    const key = completionTargetKey(item);
    const current = this.commits.get(key);
    if (current?.checked !== checked) return;
    if (accepted) {
      this.commits.set(key, { checked, phase: 'committed', intentId: current.intentId });
    } else if (
      current.phase === 'committing' &&
      current.previousCommitted !== undefined
    ) {
      this.commits.set(key, current.previousCommitted);
    } else this.commits.delete(key);
    this.publish(key);
  }

  /** Releases a durable visual override after its outbox intent is permanently rejected. */
  rejectIntent(intentId: string): void {
    for (const [key, commit] of this.commits) {
      if (commit.intentId !== intentId) continue;
      this.commits.delete(key);
      this.publish(key);
    }
  }

  reconcile(data: AgendaData | undefined): void {
    if (data === undefined) return;
    for (const [key, commit] of this.commits) {
      if (commit.phase !== 'committed') continue;
      const item = projectedItem(data, key);
      if (item === undefined || COMPLETED.has(item.status) === commit.checked) {
        this.commits.delete(key);
        this.publish(key);
      }
    }
  }

  isLocked(item: Pick<AgendaItem, 'activityId' | 'occurrenceDate'>): boolean {
    return this.isKeyLocked(completionTargetKey(item));
  }

  isKeyLocked(key: string): boolean {
    return this.commits.has(key);
  }

  /**
   * A primitive snapshot lets a single row render the last SQLite-committed value without
   * waiting for a large Agenda projection to be rebuilt. `committing` deliberately has no
   * value: the UI does not move until the local transaction has actually succeeded.
   */
  snapshotForKey(key: string): CompletionCommitSnapshot {
    const current = this.commits.get(key);
    if (current === undefined) return 'idle';
    if (current.phase === 'committed') {
      return current.checked ? 'committed-checked' : 'committed-unchecked';
    }
    if (current.previousCommitted === undefined) return 'committing';
    return current.previousCommitted.checked
      ? 'committing-from-checked'
      : 'committing-from-unchecked';
  }

  subscribe(key: string, listener: () => void): () => void {
    const current = this.listeners.get(key) ?? new Set();
    current.add(listener);
    this.listeners.set(key, current);
    return () => {
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(key);
    };
  }

  private publish(key: string): void {
    for (const listener of this.listeners.get(key) ?? []) listener();
  }
}

const gates = new WeakMap<object, CompletionCommitGate>();

export function completionCommitGateFor(owner: object): CompletionCommitGate {
  const current = gates.get(owner);
  if (current !== undefined) return current;
  const gate = new CompletionCommitGate();
  gates.set(owner, gate);
  return gate;
}
