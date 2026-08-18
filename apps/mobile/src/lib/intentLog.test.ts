import { MAX_AUTOMATIC_INTENT_AGE_DAYS, MAX_OFFLINE_MUTATIONS } from '@od/shared';
import { ApiError } from '@od/shared/client';
import type { Activity, AgendaData } from '@od/shared/types';
import { describe, expect, it, vi } from 'vitest';
import {
  INTENT_LOG_SCHEMA_VERSION,
  IntentLog,
  IntentLogFullError,
  type IntentLogStorage,
  IntentLogUnsupportedError,
  intentLogKey,
  parseEnvelope,
} from '@/lib/intentLog';
import { replayIntents, setActiveIntentLog } from '@/lib/intentReplay';
import {
  registerActivityMutationDefaults,
  waitForActivityCreateAcceptance,
} from '@/lib/mutationDefaults';
import { createOfflineQueryClient } from '@/lib/queryClient';

const USER = 'usr_01J0000000000000000000000A';
const OTHER_USER = 'usr_01J0000000000000000000000B';
const ACTIVITY = 'act_01J0000000000000000000000C';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A real storage driver, not a mock of the log's own calls.
 *
 * The whole point of this component is what survives a process boundary, so every test that
 * claims durability crosses one: it builds a second `IntentLog` over the *same* map, which is
 * exactly what a relaunch does.
 */
