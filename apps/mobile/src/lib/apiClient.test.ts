import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `apiClient.ts` reads Expo's config at **module scope** — `extra`, `profile` and
 * `apiBaseUrl` are all resolved on import — so each case re-mocks `expo-constants` and
 * re-imports the module rather than mutating a shared object. That is the cost of resolving
 * configuration once per app run, and it is the right trade for the app; the test just has
 * to respect it.
 */
async function load(expoConfig: Record<string, unknown> | undefined) {
  vi.resetModules();
  vi.doMock('expo-constants', () => ({ default: { expoConfig } }));
  return import('@/lib/apiClient');
}

/**
 * Longer than the 5-second default, because every case here re-imports a module graph.
 *
 * `vi.resetModules()` discards the transformed graph, so the next `import()` re-resolves
 * `@/lib/apiClient` and everything under `@od/shared/client` from source. That is a few
 * hundred milliseconds on an idle machine and several seconds in a loaded worker pool — the
 * first case pays the cold cost, and it started timing out when this workspace's suite grew
 * past 300 tests (P1-25). Nothing under test got slower; the budget was never realistic for
 * what this file does between assertions.
 */
vi.setConfig({ testTimeout: 30_000 });

const localConfig = (hostUri?: string) => ({
  version: '0.0.0',
  extra: { profile: 'local' },
  ...(hostUri === undefined ? {} : { hostUri }),
});

beforeEach(() => {
  vi.resetModules();
});

describe('resolveApiBaseUrl', () => {
  it('falls back to localhost when Metro advertises no host', async () => {
    const { resolveApiBaseUrl } = await load(localConfig());
    expect(resolveApiBaseUrl()).toBe('http://localhost:3000');
  });

  it('uses the LAN address Metro advertised, so a physical device can reach the API', async () => {
    const { resolveApiBaseUrl } = await load(localConfig('192.168.1.5:8081'));
    expect(resolveApiBaseUrl()).toBe('http://192.168.1.5:3000');
  });

  /**
   * The P0-22 regression, pinned. Metro does not always advertise a LAN address — on a
   * Windows machine with Hyper-V and WSL adapters it fell back to `127.0.0.1:8081`. An
   * earlier version compared against the literal string `'localhost'`, accepted `127.0.0.1`,
   * and built a base URL pointing the phone at itself: the exact failure the function exists
   * to prevent, wearing a different spelling.
   */
  it.each([
    ['localhost', 'localhost:8081'],
    ['IPv4 loopback', '127.0.0.1:8081'],
    ['IPv6 loopback, bracketed as Metro sends it', '[::1]:8081'],
    ['the unspecified address', '0.0.0.0:8081'],
  ])('rejects %s rather than pointing the device at itself', async (_why, hostUri) => {
    const { resolveApiBaseUrl } = await load(localConfig(hostUri));
    expect(resolveApiBaseUrl()).toBe('http://localhost:3000');
  });

  it('never rewrites a non-local profile, so production traffic cannot be redirected', async () => {
    const { resolveApiBaseUrl } = await load({
      version: '1.0.0',
      extra: { profile: 'prod', apiBaseUrl: 'https://api.ordinarydays.app' },
      hostUri: '192.168.1.5:8081',
    });
    expect(resolveApiBaseUrl()).toBe('https://api.ordinarydays.app');
  });

  it('honours a configured apiBaseUrl on the local profile when Metro offers nothing', async () => {
    const { resolveApiBaseUrl } = await load({
      version: '0.0.0',
      extra: { profile: 'local', apiBaseUrl: 'http://10.0.0.7:3000' },
    });
    expect(resolveApiBaseUrl()).toBe('http://10.0.0.7:3000');
  });

  it('survives a missing expoConfig entirely rather than throwing on import', async () => {
    const { resolveApiBaseUrl } = await load(undefined);
    expect(resolveApiBaseUrl()).toBe('http://localhost:3000');
  });
});

describe('httpClientConfig', () => {
  it('uses the local identity without inventing a bearer token', async () => {
    const { httpClientConfig } = await load(localConfig());
    await expect(httpClientConfig.tokenProvider.getToken()).resolves.toBeUndefined();
    await expect(httpClientConfig.tokenProvider.getIdentity()).resolves.toBe(
      'usr_local_dev',
    );
  });

  it('reports the platform and version in X-Client-Version', async () => {
    const { httpClientConfig } = await load(localConfig());
    // `react-native` is aliased to `react-native-web` under test, so `Platform.OS` is 'web'
    // — which is the truth about where this test is running.
    expect(httpClientConfig.clientVersion).toBe('web/0.0.0');
  });

  it('resolves a real IANA timezone rather than a hard-coded one', async () => {
    const { httpClientConfig } = await load(localConfig());
    expect(httpClientConfig.timezone).toMatch(/^[A-Za-z]+(?:\/[A-Za-z_+-]+)*$/);
  });

  /**
   * `fetch` is wrapped rather than passed by reference. `fetch: globalThis.fetch` detaches
   * the function from its receiver and the browser rejects that with `Illegal invocation` —
   * found in P0-22 by running the app, because every client unit test injects a stub.
   */
  it('wraps fetch so it keeps its receiver', async () => {
    const { httpClientConfig } = await load(localConfig());
    expect(httpClientConfig.fetch).not.toBe(globalThis.fetch);
  });
});
