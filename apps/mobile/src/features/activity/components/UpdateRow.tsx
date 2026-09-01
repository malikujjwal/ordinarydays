import { Text, type Theme, Touchable, useTheme } from '@od/ui';
import { memo, useCallback, useMemo } from 'react';
import { StyleSheet } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import {
  UpdateRowBody,
  type UpdateRowProps,
} from '@/features/activity/components/UpdateRowBody';

/**
 * One Updates entry on **native** (P3-40).
 *
 * The row body is not interactive (`interaction-contract.md` §3.3); the author's own `user`
 * entry offers swipe `Delete`, and on a `system` entry the affordance is **absent** — not
 * disabled — because the record of what happened is not deletable by anyone. A system entry
 * renders the same row de-emphasised with no author name; in this phase user entries carry
 * no name either, since the only possible author is the caller.
 */
export type { UpdateRowProps };

/** Matches `SwipeableRow`'s panel width, the app's one swipe-action measure. */
const ACTION_WIDTH = 88;

const Body = memo(function Body({ update, relativeTime, onDelete }: UpdateRowProps) {
  const handleDelete = useCallback(() => onDelete?.(update), [onDelete, update]);
  const containerProps = useMemo(
    () =>
      onDelete === undefined
        ? undefined
        : {
            accessibilityActions: [{ name: 'delete', label: 'Delete update' }],
            onAccessibilityAction: ({
              nativeEvent,
            }: {
              nativeEvent: { actionName: string };
            }) => {
              if (nativeEvent.actionName === 'delete') handleDelete();
            },
          },
    [handleDelete, onDelete],
  );
  return (
    <UpdateRowBody
      body={update.body}
      trailing={relativeTime}
      muted={update.kind === 'system'}
      testID={`update-${update.updateId}`}
      {...(containerProps === undefined ? {} : { containerProps })}
    />
  );
});

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    action: {
      width: ACTION_WIDTH,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.danger,
    },
  });

export const UpdateRow = memo(function UpdateRow({
  update,
  relativeTime,
  onDelete,
}: UpdateRowProps) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const handleDelete = useCallback(() => onDelete?.(update), [onDelete, update]);
  const renderRightActions = useCallback(
    () => (
      <Touchable
        accessibilityRole="button"
        accessibilityLabel="Delete update"
        onPress={handleDelete}
        testID={`update-delete-${update.updateId}`}
        style={styles.action}
      >
        <Text variant="footnoteStrong" color="inverse">
          Delete
        </Text>
      </Touchable>
    ),
    [handleDelete, styles.action, update.updateId],
  );
  if (update.kind !== 'user' || onDelete === undefined) {
    return <Body update={update} relativeTime={relativeTime} />;
  }

  return (
    <ReanimatedSwipeable overshootRight={false} renderRightActions={renderRightActions}>
      <Body update={update} relativeTime={relativeTime} onDelete={onDelete} />
    </ReanimatedSwipeable>
  );
});
