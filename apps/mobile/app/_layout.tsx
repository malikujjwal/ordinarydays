import { ThemeProvider } from '@od/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useSerifFamily } from '@/lib/fonts';
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
export default function RootLayout() {
  const serifFamily = useSerifFamily();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider {...(serifFamily === undefined ? {} : { serifFamily })}>
          <QueryClientProvider client={queryClient}>
            {/* Headerless: every screen owns its own chrome (`interaction-contract.md`). */}
            <Stack screenOptions={{ headerShown: false }} />
            <StatusBar style="auto" />
          </QueryClientProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
