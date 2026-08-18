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
   * **Offline only, deliberately.**
   *
   * A draining-after-reconnect state would need its own words, and §5.4 specifies exactly one
   * string for this bar. Inventing a second is a founder decision
   * ([`agent-playbook.md`](../../../../../../docs/04-conventions/agent-playbook.md) §10
   * trigger 11), not an implementation one. The gap it would have covered is already covered
   * per row: an unacknowledged write keeps its `Pending` indicator until it lands, which is
   * the specified way to say "this particular thing has not synced".
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
