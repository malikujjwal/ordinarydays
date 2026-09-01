import type { ActivityUpdate } from '@od/shared/types';
import { Text, Touchable, useTheme } from '@od/ui';
import { useState } from 'react';
import { View } from 'react-native';
import { UpdateRowBody } from '@/features/activity/components/UpdateRowBody';

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
    >
      <UpdateRowBody
        body={update.body}
        trailing={relativeTime}
        muted={update.kind === 'system'}
        testID={`update-${update.updateId}`}
        {...(deletable
          ? {
              trailingControl: (
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
                    /**
                     * Invisible means un-tappable (CLAUDE.md rule 6: a row tap never
                     * mutates). Keyboard access survives — focusing the control is what
                     * reveals it, and a revealed control accepts the pointer again.
                     */
                    pointerEvents: controlVisible ? 'auto' : 'none',
                  }}
                >
                  <Text variant="footnoteStrong" color="danger">
                    Delete
                  </Text>
                </Touchable>
              ),
            }
          : {})}
      />
    </View>
  );
}
