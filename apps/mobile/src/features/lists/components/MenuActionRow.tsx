import { Check, ChevronRight, type IconProps, Text, Touchable, useTheme } from '@od/ui';
import type { ComponentType } from 'react';
import { View } from 'react-native';

export interface MenuActionRowProps {
  label: string;
  summary?: string;
  icon: ComponentType<IconProps>;
  onPress: () => void;
  opens?: boolean;
  danger?: boolean;
  separated?: boolean;
  checked?: boolean;
  disabled?: boolean;
  testID?: string;
}

/** The shared compact action grammar for List overflow surfaces and nested item actions. */
export function MenuActionRow({
  label,
  summary,
  icon: Icon,
  onPress,
  opens = false,
  danger = false,
  separated = false,
  checked,
  disabled = false,
  testID,
}: MenuActionRowProps) {
  const theme = useTheme();
  const role = checked === undefined ? 'button' : 'checkbox';
  const ink = danger ? theme.colors.danger : theme.colors.textSecondary;
  const spoken = summary === undefined ? label : `${label}, ${summary}`;

  return (
    <Touchable
      square={false}
      accessibilityRole={role}
      accessibilityLabel={spoken}
      {...(checked === undefined ? {} : { accessibilityState: { checked, disabled } })}
      {...(checked === undefined ? {} : { 'aria-checked': checked })}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={{
        width: '100%',
        minHeight: theme.layout.rowMinHeight,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space[3],
        paddingVertical: theme.space[2],
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        backgroundColor: 'transparent',
        opacity: disabled ? 0.45 : 1,
        ...(separated
          ? {
              marginTop: theme.space[3],
              borderTopWidth: 1,
              borderTopColor: theme.colors.border,
            }
          : {}),
      }}
    >
      <View aria-hidden style={{ width: 24, alignItems: 'center' }}>
        <Icon size={20} color={ink} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: theme.space[1] }}>
        <Text variant="subhead" color={danger ? 'danger' : 'textPrimary'}>
          {label}
        </Text>
        {summary === undefined ? null : (
          <Text variant="footnote" color="textSecondary">
            {summary}
          </Text>
        )}
      </View>
      {checked === true ? (
        <View aria-hidden>
          <Check size={20} color={theme.colors.accentControl} />
        </View>
      ) : opens ? (
        <View aria-hidden>
          <ChevronRight size={20} color={theme.colors.accentControl} />
        </View>
      ) : null}
    </Touchable>
  );
}
