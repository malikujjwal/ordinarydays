import type { Activity } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import {
  type ActionCapabilityContext,
  deriveActionCapabilities,
} from './actionCapabilities.js';

function activity(overrides: Partial<Activity> = {}): Activity {
  return {
    activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
    ownerId: 'usr_owner',
    objectKind: 'task',
    type: 'task',
    status: 'scheduled',
    title: 'Pack bags',
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    details: { kind: 'task' },
    icsSequence: 0,
    createdAt: '2026-08-01T10:00:00.000Z',
    lastActivityAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    schemaVersion: 1,
    ...overrides,
  } as Activity;
}

const allowed = { complete: true, skip: true, snooze: true };
const denied = { complete: false, skip: false, snooze: false };

describe('deriveActionCapabilities', () => {
  it.each<{
    name: string;
    context: ActionCapabilityContext;
    expected: typeof allowed;
  }>([
    {
      name: 'the Activity owner',
      context: {
        activity: activity(),
        callerId: 'usr_owner',
        callerRole: 'owner',
        participatesInParent: false,
      },
      expected: allowed,
    },
    {
      name: 'a participant of an ordinary Plan',
      context: {
        activity: activity({
          objectKind: 'plan',
          type: 'event',
          details: { kind: 'event' },
        }),
        callerId: 'usr_participant',
        callerRole: 'participant',
        participatesInParent: false,
      },
      expected: denied,
    },
    {
      name: 'the parent Plan owner acting on a prep task',
      context: {
        activity: activity({
          ownerId: 'usr_child_owner',
          parentActivityId: 'act_parent',
        }),
        callerId: 'usr_parent_owner',
        callerRole: 'participant',
        parentOwnerId: 'usr_parent_owner',
        participatesInParent: false,
      },
      expected: allowed,
    },
    {
      name: 'a parent Plan participant acting on a prep task',
      context: {
        activity: activity({
          ownerId: 'usr_child_owner',
          parentActivityId: 'act_parent',
        }),
        callerId: 'usr_parent_participant',
        callerRole: 'participant',
        parentOwnerId: 'usr_parent_owner',
        participatesInParent: true,
      },
      expected: allowed,
    },
    {
      name: 'a direct child participant without parent participation',
      context: {
        activity: activity({
          ownerId: 'usr_child_owner',
          parentActivityId: 'act_parent',
        }),
        callerId: 'usr_child_participant',
        callerRole: 'participant',
        parentOwnerId: 'usr_parent_owner',
        participatesInParent: false,
      },
      expected: denied,
    },
    {
      name: 'a stranger',
      context: {
        activity: activity(),
        callerId: 'usr_stranger',
        callerRole: 'none',
        participatesInParent: false,
      },
      expected: denied,
    },
  ])(
    'returns one verdict for complete, skip and snooze for $name',
    ({ context, expected }) => {
      expect(deriveActionCapabilities(context)).toEqual(expected);
    },
  );
});
