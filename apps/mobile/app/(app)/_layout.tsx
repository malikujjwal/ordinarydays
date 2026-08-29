import { Stack } from 'expo-router';
import { View } from 'react-native';
import { ToastHost } from '@/features/shell/components/ToastHost';
import { NEW_LIST_ROUTE_OPTIONS } from '@/navigation/listRoutes';

/**
 * The signed-in group.
 *
 * A group, `(app)`, rather than a path segment: it nests layouts without adding `/app` to
 * every URL, which matters on web where the URL is the user's address bar.
 *
 * It holds the tab shell (P1-23) plus the routes that sit *over* it — `compose` is presented
 * modally so the chooser covers whichever tab raised it, and `health`/`gallery` are the two
 * development surfaces from Phase 0 and P1-22.
 *
 * **There is still no auth guard and no `(auth)` group.** Phase 4 adds both, and this file
 * remains the only one that changes: no screen inside the group reads a session, and no
 * navigation call assumes it is already at the root.
 *
 * `ToastHost` is mounted here, outside the `Stack`, so a confirmation survives the screen
 * that raised it — saving from the compose modal dismisses the modal and *then* names where
 * the item landed (`activities.md` §2.5).
 */
export default function AppLayout() {
  return (
    <View style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="anytime" />
        <Stack.Screen
          name="compose"
          options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
        />
        <Stack.Screen name="lists/new" options={NEW_LIST_ROUTE_OPTIONS} />
      </Stack>
      <ToastHost />
    </View>
  );
}
