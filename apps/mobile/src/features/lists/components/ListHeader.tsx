import { MAX_TITLE_LEN } from '@od/shared/constants';
import type { List } from '@od/shared/types';
import {
  Button,
  Field,
  IconButton,
  MoreHorizontal,
  Text,
  Touchable,
  useTheme,
} from '@od/ui';
import { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';

/**
 * The list detail header, and the **only** place a list is renamed
 * ([`plans-and-lists.md`](../../../../../docs/01-product/plans-and-lists.md) §5.6, §P3-32).
 *
 * ## Rename is inline on the title, and nowhere else
 *
 * §5.6 gives renaming one home: "Inline on the header title." §P3-32 says the same thing from
 * the other side — "It is not duplicated in the `⋯` settings sheet" — and
 * `ListSettingsSheet.test.tsx` asserts the sheet has no Rename row, so re-adding one fails a
 * test rather than shipping two ways to do one thing.
 *
 * Activating the title swaps it for a focused field; `Save` commits **one**
 * `PATCH /v1/lists/:id { title }` under `If-Match`, and both `Save` and `Cancel` put focus back
 * on the title. That last part is `interaction-contract.md` §7.3's rule for a control that
 * replaces itself: a keyboard user who cancels must not be dropped at the top of the document.
 *
 * ## Renaming changes nothing else
 *
 * §5.5's second rule, and it is a rule about what this component must **not** do: renaming
 * `Restaurants to try` to `Favourite restaurants` leaves behaviour, capabilities and slot exactly
 * as they were. There is no inference here from the typed words to anything — §1a.2's table
 * names "Renaming a list" and answers "Nothing" — and the write this sends carries one field.
 *
 * ## The draft is local, and it is discarded on Cancel
 *
 * Nothing is sent while typing. The committed title reappears under an open editor if somebody
 * else renames the list — the projection flows straight through to `value` — and a save that
 * loses that race gets `This list changed while you were editing.` from `useListSettings`, which
 * is §5.11.5's row for exactly this collision.
 */
export interface ListHeaderProps {
  /** Absent while the projection is still loading; the title falls back to `List`. */
  list: List | undefined;
  onBack: () => void;
  /** Opens the `⋯` menu. Absent list means no menu — there is nothing to act on yet. */
  onOpenMenu: () => void;
  /** Commits the new title. Called once, on `Save`, with the trimmed value. */
  onRename: (title: string) => void;
  testID?: string;
}

export function ListHeader({
  list,
  onBack,
  onOpenMenu,
  onRename,
  testID = 'list-header',
}: ListHeaderProps) {
  const theme = useTheme();
  const [draft, setDraft] = useState<string>();
  const editing = draft !== undefined;
  const title = list?.title ?? 'List';
  /** Wraps the title control so focus can be handed back to it after the field goes away. */
  const titleSlot = useRef<View>(null);
  const returning = useRef(false);

  /**
   * §7.3's "Web equivalents": focus returns to the triggering element when a transient control
   * closes. The field replaced the title, so leaving edit mode would otherwise drop focus onto
   * the document body — the `ItemSheet` sheet-close rule, applied to a control that swaps
   * in place.
   */
  useEffect(() => {
    if (Platform.OS !== 'web' || editing || !returning.current) return;
    returning.current = false;
    const slot = titleSlot.current as unknown as HTMLElement | null;
    slot?.querySelector<HTMLElement>('[role="button"]')?.focus();
  }, [editing]);

  const leaveEditor = () => {
    returning.current = true;
    setDraft(undefined);
  };

  const save = () => {
    const next = draft?.trim() ?? '';
    if (next.length === 0) return;
    leaveEditor();
    // One write, one field. `useListSettings` drops it when the title has not actually changed.
    onRename(next);
  };

  return (
    <View style={{ gap: theme.space[2], paddingBottom: theme.space[3] }} testID={testID}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Button
          label="Back"
          variant="ghost"
          flush
          onPress={onBack}
          testID="list-detail-back"
        />
        {list === undefined ? null : (
          <IconButton
            icon={MoreHorizontal}
            label="More"
            onPress={onOpenMenu}
            testID="list-detail-menu"
          />
        )}
      </View>

      {editing ? (
        <View style={{ gap: theme.space[3] }}>
          <Field
            label="List name"
            hideLabel
            appearance="bare"
            textVariant="display"
            autoFocus
            value={draft}
            onChangeText={setDraft}
            maxLength={MAX_TITLE_LEN}
            /* Return commits, as it does on every single-line title field in the app. */
            onSubmitEditing={save}
            submitBlurs
            testID="list-title-field"
          />
          <View style={{ flexDirection: 'row', gap: theme.space[3] }}>
            {/* Cancel first, and it discards the draft without a write. */}
            <Button
              label="Cancel"
              variant="secondary"
              onPress={leaveEditor}
              testID="list-title-cancel"
            />
            <Button
              label="Save"
              onPress={save}
              disabled={draft.trim().length === 0}
              testID="list-title-save"
            />
          </View>
        </View>
      ) : (
        <View ref={titleSlot}>
          <Touchable
            square={false}
            accessibilityRole="button"
            /*
             * The action, not the content: a screen reader hearing only the list's name would
             * have no way to know the header does anything. The name is still in it, because
             * `Rename` alone would not say *what* is being renamed.
             */
            accessibilityLabel={`Rename ${title}`}
            disabled={list === undefined}
            onPress={() => setDraft(title)}
            testID="list-title"
          >
            <Text variant="display" color="textDisplay" accessibilityRole="header">
              {title}
            </Text>
          </Touchable>
        </View>
      )}
    </View>
  );
}
