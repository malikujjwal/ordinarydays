import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../lib/errors.js';
import { registerDevice, unregisterDevice } from './deviceService.js';

/**
 * The service's own rules, with the repository mocked (`definition-of-done.md` §3).
 *
 * There are three: the server mints the id, the server sets both timestamps, and a delete
 * that matched nothing is `404`. Everything else this endpoint pair does is the schema's or
 * the key's.
 */
vi.mock('../repositories/deviceRepository.js', () => ({
  newDeviceId: vi.fn(() => 'dev_01J8XKQ2M4N5P6R7S8T9V0W1X2'),
  putDevice: vi.fn(() => Promise.resolve()),
  deleteDevice: vi.fn(() => Promise.resolve()),
}));

const repository = await import('../repositories/deviceRepository.js');

const TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';
const NOW = '2026-08-09T12:00:00.000Z';
const USER = 'usr_local_dev';

beforeEach(() => {
  vi.mocked(repository.putDevice).mockClear();
  vi.mocked(repository.deleteDevice).mockClear();
  vi.mocked(repository.deleteDevice).mockResolvedValue(undefined);
});

describe('registerDevice', () => {
  it('mints the id and returns it, because the request did not carry one', async () => {
    const device = await registerDevice(
      USER,
      { expoPushToken: TOKEN, platform: 'ios' },
      NOW,
    );

    expect(device.deviceId).toBe('dev_01J8XKQ2M4N5P6R7S8T9V0W1X2');
    expect(vi.mocked(repository.putDevice).mock.calls[0]?.[1].deviceId).toBe(
      device.deviceId,
    );
  });

  /**
   * A device row is created and deleted, never edited, so the two timestamps are equal for
   * its whole life. `updatedAt` exists because every item carries it, not because anything
   * bumps it.
   */
  it('sets both timestamps from the passed clock', async () => {
    const device = await registerDevice(
      USER,
      { expoPushToken: TOKEN, platform: 'ios' },
      NOW,
    );

    expect(device.createdAt).toBe(NOW);
    expect(device.updatedAt).toBe(NOW);
  });

  it('writes to the partition it was given', async () => {
    await registerDevice('usr_other', { expoPushToken: TOKEN, platform: 'ios' }, NOW);

    expect(vi.mocked(repository.putDevice).mock.calls[0]?.[0]).toBe('usr_other');
  });

  it('carries the deviceName through when there is one', async () => {
    const device = await registerDevice(
      USER,
      { expoPushToken: TOKEN, platform: 'ios', deviceName: "Ada's iPhone" },
      NOW,
    );

    expect(device.deviceName).toBe("Ada's iPhone");
  });

  it('omits deviceName rather than setting it undefined when there is none', async () => {
    const device = await registerDevice(
      USER,
      { expoPushToken: TOKEN, platform: 'ios' },
      NOW,
    );

    expect(device).not.toHaveProperty('deviceName');
  });
});

describe('unregisterDevice', () => {
  it('deletes the device from the caller’s partition', async () => {
    await unregisterDevice(USER, 'dev_01J8XKQ2M4N5P6R7S8T9V0W1X2');

    expect(vi.mocked(repository.deleteDevice).mock.calls[0]).toEqual([
      USER,
      'dev_01J8XKQ2M4N5P6R7S8T9V0W1X2',
    ]);
  });

  /**
   * The conditional delete failing means there is no such row in **this** partition — a
   * stranger's id, or a row already gone. Both are `404`; neither is a `409`, which would
   * tell the client to resolve a concurrent edit against something that does not exist.
   */
  it('turns a failed condition into 404, not the 409 the default mapping would give', async () => {
    const failure = new Error('The conditional request failed');
    failure.name = 'ConditionalCheckFailedException';
    vi.mocked(repository.deleteDevice).mockRejectedValue(failure);

    await expect(unregisterDevice(USER, 'dev_gone')).rejects.toMatchObject({
      code: 'not_found',
      message: 'Device not found.',
    });
  });

  it('logs the miss under a stable event code a query can filter on', async () => {
    const failure = new Error('The conditional request failed');
    failure.name = 'ConditionalCheckFailedException';
    vi.mocked(repository.deleteDevice).mockRejectedValue(failure);
    const warn = vi.fn();

    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: a logger stub with one method.
      unregisterDevice(USER, 'dev_gone', { warn } as any),
    ).rejects.toBeInstanceOf(AppError);

    expect(warn.mock.calls[0]?.[0]).toMatchObject({ event: 'device_delete_miss' });
  });

  /** Anything else is a real failure and must not be flattened into a `404`. */
  it('rethrows a failure that is not a missing row', async () => {
    const throttled = new Error('Throughput exceeded');
    throttled.name = 'ProvisionedThroughputExceededException';
    vi.mocked(repository.deleteDevice).mockRejectedValue(throttled);

    await expect(unregisterDevice(USER, 'dev_x')).rejects.toBe(throttled);
  });
});
