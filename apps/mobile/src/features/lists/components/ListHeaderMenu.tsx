import type { List } from '@od/shared/types';
import { Archive, Check, CheckSquare, ListLines, SettingRow, Sheet, Trash } from '@od/ui';
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
 * seven times". The six-second undo toast is the safety net instead. So the number has to be
 * visible before the tap, and this component is where it is.
 *
 * At zero the row is **absent, not disabled** (§P3-10's edge cases). A greyed-out row teaches
 * nothing; a row that is not there says the same thing by saying nothing.
 *
 * ## Both bulk rows require checkbox presentation
 *
 * Intrinsic `done` is rendered as checked only while `itemStateMode.mode === 'checkbox'`.
 * A different mode retains the state but removes checkbox-derived actions. Nothing here
 * compares a `templateKey`.
 */
export interface ListHeaderMenuProps {
  open: boolean;
  onClose: () => void;
  onClosed?: () => void;
  list: List;
  /** Checked items right now. The count the button states, and the reason it is offered. */
  checkedCount: number;
  /** Deletes the current done set immediately under the bulk Undo token. */
  onClearDone: () => void;
  /** Unchecks them immediately; same window, on a change that loses nothing. */
  onUncheckAll: () => void;
  /** `PATCH { archived: true }`; the caller shows the 6-second settings undo. */
  onArchive: () => void;
  /** Opens the owner-only destructive confirmation; the menu never deletes directly. */
  onDelete: () => void;
  /**
   * Opens `List settings` — state presentation, features and the default slot (§5.5, §P3-33).
   *
   * **Not rename.** §5.6 puts renaming inline on the header title and §P3-32 forbids a second
   * home for it, so neither this menu nor the sheet it opens has a Rename row.
   */
  onOpenSettings: () => void;
}

/** The presentation gate, read from the List and not its creation preset (ADR-058). */
export function supportsCheckedActions(list: List): boolean {
  return list.itemStateMode.mode === 'checkbox';
}

export function ListHeaderMenu({
  open,
  onClose,
  onClosed,
  list,
  checkedCount,
  onClearDone,
  onUncheckAll,
  onArchive,
  onDelete,
  onOpenSettings,
}: ListHeaderMenuProps) {
  const checkable = supportsCheckedActions(list);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      {...(onClosed === undefined ? {} : { onClosed })}
      title="More"
      testID="list-header-menu"
    >
      <View>
        <SettingRow
          label="List settings"
          summary="State, item details and planning"
          icon={ListLines}
          density="compact"
          opens
          onPress={onOpenSettings}
          testID="list-settings-open"
        />
        {checkable && checkedCount > 0 ? (
          <>
            <SettingRow
              label={`Clear checked (${String(checkedCount)})`}
              icon={Check}
              density="compact"
              onPress={onClearDone}
              testID="list-clear-checked"
            />
            <SettingRow
              label={`Uncheck all (${String(checkedCount)})`}
              icon={CheckSquare}
              density="compact"
              onPress={onUncheckAll}
              testID="list-uncheck-all"
            />
          </>
        ) : null}
        <SettingRow
          label="Archive list"
          icon={Archive}
          density="compact"
          onPress={onArchive}
          testID="list-archive"
        />
        <SettingRow
          label="Delete list"
          icon={Trash}
          density="compact"
          danger
          separated
          onPress={onDelete}
          testID="list-delete"
        />
      </View>
    </Sheet>
  );
}
