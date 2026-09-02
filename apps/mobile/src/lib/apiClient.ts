import type { HttpClientConfig } from '@od/shared/client';
import { createHttpClient, localTokenProvider } from '@od/shared/client';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

/**
 * Where the app's configuration is read, and the only place in the client that does so.
 *
 * `packages/shared` reads no environment and no Expo config — configuration arrives there
 * as arguments (`tech-stack.md` §5.2, and the note at the top of `shared/src/client/http.ts`).
 * This module is the one boundary that turns Expo's `extra` into that argument, so there is
 * exactly one file to look at when the app is talking to the wrong API.
 *
 * P0-20 built the client on top of it. `httpClientConfig` was not changed to accommodate
 * it — the seam held, which is the point of having written it first.
 */

/** The port `services/api` listens on locally. Set in P0-21's local server. */
const LOCAL_API_PORT = 3000;

const extra: Record<string, unknown> = Constants.expoConfig?.extra ?? {};

const profile = typeof extra.profile === 'string' ? extra.profile : 'local';

/**
 * The LAN address Metro is already serving from, as `192.168.1.5` — or `undefined` when
 * Metro is not in the picture, which is every production build.
 *
 * This exists because of one specific failure: on a **physical device**, `localhost` is the
 * phone, so `http://localhost:3000` resolves to nothing and the app shows a network error
 * that looks like the API being down. The laptop's LAN address is the fix, and hard-coding
 * it means re-editing a committed file every time the laptop joins a different network.
 * `hostUri` is the address the device already reached Metro on, so if the bundle loaded,
 * this host is reachable.
 *
 * **Every loopback form is rejected, not just the word `localhost`.** Metro does not always
 * advertise a LAN address: on a Windows machine with Hyper-V and WSL adapters it fell back
 * to `127.0.0.1:8081` while preparing the P0-22 device check. The original version of this
 * function compared against the literal string `'localhost'`, so it accepted `127.0.0.1`,
 * built `http://127.0.0.1:3000`, and produced a base URL that points the phone at itself —
 * which is the exact failure this function exists to prevent, wearing a different spelling.
 * Falling back to the configured URL is no better on a device, but it is at least the
 * failure the screen already explains.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

export function metroLanHost(): string | undefined {
  const hostUri = Constants.expoConfig?.hostUri;
  if (typeof hostUri !== 'string' || hostUri === '') return undefined;

  // IPv6 hosts arrive bracketed (`[::1]:8081`); strip the brackets before comparing.
  const host = hostUri.split(':')[0]?.replace(/^\[|\]$/g, '');
  if (host === undefined || host === '' || LOOPBACK.has(host)) return undefined;
  return host;
}

/**
 * The API this build talks to.
 *
 * Only the `local` profile is rewritten to the LAN host: `dev` and `prod` name real
 * hostnames from `app.config.ts`, and rewriting one of those to an IP address would be a
 * silent redirect of production traffic.
 */
export function resolveApiBaseUrl(): string {
  const configured =
    typeof extra.apiBaseUrl === 'string'
      ? extra.apiBaseUrl
      : `http://localhost:${LOCAL_API_PORT}`;

  if (profile !== 'local') return configured;

  const lanHost = metroLanHost();
  return lanHost === undefined ? configured : `http://${lanHost}:${LOCAL_API_PORT}`;
}

export const apiBaseUrl = resolveApiBaseUrl();

/**
 * The injected dependencies the shared client takes.
 *
 * `localTokenProvider` yields no bearer token, so no `Authorization` header is sent, while
 * presenting the fixed `usr_local_dev` app identity that the local API uses. Phase 4 swaps
 * in the Cognito provider here and no call site changes — that seam is the reason the
 * provider is a parameter from the first commit rather than a later refactor.
 */
export const httpClientConfig: HttpClientConfig = {
  baseUrl: apiBaseUrl,
  /**
   * Wrapped, not passed by reference.
   *
   * `fetch: globalThis.fetch` detaches the function from its receiver, and the browser
   * rejects that: `TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation`.
   * Every request fails before a socket is opened, which then presents as a network error
   * rather than as the programming mistake it is.
   *
   * Found in P0-22 by running the app, and it could not have been found any other way —
   * the client's 48 unit tests all inject a stub `fetch`, so the one line that supplies the
   * real one is the one line no test covers.
   */
  fetch: (input, init) => globalThis.fetch(input, init),
  tokenProvider: localTokenProvider,
  // The device's zone, resolved per call site rather than stored: a user who flies
  // somewhere should not have to reinstall to see the right day.
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  clientVersion: `${Platform.OS === 'web' ? 'web' : Platform.OS}/${
    Constants.expoConfig?.version ?? '0.0.0'
  }`,
  /**
   * `__DEV__` is Expo's own "this is not a production bundle" flag, which is exactly the
   * distinction the setting needs — not the profile, because a `dev`-profile build handed to
   * a tester is still a shipped app that must not crash on a field the server added.
   */
  strictResponses: __DEV__,
};

/**
 * The app's single client. Module scope, like `queryClient`: it holds no per-render state,
 * and a new one per component would rebuild the header set on every mount.
 */
export const apiClient = createHttpClient(httpClientConfig);
