import { EmptyState, Text, useTheme } from '@od/ui';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';

/**
 * `/lists/:listId` — **a stub**. P3-27 builds list detail and its inline add row here.
 *
 * It exists so the index's row tap has a destination. §P3-25's rule is that tapping a row
 * **opens the list and mutates nothing** (U1), and a tap that went nowhere could not be tested
 * for the second half — the navigation test asserts this route is reached and that no write
 * left the client.
 */
export default function ListDetailRoute() {
  const { listId } = useLocalSearchParams<{ listId: string }>();
  const router = useRouter();
  const theme = useTheme();

  return (
    <View
      testID="list-detail-stub"
      style={{ flex: 1, justifyContent: 'center', padding: theme.space[5] }}
    >
      <EmptyState
        heading="This list opens here"
        body="List detail and its items arrive next."
        action={{ label: 'Back', onPress: () => router.back() }}
      />
      <Text variant="footnote" color="textDisabled" align="center">
        {`P3-27 · ${listId ?? ''}`}
      </Text>
    </View>
  );
}
