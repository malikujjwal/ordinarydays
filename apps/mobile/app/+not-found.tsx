import { Link, Stack } from 'expo-router';
import { Text, View } from 'react-native';

/**
 * The unmatched-route screen.
 *
 * It earns its place on **web**, where a user can type a URL, follow a stale link, or land
 * on `/invite/<token>` for an invite that no longer exists — the one surface people without
 * the app ever reach. On iOS it is nearly unreachable, and that asymmetry is the reason it
 * offers a way back rather than only an apology.
 *
 * The copy is provisional: `interaction-contract.md` §5 owns the wording for empty and
 * error states, and this route is not in its table yet.
 */
export default function NotFound() {
  return (
    <>
      <Stack.Screen options={{ title: 'Not found' }} />
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text accessibilityRole="header">This page does not exist.</Text>
        <Link href="/" accessibilityRole="link">
          Go to Today
        </Link>
      </View>
    </>
  );
}
