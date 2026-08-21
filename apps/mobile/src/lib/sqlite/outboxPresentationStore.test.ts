import { describe, expect, it, vi } from 'vitest';
import type { OutboxIntent } from './outbox';
import { OutboxPresentationStore } from './outboxPresentationStore';
import type {
  RevisionedProjectionReader,
  RevisionedProjectionSnapshot,
} from './projectionReader';
import { RepositorySubscriptions } from './subscriptions';

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function intent(
  intentId: string,
  entityId: string,
  overrides: Partial<OutboxIntent> = {},
): OutboxIntent {
  return {
    intentId,
    mutationKey: ['activity', 'complete'],
    variables: { activityId: entityId, input: {} },
    entityId,
    orderingKey: `activity:${entityId}`,
    status: 'queued',
    createdAt: 1_787_097_600_000,
    seq: 1,
    attempts: 0,
    ...overrides,
  };
}

function snapshot(
  data: readonly OutboxIntent[],
  commitRevision: number,
): RevisionedProjectionSnapshot<readonly OutboxIntent[]> {
  return {
    data,
    commitRevision,
    source: 'reader',
    metrics: { callCount: 1, durationMs: 1 },
  };
}

class ProjectionQueue implements RevisionedProjectionReader {
  calls = 0;

  constructor(
    private readonly results: Array<
      | Promise<RevisionedProjectionSnapshot<readonly OutboxIntent[]>>
      | (() => Promise<RevisionedProjectionSnapshot<readonly OutboxIntent[]>>)
    >,
  ) {}

  snapshot<T>(): Promise<RevisionedProjectionSnapshot<T>> {
    this.calls += 1;
    const result = this.results.shift();
    if (result === undefined) throw new Error('Unexpected projection read.');
    return (typeof result === 'function' ? result() : result) as Promise<
      RevisionedProjectionSnapshot<T>
    >;
  }
}

