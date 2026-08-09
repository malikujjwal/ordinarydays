import type { IconProps } from '../icons/index';
import { useTheme } from '../theme/index';
import { Touchable } from './Touchable';

/**
 * An icon-only control (`design-system.md` §6).
 *
 * **`label` is required and is the accessible name.** An icon-only button with no label is
 * invisible to a screen reader, and making the prop optional is how that ships. Always
 * 44 × 44, and the icon does **not** scale with dynamic type — an icon-only control keeps a
 * fixed target (`interaction-contract.md` §6.3).
 */
export interface IconButtonProps {
  icon: (props: IconProps) => React.ReactElement;
  /** Required — this is the accessible name, not a tooltip. */
  label: string;
  onPress?: () => void;
  variant?: 'ghost' | 'filled';
  disabled?: boolean;
  testID?: string;
}

export function IconButton({
  icon: Icon,
  label,
  onPress,
  variant = 'ghost',
  disabled = false,
  testID,
}: IconButtonProps) {
  const theme = useTheme();

  return (
    <Touchable
      square
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={{
        width: theme.layout.hitTarget,
        height: theme.layout.hitTarget,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: theme.radius.pill,
        backgroundColor:
          variant === 'filled' ? theme.colors.surfaceSunken : 'transparent',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Icon
        size={24}
        color={disabled ? theme.colors.textDisabled : theme.colors.textPrimary}
      />
    </Touchable>
  );
}