function fakeStorage(seed: Record<string, string> = {}): IntentLogStorage & {
  data: Map<string, string>;
  failNextSet: () => void;
  delayNextGet: (ms: number) => void;
} {
  const data = new Map(Object.entries(seed));
  let failSet = false;
  let getDelay = 0;
  return {
    data,
    failNextSet: () => {
      failSet = true;
    },
    delayNextGet: (ms: number) => {
      getDelay = ms;
    },
    async getItem(key) {
      if (getDelay > 0) {
        const wait = getDelay;
        getDelay = 0;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      return data.get(key) ?? null;
    },
    async setItem(key, value) {
      if (failSet) {
        failSet = false;
        throw new Error('quota exceeded');
      }
      data.set(key, value);
    },
    async removeItem(key) {
      data.delete(key);
    },
  };
}

function intentInput(overrides: Partial<{ intentId: string; entityId: string }> = {}) {
  return {
    intentId: overrides.intentId ?? '00000000-0000-4000-8000-000000000001',
    mutationKey: ['activity', 'complete'] as const,
    variables: { activityId: ACTIVITY, idempotencyKey: 'idem-1' },
    entityId: overrides.entityId ?? ACTIVITY,
  };
}

/** A mutation runner that records dispatches, standing in for the TanStack client. */
function fakeRunner(
  behaviour: (variables: unknown) => Promise<unknown> = async () => ({}),
) {
  const dispatched: unknown[] = [];
  return {
    dispatched,
    getMutationDefaults: () => ({
      mutationFn: async (variables: unknown) => {
        dispatched.push(variables);
        return behaviour(variables);
      },
    }),
    getMutationCache: () => ({
      build: (
        _client: unknown,
        options: { mutationFn?: (v: unknown) => Promise<unknown> },
      ) => ({
        execute: (variables: unknown) =>
          options.mutationFn?.(variables) ?? Promise.resolve(undefined),
      }),
    }),
  } as unknown as Parameters<typeof replayIntents>[0] & { dispatched: unknown[] };
}

describe('the durable intent log', () => {
  it('persists write-ahead, so a kill/relaunch/reconnect replays exactly once', async () => {
    const storage = fakeStorage();
    const log = new IntentLog(USER, storage);
    await log.hydrate();
    await log.append(intentInput());

    // The process dies here. Nothing else ran; only what reached storage survives.
    const relaunched = new IntentLog(USER, storage);
    await relaunched.hydrate();
    expect(relaunched.pending()).toHaveLength(1);

    const runner = fakeRunner();
    const first = await replayIntents(runner, relaunched);
    expect(first.acknowledged).toBe(1);
    expect(runner.dispatched).toHaveLength(1);

    // Reconnecting again must not resend it: acknowledgement removed it from the log.
    const second = await replayIntents(runner, relaunched);
    expect(second.attempted).toBe(0);
    expect(runner.dispatched).toHaveLength(1);
    expect(relaunched.pending()).toHaveLength(0);
  });

  it('leaves an intent unchanged when another pass already claimed it', async () => {
    const log = new IntentLog(USER, fakeStorage());
    await log.hydrate();
    const intent = await log.append(intentInput());

    expect(await log.tryClaim(intent.intentId)).toMatchObject({
      status: 'in_flight',
      attempts: 1,
    });
    const claimed = log.snapshot();

    expect(await log.tryClaim(intent.intentId)).toBeUndefined();
    expect(log.snapshot()).toEqual(claimed);
  });

  it('coalesces concurrent replay passes so one intent dispatches once', async () => {
    const log = new IntentLog(USER, fakeStorage());
    await log.hydrate();
    await log.append(intentInput());
    let finish: ((value: unknown) => void) | undefined;
    const runner = fakeRunner(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );

    const first = replayIntents(runner, log);
    await vi.waitFor(() => expect(runner.dispatched).toHaveLength(1));
    const overlapping = replayIntents(runner, log);

    expect(overlapping).toBe(first);
    finish?.({});
    const [firstResult, overlappingResult] = await Promise.all([first, overlapping]);
    expect(firstResult).toBe(overlappingResult);
    expect(firstResult.acknowledged).toBe(1);
    expect(runner.dispatched).toHaveLength(1);
  });

  it('keeps FIFO when a second replay request arrives during the first dispatch', async () => {
    const log = new IntentLog(USER, fakeStorage());
    await log.hydrate();
    await log.append(intentInput({ intentId: 'first' }));
    await log.append({
      ...intentInput({ intentId: 'second' }),
      variables: { activityId: ACTIVITY, idempotencyKey: 'idem-2' },
    });
    let finishFirst: ((value: unknown) => void) | undefined;
    let call = 0;
    const runner = fakeRunner(async () => {
      call += 1;
      if (call !== 1) return {};
      return await new Promise((resolve) => {
        finishFirst = resolve;
      });
    });

    const first = replayIntents(runner, log);
    await vi.waitFor(() => expect(runner.dispatched).toHaveLength(1));
    const overlapping = replayIntents(runner, log);
    await Promise.resolve();
    expect(runner.dispatched).toHaveLength(1);

    finishFirst?.({});
    await Promise.all([first, overlapping]);
    expect(runner.dispatched).toEqual([
      { activityId: ACTIVITY, idempotencyKey: 'idem-1' },
      { activityId: ACTIVITY, idempotencyKey: 'idem-2' },
    ]);
  });

  it('reruns after a coalesced request when the active pass requeues an intent', async () => {
    const log = new IntentLog(USER, fakeStorage());
    await log.hydrate();
    await log.append(intentInput());
    let failFirst: ((error: Error) => void) | undefined;
    let call = 0;
    const runner = fakeRunner(() => {
      call += 1;
      if (call !== 1) return Promise.resolve({});
      return new Promise((_resolve, reject) => {
        failFirst = reject;
      });
    });

    const first = replayIntents(runner, log);
    await vi.waitFor(() => expect(runner.dispatched).toHaveLength(1));
    const overlapping = replayIntents(runner, log);
    failFirst?.(new Error('offline'));

    const result = await overlapping;
    await first;
    expect(result.requeued).toBe(1);
    expect(result.acknowledged).toBe(1);
    expect(runner.dispatched).toHaveLength(2);
    expect(log.pending()).toHaveLength(0);
  });

  it('keeps an intent far older than the query cache MAX_AGE', async () => {
    const storage = fakeStorage();
    const now = Date.parse('2026-08-17T12:00:00.000Z');
    const clock = vi.fn(() => now - 8 * DAY_MS);
    const log = new IntentLog(USER, storage, clock);
    await log.hydrate();
    await log.append(intentInput());

    // Eight days later — past the cache's seven-day MAX_AGE, well inside the automation window.
    clock.mockReturnValue(now);
    const relaunched = new IntentLog(USER, storage, () => now);
    await relaunched.hydrate();

    expect(relaunched.pending()).toHaveLength(1);
    expect(relaunched.pending()[0]?.status).toBe('queued');
    expect(relaunched.replayable()).toHaveLength(1);
  });

  it('survives a query-cache buster change, because it is not in that envelope', async () => {
    const storage = fakeStorage();
    const log = new IntentLog(USER, storage);
    await log.hydrate();
    await log.append(intentInput());

    /**
     * The cache dying is modelled as what actually happens: its key is removed. The log's key
     * is separate, so nothing about the cache's disposal can reach it.
     */
    storage.data.delete('ordinarydays-query-cache-v1');

    const relaunched = new IntentLog(USER, storage);
    await relaunched.hydrate();
    expect(relaunched.pending()).toHaveLength(1);
    expect(storage.data.has(intentLogKey(USER))).toBe(true);
  });

  it('migrates a log written before intents carried a sequence', async () => {
    const legacy = {
      schemaVersion: 0,
      ownerUserId: USER,
      clockWitness: Date.now(),
      intents: [
        {
          intentId: 'a',
          ownerUserId: USER,
          mutationKey: ['activity', 'complete'],
          variables: {},
          entityId: ACTIVITY,
          status: 'queued',
          createdAt: Date.now(),
          attempts: 0,
        },
        {
          intentId: 'b',
          ownerUserId: USER,
          mutationKey: ['activity', 'skip'],
          variables: {},
          entityId: ACTIVITY,
          status: 'queued',
          createdAt: Date.now(),
          attempts: 0,
        },
      ],
    };
    const storage = fakeStorage({ [intentLogKey(USER)]: JSON.stringify(legacy) });
    const log = new IntentLog(USER, storage);
    await log.hydrate();

    // Migrated forward, not discarded, and ordered as they were appended.
    expect(log.snapshot().schemaVersion).toBe(INTENT_LOG_SCHEMA_VERSION);
    expect(log.pending().map((intent) => intent.intentId)).toEqual(['a', 'b']);
    expect(log.replayable().map((intent) => intent.seq)).toEqual([1, 2]);
  });

  it('surfaces a newer schema version rather than deleting work it cannot read', () => {
    expect(() =>
      parseEnvelope({ schemaVersion: INTENT_LOG_SCHEMA_VERSION + 1, intents: [] }, USER),
    ).toThrow(IntentLogUnsupportedError);
  });

  it('replays a mutation that was in flight when the process died', async () => {
    const storage = fakeStorage();
    const log = new IntentLog(USER, storage);
    await log.hydrate();
    const intent = await log.append(intentInput());
    await log.tryClaim(intent.intentId);
    expect(log.snapshot().intents[0]?.status).toBe('in_flight');

    /**
     * TanStack only ever persisted `isPaused` mutations, so this write — already on the wire
     * when the app was killed — used to be lost outright. The log holds it, and hydration
     * itself returns it to `queued`; nothing here reclaims it by hand.
     */
    const relaunched = new IntentLog(USER, storage);
    await relaunched.hydrate();
    expect(relaunched.snapshot().intents[0]?.status).toBe('queued');

    const runner = fakeRunner();
    const result = await replayIntents(runner, relaunched);
    expect(result.acknowledged).toBe(1);
    expect(runner.dispatched).toHaveLength(1);
  });

  it('cancels only while queued, so a cancel racing dispatch is never a double write', async () => {
    const storage = fakeStorage();
    const log = new IntentLog(USER, storage);
    await log.hydrate();
    const intent = await log.append(intentInput());

    // The race, both orders. Cancel first: dispatch finds nothing to claim.
    const cancelled = await log.cancel(intent.intentId);
    expect(cancelled).toBe(true);
    const runner = fakeRunner();
    expect((await replayIntents(runner, log)).attempted).toBe(0);
    expect(runner.dispatched).toHaveLength(0);

    // Dispatch first: the cancel is the race loser and is refused, not applied late.
    const second = new IntentLog(USER, fakeStorage());
    await second.hydrate();
    const live = await second.append(intentInput({ intentId: 'second' }));
    await second.tryClaim(live.intentId);
    expect(await second.cancel(live.intentId)).toBe(false);
    expect(second.pending()).toHaveLength(1);
  });

  it('replays nothing after signing out and signing in as another account', async () => {
    const storage = fakeStorage();
    const log = new IntentLog(USER, storage);
    await log.hydrate();
    await log.append(intentInput());

    // Sign-out quarantines: the bytes stay on disk, the session forgets them.
    log.quarantine();
    expect(log.pending()).toHaveLength(0);
    expect(storage.data.has(intentLogKey(USER))).toBe(true);

    const otherAccount = new IntentLog(OTHER_USER, storage);
    await otherAccount.hydrate();
    const runner = fakeRunner();
    const result = await replayIntents(runner, otherAccount);

    expect(result.attempted).toBe(0);
    expect(runner.dispatched).toHaveLength(0);
    expect(otherAccount.pending()).toHaveLength(0);

    // And the original account still finds its work when it returns.
    const returning = new IntentLog(USER, storage);
    await returning.hydrate();
    expect(returning.pending()).toHaveLength(1);
  });

  it('parks intents for confirmation when the clock rolls back', async () => {
    const storage = fakeStorage();
    const now = Date.parse('2026-08-17T12:00:00.000Z');
    const clock = vi.fn(() => now);
    const log = new IntentLog(USER, storage, clock);
    await log.hydrate();
    await log.append(intentInput());
    expect(log.replayable()).toHaveLength(1);

    // The device clock moves backwards a week. Automation must reduce, never extend.
    clock.mockReturnValue(now - 7 * DAY_MS);
    await log.refreshClockRule();

    expect(log.snapshot().intents[0]?.status).toBe('needs_confirmation');
    expect(log.replayable()).toHaveLength(0);
    const runner = fakeRunner();
    expect((await replayIntents(runner, log)).attempted).toBe(0);
  });

  it('parks an intent past the automation window without ever deleting it', async () => {
    const storage = fakeStorage();
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    const clock = vi.fn(() => start);
    const log = new IntentLog(USER, storage, clock);
    await log.hydrate();
    await log.append(intentInput());

    clock.mockReturnValue(start + (MAX_AUTOMATIC_INTENT_AGE_DAYS + 1) * DAY_MS);
    await log.refreshClockRule();

    // Retention is indefinite; only automation is bounded.
    expect(log.pending()).toHaveLength(1);
    expect(log.snapshot().intents[0]?.status).toBe('needs_confirmation');
    expect(log.replayable()).toHaveLength(0);
  });

  it('refuses a write past the cap, counting failed and needs_confirmation intents', async () => {
    const storage = fakeStorage();
    const log = new IntentLog(USER, storage);
    await log.hydrate();
    for (let index = 0; index < MAX_OFFLINE_MUTATIONS; index += 1) {
      await log.append(
        intentInput({ intentId: `intent-${index}`, entityId: `act-${index}` }),
      );
    }
    // Two of them are stuck, which is precisely when the old live-mutation count undercounted.
    await log.fail('intent-0', 'rejected');
    await log.refreshClockRule();

    await expect(log.append(intentInput({ intentId: 'one-too-many' }))).rejects.toThrow(
      IntentLogFullError,
    );
    expect(log.pending()).toHaveLength(MAX_OFFLINE_MUTATIONS);
  });

  it('reports a storage failure instead of claiming the action was accepted', async () => {
    const storage = fakeStorage();
    const log = new IntentLog(USER, storage);
    await log.hydrate();
    storage.failNextSet();

    await expect(log.append(intentInput())).rejects.toThrow('quota exceeded');
    // The in-memory view rolled back, so nothing claims a durability it does not have.
    expect(log.pending()).toHaveLength(0);
  });

  it('serialises concurrent appends so neither overwrites the other', async () => {
    const storage = fakeStorage();
    const log = new IntentLog(USER, storage);
    await log.hydrate();

    await Promise.all([
      log.append(intentInput({ intentId: 'one', entityId: 'act-1' })),
      log.append(intentInput({ intentId: 'two', entityId: 'act-2' })),
      log.append(intentInput({ intentId: 'three', entityId: 'act-3' })),
    ]);

    expect(log.pending()).toHaveLength(3);
    expect(log.replayable().map((intent) => intent.seq)).toEqual([1, 2, 3]);
    const stored: unknown = JSON.parse(storage.data.get(intentLogKey(USER)) ?? '{}');
    expect((stored as { intents: unknown[] }).intents).toHaveLength(3);
  });

  it('persists before the request, so a mid-request kill still has the intent', async () => {
    const storage = fakeStorage();
    const log = new IntentLog(USER, storage);
    await log.hydrate();
    setActiveIntentLog(log);

    const order: string[] = [];
    const client = createOfflineQueryClient();
    registerActivityMutationDefaults(client, {
      request: async () => {
        order.push('request');
        // What storage held at the moment the request went out — the whole contract.
        const raw = storage.data.get(intentLogKey(USER)) ?? '{"intents":[]}';
        expect((JSON.parse(raw) as { intents: unknown[] }).intents).toHaveLength(1);
        return { data: {} };
      },
    } as unknown as Parameters<typeof registerActivityMutationDefaults>[1]);

    const originalSet = storage.setItem.bind(storage);
    storage.setItem = async (key, value) => {
      order.push('persist');
      await originalSet(key, value);
    };

    const mutation = client.getMutationCache().build(client, {
      ...client.getMutationDefaults(['activity', 'complete']),
      mutationKey: ['activity', 'complete'],
    });
    await mutation.execute({
      activityId: ACTIVITY,
      input: {},
      idempotencyKey: 'idem-write-ahead',
    });

    expect(order[0]).toBe('persist');
    expect(order).toContain('request');
    expect(order.indexOf('persist')).toBeLessThan(order.indexOf('request'));
    // Acknowledged on success, so the queue does not grow with completed work.
    expect(log.pending()).toHaveLength(0);
    setActiveIntentLog(undefined);
  });

  it('persists, expands a recurring create, then starts its request', async () => {
    const storage = fakeStorage();
    const log = new IntentLog(USER, storage);
    await log.hydrate();
    setActiveIntentLog(log);

    const client = createOfflineQueryClient();
    const key = ['agenda', '2026-08-18', '2026-08-19', 'America/New_York', null] as const;
    client.setQueryData(key, {
      days: [
        { date: '2026-08-18', schedule: [], anytime: [], earlier: [] },
        { date: '2026-08-19', schedule: [], anytime: [], earlier: [] },
      ],
      warnings: [],
    } satisfies AgendaData);

    const recurring = {
      activityId: ACTIVITY,
      objectKind: 'task',
      type: 'task',
      title: 'Daily walk',
      status: 'scheduled',
      schedule: {
        date: '2026-08-18',
        time: '18:00',
        timezone: 'America/New_York',
      },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', interval: 1, effectiveFrom: '2026-08-18' }],
      },
    } as Activity;
    let finishRequest: ((response: { data: Activity }) => void) | undefined;
    registerActivityMutationDefaults(client, {
      request: async () => {
        expect(log.pending()[0]?.entityId).toBe(ACTIVITY);
        const agenda = client.getQueryData<AgendaData>(key);
        const occurrences = agenda?.days.flatMap((day) =>
          [...day.schedule, ...day.anytime, ...day.earlier].filter(
            (row) => row.activityId === ACTIVITY,
          ),
        );
        expect(occurrences?.map((row) => row.occurrenceDate)).toEqual([
          '2026-08-18',
          '2026-08-19',
        ]);
        return await new Promise<{ data: Activity }>((resolve) => {
          finishRequest = resolve;
        });
      },
    } as unknown as Parameters<typeof registerActivityMutationDefaults>[1]);

    const mutation = client.getMutationCache().build(client, {
      ...client.getMutationDefaults(['activity', 'create']),
      mutationKey: ['activity', 'create'],
    });
    const variables = {
      input: {
        activityId: ACTIVITY,
        objectKind: 'task',
        type: 'task',
        title: 'Daily walk',
        schedule: recurring.schedule,
        recurrence: recurring.recurrence,
      },
      idempotencyKey: 'idem-recurring-create',
    };
    const accepted = waitForActivityCreateAcceptance(variables.idempotencyKey);
    const execution = mutation.execute(variables);

    await accepted.promise;
    // The UI acceptance boundary does not wait for this deliberately unfinished request.
    expect(log.pending()).toHaveLength(1);
    await vi.waitFor(() => expect(finishRequest).toBeTypeOf('function'));
    finishRequest?.({ data: recurring });
    await execution;

    expect(log.pending()).toHaveLength(0);
    setActiveIntentLog(undefined);
  });

  it('rolls a provisional create back when no durable native queue exists', async () => {
    setActiveIntentLog(undefined);
    const client = createOfflineQueryClient();
    const key = ['agenda', '2026-08-18', '2026-08-18', 'America/New_York', null] as const;
    const original = {
      days: [{ date: '2026-08-18', schedule: [], anytime: [], earlier: [] }],
      warnings: [],
    } satisfies AgendaData;
    client.setQueryData(key, original);
    registerActivityMutationDefaults(client, {
      request: async () => {
        throw new ApiError('validation_failed', 'Nope', 400, 'req-create');
      },
    } as unknown as Parameters<typeof registerActivityMutationDefaults>[1]);
    const mutation = client.getMutationCache().build(client, {
      ...client.getMutationDefaults(['activity', 'create']),
      mutationKey: ['activity', 'create'],
    });

    await expect(
      mutation.execute({
        input: {
          activityId: ACTIVITY,
          objectKind: 'task',
          type: 'task',
          title: 'Rejected',
          schedule: { date: '2026-08-18', timezone: 'America/New_York' },
        },
        idempotencyKey: 'idem-rejected-create',
      }),
    ).rejects.toThrow('Nope');
    expect(client.getQueryData(key)).toEqual(original);
  });

  it('removes a fallback Today window when a non-durable create fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T16:00:00.000Z'));
    try {
      setActiveIntentLog(undefined);
      const client = createOfflineQueryClient();
      client.setQueryData(['me'], { timezone: 'America/New_York' });
      registerActivityMutationDefaults(client, {
        request: async () => {
          throw new ApiError('validation_failed', 'Nope', 400, 'req-create');
        },
      } as unknown as Parameters<typeof registerActivityMutationDefaults>[1]);
      const mutation = client.getMutationCache().build(client, {
        ...client.getMutationDefaults(['activity', 'create']),
        mutationKey: ['activity', 'create'],
      });
      const seededKey = [
        'agenda',
        '2026-08-18',
        '2026-08-19',
        'America/New_York',
        'anytime_unscheduled,overdue',
      ] as const;

      await expect(
        mutation.execute({
          input: {
            activityId: ACTIVITY,
            objectKind: 'task',
            type: 'task',
            title: 'Rejected offline fallback',
          },
          idempotencyKey: 'idem-rejected-fallback',
        }),
      ).rejects.toThrow('Nope');
      expect(client.getQueryData(seededKey)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposes an abandoned create-acceptance waiter without retaining it', async () => {
    const acceptance = waitForActivityCreateAcceptance('idem-abandoned-compose');
    acceptance.dispose();
    await expect(acceptance.promise).resolves.toBeUndefined();

    const replacement = waitForActivityCreateAcceptance('idem-abandoned-compose');
    replacement.dispose();
    await expect(replacement.promise).resolves.toBeUndefined();
  });

  it('refuses the action rather than reporting it accepted when the queue is full', async () => {
    const storage = fakeStorage();
    const log = new IntentLog(USER, storage);
    await log.hydrate();
    for (let index = 0; index < MAX_OFFLINE_MUTATIONS; index += 1) {
      await log.append(
        intentInput({ intentId: `full-${index}`, entityId: `act-${index}` }),
      );
    }
    setActiveIntentLog(log);

    const request = vi.fn(async () => ({ data: {} }));
    const client = createOfflineQueryClient();
    registerActivityMutationDefaults(client, {
      request,
    } as unknown as Parameters<typeof registerActivityMutationDefaults>[1]);
    const mutation = client.getMutationCache().build(client, {
      ...client.getMutationDefaults(['activity', 'complete']),
      mutationKey: ['activity', 'complete'],
    });

    await expect(
      mutation.execute({ activityId: ACTIVITY, input: {}, idempotencyKey: 'refused' }),
    ).rejects.toThrow(IntentLogFullError);
    // Refused *before* the wire, which is the difference between a full queue and a lost write.
    expect(request).not.toHaveBeenCalled();
    setActiveIntentLog(undefined);
  });

  it('does not append a second intent while replaying the first', async () => {
    const storage = fakeStorage();
    const log = new IntentLog(USER, storage);
    await log.hydrate();
    await log.append(intentInput());
    setActiveIntentLog(log);

    const client = createOfflineQueryClient();
    registerActivityMutationDefaults(client, {
      request: async () => ({ data: {} }),
    } as unknown as Parameters<typeof registerActivityMutationDefaults>[1]);

    await replayIntents(client, log);

    // One intent in, one acknowledged out. A queue that grew as it drained never drains.
    expect(log.pending()).toHaveLength(0);
    setActiveIntentLog(undefined);
  });

  /**
   * A create whose response was lost, replayed later (P2-49).
   *
   * The server already has the row, so the conditional write refuses the id and the replay
   * sees a `409`. Recovery reads the client's own id and finds it — a success wearing a
   * conflict's clothes, and crucially **not** a duplicate.
   */
  it('acknowledges a collision whose own id reads back, with no duplicate', async () => {
    const storage = fakeStorage();
    const log = new IntentLog(USER, storage);
    await log.hydrate();
    await log.append({
      intentId: 'lost-response',
      mutationKey: ['activity', 'create'],
      variables: { input: { activityId: ACTIVITY, title: 'Buy milk' } },
      entityId: ACTIVITY,
    });

    const runner = fakeRunner(async () => {
      throw Object.assign(new Error('That id is already in use.'), { status: 409 });
    });
    const http = {
      request: vi.fn(async () => ({ data: { activity: { activityId: ACTIVITY } } })),
    } as unknown as Parameters<typeof replayIntents>[2];

    const result = await replayIntents(runner, log, http);

    expect(result).toMatchObject({ acknowledged: 1, recovered: 1, parked: 0 });
    expect(log.pending()).toHaveLength(0);
    // Exactly one create attempt and one recovery read — never a second create.
    expect(runner.dispatched).toHaveLength(1);
  });

  it('parks a collision whose id is gone, and never re-mints it', async () => {
    const storage = fakeStorage();
    const log = new IntentLog(USER, storage);
    await log.hydrate();
    await log.append({
      intentId: 'tombstoned',
      mutationKey: ['activity', 'create'],
      variables: { input: { activityId: ACTIVITY, title: 'Buy milk' } },
      entityId: ACTIVITY,
    });

    const runner = fakeRunner(async () => {
      throw Object.assign(new Error('That id is already in use.'), { status: 409 });
    });
    const http = {
      request: vi.fn(async () => {
        throw new ApiError('not_found', 'Not found', 404, 'req_1');
      }),
    } as unknown as Parameters<typeof replayIntents>[2];

    const result = await replayIntents(runner, log, http);

    /**
     * Deleted on another device, or a foreign id — indistinguishable, and both need the user.
     * An automatic re-mint here is exactly how a tombstone gets bypassed and a deletion comes
     * back from the dead.
     */
    expect(result).toMatchObject({ parked: 1, acknowledged: 0 });
    expect(log.pending()[0]?.status).toBe('needs_confirmation');
    expect(log.replayable()).toHaveLength(0);
  });

  it('returns a transient failure to queued and keeps a permanent one for the user', async () => {
    const storage = fakeStorage();
    const log = new IntentLog(USER, storage);
    await log.hydrate();
    await log.append({
      intentId: 'transient',
      mutationKey: ['activity', 'complete'],
      variables: { activityId: 'act-transient' },
      entityId: 'act-transient',
    });
    await log.append({
      intentId: 'permanent',
      mutationKey: ['activity', 'complete'],
      variables: { activityId: 'act-permanent' },
      entityId: 'act-permanent',
    });

    // 503 is "not right now"; 422 is "never". Only the second may consume a user's write.
    const runner = fakeRunner(async (variables) => {
      const entity = (variables as { activityId?: string }).activityId;
      throw Object.assign(new Error('nope'), {
        status: entity === 'act-permanent' ? 422 : 503,
      });
    });
    const result = await replayIntents(runner, log);

    expect(result).toMatchObject({
      attempted: 2,
      requeued: 1,
      failed: 1,
      acknowledged: 0,
    });
    const byId = new Map(log.pending().map((intent) => [intent.intentId, intent]));
    expect(byId.get('transient')?.status).toBe('queued');
    expect(byId.get('permanent')?.status).toBe('failed');
    expect(byId.get('permanent')?.lastError).toBe('nope');
  });
});
