import { SettingRow, Text, Touchable, useTheme } from '@od/ui';
import { View } from 'react-native';
import { CHOOSE_A_LIST, CHOOSE_OR_CREATE, destinationLead } from '@/lib/destinationCopy';

/**
 * The Watch form's separate `Also add a list item to…` control (P3-43, `plans-and-lists.md`
 * §8.1): **off in every context**, and when turned on it resolves the `watch` slot and
 * always shows the named destination before a write. Nothing here writes; the form's save
 * button becomes `Save plan and add <title> to <list>` and carries both writes.
 *
 * With no eligible destination the row reads `Choose or create a list`; the picker it opens
 * offers `New list` constrained to the one `Watch Later` type, still unselected — the
 * constraint is this control's, not the title's.
 */
export interface WatchListDestinationProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  /** The resolved list's title; nothing when no list holds the slot. */
  destinationTitle: string | undefined;
  destinationState?: 'use' | 'ask' | 'none' | undefined;
  onChangeDestination: () => void;
  testID?: string;
}

export function WatchListDestination({
  enabled,
  onEnabledChange,
  destinationTitle,
  destinationState,
  onChangeDestination,
  testID = 'watch-destination',
}: WatchListDestinationProps) {
  const theme = useTheme();
  const placeholder = destinationState === 'ask' ? CHOOSE_A_LIST : CHOOSE_OR_CREATE;
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
        onPress={() => {
          onEnabledChange(!enabled);
          // The one-time question is due the moment the toggle makes a destination needed.
          if (!enabled && destinationState === 'ask') onChangeDestination();
        }}
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
