import type { PlansDateStore } from '@od/shared/client';
import type { WallDate } from '@od/shared/time';
import type { Activity } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import { applyPlansCreate, applyPlansRemove, createdActivityFrom } from './plansApply';

/**
 * The Plans tab's create projection (Phase B fix for `create-activity.spec.ts`): the 201's
 * authoritative Activity lands in the stage its schedule implies, without any refetch racing
 * the eventually consistent GSI the tab reads.
 */

const CLOCK = { today: '2026-08-06' as WallDate, currentMinute: '12:00' };

const activity = (patch: Record<string, unknown> = {}): Activity =>
  ({
    activityId: 'act_01J8CREATED000000000000000',
    ownerId: 'usr_local_dev',
    objectKind: 'plan',
    type: 'event',
    status: 'scheduled',
    title: 'Dinner at Zahav',
    schedule: { date: '2026-08-07', time: '19:00', timezone: 'America/New_York' },
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    details: { kind: 'event' },
    icsSequence: 0,
    createdAt: '2026-08-06T10:00:00.000Z',
    lastActivityAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:00:00.000Z',
    schemaVersion: 1,
    ...patch,
  }) as Activity;

const emptyState = () => ({
  needsDate: [],
  store: { byDate: new Map(), covered: [] } as PlansDateStore,
});

describe('applyPlansCreate', () => {
  it('inserts a dated create on its own date, in time-then-id order', () => {
    const existing = activity({
      activityId: 'act_01J8EXISTING00000000000000',
      title: 'Later dinner',
      schedule: { date: '2026-08-07', time: '21:00', timezone: 'America/New_York' },
    });
    const seeded = applyPlansCreate(emptyState(), existing, CLOCK);
    if (seeded === undefined) throw new Error('seed projection must apply');

    const next = applyPlansCreate(seeded, activity(), CLOCK);
    const day = next?.store.byDate.get('2026-08-07' as WallDate);
    expect(day?.map((row) => row.title)).toEqual(['Dinner at Zahav', 'Later dinner']);
  });

  it('heads Needs a date with an undated plan and the server lastActivityAt', () => {
    const next = applyPlansCreate(
      emptyState(),
      activity({ status: 'saved', schedule: undefined }),
      CLOCK,
    );
    expect(next?.needsDate[0]).toMatchObject({
      activityId: 'act_01J8CREATED000000000000000',
      lastActivityAt: '2026-08-06T10:00:00.000Z',
      suggestionCount: 0,
    });
  });

  it('leaves an undated Task alone — it belongs to Today, not this tab', () => {
    expect(
      applyPlansCreate(
        emptyState(),
        activity({
          objectKind: 'task',
          type: 'task',
          status: 'saved',
          schedule: undefined,
          details: { kind: 'task' },
        }),
        CLOCK,
      ),
    ).toBeUndefined();
  });

  it('is idempotent for a row the state already holds', () => {
    const once = applyPlansCreate(emptyState(), activity(), CLOCK);
    if (once === undefined) throw new Error('first projection must apply');
    expect(applyPlansCreate(once, activity(), CLOCK)).toBeUndefined();
  });

  it('scopes a recurring create to its first occurrence', () => {
    const next = applyPlansCreate(
      emptyState(),
      activity({
        recurrence: {
          mode: 'fixed',
          segments: [{ freq: 'daily', effectiveFrom: '2026-08-07' }],
        },
      }),
      CLOCK,
    );
    const day = next?.store.byDate.get('2026-08-07' as WallDate);
    expect(day?.[0]).toMatchObject({
      isRecurring: true,
      occurrenceDate: '2026-08-07',
    });
  });
});

describe('applyPlansRemove', () => {
  it('strips the row from a date while keeping the emptied key as loaded-and-empty', () => {
    const seeded = applyPlansCreate(emptyState(), activity(), CLOCK);
    if (seeded === undefined) throw new Error('seed projection must apply');

    const next = applyPlansRemove(seeded, 'act_01J8CREATED000000000000000');
    expect(next?.store.byDate.get('2026-08-07' as WallDate)).toEqual([]);
  });

  it('strips an undated plan from Needs a date', () => {
    const seeded = applyPlansCreate(
      emptyState(),
      activity({ status: 'saved', schedule: undefined }),
      CLOCK,
    );
    if (seeded === undefined) throw new Error('seed projection must apply');

    const next = applyPlansRemove(seeded, 'act_01J8CREATED000000000000000');
    expect(next?.needsDate).toEqual([]);
  });

  it('answers undefined when nothing held the row, so identities stay stable', () => {
    expect(
      applyPlansRemove(emptyState(), 'act_01J8CREATED000000000000000'),
    ).toBeUndefined();
  });
});

describe('createdActivityFrom', () => {
  it('unwraps a bare Activity and the bridge’s enveloped one alike', () => {
    const bare = activity();
    expect(createdActivityFrom(bare)?.activityId).toBe(bare.activityId);
    expect(createdActivityFrom({ activity: bare })?.activityId).toBe(bare.activityId);
    expect(createdActivityFrom({ meta: {} })).toBeUndefined();
  });

  it('rejects an Activity-like object that fails the shared boundary schema', () => {
    expect(
      createdActivityFrom({ ...activity(), status: 'not-a-status' }),
    ).toBeUndefined();
    expect(
      createdActivityFrom({ activity: { activityId: activity().activityId } }),
    ).toBeUndefined();
  });
});
