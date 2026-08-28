import type { List } from '@od/shared/types';
import { Button, Sheet, Text, useTheme } from '@od/ui';
import { View } from 'react-native';

/**
 * The list header's `⋯` menu (`plans-and-lists.md` §5.6, §P3-10).
 *
 * **Presentational only.** Props in, callbacks out, no hooks and no data wiring — the screens
 * that own the list and its mutations arrive with P3-27 and P3-32. What it owns is the part
 * of the contract that is a rendering decision, and there are two.
 *
 * ## `Clear checked (7)` states its own count, and is absent at zero
 *
 * The count is in the button because that is what pays for there being **no confirmation
 * dialog**: §P3-10's recorded decision (`00-open-decisions.md` item 33) is that clearing
 * checked items is the *end* of a shopping trip, done one-handed, on rows the user has already
 * ticked one at a time — "a dialog asks them to re-confirm a decision they have already made
 * seven times". The 10-second undo toast is the safety net instead. So the number has to be
 * visible before the tap, and this component is where it is.
 *
 * At zero the row is **absent, not disabled** (§P3-10's edge cases). A greyed-out row teaches
 * nothing; a row that is not there says the same thing by saying nothing.
 *
 * ## Both bulk rows require the two-part gate
 *
 * `behaviour === 'collection' && capabilities.checkable`, exactly as the endpoints do
 * (criterion 18). Both halves: a `watch` list can carry a stored `checkable: true` a behaviour
 * change left behind, along with `checked` values that change retained, and offering to clear
 * them would act on state the renderer draws no checkbox for. The gate is read from the row's
 * own fields — nothing here compares a `templateKey`.
 */
export interface ListHeaderMenuProps {
  open: boolean;
  onClose: () => void;
  list: List;
  /** Checked items right now. The count the button states, and the reason it is offered. */
  checkedCount: number;
  /** Deletes them immediately; the caller shows the 10-second undo toast. */
  onClearChecked: () => void;
  /** Unchecks them immediately; same window, on a change that loses nothing. */
  onUncheckAll: () => void;
  /** `PATCH { archived: true }`; the caller shows the 6-second settings undo. */
  onArchive: () => void;
  /**
   * Opens `List settings` — the capabilities, the default slot and the behaviour (§5.5, §P3-32).
   *
   * **Not rename.** §5.6 puts renaming inline on the header title and §P3-32 forbids a second
   * home for it, so neither this menu nor the sheet it opens has a Rename row.
   */
  onOpenSettings: () => void;
}

/** The two-part gate, read from the row and not from its template (ADR-031). */
export function supportsCheckedActions(list: List): boolean {
  return list.behaviour === 'collection' && list.capabilities.checkable;
}

export function ListHeaderMenu({
  open,
  onClose,
  list,
  checkedCount,
  onClearChecked,
  onUncheckAll,
  onArchive,
  onOpenSettings,
}: ListHeaderMenuProps) {
  const theme = useTheme();
  const checkable = supportsCheckedActions(list);

  return (
    <Sheet open={open} onClose={onClose} title="More" testID="list-header-menu">
      <View style={{ gap: theme.space[4], alignItems: 'stretch' }}>
        {checkable && checkedCount > 0 ? (
          <Button
            variant="secondary"
            label={`Clear checked (${String(checkedCount)})`}
            onPress={onClearChecked}
            testID="list-clear-checked"
          />
        ) : null}
        {checkable ? (
          <Button
            variant="secondary"
            label="Uncheck all"
            onPress={onUncheckAll}
            testID="list-uncheck-all"
          />
        ) : null}
        {/*
         * Offered on every behaviour, unlike the two bulk rows above it: the slot and the
         * behaviour are settings a `watch` or `meals` list has as much as a collection, and
         * the sheet is what decides which of its own controls apply (§5.5).
         */}
        <Button
          variant="secondary"
          label="List settings"
          onPress={onOpenSettings}
          testID="list-settings-open"
        />
        <Button
          variant="secondary"
          label="Archive list"
          onPress={onArchive}
          testID="list-archive"
        />
        <Text color="textMuted">
          Archived lists keep their items and are reachable from Lists.
        </Text>
      </View>
    </Sheet>
  );
}
