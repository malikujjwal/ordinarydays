import { Button, Sheet, Text, useTheme } from '@od/ui';
import { View } from 'react-native';

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
 *
 * ## Why it lives in `src/components/` rather than in `features/activity/`
 *
 * Moved there in P3-25, when the Lists index needed the same dialog for `Delete list`. §1a.1 is
 * explicit that a feature spec "may point at this section; it may not restate it differently",
 * and `check-forbidden.mjs`'s `client-layer-rules` forbids one feature importing another's
 * internals — so leaving it in `features/activity` left only two options, both wrong: a second
 * dialog that would drift, or an illegal import. `repo-structure.md` §3.2 names the fix
 * outright: "if two features need the same thing, it moves up to `src/components/`".
 *
 * The **content builders** stayed where they were. `features/activity/model/confirmations.ts`
 * counts notes, reminders and prep children; the Lists index counts linked plans and members.
 * Those are feature knowledge. What moved is the shape they both fill and the rules that
 * render it.
 */

/**
 * What a destructive confirmation says. The shape §1a.1 owns; the numbers are the feature's.
 */
export interface Confirmation {
  /** Names the object and the change: `Delete "Paris weekend"?` */
  heading: string;
  /** `This removes:` for a deletion, `This will remove:` for a change (§6.3, §6.4). */
  removesLead: string;
  /**
   * One entry is rendered as a prose sentence after the lead; several are rendered as a
   * list. Deletion names its losses in a sentence and a kind change lists them by field.
   */
  removes: string[];
  /** Present whenever anything survives (§1a.1: "the `Keeps:` line, whenever anything does"). */
  keeps?: string;
  /** The destructive button. **Repeats the verb** — never `OK`, never `Continue`. */
  confirmLabel: string;
}
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
