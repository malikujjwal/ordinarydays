import { Button, Card, Text, useTheme } from '@od/ui';
import { View } from 'react-native';

/**
 * Why an entity cannot yet be acted on, and the one thing that can be done about it (P2-50).
 *
 * **Words, not just disabled controls.** `interaction-contract.md` §5.4 requires the row to
 * say why, and §6.4 forbids a disabled control from being the only signal — a greyed button
 * tells a sighted user something is wrong and tells a screen-reader user nothing at all. The
 * text carries the meaning; the disabled state is the redundant half.
 *
 * The copy lives in §5.5's table. It is passed in rather than hard-coded here so the reminder
 * variant, and Phase 3's list-item wording, are parameters of one component instead of three
 * that drift.
 */
export interface PendingNoticeProps {
  /** The explanation. §5.5 owns the exact string. */
  message: string;
  /** Offered only while the create is still queued; a request on the wire cannot be retracted. */
  onCancel?: (() => void) | undefined;
  cancelLabel?: string;
  busy?: boolean;
}

export function PendingNotice({
  message,
  onCancel,
  cancelLabel = 'Cancel this',
  busy = false,
}: PendingNoticeProps) {
  const theme = useTheme();

  return (
    <Card elevation="e1" radius="lg" padding={5}>
      <View
        testID="pending-notice"
        /**
         * Announced on appearance, and readable as one element when reached.
         *
         * `polite` rather than `alert`: nothing has gone wrong — the write is waiting, which
         * is the ordinary offline path and not something to interrupt the user for. React
         * Native has no `status` role, so the live region does the announcing and
         * `accessible` + the label make the sentence a single stop rather than stray text a
         * screen reader may skip past. **The words are the signal**, never the styling
         * (§6.4).
         */
        accessible
        accessibilityLabel={message}
        accessibilityLiveRegion="polite"
        style={{ gap: theme.space[3] }}
      >
        <Text variant="subhead" color="textPrimary" numberOfLines={0}>
          {message}
        </Text>
        {onCancel === undefined ? null : (
          <Button
            label={cancelLabel}
            variant="secondary"
            loading={busy}
            onPress={onCancel}
            testID="pending-cancel"
          />
        )}
      </View>
    </Card>
  );
}
