import { Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import { useIsPending } from '@/hooks/usePendingIntents';

/**
 * The `Pending` indicator for a row whose write has not reached the server
 * (`interaction-contract.md` §5.4).
 *
 * **Entity-generic and copy-parameterised**, which is the whole reason it takes both an
 * `entityId` and a `label`. Phase 3's `Plan will finish syncing` and P2-57's reminder copy are
 * parameters of this component, not second systems — the phase preamble says so explicitly,
 * and a per-entity indicator is how you end up with three that drift.
 *
 * Not an error colour: waiting is not failure. §5.4 calls for "a small `Pending` dot in the
 * row's trailing slot. Not an error colour."
 */
export interface PendingIndicatorProps {
  /** Whatever the row is about — `act_`, `rem_`, later `itm_`. */
  entityId: string | undefined;
  /** The word shown. Defaults to §5.4's `Pending`. */
  label?: string;
}

export function PendingIndicator({ entityId, label = 'Pending' }: PendingIndicatorProps) {
  const theme = useTheme();
  const pending = useIsPending(entityId);
  if (!pending) return null;

  return (
    <View
      testID="pending-indicator"
      // The dot is decorative; the word carries the meaning, so one label covers both (§6.4).
      accessibilityLabel={label}
      style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[1] }}
    >
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: theme.colors.textSecondary,
        }}
      />
      <Text variant="footnote" color="textSecondary" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}
