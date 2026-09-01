import { Text, Touchable, useTheme } from '@od/ui';

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
}

export function ActionRow({
  label,
  accessibilityLabel,
  onPress,
  testID,
  disabled = false,
}: ActionRowProps) {
  const theme = useTheme();
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      disabled={disabled}
      style={{ alignItems: 'flex-start', paddingVertical: theme.space[2] }}
      {...(testID === undefined ? {} : { testID })}
    >
      <Text variant="body" color="textAction">
        {label}
      </Text>
    </Touchable>
  );
}
