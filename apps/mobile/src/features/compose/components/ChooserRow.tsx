import { ChevronRight, Row, useTheme } from '@od/ui';
import { View } from 'react-native';

/**
 * One row of a chooser.
 *
 * A thin wrapper over `@od/ui`'s `Row`, and the reason it exists is what it cannot express:
 * **there is no `selected` prop to pass.** A component that could render a selected chooser row
 * is a component that could pre-select one, and the rule the choosers exist to enforce is that
 * nothing is selected until the user taps (`interaction-contract.md` §1a.3).
 *
 * It carries no selection state to assistive technology either, and that is deliberate rather
 * than an omission: a chooser row **navigates** to the next step, and a navigation row is
 * neither selected nor unselected. Saying otherwise in ARIA is what `SettingRow` documents as
 * an axe-`critical` violation, and `aria-pressed="false"` on a row that is not a toggle would
 * be the same mistake in the opposite direction.
 *
 * The chevron is decorative — the row's label is its accessible name — so it is hidden from
 * assistive technology rather than read as "chevron right". It is also the only trailing mark
 * a chooser row ever carries: no check can appear on one, because none is ever chosen here.
 */
export interface ChooserRowProps {
  label: string;
  /**
   * One line saying what the choice is for (founder, 2026-08-16).
   *
   * It is rendered **and spoken, inside the accessible name** — `Task, Something you need to
   * do` — which is §6.2's own comma-joined grammar for every other row in the product.
   *
   * `accessibilityHint` was tried first and is the textbook answer, but React Native Web drops
   * it, and an explicit `accessibilityLabel` also suppresses the rendered subtitle from the
   * name. The result was a sentence that only iOS users heard. A subtitle the founder added so
   * "the user can tell what the option is for" cannot be one that half the users never get.
   */
  subtitle: string;
  onPress: () => void;
  testID?: string;
}

export function ChooserRow({ label, subtitle, onPress, testID }: ChooserRowProps) {
  const theme = useTheme();

  return (
    <Row
      title={label}
      subtitle={subtitle}
      subtitleTone="explanatory"
      accessibilityLabel={`${label}, ${subtitle}`}
      onPress={onPress}
      {...(testID === undefined ? {} : { testID })}
      trailing={
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <ChevronRight size={20} color={theme.colors.textSecondary} />
        </View>
      }
    />
  );
}
