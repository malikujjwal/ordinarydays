import { describe, expect, it } from 'vitest';
import { bridgeViewerPair } from './bridgeViewerPair';

const LINK = {
  listId: 'lst_01J000000000000000000000AA',
  itemId: 'itm_01J000000000000000000000AA',
  activityId: 'act_01J000000000000000000000BB',
  relationship: 'scheduled_from' as const,
};

const plan = (
  activityId: string,
  extras: { objectKind?: 'plan' | 'task'; type?: string; status?: string } = {},
) => ({
  activityId,
  objectKind: extras.objectKind ?? 'plan',
  type: extras.type ?? 'meal',
  status: extras.status ?? 'scheduled',
  schedule: { date: '2026-09-08', timezone: 'America/New_York' as const },
});

describe('bridgeViewerPair', () => {
  it("pairs the current pointer with that Plan's own type, status and schedule", () => {
    const current = plan(LINK.activityId);
    expect(bridgeViewerPair(LINK, current)).toEqual({
      viewerLink: LINK,
      viewerPlan: {
        type: 'meal',
        status: 'scheduled',
        schedule: current.schedule,
      },
    });
  });

  it('omits the pair when a replayed Plan is not the current pointer', () => {
    expect(
      bridgeViewerPair(LINK, plan('act_01J000000000000000000000AA')),
    ).toBeUndefined();
  });

  it('omits the pair when the installed activity is not a Plan', () => {
    expect(
      bridgeViewerPair(LINK, plan(LINK.activityId, { objectKind: 'task' })),
    ).toBeUndefined();
  });
});
