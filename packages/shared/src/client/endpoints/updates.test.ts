import { describe, expect, it } from 'vitest';
import type { FetchLike, HttpClientConfig } from '../http.js';
import { createHttpClient, nullTokenProvider } from '../http.js';
import {
  deleteActivityUpdate,
  getActivityUpdates,
  postActivityUpdate,
} from './updates.js';

/** The plan's activity feed (P3-24, `api-contract.md` §2.5). */

const REQUEST_ID = 'req_test';
const ACTIVITY_ID = 'act_01J0000000000000000000000A';
const UPDATE_ID = 'upd_01J0000000000000000000000B';

interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string | undefined;
}

function makeClient(
  outcomes: Array<{ status: number; body?: unknown }>,
  overrides: Partial<HttpClientConfig> = {},
) {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers ?? {},
      body: init?.body,
    });
    const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
    if (outcome === undefined) throw new Error('no outcome');
    return Promise.resolve({
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      headers: { get: () => null },
      json: () => Promise.resolve(outcome.body),
      text: () =>
        Promise.resolve(outcome.body === undefined ? '' : JSON.stringify(outcome.body)),
    });
  };

  const client = createHttpClient({
    baseUrl: 'https://api.test',
    fetch,
    tokenProvider: nullTokenProvider,
    timezone: 'Europe/London',
    clientVersion: 'ios/0.1.0',
    strictResponses: true,
    sleep: () => Promise.resolve(),
    newRequestId: () => REQUEST_ID,
    onWarning: () => {},
    ...overrides,
  });
  return { client, calls };
}

const UPDATE = {
  updateId: UPDATE_ID,
  activityId: ACTIVITY_ID,
  kind: 'user' as const,
  body: 'Bringing the cake',
  authorUserId: 'usr_01J0000000000000000000000C',
  authorDisplayName: 'Alice',
  createdAt: '2026-08-26T10:00:00.000Z',
  schemaVersion: 1 as const,
};

const ok = (data: unknown) => ({
  status: 200,
  body: { data, meta: { requestId: REQUEST_ID } },
});

describe('getActivityUpdates', () => {
  it('pages with the feed’s own cursor, which lives inside data', async () => {
    const { client, calls } = makeClient([ok({ updates: [UPDATE], cursor: 'next-1' })]);

    const page = await getActivityUpdates(client, ACTIVITY_ID);

    expect(calls[0]?.url).toBe(`https://api.test/v1/activities/${ACTIVITY_ID}/updates`);
    // Not `meta.nextCursor`: this is the shape Activity detail embeds for its first page.
    expect(page.cursor).toBe('next-1');
    expect(page.updates).toHaveLength(1);
  });

  it('sends a continuation cursor when it has one', async () => {
    const { client, calls } = makeClient([ok({ updates: [] })]);

    await getActivityUpdates(client, ACTIVITY_ID, 'cur/1');

    expect(calls[0]?.url).toBe(
      `https://api.test/v1/activities/${ACTIVITY_ID}/updates?cursor=cur%2F1`,
    );
  });
});

describe('postActivityUpdate', () => {
  /**
   * The whole result is returned, not just the entry. `#P` sorts on `lastActivityAt` and GSI1
   * is eventually consistent, so a client that posted and then refetched could read a
   * projection older than its own write and put the row back where it was. A signature that
   * returned the `ActivityUpdate` alone would make losing the timestamp the default.
   */
  it('returns the entry and the authoritative lastActivityAt together', async () => {
    const lastActivityAt = '2026-08-26T10:05:00.000Z';
    const { client, calls } = makeClient([ok({ update: UPDATE, lastActivityAt })]);

    const result = await postActivityUpdate(
      client,
      ACTIVITY_ID,
      'Bringing the cake',
      'key-1',
    );

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['Idempotency-Key']).toBe('key-1');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ body: 'Bringing the cake' });
    expect(result.lastActivityAt).toBe(lastActivityAt);
    expect(result.update.updateId).toBe(UPDATE_ID);
  });
});

describe('deleteActivityUpdate', () => {
  /**
   * The one endpoint in the client with no envelope to parse. P3-19 ships a bare `204`, which
   * diverges from the body-not-204 convention `deletedDevice`, `deletedAttachment` and
   * `deletedList` all follow. The code is the contract; the divergence is raised in the PR.
   */
  it('accepts the bare 204 the route actually returns', async () => {
    const { client, calls } = makeClient([{ status: 204 }]);

    await expect(
      deleteActivityUpdate(client, ACTIVITY_ID, UPDATE_ID),
    ).resolves.toBeUndefined();

    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url).toBe(
      `https://api.test/v1/activities/${ACTIVITY_ID}/updates/${UPDATE_ID}`,
    );
  });

  it('surfaces the 404 that a system entry and another author both answer with', async () => {
    // Deliberately indistinguishable from a missing row, so this function cannot tell them
    // apart and does not pretend to.
    const { client } = makeClient([
      {
        status: 404,
        body: { error: { code: 'not_found', message: 'Gone.', requestId: REQUEST_ID } },
      },
    ]);

    await expect(
      deleteActivityUpdate(client, ACTIVITY_ID, UPDATE_ID),
    ).rejects.toMatchObject({ name: 'ApiError', status: 404 });
  });
});
