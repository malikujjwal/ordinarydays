import type { ActivityUpdate } from '@od/shared/types';
import { Text, Touchable, useTheme } from '@od/ui';
import { useState } from 'react';
import { View } from 'react-native';

/**
 * One Updates entry on **web** (P3-40).
 *
 * The row body is not interactive (`interaction-contract.md` §3.3) and no entry carries an
 * author name in this phase. Web renders the delete affordance the way agenda rows render
 * their actions — a hover/focus-revealed control in place of the native swipe — and only on
 * the caller's own `user` entries: on a `system` entry the affordance is **absent**, not
 * disabled, because the record of what happened is not deletable by anyone.
 */
export interface UpdateRowProps {
  update: ActivityUpdate;
  relativeTime: string;
  /** Absent on a system entry by construction — the caller never passes it for one. */
  onDelete?: () => void;
}

export function UpdateRow({ update, relativeTime, onDelete }: UpdateRowProps) {
  const theme = useTheme();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const deletable = update.kind === 'user' && onDelete !== undefined;
  const controlVisible = deletable && (hovered || focused);

  return (
    <View
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={{
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: theme.space[3],
        paddingVertical: theme.space[1],
      }}
      testID={`update-${update.updateId}`}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          variant="body"
          color={update.kind === 'system' ? 'textSecondary' : 'textPrimary'}
          numberOfLines={2}
        >
          {update.body}
        </Text>
      </View>
      {deletable ? (
        <Touchable
          accessibilityRole="button"
          accessibilityLabel="Delete update"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onPress={onDelete}
          testID={`update-delete-${update.updateId}`}
          style={{
            paddingHorizontal: theme.space[2],
            opacity: controlVisible ? 1 : 0,
          }}
        >
          <Text variant="footnoteStrong" color="danger">
            Delete
          </Text>
        </Touchable>
      ) : null}
      <Text variant="footnote" color="textMuted">
        {relativeTime}
      </Text>
    </View>
  );
}
