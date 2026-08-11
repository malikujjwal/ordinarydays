import {
  DeleteCommand,
  DynamoDBDocumentClient,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Device } from '@od/shared/types';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { deleteDevice, newDeviceId, putDevice } from './deviceRepository.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

const sentPut = () =>
  ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems?.[0]?.Put;
const sentDelete = () => ddbMock.commandCalls(DeleteCommand)[0]?.args[0].input;

const device = (overrides: Partial<Device> = {}): Device => ({
  deviceId: 'dev_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  expoPushToken: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
  platform: 'ios',
  createdAt: '2026-08-09T12:00:00.000Z',
  updatedAt: '2026-08-09T12:00:00.000Z',
  schemaVersion: 1,
  ...overrides,
});

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(TransactWriteCommand).resolves({});
  ddbMock.on(DeleteCommand).resolves({});
});

describe('newDeviceId', () => {
  it('is dev_ plus a 26-character ULID', () => {
    expect(newDeviceId()).toMatch(/^dev_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('passes the shared deviceId schema', async () => {
    const { deviceId } = await import('@od/shared/schemas');
    expect(deviceId.safeParse(newDeviceId()).success).toBe(true);
  });

  it('is unique across calls', () => {
    const ids = new Set(Array.from({ length: 50 }, newDeviceId));
    expect(ids.size).toBe(50);
  });

  /**
   * Two registrations inside one millisecond is not hypothetical — a client retrying a
   * timed-out `POST` does exactly that — and plain `ulid()` would break the tie with random
   * bits, so the ids would sort arbitrarily (`data-model.md` §8).
   */
  it('sorts by creation time as a plain string, even within one millisecond', () => {
    const ids = Array.from({ length: 20 }, newDeviceId);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('putDevice', () => {
  it('writes USER#<id> / DEVICE#<deviceId>', async () => {
    await putDevice('usr_a', device());

    expect(sentPut()?.Item?.pk).toBe('USER#usr_a');
    expect(sentPut()?.Item?.sk).toBe('DEVICE#dev_01J8XKQ2M4N5P6R7S8T9V0W1X2');
  });

  it('stamps entity and schemaVersion, which nothing else can supply', async () => {
    await putDevice('usr_a', device());

    expect(sentPut()?.Item?.entity).toBe('Device');
    expect(sentPut()?.Item?.schemaVersion).toBe(1);
  });

  it('writes the domain fields, field by field', async () => {
    await putDevice('usr_a', device({ deviceName: "Ada's iPhone" }));

    expect(sentPut()?.Item).toMatchObject({
      deviceId: 'dev_01J8XKQ2M4N5P6R7S8T9V0W1X2',
      expoPushToken: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
      platform: 'ios',
      deviceName: "Ada's iPhone",
      createdAt: '2026-08-09T12:00:00.000Z',
      updatedAt: '2026-08-09T12:00:00.000Z',
    });
  });

  it('omits an absent deviceName rather than writing an undefined attribute', async () => {
    await putDevice('usr_a', device());

    expect(sentPut()?.Item).not.toHaveProperty('deviceName');
  });

  /** A fresh ULID cannot collide; the condition asserts that rather than trusting it. */
  it('refuses to overwrite an existing row', async () => {
    await putDevice('usr_a', device());

    expect(sentPut()?.ConditionExpression).toBe('attribute_not_exists(pk)');
  });

  /**
   * Tenancy is in the key and nowhere else — there is no ownership attribute on the row to
   * check, and so no way to check the wrong one.
   */
  it('scopes the write to the user it was given', async () => {
    await putDevice('usr_b', device());

    expect(sentPut()?.Item?.pk).toBe('USER#usr_b');
  });
});

describe('deleteDevice', () => {
  it('deletes USER#<id> / DEVICE#<deviceId>', async () => {
    await deleteDevice('usr_a', 'dev_01J8XKQ2M4N5P6R7S8T9V0W1X2');

    expect(sentDelete()?.Key).toEqual({
      pk: 'USER#usr_a',
      sk: 'DEVICE#dev_01J8XKQ2M4N5P6R7S8T9V0W1X2',
    });
  });

  /**
   * Conditional, so a delete that matched nothing is distinguishable from one that removed a
   * row — which is what lets the service answer `404` without paying for a read first.
   */
  it('is conditional on the row existing', async () => {
    await deleteDevice('usr_a', 'dev_01J8XKQ2M4N5P6R7S8T9V0W1X2');

    expect(sentDelete()?.ConditionExpression).toBe('attribute_exists(pk)');
  });

  it("cannot address another user's partition", async () => {
    await deleteDevice('usr_b', 'dev_01J8XKQ2M4N5P6R7S8T9V0W1X2');

    expect(sentDelete()?.Key?.pk).toBe('USER#usr_b');
  });
});
