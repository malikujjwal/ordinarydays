import { Row } from '@od/ui';
import type { ListItemRow } from '@/lib/sqlite/listItemsRepository';

/**
 * **A placeholder row, and deliberately the dumbest thing that renders an item** (P3-27).
 *
 * P3-28 replaces this file with `ListItemRow.tsx`: one capability-driven component for every
 * list in the product, reading `behaviour` and `capabilities` to decide on a checkbox, a
 * location subtitle, `S2 E4`, an ingredient count and a caller-scoped state line.
 *
 * ## What it must not grow before then
 *
 * No checkbox, no `behaviour` branch, no capability read, no provenance line, and above all no
 * `templateKey` — the feature's grep test covers this file too. Every one of those is a
 * decision P3-28 owns, and a half-version here would be a second renderer to reconcile rather
 * than a component to replace. It takes the item and draws its title; the list it belongs to is
 * not even a prop, because nothing here may consult it.
 *
 * The tap target is here, though, and it is `U1`: **tapping a row opens detail and mutates
 * nothing** (`CLAUDE.md` rule 6). P3-29 gives `onPress` the item sheet; until then the screen
 * passes nothing and the row is inert rather than pretending to open something.
 */
export interface ListItemTitleRowProps {
  item: ListItemRow;
  /** P3-29's item sheet. Absent until then, which leaves the row genuinely non-interactive. */
  onPress?: () => void;
  testID?: string;
}

export function ListItemTitleRow({ item, onPress, testID }: ListItemTitleRowProps) {
  return (
    <Row
      title={item.title}
      {...(item.note === undefined ? {} : { subtitle: item.note })}
      {...(onPress === undefined ? {} : { onPress })}
      {...(testID === undefined ? {} : { testID })}
    />
  );
}
