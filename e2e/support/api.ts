import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';

export const API = `http://127.0.0.1:${process.env.E2E_API_PORT ?? '3000'}`;
export const ZONE = 'America/New_York';

export interface E2EActivity {
  activityId: string;
  title: string;
}

export function e2eHeaders(idempotencyKey?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Request-Id': `req_e2e_${randomUUID().replaceAll('-', '')}`,
    'X-Client-Timezone': ZONE,
    'X-Client-Version': 'web/e2e',
    ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
  };
}

export function wallDate(instant = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export async function createTask(
  request: APIRequestContext,
  input: { title: string; date: string; time?: string },
): Promise<E2EActivity> {
  const response = await request.post(`${API}/v1/activities`, {
    headers: e2eHeaders(randomUUID()),
    data: {
      objectKind: 'task',
      type: 'task',
      title: input.title,
      details: { kind: 'task' },
      schedule: {
        date: input.date,
        ...(input.time === undefined ? {} : { time: input.time }),
        timezone: ZONE,
      },
    },
  });
  if (!response.ok()) {
    throw new Error(
      `Could not create E2E task: ${response.status()} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { data: { activityId: string } };
  return { activityId: body.data.activityId, title: input.title };
}

export async function createDailyTask(
  request: APIRequestContext,
  input: { title: string; date: string; time?: string },
): Promise<E2EActivity> {
  const response = await request.post(`${API}/v1/activities`, {
    headers: e2eHeaders(randomUUID()),
    data: {
      objectKind: 'task',
      type: 'task',
      title: input.title,
      details: { kind: 'task' },
      schedule: {
        date: input.date,
        ...(input.time === undefined ? {} : { time: input.time }),
        timezone: ZONE,
      },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: input.date }],
      },
    },
  });
  if (!response.ok()) {
    throw new Error(
      `Could not create recurring E2E task: ${response.status()} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { data: { activityId: string } };
  return { activityId: body.data.activityId, title: input.title };
}

export async function deleteActivities(
  request: APIRequestContext,
  activityIds: readonly string[],
): Promise<void> {
  for (const activityId of activityIds) {
    const response = await request.delete(`${API}/v1/activities/${activityId}`, {
      headers: e2eHeaders(),
    });
    if (!response.ok() && response.status() !== 404) {
      throw new Error(
        `Could not delete E2E activity ${activityId}: ${response.status()}`,
      );
    }
  }
}
