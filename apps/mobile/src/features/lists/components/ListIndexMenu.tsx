import { Archive, Sheet } from '@od/ui';
import { View } from 'react-native';
import { MenuActionRow } from './MenuActionRow';

/**
 * The Lists **index** header's `⋯` (`plans-and-lists.md` §5.6 — "reachable through
 * `Lists → ⋯ → Show archived`").
 *
 * ## Why this is not `ListHeaderMenu`
 *
 * That component is the **list detail** header's menu: it takes one `List` and offers
 * `Clear checked (n)`, `Uncheck all` and `Archive list`, all of which act on the list you are
 * inside. The index has no such list, and its menu holds exactly one thing — the archived
 * filter. Making one component serve both would mean a `list?: List` prop and three conditional
 * rows, which is two menus wearing one name.
 *
 * Presentational, on the same terms as `ListHeaderMenu`: props in, callbacks out, no hooks and
 * no data wiring.
 *
 * ## One toggle, stated as its current effect
 *
 * The label says what tapping it will do, not what state it is in — `Show archived` when they
 * are hidden, `Hide archived` when they are shown. A row labelled with the state leaves the
 * reader to work out whether it is a description or a button.
 */
export interface ListIndexMenuProps {
  open: boolean;
  onClose: () => void;
  /** Whether archived lists are currently included in the index. */
  showingArchived: boolean;
  onToggleArchived: () => void;
  /** How many archived lists have been materialized, for the row's count. */
  archivedCount: number;
}

export function ListIndexMenu({
  open,
  onClose,
  showingArchived,
  onToggleArchived,
  archivedCount,
}: ListIndexMenuProps) {
  const summary =
    archivedCount === 0
      ? 'Archived lists keep their items and can be restored.'
      : `${String(archivedCount)} archived ${
          archivedCount === 1 ? 'list' : 'lists'
        }. They keep their items and can be restored.`;

  return (
    <Sheet open={open} onClose={onClose} title="More" testID="list-index-menu">
      <View>
        <MenuActionRow
          label={showingArchived ? 'Hide archived' : 'Show archived'}
          summary={summary}
          icon={Archive}
          checked={showingArchived}
          onPress={onToggleArchived}
          testID="lists-toggle-archived"
        />
      </View>
    </Sheet>
  );
}
