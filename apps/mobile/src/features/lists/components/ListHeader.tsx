import { MAX_TITLE_LEN } from '@od/shared/constants';
import type { List } from '@od/shared/types';
import {
  Button,
  ChevronLeft,
  Field,
  IconButton,
  MoreHorizontal,
  Text,
  Touchable,
  useTheme,
} from '@od/ui';
import { useEffect, useRef, useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { ConnectivityStatus } from '@/components/ConnectivityStatus';

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
 * Activating the title swaps it for a focused field; Return or blur commits **one**
 * `PATCH /v1/lists/:id { title }` under `If-Match`. There are no duplicate Save/Cancel
 * controls in the compact header. Leaving the editor puts focus back on the title, following
 * `interaction-contract.md` §7.3's replacement-control rule.
 *
 * ## Renaming changes nothing else
 *
 * §5.5's second rule, and it is a rule about what this component must **not** do: renaming
 * `Restaurants to try` to `Favourite restaurants` leaves behaviour, capabilities and slot exactly
 * as they were. There is no inference here from the typed words to anything — §1a.2's table
 * names "Renaming a list" and answers "Nothing" — and the write this sends carries one field.
 *
 * ## The draft is local
 *
 * Nothing is sent while typing. The committed title reappears under an open editor if somebody
 * else renames the list — the projection flows straight through to `value` — and a save that
 * loses that race gets `This list changed while you were editing.` from `useListSettings`, which
 * is §5.11.5's row for exactly this collision.
 */
export interface ListHeaderProps {
  /** Absent while the projection is still loading; the title falls back to `List`. */
  list: List | undefined;
  /** The detail page's authoritative paged count when it is newer than the List row. */
  itemCount?: number;
  onBack: () => void;
  /** Opens the `⋯` menu. Absent list means no menu — there is nothing to act on yet. */
  onOpenMenu: () => void;
  /** Commits the new title once, on Return or blur, with the trimmed value. */
  onRename: (title: string) => void;
  /** Overrides the platform share sheet, primarily for deterministic callers and tests. */
  onShare?: () => void;
  testID?: string;
}

function headerKind(list: List): string {
  if (list.itemStateMode.mode === 'stages') return 'STAGED LIST';
  if (list.itemStateMode.mode === 'checkbox') return 'CHECKLIST';
  return 'SIMPLE LIST';
}

export function ListHeader({
  list,
  itemCount,
  onBack,
  onOpenMenu,
  onRename,
  onShare,
  testID = 'list-header',
}: ListHeaderProps) {
  const theme = useTheme();
  const [draft, setDraft] = useState<string>();
  const editing = draft !== undefined;
  const title = list?.title ?? 'List';
  const visibleItemCount = itemCount ?? list?.itemCount ?? 0;
  const returning = useRef(false);
  const leaving = useRef(false);

  /**
   * §7.3's "Web equivalents": focus returns to the triggering element when a transient control
   * closes. The field replaced the title, so leaving edit mode would otherwise drop focus onto
   * the document body — the `ItemSheet` sheet-close rule, applied to a control that swaps
   * in place.
   */
  useEffect(() => {
    if (Platform.OS !== 'web' || editing || !returning.current) return;
    returning.current = false;
    document.querySelector<HTMLElement>('[data-testid="list-title"]')?.focus();
  }, [editing]);

  const leaveEditor = () => {
    returning.current = true;
    setDraft(undefined);
  };

  const save = () => {
    if (leaving.current) return;
    leaving.current = true;
    const next = draft?.trim() ?? '';
    if (next.length === 0) {
      leaveEditor();
      return;
    }
    leaveEditor();
    // One write, one field. `useListSettings` drops it when the title has not actually changed.
    onRename(next);
  };

  return (
    <View style={{ paddingBottom: theme.space[3] }} testID={testID}>
      <View
        testID="list-header-navigation-line"
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space[2],
          minHeight: theme.layout.hitTarget,
        }}
      >
        <View testID="list-header-back-slot" style={{ width: theme.layout.hitTarget }}>
          <IconButton
            icon={ChevronLeft}
            label="Back"
            onPress={onBack}
            testID="list-detail-back"
          />
        </View>
        <View style={{ flex: 1, minWidth: 0 }} />
        {/*
         * The Today header's cloud glyph, in the same quiet role (founder, 2026-08-31):
         * offline, syncing and synced live here rather than as inline lines that reflow
         * the rows beneath. It renders nothing at all when there is nothing to say.
         */}
        <ConnectivityStatus />
        {list === undefined ? null : (
          <>
            <View
              testID="list-header-share-slot"
              style={{ minWidth: theme.space[11], flexShrink: 0 }}
            >
              <Button
                label="Share"
                variant="ghost"
                size="sm"
                onPress={onShare ?? (() => void Share.share({ message: title, title }))}
                testID="list-detail-share"
              />
            </View>
            <View
              testID="list-header-more-slot"
              style={{ width: theme.layout.hitTarget }}
            >
              <IconButton
                icon={MoreHorizontal}
                label="More"
                onPress={onOpenMenu}
                testID="list-detail-menu"
              />
            </View>
          </>
        )}
      </View>
      {list === undefined ? null : (
        <View style={{ marginTop: theme.space[7] }}>
          <Text variant="caption" color="textSecondary" testID="list-header-caption">
            {`${headerKind(list)} · ${String(visibleItemCount)} ${visibleItemCount === 1 ? 'ITEM' : 'ITEMS'}`}
          </Text>
        </View>
      )}
      <View
        testID="list-header-title-line"
        style={{
          minHeight: theme.layout.hitTarget,
          flexDirection: 'row',
          alignItems: 'center',
        }}
      >
        <View testID="list-header-title-slot" style={{ flex: 1, minWidth: 0 }}>
          {editing ? (
            <Field
              label="List name"
              hideLabel
              appearance="bare"
              textVariant="display"
              autoFocus
              value={draft}
              onChangeText={(next) => {
                leaving.current = false;
                setDraft(next);
              }}
              maxLength={MAX_TITLE_LEN}
              onSubmitEditing={save}
              onBlur={save}
              testID="list-title-field"
            />
          ) : (
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
              onPress={() => {
                leaving.current = false;
                setDraft(title);
              }}
              testID="list-title"
              style={{
                alignSelf: 'flex-start',
                maxWidth: '100%',
                minHeight: theme.layout.hitTarget,
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.space[2],
              }}
            >
              <Text
                variant="display"
                color="textDisplay"
                accessibilityRole="header"
                numberOfLines={2}
              >
                {title}
              </Text>
            </Touchable>
          )}
        </View>
      </View>
    </View>
  );
}
