import { Stack } from 'expo-router';

/**
 * The signed-in group.
 *
 * A group, `(app)`, rather than a path segment: it nests layouts without adding `/app` to
 * every URL, which matters on web where the URL is the user's address bar.
 *
 * It is a bare `Stack` today. Two things land in it later and both are structural rather
 * than cosmetic, which is why the group exists now: the **auth guard** in Phase 4, which
 * redirects to `(auth)` when there is no session, and the **tabs** in Phase 2, when there
 * are three nouns to switch between. Adding either to a group that already exists is a
 * change to one file; introducing the group later moves every route in the app.
 */
export default function AppLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
