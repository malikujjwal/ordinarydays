import { Button, SectionHeader, Text, useTheme } from '@od/ui';
import { View } from 'react-native';

/**
 * A section whose capability arrives in a later phase (P1-26).
 *
 * > Render the sections from `plans-and-lists.md` §2.1 that exist in this phase — header,
 * > when/where, notes — with the rest present as their empty-state affordances **so the
 * > plan's capabilities stay discoverable**.
 *
 * The heading and a disabled `Add …` button, with one line saying why. It is deliberately not
 * hidden: a plan that shows PEOPLE and PREP is a plan whose shape the user can learn now,
 * and the layout does not rearrange itself when the phase that fills it lands.
 *
 * Only Plans get these. A Task renders no placeholder for anything it lacks
 * (`today-and-tasks.md` §5.6) — see `../model/sections.ts`.
 */
export interface ComingSoonSectionProps {
  heading: string;
  action: string;
  note: string;
  testID?: string;
}

export function ComingSoonSection({
  heading,
  action,
  note,
  testID,
}: ComingSoonSectionProps) {
  const theme = useTheme();

  return (
    <View style={{ gap: theme.space[3] }} testID={testID}>
      <SectionHeader title={heading} />
      <View style={{ gap: theme.space[3], alignItems: 'flex-start' }}>
        <Button label={action} variant="secondary" disabled />
        {/**
         * The reason sits outside the button rather than replacing its label, so the
         * affordance still reads as the thing it will become. `accessibilityState.disabled`
         * on the button already announces the state; this says why.
         */}
        <Text variant="footnote" color="textSecondary">
          {note}
        </Text>
      </View>
    </View>
  );
}
