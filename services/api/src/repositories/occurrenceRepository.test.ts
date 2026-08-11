import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Occurrence } from '@od/shared/types';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import * as repository from './occurrenceRepository.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ACTIVITY_ID = 'act_01J8XKQ2M4N5P6R7S8T9V0W1AA';

const completed = (date = '2026-08-08'): Occurrence => ({
  activityId: ACTIVITY_ID,
  date,
  status: 'completed',
  completedAt: '2026-08-08T15:00:00.000Z',
});

const stored = (value: Occurrence) => ({
  pk: `ACT#${value.activityId}`,
  sk: `OCC#${value.date}`,
  entity: 'Occurrence',
  ...value,
  createdAt: '2026-08-08T15:00:00.000Z',
  updatedAt: '2026-08-08T15:00:00.000Z',
  schemaVersion: 1,
});

beforeEach(() => ddbMock.reset());

describe('get', () => {
  it('returns null for the absence that means not yet acted on', async () => {
    ddbMock.on(GetCommand).resolves({});
    await expect(repository.get(ACTIVITY_ID, '2026-08-08')).resolves.toBeNull();
  });

  it('validates and projects a stored row', async () => {
    const value = completed();
    ddbMock.on(GetCommand).resolves({ Item: stored(value) });
    await expect(repository.get(ACTIVITY_ID, value.date)).resolves.toEqual(value);
  });

  it('never projects participant identity from a malformed stored row', async () => {
    const value = completed();
    ddbMock.on(GetCommand).resolves({ Item: { ...stored(value), userId: 'usr_wrong' } });

    const read = await repository.get(ACTIVITY_ID, value.date);
    expect(read).not.toHaveProperty('userId');
  });
});

describe('batchGetForPairs', () => {
  it('preserves requested order and explicit misses', async () => {
    const first = completed('2026-08-01');
    const third = completed('2026-08-03');
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'od-main-local': [stored(third), stored(first)] },
    });

    const result = await repository.batchGetForPairs([
      { activityId: ACTIVITY_ID, date: first.date },
      { activityId: ACTIVITY_ID, date: '2026-08-02' },
      { activityId: ACTIVITY_ID, date: third.date },
    ]);

    expect(result).toEqual([first, null, third]);
  });
});

describe('batchGetAgendaRows', () => {
  it('deduplicates mixed keys and normalises destination move markers', async () => {
    const value = completed('2026-08-03');
    ddbMock.on(BatchGetCommand).resolves({
      Responses: {
        'od-main-local': [
          stored(value),
          {
            pk: `ACT#${ACTIVITY_ID}`,
            sk: 'MOVE#2026-08-04',
            entity: 'OccurrenceMoveMarker',
            activityId: ACTIVITY_ID,
            destinationDate: '2026-08-04',
            movedFrom: ['2026-08-03', '2026-08-02', '2026-08-03'],
          },
        ],
      },
    });

    await expect(
      repository.batchGetAgendaRows(
        [
          { activityId: ACTIVITY_ID, date: value.date },
          { activityId: ACTIVITY_ID, date: value.date },
        ],
        [
          { activityId: ACTIVITY_ID, date: '2026-08-04' },
          { activityId: ACTIVITY_ID, date: '2026-08-04' },
        ],
      ),
    ).resolves.toEqual({
      occurrences: [value],
      markers: [
        {
          activityId: ACTIVITY_ID,
          destinationDate: '2026-08-04',
          movedFrom: ['2026-08-02', '2026-08-03'],
        },
      ],
    });

    expect(ddbMock.commandCalls(BatchGetCommand)[0]?.args[0]?.input).toMatchObject({
      RequestItems: {
        'od-main-local': {
          Keys: [
            { pk: `ACT#${ACTIVITY_ID}`, sk: 'OCC#2026-08-03' },
            { pk: `ACT#${ACTIVITY_ID}`, sk: 'MOVE#2026-08-04' },
          ],
        },
      },
    });
  });
});

describe('queryWindow and countCompleted', () => {
  it('uses inclusive occurrence sort-key bounds', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await repository.queryWindow(ACTIVITY_ID, '2026-08-01', '2026-08-31');

    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0]?.input).toMatchObject({
      KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :from AND :to',
      ExpressionAttributeValues: {
        ':pk': `ACT#${ACTIVITY_ID}`,
        ':from': 'OCC#2026-08-01',
        ':to': 'OCC#2026-08-31',
      },
    });
  });

  it('counts only completed occurrence rows', async () => {
    ddbMock.on(QueryCommand).resolves({ Count: 3 });
    await expect(repository.countCompleted(ACTIVITY_ID)).resolves.toBe(3);

    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0]?.input).toMatchObject({
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :skPrefix)',
      FilterExpression: '#filter = :filter',
      Select: 'COUNT',
      ExpressionAttributeValues: { ':skPrefix': 'OCC#', ':filter': 'completed' },
    });
  });
});

describe('writes', () => {
  it('puts one OCC domain item and no META item', async () => {
    ddbMock.on(PutCommand).resolves({});
    await repository.put(completed());

    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0]?.input.Item).toMatchObject({
      pk: `ACT#${ACTIVITY_ID}`,
      sk: 'OCC#2026-08-08',
      entity: 'Occurrence',
    });
    expect(calls[0]?.args[0]?.input.Item?.sk).not.toBe('META');
  });

  it('deletes only the addressed override', async () => {
    ddbMock.on(DeleteCommand).resolves({});
    await repository.delete(ACTIVITY_ID, '2026-08-08');
    expect(ddbMock.commandCalls(DeleteCommand)[0]?.args[0]?.input.Key).toEqual({
      pk: `ACT#${ACTIVITY_ID}`,
      sk: 'OCC#2026-08-08',
    });
  });
});

describe('repository ownership', () => {
  const directory = fileURLToPath(new URL('.', import.meta.url));

  it('keeps listOccurrences only in OccurrenceRepository', () => {
    const owners = readdirSync(directory)
      .filter((file) => file.endsWith('Repository.ts'))
      .filter((file) =>
        readFileSync(`${directory}/${file}`, 'utf8').includes('listOccurrences'),
      );
    expect(owners).toEqual(['occurrenceRepository.ts']);
  });

  it('leaves no OCC# access in ActivityRepository', () => {
    const activity = readFileSync(`${directory}/activityRepository.ts`, 'utf8');
    expect(activity).not.toContain('OCC#');
    expect(activity).not.toContain('occurrenceRange');
  });
});
