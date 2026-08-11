import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Reminder } from '@od/shared/types';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.STAGE = 'local';
process.env.AUTH_MODE = 'local';
process.env.TABLE_NAME = 'od-main-local';
process.env.MEDIA_BUCKET = 'od-media-local';
process.env.WEB_ORIGINS = 'http://localhost:8081';
process.env.LOG_LEVEL = 'fatal';

const mocks = vi.hoisted(() => ({
  listReminders: vi.fn(),
  createReminder: vi.fn(),
  removeReminder: vi.fn(),
}));

vi.mock('../services/reminderService.js', () => mocks);

import type { createApp as CreateApp } from '../app.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
let createApp: typeof CreateApp;

const USER = 'usr_local_dev';
const ACTIVITY_ID = 'act_01J8XKQ2M4N5P6R7S8T9V0W1AA';
const REMINDER_ID = 'rem_01J8XKQ2M4N5P6R7S8T9V0W1AA';
const row: Reminder = {
  reminderId: REMINDER_ID,
  activityId: ACTIVITY_ID,
  userId: USER,
  offsetMinutes: -15,
  channel: 'push',
};

const path = `http://localhost/v1/activities/${ACTIVITY_ID}/reminders`;
const key = () => crypto.randomUUID();

beforeEach(async () => {
  ddbMock.reset();
  ddbMock.on(UpdateCommand).resolves({});
  ddbMock.on(GetCommand).resolves({});
  vi.clearAllMocks();
  mocks.listReminders.mockResolvedValue([row]);
  mocks.createReminder.mockImplementation(
    async (
      _userId: string,
      _activityId: string,
      _input: unknown,
      _now: string,
      receiptFor: (result: Reminder) => unknown,
    ) => {
      receiptFor(row);
      return row;
    },
  );
  mocks.removeReminder.mockResolvedValue(REMINDER_ID);
  vi.resetModules();
  createApp = (await import('../app.js')).createApp;
});

it('GET returns the service-projected caller-owned array', async () => {
  const res = await createApp().fetch(new Request(path));
  const body = await res.json();

  expect(res.status).toBe(200);
  expect(body.data).toEqual([row]);
  expect(mocks.listReminders).toHaveBeenCalledWith(USER, ACTIVITY_ID);
});

describe('POST', () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    createApp().fetch(
      new Request(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key(),
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    );

  it('returns the server-id row in a 201 envelope', async () => {
    const res = await post({ offsetMinutes: -15 });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data).toEqual(row);
    expect(mocks.createReminder).toHaveBeenCalledWith(
      USER,
      ACTIVITY_ID,
      { offsetMinutes: -15 },
      expect.any(String),
      expect.any(Function),
    );
  });

  it('rejects a positive offset before the service runs', async () => {
    const res = await post({ offsetMinutes: 30 });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
    expect(mocks.createReminder).not.toHaveBeenCalled();
  });

  it('requires an Idempotency-Key', async () => {
    const res = await createApp().fetch(
      new Request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offsetMinutes: -15 }),
      }),
    );
    expect(res.status).toBe(400);
    expect(mocks.createReminder).not.toHaveBeenCalled();
  });
});

describe('DELETE', () => {
  it('passes no user identity except the resolved caller', async () => {
    const res = await createApp().fetch(
      new Request(`${path}/${REMINDER_ID}`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ reminderId: REMINDER_ID });
    expect(mocks.removeReminder).toHaveBeenCalledWith(USER, ACTIVITY_ID, REMINDER_ID);
  });

  it('preserves the not_found answer for somebody else’s opaque id', async () => {
    const { AppError } = await import('../lib/errors.js');
    mocks.removeReminder.mockRejectedValue(
      new AppError('not_found', 'Reminder not found.'),
    );
    const res = await createApp().fetch(
      new Request(`${path}/${REMINDER_ID}`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });
});
