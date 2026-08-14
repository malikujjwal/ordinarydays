import { ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import {
  auditRecurringTerminalStatus,
  confirmationFor,
  findDamagedSeries,
} from '../scripts/migrations/recurring-terminal-status.js';

const meta = (activityId: string, status: string, recurring = true) => ({
  pk: `activity-${activityId}`,
  sk: 'meta',
  entity: 'Activity',
  activityId,
  status,
  ...(recurring ? { recurrence: { mode: 'fixed' } } : {}),
  ...(status === 'completed'
    ? { completedAt: '2026-08-14T11:00:00.000Z', outcome: 'done' }
    : status === 'skipped'
      ? { outcome: 'didnt_happen' }
      : {}),
  updatedAt: '2026-08-14T12:00:00.000Z',
});

const index = (activityId: string, user: string) => ({
  pk: `user-${user}`,
  sk: `index-${activityId}`,
  entity: 'ActivityIndex',
  activityId,
});

describe('the recurring terminal-status audit', () => {
  it('reports only recurring Activity rows with a terminal series status', () => {
    const candidates = findDamagedSeries([
      meta('z-recurring-skipped', 'skipped'),
      meta('a-recurring-completed', 'completed'),
      meta('healthy-recurring', 'scheduled'),
      meta('completed-one-off', 'completed', false),
      index('a-recurring-completed', 'owner'),
    ]);

    expect(
      candidates.map(({ activityId, currentStatus, proposedStatus, indexKeys }) => ({
        activityId,
        currentStatus,
        proposedStatus,
        indexCount: indexKeys.length,
      })),
    ).toEqual([
      {
        activityId: 'a-recurring-completed',
        currentStatus: 'completed',
        proposedStatus: 'scheduled',
        indexCount: 1,
      },
      {
        activityId: 'z-recurring-skipped',
        currentStatus: 'skipped',
        proposedStatus: 'scheduled',
        indexCount: 0,
      },
    ]);
  });

  it('is report-only by default and never sends a transaction', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Items: [meta('damaged', 'completed'), index('damaged', 'owner')],
    });

    const report = await auditRecurringTerminalStatus(
      { send },
      { tableName: 'od-main-dev' },
    );

    expect(report).toEqual({
      tableName: 'od-main-dev',
      mode: 'report-only',
      damagedSeries: [
        {
          activityId: 'damaged',
          currentStatus: 'completed',
          proposedStatus: 'scheduled',
          indexRowCount: 1,
        },
      ],
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(ScanCommand);
  });

  it('refuses repair until the operator confirms the exact table', async () => {
    const send = vi.fn();

    await expect(
      auditRecurringTerminalStatus(
        { send },
        { tableName: 'od-main-prod', repair: true, confirmation: 'yes' },
      ),
    ).rejects.toThrow(confirmationFor('od-main-prod'));
    expect(send).not.toHaveBeenCalled();
  });

  it('conditionally restores META and every index after explicit confirmation', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [
          meta('damaged', 'completed'),
          index('damaged', 'owner'),
          index('damaged', 'participant'),
        ],
      })
      .mockResolvedValueOnce({});

    const report = await auditRecurringTerminalStatus(
      { send },
      {
        tableName: 'od-main-dev',
        repair: true,
        confirmation: confirmationFor('od-main-dev'),
        now: () => '2026-08-14T13:00:00.000Z',
      },
    );

    expect(report.mode).toBe('repair');
    expect(send).toHaveBeenCalledTimes(2);
    const command = send.mock.calls[1]?.[0];
    expect(command).toBeInstanceOf(TransactWriteCommand);
    const input = (command as TransactWriteCommand).input;
    expect(input.TransactItems).toHaveLength(3);
    expect(input.TransactItems?.[0]?.Update).toMatchObject({
      Key: { pk: 'activity-damaged', sk: 'meta' },
      UpdateExpression: expect.stringContaining('REMOVE #completedAt, #outcome'),
      ConditionExpression: expect.stringContaining('attribute_exists(#recurrence)'),
      ExpressionAttributeNames: expect.objectContaining({
        '#completedAt': 'completedAt',
        '#outcome': 'outcome',
      }),
      ExpressionAttributeValues: expect.objectContaining({
        ':current': 'completed',
        ':scheduled': 'scheduled',
        ':expected': '2026-08-14T12:00:00.000Z',
        ':repairedAt': '2026-08-14T13:00:00.000Z',
      }),
    });
    expect(input.TransactItems?.slice(1).map((item) => item.Update?.Key)).toEqual([
      { pk: 'user-owner', sk: 'index-damaged' },
      { pk: 'user-participant', sk: 'index-damaged' },
    ]);
  });
});
