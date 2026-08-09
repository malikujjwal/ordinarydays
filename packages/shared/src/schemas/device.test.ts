import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import { MAX_FREE_TEXT_LEN } from '../constants.js';
import type { Device, RegisterDeviceInput } from '../types/device.js';
import { device, registerDeviceInput } from './device.js';

/**
 * The schema and the interface describe one stored shape. Nothing forces them to agree, so
 * this does — in both directions, because a one-way assertion passes happily when one side
 * gains a field the other lacks. Same shape as `user.test.ts`.
 */
describe('the schema and the interface are the same shape', () => {
  it('Device is assignable both ways', () => {
    expectTypeOf<z.infer<typeof device>>().toEqualTypeOf<Device>();
  });

  it('RegisterDeviceInput is assignable both ways', () => {
    expectTypeOf<
      z.infer<typeof registerDeviceInput>
    >().toEqualTypeOf<RegisterDeviceInput>();
  });
});

const TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

const valid: Device = {
  deviceId: 'dev_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  expoPushToken: TOKEN,
  platform: 'ios',
  createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
  schemaVersion: 1,
};

describe('the stored device', () => {
  it('accepts the minimal shape, with no deviceName', () => {
    expect(device.safeParse(valid).success).toBe(true);
  });

  it('accepts a deviceName', () => {
    expect(device.safeParse({ ...valid, deviceName: "Ada's iPhone" }).success).toBe(true);
  });

  it('rejects a deviceId that is not a dev_ ULID', () => {
    expect(device.safeParse({ ...valid, deviceId: 'usr_local_dev' }).success).toBe(false);
  });

  it('rejects a wrong schemaVersion', () => {
    expect(device.safeParse({ ...valid, schemaVersion: 2 }).success).toBe(false);
  });
});

/**
 * The token shape P5-16 names. Both spellings are deliverable and `expo-server-sdk` accepts
 * either, so both are accepted here; what is pinned is the bracketed form, which is what
 * separates an Expo token from a raw APNs one.
 */
describe('the Expo push token', () => {
  it.each([
    ['the documented spelling', TOKEN],
    ['the shorter spelling Expo also issues', 'ExpoPushToken[xxxxxxxxxxxxxxxxxxxxxx]'],
    ['a token with the separators Expo uses', 'ExponentPushToken[A-b_9]'],
  ])('accepts %s', (_why, token) => {
    expect(
      registerDeviceInput.safeParse({ expoPushToken: token, platform: 'ios' }).success,
    ).toBe(true);
  });

  it.each([
    ['a raw APNs token, which this API never sees', 'a'.repeat(64)],
    ['the brackets missing', 'ExponentPushToken'],
    ['nothing between the brackets', 'ExponentPushToken[]'],
    ['a different vendor', 'FirebaseToken[xxxxxxxxxxxxxxxxxxxxxx]'],
    ['an empty string', ''],
    // Unbounded input becomes an unbounded stored attribute; the bound is the cheapest
    // place to stop that.
    ['a token past the length bound', `ExponentPushToken[${'x'.repeat(190)}]`],
  ])('rejects %s', (_why, token) => {
    expect(
      registerDeviceInput.safeParse({ expoPushToken: token, platform: 'ios' }).success,
    ).toBe(false);
  });
});

describe('the registration body', () => {
  it('accepts the three fields the contract names', () => {
    expect(
      registerDeviceInput.safeParse({
        expoPushToken: TOKEN,
        platform: 'ios',
        deviceName: "Ada's iPhone",
      }).success,
    ).toBe(true);
  });

  it('accepts an omitted deviceName — a simulator reports none', () => {
    expect(
      registerDeviceInput.safeParse({ expoPushToken: TOKEN, platform: 'ios' }).success,
    ).toBe(true);
  });

  /**
   * A client that sent one would be asking for an upsert, and rotation is delete-then-create
   * by decision (P5-16 rule 2). Being told beats having it ignored and then wondering why
   * the id came back different.
   */
  it.each(['deviceId', 'createdAt', 'updatedAt', 'schemaVersion', 'userId'])(
    'rejects %s, which the server derives',
    (field) => {
      const result = registerDeviceInput.safeParse({
        expoPushToken: TOKEN,
        platform: 'ios',
        [field]: 'anything',
      });

      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain(field);
    },
  );

  it.each([
    ['web, which has no push at all', 'web'],
    ['android, which has no build in v1', 'android'],
    ['an empty platform', ''],
  ])('rejects %s', (_why, platform) => {
    expect(
      registerDeviceInput.safeParse({ expoPushToken: TOKEN, platform }).success,
    ).toBe(false);
  });

  it('rejects a deviceName past the free-text bound', () => {
    expect(
      registerDeviceInput.safeParse({
        expoPushToken: TOKEN,
        platform: 'ios',
        deviceName: 'x'.repeat(MAX_FREE_TEXT_LEN + 1),
      }).success,
    ).toBe(false);
  });
});
