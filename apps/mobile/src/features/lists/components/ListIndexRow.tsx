import type { Instant, TimeZone } from '@od/shared/time';
import type { List } from '@od/shared/types';
import { Card, IconTile, ProgressBar, Text, templateIcons, useTheme } from '@od/ui';
import { View } from 'react-native';
import {
  checkedProgress,
  countLine,
  listTint,
  showsCheckedCount,
} from '../model/listCard';
import { updatedLine } from '../model/updatedLine';

/**
 * One Lists-index card (`design-system.md` §7.2).
 *
 * ```
 *  ┌──────────────────────────┐  radius.lg · e2 · surfaceRaised
 *  │  [icon squircle 44]      │  IconTile, behaviour tint
 *  │  Groceries               │  heading
 *  │  12 items · 5 checked    │  subhead — the checked half only when checkable
 *  │  ────────                │  ProgressBar (neutral), same gate
 *  │  Updated today           │  footnote, from lastItemActivityAt
 *  └──────────────────────────┘
 * ```
 *
 * ## It renders the row, and never the catalogue
 *
 * `icon` is the string **stored on this list** at creation, looked up in `@od/ui`'s registry.
 * Nothing here reads `templateKey`, and nothing imports `LIST_TEMPLATES` — the same rule
 * P3-28's renderer follows, enforced by `check-forbidden.mjs` for the symbol and by this
 * feature's own grep test for the field. The failure it prevents is concrete: a template
 * edited after a list was created would silently change that list's card, and template values
 * are frozen at creation precisely so it cannot.
 *
 * A stored icon with no glyph falls back to `list` rather than rendering an empty square.
 * P3-46 closed the eleven-glyph gap and `templateIcons.test.ts` keeps the registry total, so
 * this branch should be unreachable — it exists because a blank tile is the kind of bug that
 * gets shrugged at instead of diagnosed, and a generic list marker is not.
 *
 * ## Nothing on the card mutates
 *
 * Tapping it opens the list (U1). There is no checkbox, no menu and no long-press: the index is
 * not reorderable (`interaction-contract.md` §3.2 — `ListIndex` stores no rank, ADR-042), and
 * the swipe actions belong to the wrapper, not to the card.
 */
export interface ListIndexRowProps {
  list: List;
  /** The clock, from the screen. Pure by rule — §4.3 keeps clock reads at the edge. */
  now: Instant;
  timezone: TimeZone;
  onPress: () => void;
  /** Archived rows render de-emphasised in their own group; the data is identical. */
  dimmed?: boolean;
  testID?: string;
}

export function ListIndexRow({
  list,
  now,
  timezone,
  onPress,
  dimmed = false,
  testID,
}: ListIndexRowProps) {
  const theme = useTheme();
  const glyph =
    templateIcons[list.icon as keyof typeof templateIcons] ?? templateIcons.list;
  const count = countLine(list);
  const progress = checkedProgress(list);
  // `lastItemActivityAt`, never `updatedAt`. The distinction is the whole of P3-47 and the
  // reason the field exists; `model/updatedLine.ts` records why using the other reads backwards.
  const updated = updatedLine(list.lastItemActivityAt, now, timezone);

  return (
    <Card
      elevation="e2"
      radius="lg"
      onPress={onPress}
      /**
       * One accessible element carrying the whole card, per `interaction-contract.md` §6: the
       * three lines are one thing to a screen reader, and three separate nodes would be three
       * stops that each say part of a sentence.
       */
      accessibilityLabel={`${list.title}. ${count}. ${updated}`}
      {...(testID === undefined ? {} : { testID })}
    >
      <View style={{ gap: theme.space[2], opacity: dimmed ? 0.6 : 1 }}>
        <IconTile icon={glyph} tint={listTint()} />
        <Text variant="heading" numberOfLines={2}>
          {list.title}
        </Text>
        <Text variant="subhead" color="textSecondary">
          {count}
        </Text>
        {progress === undefined ? null : (
          <ProgressBar
            value={progress}
            tone="neutral"
            label={count}
            {...(testID === undefined ? {} : { testID: `${testID}-progress` })}
          />
        )}
        <Text variant="footnote" color="textDisabled">
          {updated}
        </Text>
      </View>
    </Card>
  );
}

/** Re-exported so a screen can gate the same way without reaching into the model directly. */
export { showsCheckedCount };
