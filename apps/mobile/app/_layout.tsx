import { ThemeProvider } from '@od/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { Stack } from 'expo-router';
import Head from 'expo-router/head';
import { StatusBar } from 'expo-status-bar';
import { Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { HydrationGate } from '@/components/HydrationGate';
import { installLocalReminderScheduler } from '@/features/reminders/localSchedule';
import { SyncStatusBanner } from '@/features/shell/components/SyncStatusBanner';
import { ClockProvider } from '@/hooks/useClock';
import { useSerifFamily } from '@/lib/fonts';
import { installOnlineManager } from '@/lib/onlineManager';
import { queryClient } from '@/lib/queryClient';

/**
 * The root layout: every provider the app needs, in the order they have to nest.
 *
 * `GestureHandlerRootView` is outermost and takes `flex: 1`. Both matter — a gesture
 * handler mounted inside a provider that re-renders loses its native handlers, and without
 * the flex the whole tree collapses to zero height on Android with no error to explain it.
 *
 * `ThemeProvider` mounts inside `SafeAreaProvider` (P1-22) and is handed the serif family
 * once `expo-font` has it. **The tree renders before the font arrives** — `serifFamily` is
 * `undefined` until then and the theme falls back to the platform serif, so nothing is
 * gated on a network-ish load.
 */

/**
 * The app's own name, from `app.config.ts` — so the profile suffix that already distinguishes
 * `Ordinary Days (local)` from `Ordinary Days` distinguishes the browser tabs too.
 */
const APP_NAME =
  typeof Constants.expoConfig?.name === 'string'
    ? Constants.expoConfig.name
    : 'Ordinary Days';

/**
 * Module-level so its identity is stable across renders — `HydrationGate` re-runs its
 * startup effect when this changes. The gate cannot import these itself: they live in
 * feature slices, and a shared component importing a feature is the layer inversion
 * `repo-structure.md` §3.2 exists to prevent.
 */
function installShellServices(): () => void {
  const stopOnlineManager = installOnlineManager(queryClient);
  const stopLocalReminders = installLocalReminderScheduler();
  return () => {
    stopOnlineManager();
    stopLocalReminders();
  };
}

export default function RootLayout() {
  const serifFamily = useSerifFamily();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/*
        The document title, on web only. On iOS, Expo Head enables Handoff and requires
        a hosted origin, so do not mount it for a native app that only needs a web title.

        Without it the static export writes a **present but empty** `<title></title>` on every
        page, which `axe-core` reports as a `serious` `document-title` violation and which
        `definition-of-done.md` §5 item 11 does not allow. Found by P1-29's Playwright flow on
        its first run, which is what that gate is for.

        One title for the whole app, not one per route. A per-route title is better for the
        "aid in navigation" the rule is named after, but the copy for each is a product
        decision this task does not own — the web surface is Phase 5. A screen that wants its
        own renders its own `<Head>`, and this stays the fallback.
      */}
      {Platform.OS === 'web' && (
        <Head>
          <title>{APP_NAME}</title>
        </Head>
      )}
      <SafeAreaProvider>
        <ClockProvider>
          <ThemeProvider {...(serifFamily === undefined ? {} : { serifFamily })}>
            <QueryClientProvider client={queryClient}>
              <HydrationGate install={installShellServices}>
                {/* Headerless: every screen owns its own chrome (`interaction-contract.md`). */}
                <Stack screenOptions={{ headerShown: false }} />
                <StatusBar style="auto" />
                <SyncStatusBanner />
              </HydrationGate>
            </QueryClientProvider>
          </ThemeProvider>
        </ClockProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
