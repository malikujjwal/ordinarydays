import { Text, type Theme, Touchable, useTheme } from '@od/ui';
import { memo, useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  UpdateRowBody,
  type UpdateRowProps,
} from '@/features/activity/components/UpdateRowBody';

/**
 * One Updates entry on **web** (P3-40).
 *
 * The row body is not interactive (`interaction-contract.md` §3.3) and no entry carries an
 * author name in this phase. Web renders the delete affordance the way agenda rows render
 * their actions — a hover/focus-revealed control in place of the native swipe — and only on
 * the caller's own `user` entries: on a `system` entry the affordance is **absent**, not
 * disabled, because the record of what happened is not deletable by anyone.
 */
export type { UpdateRowProps };

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    deleteControl: { paddingHorizontal: theme.space[2] },
  });

export const UpdateRow = memo(function UpdateRow({
  update,
  relativeTime,
  onDelete,
}: UpdateRowProps) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const deletable = update.kind === 'user' && onDelete !== undefined;
  const controlVisible = deletable && (hovered || focused);
  const showHover = useCallback(() => setHovered(true), []);
  const hideHover = useCallback(() => setHovered(false), []);
  const showFocus = useCallback(() => setFocused(true), []);
  const hideFocus = useCallback(() => setFocused(false), []);
  const handleDelete = useCallback(() => onDelete?.(update), [onDelete, update]);
  const controlStyle = useMemo(
    () => [
      styles.deleteControl,
      {
        opacity: controlVisible ? 1 : 0,
        pointerEvents: controlVisible ? ('auto' as const) : ('none' as const),
      },
    ],
    [controlVisible, styles.deleteControl],
  );

  return (
    <View onPointerEnter={showHover} onPointerLeave={hideHover}>
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
                  onFocus={showFocus}
                  onBlur={hideFocus}
                  onPress={handleDelete}
                  testID={`update-delete-${update.updateId}`}
                  style={controlStyle}
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
});
