import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Intent } from '@/lib/intentLog';
import {
  pendingCreateAllowsOpen,
  useAgendaRowIntentState,
  usePendingCreate,
  usePendingIntents,
} from './usePendingIntents.native';

const nativeState = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('@/lib/sqlite/nativeState', () => ({
  requireActiveNativeState: () => nativeState.current,
}));

function presentation(rows: readonly Intent[]) {
  const pending = rows.filter((intent) => intent.status !== 'acknowledged');
  const blocked = pending.filter((intent) => intent.status === 'needs_attention');
  const global = { pending, blocked };
  const entities = new Map<string | undefined, readonly Intent[]>();
  const occurrences = new Map<string, readonly Intent[]>();
  return {
    subscribe: vi.fn(() => () => undefined),
    getSnapshot: vi.fn(() => global),
    subscribeEntity: vi.fn(() => () => undefined),
    getEntitySnapshot: vi.fn((entityId: string | undefined) => {
      const current = entities.get(entityId);
      if (current !== undefined) return current;
      const next = rows.filter((intent) => intent.entityId === entityId);
      entities.set(entityId, next);
      return next;
    }),
    subscribeOccurrence: vi.fn(() => () => undefined),
    getOccurrenceSnapshot: vi.fn(
      (entityId: string | undefined, occurrenceDate?: string) => {
        const key = JSON.stringify([entityId, occurrenceDate ?? null]);
        const current = occurrences.get(key);
        if (current !== undefined) return current;
        const next = rows.filter((intent) => {
          if (intent.entityId !== entityId) return false;
          if (!['complete', 'uncomplete'].includes(intent.mutationKey[1] ?? '')) {
            return true;
          }
          const input = (intent.variables as { input?: { occurrenceDate?: string } })
            .input;
          return input?.occurrenceDate === occurrenceDate;
        });
        occurrences.set(key, next);
        return next;
      },
    ),
  };
}

function row(
  intentId: string,
  entityId: string,
  overrides: Partial<Intent> = {},
): Intent {
  return {
    intentId,
    ownerUserId: 'usr_01J0000000000000000000000A',
    mutationKey: ['activity', 'create'],
    variables: {},
    entityId,
    status: 'queued',
    createdAt: 1_787_097_600_000,
    seq: 1,
    attempts: 0,
    ...overrides,
  };
}

describe('native pending intent selectors', () => {
  afterEach(() => {
    nativeState.current = undefined;
    vi.restoreAllMocks();
  });

  it('reads stable keyed and aggregate snapshots from the session store', () => {
    const first = 'act_01J0000000000000000000000A';
    const second = 'act_01J0000000000000000000000B';
    const store = presentation([row('intent-create', first)]);
    nativeState.current = {
      outboxPresentation: store,
      coordinator: { ownerUserId: 'usr_01J0000000000000000000000A' },
    };

    const mounted = renderHook(() => ({
      first: usePendingCreate(first),
      second: usePendingCreate(second),
      all: usePendingIntents(),
    }));

    expect(mounted.result.current.first.pending).toBe(true);
    expect(mounted.result.current.second.pending).toBe(false);
    expect(mounted.result.current.all).toHaveLength(1);
    expect(store.subscribe).toHaveBeenCalledOnce();
    expect(store.subscribeEntity).toHaveBeenCalledTimes(2);
    mounted.unmount();
  });

  it('derives both agenda-row gates from one exact occurrence snapshot', () => {
    const entityId = 'act_01J0000000000000000000000A';
    const store = presentation([row('intent-create', entityId)]);
    nativeState.current = {
      outboxPresentation: store,
      coordinator: { ownerUserId: 'usr_01J0000000000000000000000A' },
    };

    const mounted = renderHook(() => useAgendaRowIntentState(entityId));

    expect(mounted.result.current.pendingCreate.pending).toBe(true);
    expect(mounted.result.current.mutationInert).toBe(true);
    expect(mounted.result.current.recurrenceEdit.status).toBe('idle');
    expect(pendingCreateAllowsOpen).toBe(true);
    expect(store.subscribeOccurrence).toHaveBeenCalledOnce();
    mounted.unmount();
  });

  it('matches failed completion intents to the exact recurring occurrence', () => {
    const entityId = 'act_01J0000000000000000000000A';
    const store = presentation(
      ['2026-08-20', '2026-08-21'].map((occurrenceDate, index) =>
        row(`intent-complete-${index + 1}`, entityId, {
          mutationKey: ['activity', 'complete'],
          variables: { activityId: entityId, input: { occurrenceDate } },
          status: 'needs_attention',
          seq: index + 1,
          attempts: 1,
          attention: { kind: 'rejected', status: 409 },
        }),
      ),
    );
    nativeState.current = {
      outboxPresentation: store,
      coordinator: { ownerUserId: 'usr_01J0000000000000000000000A' },
    };

    const mounted = renderHook(() => useAgendaRowIntentState(entityId, '2026-08-21'));

    expect(mounted.result.current.failedCompletionIntentIds).toEqual([
      'intent-complete-2',
    ]);
    mounted.unmount();
  });

  it.each([
    {
      label: 'queued',
      status: 'queued' as const,
      expected: { inert: true, status: 'queued', message: 'Will update when online' },
    },
    {
      label: 'in flight',
      status: 'in_flight' as const,
      expected: { inert: true, status: 'updating', message: 'Updating schedule…' },
    },
    {
      label: 'acknowledged and reconciling',
      status: 'acknowledged' as const,
      expected: { inert: true, status: 'updating', message: 'Updating schedule…' },
    },
    {
      label: 'waiting for reconciliation retry',
      status: 'acknowledged' as const,
      lastError: 'network',
      expected: {
        inert: true,
        status: 'retry',
        message: "Couldn't refresh schedule · Retry",
      },
    },
    {
      label: 'permanently rejected',
      status: 'needs_attention' as const,
      lastError: 'The recurrence conversion was rejected.',
      expected: {
        inert: false,
        status: 'failed',
        message: 'The recurrence conversion was rejected.',
      },
    },
  ])('classifies a $label recurrence conversion consistently', (fixture) => {
    const entityId = 'act_01J0000000000000000000000A';
    const store = presentation([
      row('intent-convert', entityId, {
        mutationKey: ['activity', 'convert-recurrence'],
        variables: { activityId: entityId, input: { selectedDate: '2026-08-21' } },
        status: fixture.status,
        ...(fixture.lastError === undefined ? {} : { lastError: fixture.lastError }),
      }),
    ]);
    nativeState.current = {
      outboxPresentation: store,
      coordinator: { ownerUserId: 'usr_01J0000000000000000000000A' },
    };

    const mounted = renderHook(() => useAgendaRowIntentState(entityId, '2026-08-21'));

    expect(mounted.result.current.recurrenceEdit).toEqual(fixture.expected);
    expect(mounted.result.current.mutationInert).toBe(fixture.expected.inert);
    mounted.unmount();
  });
});
