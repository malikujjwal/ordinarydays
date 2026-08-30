import {
  AlertDialog,
  Button,
  Calendar,
  Check,
  type IconProps,
  List,
  Sheet,
  Text,
  Trash,
  Users,
  useTheme,
} from '@od/ui';
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
  /** Compact alert-dialog introduction; destructive List deletion uses the approved wording. */
  summary?: string;
  /** Ordered, icon-backed consequences for the centred alert-dialog presentation. */
  consequences?: readonly {
    kind: 'removed' | 'kept' | 'access';
    text: string;
  }[];
}
export interface ConfirmDialogProps {
  open: boolean;
  confirmation: Confirmation;
  onCancel: () => void;
  onConfirm: () => void;
  /** Renders the confirmation inside a sheet that is already open. */
  embedded?: boolean;
  /** Uses the compact, centred alert-dialog presentation for a destructive object delete. */
  centred?: boolean;
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
  centred = false,
  busy = false,
  testID = 'confirm-dialog',
}: ConfirmDialogProps) {
  const theme = useTheme();
  const { heading, removesLead, removes, keeps, confirmLabel } = confirmation;
  const actions = (
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
  );

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

      {actions}
    </View>
  );

  const consequenceIcons: Readonly<
    Record<'removed' | 'kept' | 'access', (props: IconProps) => React.ReactElement>
  > = { removed: List, kept: Calendar, access: Users };
  const centredContent =
    confirmation.consequences === undefined ? (
      content
    ) : (
      <View style={{ gap: theme.space[5] }}>
        <View
          aria-hidden
          style={{
            width: theme.layout.hitTarget,
            height: theme.layout.hitTarget,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: theme.radius.pill,
            backgroundColor: theme.colors.surfaceRaised,
          }}
        >
          <Trash size={22} color={theme.colors.danger} />
        </View>
        <View style={{ gap: theme.space[2] }}>
          <Text variant="heading" color="textDisplay" accessibilityRole="header">
            {heading}
          </Text>
          {confirmation.summary === undefined ? null : (
            <Text variant="body" color="textSecondary">
              {confirmation.summary}
            </Text>
          )}
        </View>
        <View style={{ gap: theme.space[3] }}>
          {confirmation.consequences.map((consequence) => {
            const Icon = consequenceIcons[consequence.kind];
            return (
              <View
                key={`${consequence.kind}:${consequence.text}`}
                style={{
                  minHeight: theme.layout.hitTarget,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: theme.space[3],
                }}
              >
                <View aria-hidden>
                  {consequence.kind === 'kept' ? (
                    <View>
                      <Calendar size={20} color={theme.colors.textSecondary} />
                      <View style={{ position: 'absolute', right: -5, bottom: -5 }}>
                        <Check size={13} color={theme.colors.success} />
                      </View>
                    </View>
                  ) : (
                    <Icon size={20} color={theme.colors.textSecondary} />
                  )}
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text variant="body" color="textPrimary">
                    {consequence.text}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
        {actions}
      </View>
    );

  if (embedded) return open ? content : null;

  if (centred) {
    return (
      <AlertDialog
        open={open}
        label={heading}
        onRequestClose={onCancel}
        initialFocusTestID="confirm-cancel"
        testID={testID}
      >
        {centredContent}
      </AlertDialog>
    );
  }

  return (
    <Sheet open={open} onClose={onCancel} dismissible={false} testID={testID}>
      {content}
    </Sheet>
  );
}
