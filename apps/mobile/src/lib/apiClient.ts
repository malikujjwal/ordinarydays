import type { HttpClientConfig } from '@od/shared/client';
import { nullTokenProvider } from '@od/shared/client';
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
 * P0-20 adds the client itself and consumes `httpClientConfig` unchanged.
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
 */
function metroLanHost(): string | undefined {
  const hostUri = Constants.expoConfig?.hostUri;
  if (typeof hostUri !== 'string' || hostUri === '') return undefined;

  const host = hostUri.split(':')[0];
  if (host === undefined || host === '' || host === 'localhost') return undefined;
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
 * `nullTokenProvider` yields nothing, so no `Authorization` header is sent at all. Phase 4
 * swaps in the Cognito provider here and no call site changes — that seam is the reason the
 * provider is a parameter from the first commit rather than a later refactor.
 */
export const httpClientConfig: HttpClientConfig = {
  baseUrl: apiBaseUrl,
  fetch: globalThis.fetch,
  tokenProvider: nullTokenProvider,
  // The device's zone, resolved per call site rather than stored: a user who flies
  // somewhere should not have to reinstall to see the right day.
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  clientVersion: `${Platform.OS === 'web' ? 'web' : Platform.OS}/${
    Constants.expoConfig?.version ?? '0.0.0'
  }`,
};
