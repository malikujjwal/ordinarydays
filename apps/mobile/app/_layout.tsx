import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { queryClient } from '@/lib/queryClient';

/**
 * The root layout: every provider the app needs, in the order they have to nest.
 *
 * `GestureHandlerRootView` is outermost and takes `flex: 1`. Both matter — a gesture
 * handler mounted inside a provider that re-renders loses its native handlers, and without
 * the flex the whole tree collapses to zero height on Android with no error to explain it.
 *
 * The theme provider named in P0-19's file list is **not here**: `@od/ui` has no theme yet.
 * It is written in P1-22 and mounts inside `SafeAreaProvider`. A provider wrapping a theme
 * that does not exist would be a component doing nothing, which reads as one doing
 * something.
 */
export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          {/* Headerless: every screen owns its own chrome (`interaction-contract.md`). */}
          <Stack screenOptions={{ headerShown: false }} />
          <StatusBar style="auto" />
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
