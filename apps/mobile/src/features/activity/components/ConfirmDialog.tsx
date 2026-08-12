import { Button, Sheet, Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import type { Confirmation } from '@/features/activity/model/confirmations';

/**
 * The destructive confirmation `interaction-contract.md` §1a.1 specifies, as one component.
 *
 * §1a.1 is a product-wide invariant and says so outright: "A feature spec may point at this
 * section; it may not restate it differently." One component is how that holds — the delete
 * dialog and the kind-change dialog cannot drift apart into two shapes, because they are the
 * same shape given different content.
 *
 * The four rules it encodes:
 *
 * 1. **`Cancel` sits first and is the default focus.** The destructive button repeats the
 *    verb — never `OK`, never `Continue` — and carries the `danger` styling.
 * 2. The fields are named the way the user sees them: `Season and episode`, not
 *    `details.season`.
 * 3. The `Keeps:` line appears whenever anything survives.
 * 4. Not dismissible by the scrim. A confirmation a stray tap can answer is not one.
 */
export interface ConfirmDialogProps {
  open: boolean;
  confirmation: Confirmation;
  onCancel: () => void;
  onConfirm: () => void;
  /** Renders the confirmation inside a sheet that is already open. */
  embedded?: boolean;
  /** True while the write is in flight; the primary button shows its own spinner. */
  busy?: boolean;
  testID?: string;
}

export function ConfirmDialog({
  open,
  confirmation,
  onCancel,
  onConfirm,
  embedded = false,
  busy = false,
  testID = 'confirm-dialog',
}: ConfirmDialogProps) {
  const theme = useTheme();
  const { heading, removesLead, removes, keeps, confirmLabel } = confirmation;

  const content = (
    <View testID={embedded ? testID : undefined} style={{ gap: theme.space[5] }}>
      <Text variant="heading" color="textDisplay" accessibilityRole="header">
        {heading}
      </Text>

      <View style={{ gap: theme.space[2] }}>
        {/* One entry reads as a sentence after the lead; several read as a list. */}
        {removes.length === 1 ? (
          <Text variant="body" color="textPrimary">
            {`${removesLead} ${removes[0]}`}
          </Text>
        ) : (
          <>
            <Text variant="body" color="textPrimary">
              {removesLead}
            </Text>
            <View style={{ gap: theme.space[1], paddingLeft: theme.space[4] }}>
              {removes.map((line) => (
                <Text key={line} variant="body" color="textPrimary">
                  {line}
                </Text>
              ))}
            </View>
          </>
        )}

        {keeps === undefined ? null : (
          <Text variant="subhead" color="textSecondary" testID="confirm-keeps">
            {`Keeps: ${keeps}`}
          </Text>
        )}
      </View>

      <View style={{ flexDirection: 'row', gap: theme.space[3], flexWrap: 'wrap' }}>
        {/* Cancel first, and the safe choice. */}
        <Button
          label="Cancel"
          variant="secondary"
          onPress={onCancel}
          testID="confirm-cancel"
        />
        <Button
          label={confirmLabel}
          variant="danger"
          loading={busy}
          onPress={onConfirm}
          testID="confirm-accept"
        />
      </View>
    </View>
  );

  if (embedded) return open ? content : null;

  return (
    <Sheet open={open} onClose={onCancel} dismissible={false} testID={testID}>
      {content}
    </Sheet>
  );
}
