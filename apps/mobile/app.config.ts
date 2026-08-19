import type { ExpoConfig } from 'expo/config';

/**
 * The profile-driven Expo config (`infrastructure.md` §6.4).
 *
 * One variable decides the app's name, its bundle identifier, its URL scheme and which API
 * it talks to. Nothing reads an API hostname from a source file — that is the whole point:
 * a hostname compiled into a component is a hostname that ships to the wrong environment
 * eventually.
 *
 * Distinct bundle identifiers mean the dev and prod apps install side by side on one device
 * with distinct names, so it is never ambiguous which is open. Distinct URL schemes keep
 * deep links routed to the right one.
 */
const PROFILE = (process.env.EXPO_PUBLIC_PROFILE ?? 'local') as Profile;

type Profile = 'local' | 'dev' | 'prod';

/**
 * Only `local` resolves to something that answers in Phase 0. The `dev` and `prod` entries
 * name hostnames Phase 4 and Phase 5 create, and they are here now so that the shape of
 * this table does not change when they do — a table that gains rows later is a table
 * somebody has to re-reason about.
 *
 * `local` is a **fallback**, not the answer: on a physical device `localhost` is the phone,
 * not the laptop. `src/lib/apiClient.ts` prefers the LAN host Metro is already serving from
 * and uses this only when there is none.
 */
const API: Record<Profile, string> = {
  local: 'http://localhost:3000',
  dev: 'https://api.dev.ordinarydays.app',
  prod: 'https://api.ordinarydays.app',
};

const config: ExpoConfig = {
  name: PROFILE === 'prod' ? 'Ordinary Days' : `Ordinary Days (${PROFILE})`,
  slug: 'ordinarydays',
  scheme: PROFILE === 'prod' ? 'ordinarydays' : `ordinarydays-${PROFILE}`,
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  newArchEnabled: true,
  ios: {
    bundleIdentifier:
      PROFILE === 'prod' ? 'app.ordinarydays.ios' : `app.ordinarydays.ios.${PROFILE}`,
    supportsTablet: true,
    /**
     * iOS blocks cleartext HTTP by default, and the local API is `http://<lan-ip>:3000`. So
     * a physical device would fail every request with a transport error that never reaches
     * JavaScript — no status, no body, nothing to read on screen (P0-22).
     *
     * `NSAllowsLocalNetworking`, **not** `NSAllowsArbitraryLoads`. It permits cleartext to
     * local-network hosts only, so an accidental `http://` to the public internet still
     * fails, which is the behaviour we want to keep. And it is inside a
     * `PROFILE !== 'prod'` guard, so no relaxation of transport security can reach a
     * production build even by accident.
     *
     * Expo Go reads this from the manifest. A development build (Phase 4) bakes it in from
     * here, which is why it lives in the config rather than in a one-off Xcode change.
     */
    ...(PROFILE === 'prod'
      ? {}
      : { infoPlist: { NSAppTransportSecurity: { NSAllowsLocalNetworking: true } } }),
  },
  web: {
    bundler: 'metro',
    /**
     * Static export, not `single`. Every route pre-renders to its own HTML file, which is
     * what gives the public invite page a real URL that CloudFront can serve and a crawler
     * can read (`tech-stack.md` §3.5). It is also what `WebStack`'s `BucketDeployment`
     * uploads, so changing it changes how the site is hosted.
     */
    output: 'static',
  },
  plugins: ['expo-router', 'expo-sqlite'],
  experiments: { typedRoutes: true },
  extra: {
    profile: PROFILE,
    apiBaseUrl: API[PROFILE],
    // Cognito arrives in Phase 4. The keys are declared so that adding identity is a
    // deployment variable rather than a config change.
    cognitoUserPoolId: process.env.EXPO_PUBLIC_COGNITO_POOL_ID,
    cognitoClientId: process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID,
  },
};

export default config;
