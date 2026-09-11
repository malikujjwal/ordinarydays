import type {
  ActivityStatus,
  ActivityType,
  ListItemActivityLink,
} from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import { bridgeViewerPair } from './bridgeViewerPair';

const LINK: ListItemActivityLink = {
  listId: 'lst_01J000000000000000000000AA',
  itemId: 'itm_01J000000000000000000000AA',
  viewerUserId: 'usr_01J000000000000000000000AA',
  activityId: 'act_01J000000000000000000000BB',
  linkedAt: '2026-09-08T12:00:00.000Z',
};

const plan = (
  activityId: string,
  extras: {
    objectKind?: 'plan' | 'task';
    type?: ActivityType;
    status?: ActivityStatus;
  } = {},
): Parameters<typeof bridgeViewerPair>[1] => ({
  activityId,
  objectKind: extras.objectKind ?? 'plan',
  type: extras.type ?? 'meal',
  status: extras.status ?? 'scheduled',
  schedule: { date: '2026-09-08', timezone: 'America/New_York' },
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

  it('omits the pair when a Plan carries a Task type, which no valid Activity does', () => {
    expect(
      bridgeViewerPair(LINK, plan(LINK.activityId, { type: 'task' })),
    ).toBeUndefined();
  });
});
