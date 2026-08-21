import type { AgendaItem } from '@od/shared/types';
import { formatWallTime, SectionHeader, Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import { agendaItemKey } from './AgendaSection';

/**
 * How many of tomorrow's rows the look-ahead shows.
 *
 * A preview that can run to twenty rows is a second Today, and Today is the screen this one is
 * meant to end. Three is enough to answer "is tomorrow busy?" — which is the whole question a
 * look-ahead exists to answer — without turning into a list you work from.
 */
export const TOMORROW_PREVIEW_LIMIT = 3;

export interface TomorrowPreviewProps {
  /** Tomorrow's dated rows, already in the server's order. */
  items: readonly AgendaItem[];
}

/**
 * A short **overview** of tomorrow at the foot of Today (P2-45, founder's 2026-08-12 ruling,
 * narrowed 2026-08-17).
 *
 * ```
 * TOMORROW
 * 7:30 PM   Dinner at Zahav
 * Anytime   Pick up dry cleaning
 * ```
 *
 * ## It is not interactive at all
 *
 * The first build shared `AgendaRow` so the preview would carry the timeline's marker and
 * connector, and made the rows tappable-to-open. The founder's ruling is narrower and better:
 * *"no need to open a task or anything, its just to show the stuff for tomorrow"*. So this is a
 * time-and-title list and nothing else — no marker, no checkbox, no connector, no subtitle, no
 * tap target.
 *
 * That is why it no longer uses `AgendaRow`. Sharing the row and then suppressing most of it is
 * how a `readOnly` flag ended up inside `RowLeading`, which forced an edit to the grep guard
 * that exists to stop the client deciding checkboxes for itself. Not rendering a row at all
 * removes the flag, the edit and the question — that guard is back to its original assertions.
 *
 * **Nothing here can mutate or navigate**: there is no callback prop through which either could
 * arrive, and no `Touchable` to fire one. The rows are plain text, read in order by a screen
 * reader and absent from the tab order.
 *
 * ## It is hidden entirely when tomorrow holds nothing
 *
 * No empty state and no heading. A look-ahead that says "nothing tomorrow" is a nag about an
 * empty day (`today-and-tasks.md` §8.3).
 *
 * ## It changes no aggregate
 *
 * The day count and the progress bar count Today alone; UP NEXT stays today's next timed item.
 */
export function TomorrowPreview({ items }: TomorrowPreviewProps) {
  const theme = useTheme();
  if (items.length === 0) return null;

  return (
    <View testID="today-tomorrow" style={{ gap: theme.space[2] }}>
      <SectionHeader title="Tomorrow" count={items.length} variant="sectionLabel" />
      {items.slice(0, TOMORROW_PREVIEW_LIMIT).map((item) => (
        <View
          /**
           * Keyed by `agendaItemKey`, not a hand-built string. ADR-053's guard is a ratchet — no
           * new file starts naming the wire key — and row identity is already answered once.
           */
          key={agendaItemKey(item)}
          style={{ flexDirection: 'row', gap: theme.space[4], alignItems: 'baseline' }}
        >
          {/**
           * `Anytime` for a dated-but-untimed row, borrowing Today's own section name rather
           * than inventing a second word for the same idea. The column holds the time rail's
           * width so the titles line up with one another.
           */}
          <View style={{ width: theme.space[11] }}>
            <Text variant="footnote" color="textSecondary" numberOfLines={1}>
              {item.time === undefined ? 'Anytime' : formatWallTime(item.time)}
            </Text>
          </View>
          {/**
           * Tomorrow is a quiet preview rather than today's working list. Keep the title at the
           * body size but regular weight; the time remains the quieter anchor beside it.
           */}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="body" color="textPrimary" numberOfLines={1}>
              {item.title}
            </Text>
          </View>
        </View>
      ))}

      {/**
       * `+n more` rather than the rest of the day. Tomorrow is a preview; the full day is the
       * Plans tab's job, which is why this states the remainder instead of offering to render it.
       */}
      {items.length <= TOMORROW_PREVIEW_LIMIT ? null : (
        <View style={{ paddingLeft: theme.space[11] + theme.space[4] }}>
          <Text variant="footnote" color="textMuted" testID="today-tomorrow-more">
            {`+${items.length - TOMORROW_PREVIEW_LIMIT} more`}
          </Text>
        </View>
      )}
    </View>
  );
}
