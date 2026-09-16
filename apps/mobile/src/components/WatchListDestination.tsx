import { SettingRow, Text, Touchable, useTheme } from '@od/ui';
import { View } from 'react-native';
import { CHOOSE_OR_CREATE, destinationLead } from '@/lib/destinationCopy';

/**
 * The Watch form's separate `Also add a list item to…` control (P3-43, `plans-and-lists.md`
 * §8.1): **off in every context**, and when turned on it resolves the `watch` slot and
 * always shows the named destination before a write. Nothing here writes; the form's save
 * button becomes `Save plan and add <title> to <list>` and carries both writes.
 *
 * With no destination chosen yet the row reads `Choose or create a list`; the picker it
 * opens offers `New list` constrained to the one `Watch Later` type, still unselected — the
 * constraint is this control's, not the title's. Turning the toggle on no longer forces the
 * picker open (Option B1 removes the one-time-question ceremony that did that): the row is
 * always tappable, and nothing is asked until the user taps it.
 */
export interface WatchListDestinationProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  /** The resolved list's title; nothing when nothing is chosen or capable yet. */
  destinationTitle: string | undefined;
  onChangeDestination: () => void;
  testID?: string;
}

export function WatchListDestination({
  enabled,
  onEnabledChange,
  destinationTitle,
  onChangeDestination,
  testID = 'watch-destination',
}: WatchListDestinationProps) {
  const theme = useTheme();
  const placeholder = CHOOSE_OR_CREATE;
  return (
    <View style={{ gap: theme.space[3] }} testID={testID}>
      <SettingRow
        label="Also add to…"
        summary={
          enabled
            ? (destinationTitle ?? placeholder)
            : 'Off — the plan is saved on its own'
        }
        switchValue={enabled}
        onPress={() => onEnabledChange(!enabled)}
        testID={`${testID}-toggle`}
      />
      {enabled ? (
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={
            destinationTitle === undefined
              ? placeholder
              : `${destinationLead('watch')} ${destinationTitle}. Change`
          }
          onPress={onChangeDestination}
          testID={`${testID}-list`}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              minHeight: theme.layout.hitTarget,
              paddingHorizontal: theme.space[4],
              borderRadius: theme.radius.md,
              backgroundColor: theme.colors.surfaceInput,
            }}
          >
            <Text variant="footnoteStrong" color="textSecondary">
              {destinationLead('watch')}
            </Text>
            <Text
              variant="body"
              color={destinationTitle === undefined ? 'textAction' : 'textPrimary'}
              testID={`${testID}-list-name`}
            >
              {destinationTitle ?? placeholder}
            </Text>
          </View>
        </Touchable>
      ) : null}
    </View>
  );
}
