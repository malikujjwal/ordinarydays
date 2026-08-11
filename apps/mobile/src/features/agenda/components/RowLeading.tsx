import { Checkbox, useTheme } from '@od/ui';
import { View } from 'react-native';

export interface RowLeadingProps {
  hasCheckbox: boolean;
  checked: boolean;
  title: string;
  onChange?: (checked: boolean) => void;
}

/** The projection's `hasCheckbox` flag is the sole leading-control decision. */
export function RowLeading({ hasCheckbox, checked, title, onChange }: RowLeadingProps) {
  const theme = useTheme();

  if (hasCheckbox) {
    return (
      <Checkbox
        checked={checked}
        label={`${title}, ${checked ? 'completed' : 'not completed'}`}
        {...(onChange === undefined ? {} : { onChange })}
        testID="agenda-leading-checkbox"
      />
    );
  }

  return (
    <View
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="agenda-leading-marker"
      style={{
        width: theme.layout.hitTarget,
        minHeight: theme.layout.hitTarget,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <View
        style={{
          width: theme.space[3],
          height: theme.space[3],
          backgroundColor: theme.colors.borderStrong,
          transform: [{ rotate: '45deg' }],
        }}
      />
    </View>
  );
}
