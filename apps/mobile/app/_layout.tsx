import { Skeleton, ThemeProvider, useTheme } from '@od/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { Stack } from 'expo-router';
import Head from 'expo-router/head';
import { StatusBar } from 'expo-status-bar';
import { type ReactNode, useEffect, useState } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { installLocalReminderScheduler } from '@/features/reminders/localSchedule';
import { SyncStatusBanner } from '@/features/shell/components/SyncStatusBanner';
import { ClockProvider } from '@/hooks/useClock';
import { useSerifFamily } from '@/lib/fonts';
import { startIntentLogSession } from '@/lib/intentLogSession';
import { installOnlineManager } from '@/lib/onlineManager';
import { restorePersistedClient, subscribeToPersistence } from '@/lib/persister';
import { queryClient } from '@/lib/queryClient';
import { startNativeStateSession } from '@/lib/sqlite/nativeStateSession';

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

function HydrationGate({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    let stopPersistence: (() => void) | undefined;
    let stopOnlineManager: (() => void) | undefined;
    let stopLocalReminders: (() => void) | undefined;
    let stopIntentLog: (() => void) | undefined;
    let stopNativeState: (() => void) | undefined;

    void restorePersistedClient(queryClient).then(async (outcome) => {
      if (!active) return;
      /**
       * `outcome.safeToPersist` is what stops a slow storage read being overwritten by the
       * empty client that was rendering while it was still in flight. The app becomes
       * interactive now either way; only the *saving* waits.
       */
      stopPersistence = subscribeToPersistence(queryClient, outcome.safeToPersist);
      /**
       * The log is the iOS durability boundary, so it must be hydrated and any legacy paused
       * mutations must be imported before connectivity can resume work or the app can accept
       * a write. Web returns immediately because it has no durable log.
       */
      const nativeSession = await startNativeStateSession(queryClient);
      const session =
        nativeSession === undefined
          ? await startIntentLogSession(queryClient)
          : undefined;
      if (!active) {
        session?.stop();
        nativeSession?.stop();
        return;
      }
      stopNativeState = nativeSession?.stop;
      stopIntentLog = session?.stop;
      stopOnlineManager = installOnlineManager(queryClient);
      stopLocalReminders = installLocalReminderScheduler();
      setReady(true);
    });

    return () => {
      active = false;
      stopPersistence?.();
      stopOnlineManager?.();
      stopLocalReminders?.();
      stopIntentLog?.();
      stopNativeState?.();
    };
  }, []);

  if (!ready) {
    return (
      <View
        testID="cache-hydration-loading"
        style={{
          flex: 1,
          justifyContent: 'center',
          paddingHorizontal: theme.space[6],
          backgroundColor: theme.colors.surface,
        }}
      >
        <Skeleton shape="row" count={5} />
      </View>
    );
  }

  return (
    <>
      {children}
      <SyncStatusBanner />
    </>
  );
}

export default function RootLayout() {
  const serifFamily = useSerifFamily();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/*
        The document title, on web only — `expo-router/head` is a no-op on native.

        Without it the static export writes a **present but empty** `<title></title>` on every
        page, which `axe-core` reports as a `serious` `document-title` violation and which
        `definition-of-done.md` §5 item 11 does not allow. Found by P1-29's Playwright flow on
        its first run, which is what that gate is for.

        One title for the whole app, not one per route. A per-route title is better for the
        "aid in navigation" the rule is named after, but the copy for each is a product
        decision this task does not own — the web surface is Phase 5. A screen that wants its
        own renders its own `<Head>`, and this stays the fallback.
      */}
      <Head>
        <title>{APP_NAME}</title>
      </Head>
      <SafeAreaProvider>
        <ClockProvider>
          <ThemeProvider {...(serifFamily === undefined ? {} : { serifFamily })}>
            <QueryClientProvider client={queryClient}>
              <HydrationGate>
                {/* Headerless: every screen owns its own chrome (`interaction-contract.md`). */}
                <Stack screenOptions={{ headerShown: false }} />
                <StatusBar style="auto" />
              </HydrationGate>
            </QueryClientProvider>
          </ThemeProvider>
        </ClockProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
