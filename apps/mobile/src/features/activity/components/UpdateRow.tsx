import type { ActivityUpdate } from '@od/shared/types';
import { Text, Touchable, useTheme } from '@od/ui';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { UpdateRowBody } from '@/features/activity/components/UpdateRowBody';

/**
 * One Updates entry on **native** (P3-40).
 *
 * The row body is not interactive (`interaction-contract.md` §3.3); the author's own `user`
 * entry offers swipe `Delete`, and on a `system` entry the affordance is **absent** — not
 * disabled — because the record of what happened is not deletable by anyone. A system entry
 * renders the same row de-emphasised with no author name; in this phase user entries carry
 * no name either, since the only possible author is the caller.
 */
export interface UpdateRowProps {
  update: ActivityUpdate;
  relativeTime: string;
  /** Absent on a system entry by construction — the caller never passes it for one. */
  onDelete?: () => void;
}

const ACTION_WIDTH = 88;

function Body({ update, relativeTime, onDelete }: UpdateRowProps) {
  return (
    <UpdateRowBody
      body={update.body}
      trailing={relativeTime}
      muted={update.kind === 'system'}
      testID={`update-${update.updateId}`}
      {...(onDelete === undefined
        ? {}
        : {
            // The swipe's non-gesture path: assistive tech reaches Delete as a custom action.
            containerProps: {
              accessibilityActions: [{ name: 'delete', label: 'Delete update' }],
              onAccessibilityAction: ({
                nativeEvent,
              }: {
                nativeEvent: { actionName: string };
              }) => {
                if (nativeEvent.actionName === 'delete') onDelete();
              },
            },
          })}
    />
  );
}

export function UpdateRow({ update, relativeTime, onDelete }: UpdateRowProps) {
  const theme = useTheme();
  if (update.kind !== 'user' || onDelete === undefined) {
    return <Body update={update} relativeTime={relativeTime} />;
  }

  return (
    <ReanimatedSwipeable
      overshootRight={false}
      renderRightActions={() => (
        <Touchable
          accessibilityRole="button"
          accessibilityLabel="Delete update"
          onPress={onDelete}
          testID={`update-delete-${update.updateId}`}
          style={{
            width: ACTION_WIDTH,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.danger,
          }}
        >
          <Text variant="footnoteStrong" color="inverse">
            Delete
          </Text>
        </Touchable>
      )}
    >
      <Body update={update} relativeTime={relativeTime} onDelete={onDelete} />
    </ReanimatedSwipeable>
  );
}
