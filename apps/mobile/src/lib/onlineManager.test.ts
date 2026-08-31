import { onlineManager, QueryClient } from '@tanstack/react-query';
import { Platform } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installOnlineManager,
  localReachabilityConfiguration,
} from '@/lib/onlineManager';
import {
  configuredNetInfo,
  emitNetInfoState,
  resetConfiguredNetInfo,
} from '../../test/netinfo-stub';

const originalPlatform = Platform.OS;

afterEach(() => {
  Object.defineProperty(Platform, 'OS', { value: originalPlatform });
  resetConfiguredNetInfo();
  onlineManager.setOnline(true);
});

describe('local native reachability configuration', () => {
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

  it.each(['ios', 'android'] as const)(
    'uses API reachability on a local %s device',
    (platform) => {
      Object.defineProperty(Platform, 'OS', { value: platform });

      const uninstall = installOnlineManager(new QueryClient());

      expect(configuredNetInfo()).toMatchObject({
        reachabilityUrl: 'http://localhost:3000/v1/health',
        useNativeReachability: false,
      });
      emitNetInfoState({ isConnected: true, isInternetReachable: false });
      expect(onlineManager.isOnline()).toBe(false);
      emitNetInfoState({ isConnected: true, isInternetReachable: true });
      expect(onlineManager.isOnline()).toBe(true);
      uninstall();
    },
  );

  it('stops the native subscription when the shell service uninstalls', () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios' });
    const uninstall = installOnlineManager(new QueryClient());
    uninstall();
    onlineManager.setOnline(false);

    emitNetInfoState({
      type: 'wifi',
      isConnected: true,
      isInternetReachable: true,
    });

    expect(onlineManager.isOnline()).toBe(false);
  });

  it('does not report interface churn when semantic connectivity stays online', () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios' });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const uninstall = installOnlineManager(new QueryClient());

    emitNetInfoState({
      type: 'wifi',
      isConnected: true,
      isInternetReachable: true,
    });
    emitNetInfoState({
      type: 'cellular',
      isConnected: true,
      isInternetReachable: true,
    });

    expect(info).toHaveBeenCalledTimes(1);
    uninstall();
    info.mockRestore();
  });
});
