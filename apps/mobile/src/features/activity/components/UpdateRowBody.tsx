import type { ActivityUpdate } from '@od/shared/types';
import { Text, type Theme, useTheme } from '@od/ui';
import { type ComponentProps, memo, type ReactNode, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

/**
 * The one visual body every Updates entry shares (P3-40): the native swipe row, the web
 * hover row, and the optimistic pending row are the same entry milliseconds apart, so they
 * render through the same component — a geometry tweak here cannot make the row jump the
 * moment a post settles or a platform differ from its sibling.
 */
/**
 * The platform forks' shared contract (§8.6: identical public surface). Defined beside the
 * shared body so `UpdateRow.tsx` and `UpdateRow.web.tsx` cannot drift apart.
 */
export interface UpdateRowProps {
  update: ActivityUpdate;
  relativeTime: string;
  /** Absent on a system entry by construction — the caller never passes it for one. */
  onDelete?: (update: ActivityUpdate) => void;
}

export interface UpdateRowBodyProps {
  body: string;
  /** `2 days ago`, or `Just now` for an optimistic entry. */
  trailing: string;
  /** System entries de-emphasise; the entry text is the event, and it names no author. */
  muted: boolean;
  testID: string;
  /** A control between the text and the timestamp (web's hover Delete). */
  trailingControl?: ReactNode;
  /** Container extras — the native row's accessibility custom actions ride here. */
  containerProps?: Partial<ComponentProps<typeof View>>;
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: theme.space[3],
      paddingVertical: theme.space[1],
    },
    body: { flex: 1, minWidth: 0 },
  });

export const UpdateRowBody = memo(function UpdateRowBody({
  body,
  trailing,
  muted,
  testID,
  trailingControl,
  containerProps,
}: UpdateRowBodyProps) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View {...containerProps} style={styles.row} testID={testID}>
      <View style={styles.body}>
        <Text
          variant="body"
          color={muted ? 'textSecondary' : 'textPrimary'}
          numberOfLines={2}
        >
          {body}
        </Text>
      </View>
      {trailingControl}
      <Text variant="footnote" color="textMuted">
        {trailing}
      </Text>
    </View>
  );
});
