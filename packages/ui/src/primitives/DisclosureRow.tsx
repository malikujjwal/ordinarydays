import { type ReactNode, useState } from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme/index';
import { SettingRow } from './SettingRow';

export interface DisclosureRowProps {
  label: string;
  /**
   * The current content, one line, while shut.
   *
   * Optional, because a group whose content is a set of empty fields has no current content to
   * summarise — `Reservation` on a blank Event form summarises nothing, and inventing a line
   * of copy for it would be describing the form rather than reporting it.
   */
  summary?: string;
  children: ReactNode;
  testID: string;
}

/**
 * A `SettingRow` that opens in place.
 *
 * The distinction from a plain `SettingRow` is behavioural, not visual: this one reveals its
 * content **inline**, so the chevron rotates and the row reports `expanded` to assistive
 * technology. A setting whose choices open in a sheet is a `SettingRow` and stays shut.
 *
 * Which of the two a capability gets is a real decision. A short, bounded set of choices belongs
 * in a sheet — expanded in place, the reminder offsets pushed every row beneath them down the
 * screen. Free content the user is editing belongs here, where it opens under its own label.
 */
export function DisclosureRow({ label, summary, children, testID }: DisclosureRowProps) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);

  return (
    <View>
      <SettingRow
        label={label}
        {...(summary === undefined ? {} : { summary })}
        opens
        expanded={expanded}
        onPress={() => setExpanded((current) => !current)}
        testID={testID}
      />
      {expanded ? (
        <View
          /**
           * **The content is padded top and bottom.** Without the top pad the first revealed
           * row's own hairline sat almost on top of the disclosure row's, reading as a doubled
           * rule rather than as a group opening — reported on the built Add form, 2026-08-16.
           */
          style={{
            gap: theme.space[4],
            paddingTop: theme.space[5],
            paddingBottom: theme.space[6],
          }}
          testID={`${testID}-content`}
        >
          {children}
        </View>
      ) : null}
    </View>
  );
}
