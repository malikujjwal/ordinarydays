import { describe, expect, it } from 'vitest';
import { localReachabilityConfiguration } from '@/lib/onlineManager';

describe('local iOS reachability configuration', () => {
  it('probes the local API frequently enough for the simulator network proxy', async () => {
    const configuration = localReachabilityConfiguration(
      'local',
      'http://localhost:3000',
    );

    expect(configuration).toMatchObject({
      reachabilityUrl: 'http://localhost:3000/v1/health',
      reachabilityMethod: 'GET',
      // Wide enough that ordinary LAN latency is not mistaken for a dead connection.
      reachabilityShortTimeout: 2_000,
      reachabilityLongTimeout: 30_000,
      reachabilityRequestTimeout: 5_000,
      useNativeReachability: false,
    });
    await expect(
      configuration?.reachabilityTest?.(new Response(null, { status: 200 })),
    ).resolves.toBe(true);
    await expect(
      configuration?.reachabilityTest?.(new Response(null, { status: 503 })),
    ).resolves.toBe(false);
  });

  it.each(['dev', 'prod', undefined])(
    'leaves %s builds on native reachability',
    (profile) => {
      expect(
        localReachabilityConfiguration(profile, 'https://api.example.test'),
      ).toBeUndefined();
    },
  );
});