describe('OutboxPresentationStore', () => {
  it('owns one outbox observer and coalesces invalidations behind one running read', async () => {
    const first = deferred<RevisionedProjectionSnapshot<readonly OutboxIntent[]>>();
    const second = deferred<RevisionedProjectionSnapshot<readonly OutboxIntent[]>>();
    const projections = new ProjectionQueue([first.promise, second.promise]);
    const subscriptions = new RepositorySubscriptions();
    const originalSubscribe = subscriptions.subscribe.bind(subscriptions);
    const unsubscribe = vi.fn();
    const subscribe = vi
      .spyOn(subscriptions, 'subscribe')
      .mockImplementation((scope, listener) => {
        const release = originalSubscribe(scope, listener);
        return () => {
          unsubscribe();
          release();
        };
      });
    const store = new OutboxPresentationStore('user-a', subscriptions, projections);

    store.start();
    store.start();
    store.getEntitySnapshot('activity-a');
    store.subscribeEntity('activity-a', () => undefined);
    store.subscribeOccurrence('activity-a', '2026-08-20', () => undefined);
    await vi.waitFor(() => expect(projections.calls).toBe(1));
    expect(subscribe).toHaveBeenCalledTimes(1);

    subscriptions.publish(new Set(['outbox']), 2);
    subscriptions.publish(new Set(['outbox']), 3);
    first.resolve(snapshot([], 1));
    await vi.waitFor(() => expect(projections.calls).toBe(2));
    expect(store.getSnapshot().pending).toEqual([]);

    second.resolve(snapshot([intent('newest', 'activity-a')], 3));
    await vi.waitFor(() => expect(store.getSnapshot().pending).toHaveLength(1));
    expect(projections.calls).toBe(2);
    store.stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('rejects a stale revision and applies its fenced retry', async () => {
    const projections = new ProjectionQueue([
      Promise.resolve(snapshot([intent('stale', 'activity-a')], 4)),
      Promise.resolve(snapshot([intent('fresh', 'activity-a')], 5)),
    ]);
    const subscriptions = new RepositorySubscriptions();
    const store = new OutboxPresentationStore('user-a', subscriptions, projections);
    const listener = vi.fn();
    store.subscribe(listener);

    store.start();
    subscriptions.publish(new Set(['outbox']), 5);

    await vi.waitFor(() => expect(projections.calls).toBe(2));
    await vi.waitFor(() =>
      expect(store.getSnapshot().pending.map(({ intentId }) => intentId)).toEqual([
        'fresh',
      ]),
    );
    expect(listener).toHaveBeenCalledOnce();
    store.stop();
  });

  it('keeps the final invalidation dirty across repeated failures with delayed backoff', async () => {
    const projections = new ProjectionQueue([
      Promise.resolve(snapshot([intent('pending', 'activity-a')], 1)),
      async () => {
        throw new Error('reader temporarily unavailable');
      },
      async () => {
        throw new Error('writer fallback temporarily unavailable');
      },
      Promise.resolve(snapshot([], 2)),
    ]);
    const subscriptions = new RepositorySubscriptions();
    const store = new OutboxPresentationStore('user-a', subscriptions, projections);
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().pending).toHaveLength(1));

    subscriptions.publish(new Set(['outbox']), 2);
    await vi.waitFor(() => expect(projections.calls).toBe(2));
    expect(store.getSnapshot().pending).toHaveLength(1);

    await vi.waitFor(
      () => {
        expect(projections.calls).toBe(4);
        expect(store.getSnapshot().pending).toEqual([]);
      },
      { timeout: 2_000 },
    );
    store.stop();
  });

  it('cancels a delayed retry when its session stops', async () => {
    const projections = new ProjectionQueue([
      async () => {
        throw new Error('reader unavailable');
      },
      Promise.resolve(snapshot([intent('late', 'activity-a')], 1)),
    ]);
    const store = new OutboxPresentationStore(
      'user-a',
      new RepositorySubscriptions(),
      projections,
    );
    store.start();
    await vi.waitFor(() => expect(projections.calls).toBe(1));
    store.stop();

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(projections.calls).toBe(1);
    expect(store.getSnapshot().pending).toEqual([]);
  });

  it('rejects an older generation even when its revision is high enough', async () => {
    const first = deferred<RevisionedProjectionSnapshot<readonly OutboxIntent[]>>();
    const second = deferred<RevisionedProjectionSnapshot<readonly OutboxIntent[]>>();
    const projections = new ProjectionQueue([first.promise, second.promise]);
    const subscriptions = new RepositorySubscriptions();
    const store = new OutboxPresentationStore('user-a', subscriptions, projections);
    const listener = vi.fn();
    store.subscribe(listener);
    store.start();
    await vi.waitFor(() => expect(projections.calls).toBe(1));

    subscriptions.publish(new Set(['outbox']), 2);
    first.resolve(snapshot([intent('old', 'activity-a')], 2));
    await vi.waitFor(() => expect(projections.calls).toBe(2));
    expect(listener).not.toHaveBeenCalled();

    second.resolve(snapshot([intent('new', 'activity-a')], 2));
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    expect(store.getSnapshot().pending[0]?.intentId).toBe('new');
    store.stop();
  });

  it('preserves unaffected entity and occurrence snapshots and notifications', async () => {
    const occurrenceA = intent('occurrence-a', 'series', {
      variables: { activityId: 'series', input: { occurrenceDate: '2026-08-20' } },
      seq: 1,
    });
    const occurrenceB = intent('occurrence-b', 'series', {
      variables: { activityId: 'series', input: { occurrenceDate: '2026-08-21' } },
      seq: 2,
    });
    const other = intent('other', 'activity-b', { seq: 3 });
    const projections = new ProjectionQueue([
      Promise.resolve(snapshot([occurrenceA, occurrenceB, other], 1)),
      Promise.resolve(
        snapshot(
          [{ ...occurrenceA, status: 'in_flight', attempts: 1 }, occurrenceB, other],
          2,
        ),
      ),
      Promise.resolve(
        snapshot(
          [{ ...occurrenceA, status: 'in_flight', attempts: 1 }, occurrenceB, other],
          3,
        ),
      ),
    ]);
    const subscriptions = new RepositorySubscriptions();
    const store = new OutboxPresentationStore('user-a', subscriptions, projections);
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().pending).toHaveLength(3));

    const otherEntity = store.getEntitySnapshot('activity-b');
    const otherOccurrence = store.getOccurrenceSnapshot('series', '2026-08-21');
    const otherEntityListener = vi.fn();
    const otherOccurrenceListener = vi.fn();
    const globalListener = vi.fn();
    store.subscribeEntity('activity-b', otherEntityListener);
    const unsubscribeOccurrence = store.subscribeOccurrence(
      'series',
      '2026-08-21',
      otherOccurrenceListener,
    );
    store.subscribe(globalListener);

    subscriptions.publish(new Set(['outbox']), 2);
    await vi.waitFor(() => expect(projections.calls).toBe(2));
    await vi.waitFor(() => expect(globalListener).toHaveBeenCalledOnce());
    expect(store.getEntitySnapshot('activity-b')).toBe(otherEntity);
    expect(store.getOccurrenceSnapshot('series', '2026-08-21')).toBe(otherOccurrence);
    expect(otherEntityListener).not.toHaveBeenCalled();
    expect(otherOccurrenceListener).not.toHaveBeenCalled();

    const stableGlobal = store.getSnapshot();
    globalListener.mockClear();
    subscriptions.publish(new Set(['outbox']), 3);
    await vi.waitFor(() => expect(projections.calls).toBe(3));
    await Promise.resolve();
    expect(store.getSnapshot()).toBe(stableGlobal);
    expect(globalListener).not.toHaveBeenCalled();

    unsubscribeOccurrence();
    const remountedOccurrence = store.getOccurrenceSnapshot('series', '2026-08-21');
    expect(remountedOccurrence).not.toBe(otherOccurrence);
    expect(remountedOccurrence).toEqual(otherOccurrence);
    store.stop();
  });

  it('offers recovery for a failed queued recurrence write without exposing ordinary retries', async () => {
    const failedRecurrence = intent('failed-recurrence', 'series', {
      mutationKey: ['activity', 'patch'],
      variables: {
        activityId: 'series',
        input: { recurrence: { mode: 'fixed', segments: [] } },
      },
      lastError: 'Schedule service unavailable.',
      attempts: 1,
      seq: 1,
    });
    const failedTitle = intent('failed-title', 'other', {
      mutationKey: ['activity', 'patch'],
      variables: { activityId: 'other', input: { title: 'Later' } },
      lastError: 'Schedule service unavailable.',
      attempts: 1,
      seq: 2,
    });
    const offlineRecurrence = intent('offline-recurrence', 'offline-series', {
      mutationKey: ['activity', 'patch'],
      variables: {
        activityId: 'offline-series',
        input: { recurrence: { mode: 'fixed', segments: [] } },
      },
      lastError: 'The request could not be sent.',
      attempts: 1,
      seq: 3,
    });
    const projections = new ProjectionQueue([
      Promise.resolve(snapshot([failedRecurrence, failedTitle, offlineRecurrence], 1)),
    ]);
    const store = new OutboxPresentationStore(
      'user-a',
      new RepositorySubscriptions(),
      projections,
    );

    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().pending).toHaveLength(3));

    expect(store.getSnapshot().blocked.map(({ intentId }) => intentId)).toEqual([
      'failed-recurrence',
    ]);
    store.stop();
  });

  it('does not apply after shutdown or expose an old account to the next session', async () => {
    const pending = deferred<RevisionedProjectionSnapshot<readonly OutboxIntent[]>>();
    const projections = new ProjectionQueue([pending.promise]);
    const subscriptions = new RepositorySubscriptions();
    const store = new OutboxPresentationStore('user-a', subscriptions, projections);
    const listener = vi.fn();
    store.subscribe(listener);
    store.start();
    await vi.waitFor(() => expect(projections.calls).toBe(1));

    store.stop();
    pending.resolve(snapshot([intent('old-account', 'activity-a')], 1));
    await Promise.resolve();
    await Promise.resolve();
    subscriptions.publish(new Set(['outbox']), 2);

    expect(store.getSnapshot().pending).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    expect(projections.calls).toBe(1);

    const nextProjections = new ProjectionQueue([
      Promise.resolve(snapshot([intent('new-account', 'activity-b')], 1)),
    ]);
    const next = new OutboxPresentationStore(
      'user-b',
      new RepositorySubscriptions(),
      nextProjections,
    );
    next.start();
    await vi.waitFor(() => expect(next.getSnapshot().pending).toHaveLength(1));
    expect(next.getSnapshot().pending[0]).toMatchObject({
      intentId: 'new-account',
      ownerUserId: 'user-b',
    });
    expect(store.getSnapshot().pending).toEqual([]);
    next.stop();
  });
});
