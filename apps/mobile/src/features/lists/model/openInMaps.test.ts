import { Linking, Platform } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openInMaps } from './openInMaps';

const originalOS = Platform.OS;

afterEach(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS });
  vi.restoreAllMocks();
});

describe('openInMaps', () => {
  it.each([
    ['ios', 'maps:0,0?q=10%20Main%20St'],
    ['android', 'geo:0,0?q=10%20Main%20St'],
    ['web', 'https://www.google.com/maps/search/?api=1&query=10%20Main%20St'],
  ] as const)(
    'uses the %s destination and prefers the visible address',
    async (os, expected) => {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
      const opened = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined);

      await openInMaps({ label: 'Library', address: '10 Main St' });

      expect(opened).toHaveBeenCalledWith(expected);
    },
  );

  it('does nothing without a stored Place and absorbs a device open failure', async () => {
    const opened = vi
      .spyOn(Linking, 'openURL')
      .mockRejectedValue(new Error('no maps app'));

    await expect(openInMaps(undefined)).resolves.toBeUndefined();
    await expect(openInMaps({ label: 'Morris Arboretum' })).resolves.toBeUndefined();

    expect(opened).toHaveBeenCalledOnce();
  });
});
