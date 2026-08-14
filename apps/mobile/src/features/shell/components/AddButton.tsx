import { eFloatingAction, Plus, Touchable, useTheme } from '@od/ui';
import { GLOBAL_ADD_SIZE } from '@/components/globalAddLayout';
import { ADD_LABEL } from '@/features/shell/model/tabs';

/**
 * The global `+` (`interaction-contract.md` §2, `activities.md` §2.1).
 *
 * 56 × 56, bottom-right, above the tab bar, with the accessible label `Add`.
 *
 * **It takes an `onPress` and nothing else.** No `defaultTarget`, no `type`, no "add a task
 * here" variant. The one thing this control is allowed to do is open the chooser, and the
 * absence of any other prop is what guarantees a tab cannot quietly hand it a preselected
 * form — which is exactly what P1-23's edge case warns about. Contextual adds
 * (`+ Add a task`, `+ Add an item`, `+ Add a prep task`) are *different* controls with their
 * own labels, not this one configured.
 */
export interface AddButtonProps {
  onPress: () => void;
  testID?: string;
}

export function AddButton({ onPress, testID = 'global-add' }: AddButtonProps) {
  const theme = useTheme();

  return (
    <Touchable
      square
      accessibilityRole="button"
      accessibilityLabel={ADD_LABEL}
      onPress={onPress}
      testID={testID}
      style={[
        {
          width: GLOBAL_ADD_SIZE,
          height: GLOBAL_ADD_SIZE,
          borderRadius: theme.radius.pill,
          // `accentControl`, the filled-control surface (P2-40 §5.1). The dark `accent` carries
          // an inverse glyph at 4.00:1; `accentControl` resolves per scheme and clears it.
          backgroundColor: theme.colors.accentControl,
          alignItems: 'center',
          justifyContent: 'center',
        },
        { boxShadow: eFloatingAction } as object,
      ]}
    >
      <Plus size={28} color={theme.colors.textInverse} />
    </Touchable>
  );
}
