import type { PlanType } from '@od/shared/types';
import {
  Bowl,
  Card,
  Diamond,
  type IconProps,
  IconTile,
  MapPin,
  PlayRect,
  Text,
  Touchable,
  useTheme,
} from '@od/ui';
import { memo } from 'react';
import { View } from 'react-native';
import { planKindLabel } from '@/lib/planKinds';
import type { NeedsDateRowData } from '../hooks/usePlans';
import { needsDateLine } from '../model/plansStages';
import { rsvpSummaryLine } from '../model/rsvpSummary';

/**
 * One needs-a-date event card (P3-36, `design-system.md` §7.3, `plans-and-lists.md` §1.3.1).
 *
 * ```
 *  [squircle]  Dinner at Zahav                     Event
 *              No date yet — 2 suggestions
 *              Just you
 * ```
 *
 * The rules a reviewer checks, each rendered here and asserted in the tests:
 *
 * - The leading tile is the type's non-interactive squircle — **never a checkbox**, for any
 *   of the four Plan kinds. Tasks cannot enter this stage at all.
 * - The trailing label is the Plan-kind word, de-emphasised. **No date chip** — there is no
 *   date; the date slot reads `No date yet`, with the suggestion count appended as content
 *   when one exists (§1.3.1's third line is content, never stage chrome).
 * - The RSVP summary is always rendered and never empty — `Just you` in this phase.
 * - The whole card is one tap target opening plan detail (U1). Nothing on it mutates.
 */
export interface NeedsDateCardProps {
  item: NeedsDateRowData;
  onOpen: (item: NeedsDateRowData) => void;
  testID?: string;
}

const KIND_ICONS: Record<PlanType, (props: IconProps) => React.ReactElement> = {
  custom: Diamond,
  meal: Bowl,
  watch: PlayRect,
  event: MapPin,
};

/** The needs-date stage holds Plans only; a stray type degrades to the General mark. */
function planKindOf(type: NeedsDateRowData['type']): PlanType {
  return type === 'meal' || type === 'watch' || type === 'event' ? type : 'custom';
}

/** Memoised: a `SectionList` row under an always-on minute ticker (§8.3's first row). */
export const NeedsDateCard = memo(function NeedsDateCard({
  item,
  onOpen,
  testID,
}: NeedsDateCardProps) {
  const theme = useTheme();
  const kind = planKindOf(item.type);
  const summary = rsvpSummaryLine(item.rsvpSummary);
  const dateLine = needsDateLine(item.suggestionCount);

  return (
    <Card padding={5} {...(testID === undefined ? {} : { testID })}>
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={[item.title, planKindLabel(kind), dateLine, summary].join(
          ', ',
        )}
        onPress={() => onOpen(item)}
        style={{ flexDirection: 'row', gap: theme.space[4], alignItems: 'flex-start' }}
        {...(testID === undefined ? {} : { testID: `${testID}-body` })}
      >
        <IconTile icon={KIND_ICONS[kind]} tint={kind} />
        <View style={{ flex: 1, minWidth: 0, gap: theme.space[1] }}>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              gap: theme.space[2],
              alignItems: 'baseline',
            }}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text variant="heading" color="textDisplay" numberOfLines={2}>
                {item.title}
              </Text>
            </View>
            <Text variant="footnote" color="textSecondary">
              {planKindLabel(kind)}
            </Text>
          </View>
          <Text variant="subhead" color="textSecondary">
            {dateLine}
          </Text>
          <Text variant="footnote" color="textSecondary">
            {summary}
          </Text>
        </View>
      </Touchable>
    </Card>
  );
});
