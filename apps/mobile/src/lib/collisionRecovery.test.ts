import { ApiError, type HttpClient } from '@od/shared/client';
import { describe, expect, it, vi } from 'vitest';
import { recoverFromCollision } from '@/lib/collisionRecovery';

const ACTIVITY_ID = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';

function clientReturning(
  behaviour: () => Promise<unknown>,
): HttpClient & { request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(behaviour);
  return { request } as unknown as HttpClient & { request: ReturnType<typeof vi.fn> };
}

describe('collision recovery', () => {
  it('acknowledges on a 200, because a readable id is the caller’s own', async () => {
    const client = clientReturning(async () => ({
      data: { activity: { activityId: ACTIVITY_ID, title: 'What the server has' } },
    }));

    const outcome = await recoverFromCollision(client, ACTIVITY_ID);

    expect(outcome.kind).toBe('acknowledged');
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: `/v1/activities/${ACTIVITY_ID}`,
      }),
    );
  });

  it('acknowledges without comparing a single field', async () => {
    /**
     * The server's copy differs from what this device would have sent — a later edit from
     * another device. It still acknowledges: the server entity wins wholesale. Comparing
     * fields is how a reconciliation pipeline grows back, and client-minted ids exist to
     * delete that pipeline (founder decision 3).
     */
    const client = clientReturning(async () => ({
      data: { activity: { activityId: ACTIVITY_ID, title: 'Edited elsewhere' } },
    }));

    const outcome = await recoverFromCollision(client, ACTIVITY_ID);

    expect(outcome.kind).toBe('acknowledged');
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it('surfaces a 404 for confirmation and never re-mints', async () => {
    const client = clientReturning(async () => {
      throw new ApiError('not_found', 'Not found', 404, 'req_1');
    });

    const outcome = await recoverFromCollision(client, ACTIVITY_ID);

    /**
     * A foreign collision and a tombstoned create-then-delete are indistinguishable here, by
     * design, and both need the same thing: the user decides. An automatic re-mint would
     * walk straight past the tombstone and resurrect a deleted activity.
     */
    expect(outcome).toEqual({ kind: 'needs_confirmation' });
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it('propagates a transport failure, so the intent stays queued', async () => {
    const client = clientReturning(async () => {
      throw new ApiError('internal', 'Unavailable', 503, 'req_2');
    });

    // Not an answer about the id — nothing may be concluded, and the queue keeps the write.
    await expect(recoverFromCollision(client, ACTIVITY_ID)).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
