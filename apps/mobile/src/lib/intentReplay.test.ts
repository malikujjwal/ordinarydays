import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntentLog, type IntentLogStorage } from '@/lib/intentLog';
import {
  registerIntentReplayTarget,
  requestActiveIntentReplay,
} from '@/lib/intentReplay';

const USER = 'usr_01J0000000000000000000000A';
const ENTITY = 'act_01J0000000000000000000000B';
let stopReplay: (() => void) | undefined;

function storage(): IntentLogStorage {
  const data = new Map<string, string>();
  return {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
  };
}

function runner(behaviour: () => Promise<unknown>) {
  const dispatch = vi.fn(behaviour);
  return {
    dispatch,
    getMutationDefaults: () => ({ mutationFn: dispatch }),
    getMutationCache: () => ({
      build: (
        _client: unknown,
        options: { mutationFn?: (variables: unknown) => Promise<unknown> },
      ) => ({
        execute: (variables: unknown) =>
          options.mutationFn?.(variables) ?? Promise.resolve(undefined),
      }),
    }),
  } as unknown as Parameters<typeof registerIntentReplayTarget>[0] & {
    dispatch: ReturnType<typeof vi.fn>;
  };
}

async function queuedLog(): Promise<IntentLog> {
  const log = new IntentLog(USER, storage());
  await log.hydrate();
  await log.append({
    intentId: 'queued',
    mutationKey: ['activity', 'complete'],
    variables: { activityId: ENTITY },
    entityId: ENTITY,
  });
  return log;
}

afterEach(() => {
  stopReplay?.();
  stopReplay = undefined;
  vi.useRealTimers();
});

describe('level-triggered intent replay', () => {
  it('coalesces enqueue, foreground and reconnect requests into one dispatch', async () => {
    const log = await queuedLog();
    let finish: (() => void) | undefined;
    const target = runner(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({});
        }),
    );
    stopReplay = registerIntentReplayTarget(target, log);

    const enqueue = requestActiveIntentReplay('enqueue');
    const foreground = requestActiveIntentReplay('foreground');
    const reconnect = requestActiveIntentReplay('reconnect');
    await vi.waitFor(() => expect(target.dispatch).toHaveBeenCalledOnce());
    finish?.();
    await Promise.all([enqueue, foreground, reconnect]);

    expect(target.dispatch).toHaveBeenCalledOnce();
    expect(log.pending()).toHaveLength(0);
  });

  it('backs off a transient failure and drains without a connectivity edge', async () => {
    vi.useFakeTimers();
    const log = await queuedLog();
    let calls = 0;
    const target = runner(async () => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return {};
    });
    stopReplay = registerIntentReplayTarget(target, log);

    const first = requestActiveIntentReplay('foreground');
    expect((await first)?.requeued).toBe(1);
    expect(log.pending()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(target.dispatch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(log.pending()).toHaveLength(0));

    expect(target.dispatch).toHaveBeenCalledTimes(2);
  });

  it('bounds repeated backoff attempts instead of installing a fixed loop', async () => {
    vi.useFakeTimers();
    const log = await queuedLog();
    const target = runner(async () => {
      throw new Error('still offline');
    });
    stopReplay = registerIntentReplayTarget(target, log);

    await requestActiveIntentReplay('enqueue');
    for (const delay of [1_000, 2_000, 5_000, 10_000, 30_000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    await vi.advanceTimersByTimeAsync(120_000);

    expect(target.dispatch).toHaveBeenCalledTimes(6);
    expect(log.pending()).toHaveLength(1);
  });
});
