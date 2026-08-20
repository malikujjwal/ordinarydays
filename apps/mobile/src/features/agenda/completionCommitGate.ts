import type { AgendaData, AgendaItem } from '@od/shared/types';

interface CommittedCompletion {
  readonly checked: boolean;
  readonly phase: 'committed';
  readonly intentId: string | undefined;
  readonly viewerDate: string;
  readonly requiredRevision: number;
}

type CompletionCommit =
  | {
      readonly checked: boolean;
      readonly phase: 'committing';
      /** Keeps the last durable visual state while an inverse write is still in flight. */
      readonly previousCommitted: CommittedCompletion | undefined;
      readonly intentId: string | undefined;
      readonly viewerDate: string;
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

function projectedItems(day: AgendaData['days'][number]): AgendaItem[] {
  return [
    ...(day.upNext === undefined ? [] : [day.upNext]),
    ...day.schedule,
    ...day.anytime,
    ...day.earlier,
  ];
}

/**
 * Per-native-session completion gate. Its keyed listeners update only the affected row instead
 * of re-rendering an entire Agenda when a checkbox locks or unlocks.
 */
export class CompletionCommitGate {
  private readonly commits = new Map<string, CompletionCommit>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly latestDays = new Map<
    string,
    { readonly revision: number; readonly items: ReadonlyMap<string, AgendaItem> }
  >();

  begin(
    item: AgendaItem,
    checked: boolean,
    intentId: string | undefined,
    viewerDate: string,
  ): boolean {
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
      viewerDate,
    });
    this.publish(key);
    return true;
  }

  settle(
    item: AgendaItem,
    checked: boolean,
    accepted: boolean,
    commitRevision?: number,
  ): void {
    const key = completionTargetKey(item);
    const current = this.commits.get(key);
    if (current?.checked !== checked) return;
    if (accepted) {
      if (commitRevision === undefined) {
        throw new Error('An accepted completion must carry its SQLite commit revision.');
      }
      this.commits.set(key, {
        checked,
        phase: 'committed',
        intentId: current.intentId,
        viewerDate: current.viewerDate,
        requiredRevision: commitRevision,
      });
    } else if (
      current.phase === 'committing' &&
      current.previousCommitted !== undefined
    ) {
      this.commits.set(key, current.previousCommitted);
    } else this.commits.delete(key);
    this.publish(key);
    if (accepted) this.reconcileKnown(key);
  }

  /** Releases a durable visual override after its outbox intent is permanently rejected. */
  rejectIntent(intentId: string): void {
    for (const [key, commit] of this.commits) {
      if (commit.intentId !== intentId) continue;
      this.commits.delete(key);
      this.publish(key);
    }
  }

  reconcile(data: AgendaData, snapshotRevision: number): void {
    for (const day of data.days) {
      const previous = this.latestDays.get(day.date);
      if (previous !== undefined && previous.revision > snapshotRevision) continue;
      this.latestDays.set(day.date, {
        revision: snapshotRevision,
        items: new Map(
          projectedItems(day).map((item) => [completionTargetKey(item), item]),
        ),
      });
    }
    for (const key of this.commits.keys()) this.reconcileKnown(key);
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

  private reconcileKnown(key: string): void {
    const commit = this.commits.get(key);
    if (commit?.phase !== 'committed') return;
    const day = this.latestDays.get(commit.viewerDate);
    if (day === undefined || day.revision < commit.requiredRevision) return;
    const item = day.items.get(key);
    if (item === undefined || COMPLETED.has(item.status) === commit.checked) {
      this.commits.delete(key);
      this.publish(key);
    }
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
