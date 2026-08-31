import NetInfo from '@react-native-community/netinfo';
import { onlineManager, type QueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { apiBaseUrl } from '@/lib/apiClient';

type NetInfoConfiguration = NonNullable<Parameters<typeof NetInfo.configure>[0]>;

/**
 * Local native builds use the API health endpoint as their reachability probe. The phone can
 * have internet while the laptop-hosted API is unavailable; native internet reachability alone
 * would then leave queued writes presented as active syncing forever. Dev and production builds
 * retain the operating system's native reachability source.
 */
export function localReachabilityConfiguration(
  profile: unknown,
  baseUrl: string,
): NetInfoConfiguration | undefined {
  if (profile !== 'local') return undefined;
  return {
    reachabilityUrl: `${baseUrl}/v1/health`,
    reachabilityMethod: 'GET',
    reachabilityTest: async (response) => response.ok,
    /**
     * **Timings widened 2026-08-18, after the founder saw the offline status on a healthy LAN.**
     *
     * These were one second across the board. `reachabilityLongTimeout` is the gap between
     * probes *while connected*, so the app was asking a laptop across WiFi for `/v1/health`
     * every second and calling the connection dead if it took longer than two — which it
     * regularly does over Expo Go on a real network. Every one of those false negatives put
     * `onlineManager` offline, which surfaced §5.4's status and, until it was coalesced, kicked
     * off a reminder refresh.
     *
     * The proxy flow P2-37 needs this for is unaffected: when the proxy blocks the port the
     * request fails outright rather than slowly, so a five-second budget detects it just as
     * reliably as a two-second one. `reachabilityShortTimeout` stays tight so *recovery* is
     * still noticed promptly, which is the half that flow actually asserts.
     */
    reachabilityShortTimeout: 2_000,
    reachabilityLongTimeout: 30_000,
    reachabilityRequestTimeout: 5_000,
    useNativeReachability: false,
  };
}

function pendingMutationCount(client: QueryClient): number {
  return client
    .getMutationCache()
    .getAll()
    .filter((mutation) => mutation.state.status === 'pending').length;
}

export function shouldWarnBeforeUnload(client: QueryClient): boolean {
  return pendingMutationCount(client) > 0;
}

/**
 * Uses the platform connectivity source. Native connectivity wakes the SQLite sync engine;
 * TanStack's client keeps its ordinary in-memory behavior on web and for non-domain native
 * queries.
 */
export function installOnlineManager(client: QueryClient): () => void {
  onlineManager.setEventListener((setOnline) => {
    if (Platform.OS === 'web') {
      const onOnline = () => setOnline(true);
      const onOffline = () => setOnline(false);
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
      setOnline(navigator.onLine);
      return () => {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
      };
    }

    const reachability = localReachabilityConfiguration(
      Constants.expoConfig?.extra?.profile,
      apiBaseUrl,
    );
    if (reachability !== undefined) {
      NetInfo.configure(reachability);
    }

    return NetInfo.addEventListener((state) => {
      const online = state.isConnected === true && state.isInternetReachable !== false;
      if (__DEV__) {
        console.info('native_connectivity_changed', {
          type: state.type,
          isConnected: state.isConnected,
          isInternetReachable: state.isInternetReachable,
          online,
        });
      }
      setOnline(online);
    });
  });

  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!shouldWarnBeforeUnload(client)) return;
    event.preventDefault();
    event.returnValue = '';
  };
  if (Platform.OS === 'web') window.addEventListener('beforeunload', beforeUnload);

  return () => {
    if (Platform.OS === 'web') window.removeEventListener('beforeunload', beforeUnload);
  };
}
