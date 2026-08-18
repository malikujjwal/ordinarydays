import { Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import { useIsOffline } from '@/hooks/usePendingIntents';

/**
 * The persistent offline bar (`interaction-contract.md` §5.4).
 *
 * "A persistent 20 pt bar under the header: `Offline — changes will sync.` No modal, no
 * blocking." Promised since Phase 2 began and never built; P2-48 builds it, because durable
 * queued writes the user cannot see are worse than what existed before.
 *
 * It states connectivity, not queue depth. A count would invite the user to reason about a
 * number they cannot act on, and §5.4's copy is the copy.
 */
export function OfflineBar() {
  const theme = useTheme();
  const offline = useIsOffline();

  /**
   * **Strictly connectivity-scoped, and it leaves the moment connectivity returns**
   * (founder, 2026-08-17).
   *
   * The bar answers one question — are you online — so it must not linger to report a queue
   * still draining. That would give it a second meaning and need a second string §5.4 does
   * not specify. Per-write status is the `Pending` indicator's job, and it stays on the row
   * until that write lands, which is the specified way to say "this particular thing has not
   * synced yet".
   */
  if (!offline) return null;

  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      testID="offline-bar"
      style={{
        minHeight: 20,
        justifyContent: 'center',
        paddingVertical: theme.space[1],
        paddingHorizontal: theme.space[5],
        backgroundColor: theme.colors.surfaceSunken,
      }}
    >
      <Text variant="footnote" color="textSecondary" numberOfLines={1}>
        Offline — changes will sync.
      </Text>
    </View>
  );
}
