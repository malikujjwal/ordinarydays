import type { ActivityType } from '@od/shared/types';
import { Checkbox, MARKER_SIZE, useTheme } from '@od/ui';
import { View } from 'react-native';
import { typeMarker } from '../model/typeMarker';

export interface RowLeadingProps {
  hasCheckbox: boolean;
  checked: boolean;
  title: string;
  /**
   * Chooses the **marker glyph and accent only** (`design-system.md` §5.2, P3-49). It never
   * chooses between checkbox and marker — that is `hasCheckbox`'s, and only `hasCheckbox`'s,
   * decision, because `hasCheckbox` is the server's projection and a client that derived the
   * control from the activity kind would be deciding checkboxes for itself.
   */
  type: ActivityType;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
}

/** The projection's `hasCheckbox` flag is the sole leading-control decision. */
export function RowLeading({
  hasCheckbox,
  checked,
  title,
  type,
  disabled = false,
  onChange,
}: RowLeadingProps) {
  const theme = useTheme();

  if (hasCheckbox) {
    return (
      <Checkbox
        checked={checked}
        label={`${title}, ${checked ? 'completed' : 'not completed'}`}
        disabled={disabled}
        {...(onChange === undefined ? {} : { onChange })}
        testID="agenda-leading-checkbox"
      />
    );
  }

  const marker = typeMarker(type);

  /**
   * Non-interactive and hidden from assistive technology: the marker keeps no hit target and
   * its meaning is already in the row's label (`interaction-contract.md` §6.2). It is drawn
   * from the marker forms at 16 pt in the kind's accent — a 1.9 viewBox stroke that renders
   * visibly lighter than the checkbox border on the adjacent row, so it does not begin to
   * read as a control (§5.2).
   */
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
      {marker === undefined ? null : (
        <View testID={`agenda-leading-marker-${marker.glyph}`}>
          <marker.Icon size={MARKER_SIZE} color={theme.typeAccent(type).accent} />
        </View>
      )}
    </View>
  );
}
