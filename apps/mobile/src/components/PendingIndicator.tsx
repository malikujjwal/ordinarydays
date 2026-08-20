import { CloudOff, Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import { usePendingCreate } from '@/hooks/usePendingIntents';

/**
 * The `Pending` indicator for a row whose write has not reached the server
 * (`interaction-contract.md` §5.4).
 *
 * **Entity-generic and copy-parameterised**, which is the whole reason it takes both an
 * `entityId` and a `label`. Phase 3's `Plan will finish syncing` and P2-57's reminder copy are
 * parameters of this component, not second systems — the phase preamble says so explicitly,
 * and a per-entity indicator is how you end up with three that drift.
 *
 * Not an error colour: waiting is not failure. §5.4 places the cloud-off glyph and `Pending`
 * at the end of the row's metadata line, where it explains the absent checkbox without adding
 * a separate trailing line.
 *
 * **It tracks the unacknowledged *create*, not any queued write** (fixed 2026-08-18). It first
 * shipped asking "does this entity have any pending intent", which meant ticking a checkbox
 * offline flagged the row as `Pending` — a task whose completion is queued exists on the
 * server perfectly well, and §5.4 ties this indicator to the create specifically: "until its
 * create is acknowledged it renders with the `Pending` indicator". The row's checkbox was
 * already gated on the create; this is the half that disagreed with it.
 */
export interface PendingIndicatorProps {
  /** Whatever the row is about — `act_`, `rem_`, later `itm_`. */
  entityId: string | undefined;
  /** The word shown. Defaults to §5.4's `Pending`. */
  label?: string;
}

export interface PendingLabelProps {
  label?: string;
}

/** Pure presentation for callers that already subscribe to the entity's intent state. */
export function PendingLabel({ label = 'Pending' }: PendingLabelProps) {
  const theme = useTheme();

  return (
    <View
      testID="pending-indicator"
      // The cloud is decorative; the word carries the meaning, so one label covers both (§6.4).
      accessibilityLabel={label}
      style={{
        flexShrink: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space[1],
      }}
    >
      <View
        aria-hidden
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <CloudOff size={14} color={theme.colors.textSecondary} />
      </View>
      <Text variant="footnote" color="textSecondary" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function PendingIndicator({ entityId, label = 'Pending' }: PendingIndicatorProps) {
  const { pending } = usePendingCreate(entityId);
  return pending ? <PendingLabel label={label} /> : null;
}
