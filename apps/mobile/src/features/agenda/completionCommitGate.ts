import type { AgendaData, AgendaItem } from '@od/shared/types';

interface CommittedCompletion {
  readonly checked: boolean;
  readonly phase: 'committed';
  readonly intentId: string | undefined;
  /** Undefined identifies the undated Anytime projection. */
  readonly viewerDate: string | undefined;
  readonly requiredRevision: number;
}

type CompletionCommit =
  | {
      readonly checked: boolean;
      readonly phase: 'committing';
      /** Keeps the last durable visual state while an inverse write is still in flight. */
      readonly previousCommitted: CommittedCompletion | undefined;
      readonly intentId: string | undefined;
      /** Undefined identifies the undated Anytime projection. */
      readonly viewerDate: string | undefined;
    }
  | CommittedCompletion;

export type CompletionCommitSnapshot =
  | 'idle'
  | 'committing-checked'
  | 'committing-unchecked'
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
  private latestAnytime:
    | { readonly revision: number; readonly targetKeys: ReadonlySet<string> }
    | undefined;

  begin(
    item: AgendaItem,
    checked: boolean,
    intentId: string | undefined,
    viewerDate: string | undefined,
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

  /**
   * Changes the requested visual value while the first serialized SQLite write is still in
   * flight. The action owner turns this into a dependent compensation after that write lands.
   */
  retargetCommitting(
    item: AgendaItem,
    checked: boolean,
    intentId: string | undefined,
    viewerDate: string | undefined,
  ): boolean {
    const key = completionTargetKey(item);
    const current = this.commits.get(key);
    if (
      current?.phase !== 'committing' ||
      current.checked === checked ||
      current.viewerDate !== viewerDate
    ) {
      return false;
    }
    this.commits.set(key, {
      checked,
      phase: 'committing',
      previousCommitted: current.previousCommitted,
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
      this.publish(key);
      this.reconcileKnown(key);
      return;
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

  /** Reconciles completion locks owned by the undated saved-task projection. */
  reconcileAnytime(
    items: readonly Pick<AgendaItem, 'activityId' | 'occurrenceDate'>[],
    snapshotRevision: number,
  ): void {
    if (
      this.latestAnytime !== undefined &&
      this.latestAnytime.revision > snapshotRevision
    ) {
      return;
    }
    this.latestAnytime = {
      revision: snapshotRevision,
      targetKeys: new Set(items.map(completionTargetKey)),
    };
    for (const [key, commit] of this.commits) {
      if (commit.viewerDate === undefined) this.reconcileKnown(key);
    }
  }

  isLocked(item: Pick<AgendaItem, 'activityId' | 'occurrenceDate'>): boolean {
    return this.isKeyLocked(completionTargetKey(item));
  }

  isKeyLocked(key: string): boolean {
    return this.commits.has(key);
  }

  /**
   * A primitive snapshot lets a single row show the requested value while its SQLite write is
   * pending, then retain the durable value until the committed Agenda projection catches up.
   * Refusal restores `previousCommitted` or exposes the unchanged repository projection.
   */
  snapshotForKey(key: string): CompletionCommitSnapshot {
    const current = this.commits.get(key);
    if (current === undefined) return 'idle';
    if (current.phase === 'committed') {
      return current.checked ? 'committed-checked' : 'committed-unchecked';
    }
    return current.checked ? 'committing-checked' : 'committing-unchecked';
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
    if (commit.viewerDate === undefined) {
      const anytime = this.latestAnytime;
      if (anytime === undefined || anytime.revision < commit.requiredRevision) return;
      const present = anytime.targetKeys.has(key);
      if (present === !commit.checked) {
        this.commits.delete(key);
        this.publish(key);
      }
      return;
    }
    const day = this.latestDays.get(commit.viewerDate);
    if (day === undefined || day.revision < commit.requiredRevision) return;
    const item = day.items.get(key);
    // An equal revision must prove this exact commit landed. A later SQLite snapshot may
    // instead contain a durable inverse written outside this gate (for example, detail Undo).
    if (
      item === undefined ||
      COMPLETED.has(item.status) === commit.checked ||
      day.revision > commit.requiredRevision
    ) {
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
