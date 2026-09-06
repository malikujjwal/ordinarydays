import { Plus, Text, Touchable, useTheme } from '@od/ui';
import { View } from 'react-native';

/**
 * One left-aligned action-text row: the Plan-detail section affordances (`+ Add prep task`,
 * `+ Add list`, `Show all n`, `+ Write an update`, `Show earlier updates`) share a single
 * tap target so a spacing or colour change cannot fork them.
 */
export interface ActionRowProps {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  testID?: string;
  disabled?: boolean;
  /**
   * `body` is a create affordance (`+ Add prep task`); `subhead` is a disclosure
   * (`Show all n`, `Show earlier updates`) — the deliberate weight distinction between
   * making something and revealing what exists.
   */
  variant?: 'body' | 'subhead';
  icon?: 'plus';
}

export function ActionRow({
  label,
  accessibilityLabel,
  onPress,
  testID,
  disabled = false,
  variant = 'body',
  icon,
}: ActionRowProps) {
  const theme = useTheme();
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      disabled={disabled}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: theme.space[3],
        paddingVertical: theme.space[2],
      }}
      {...(testID === undefined ? {} : { testID })}
    >
      {icon === 'plus' ? <Plus size={20} color={theme.colors.textAction} /> : null}
      <View style={{ flexShrink: 1 }}>
        <Text variant={variant} color="textAction">
          {label}
        </Text>
      </View>
    </Touchable>
  );
}
