import { View } from 'react-native';
import { Check, ChevronRight } from '../icons/index';
import { useTheme } from '../theme/index';
import { Text } from './Text';
import { Touchable } from './Touchable';

/**
 * The utility row: a control in a list (`design-system.md` §6, §7.5).
 *
 * ## Two row families, and why this is the second one
 *
 * `Row` is for **content** — something the user made. Its title is the largest, darkest thing on
 * it, because "content is the interface". `SettingRow` is for a **control**: `Reminder`,
 * `Repeat`, `Notes`, a date option in a sheet. Its label is not content, so it steps down to
 * `subhead` and the loud thing becomes the action on the right.
 *
 * That distinction is the only one worth having. Before this component there were six
 * hand-rolled rows across the app — each with its own padding, minimum height, divider side and
 * trailing treatment — because the shared `Row` fitted content and nothing fitted controls, so
 * every screen invented one. Fixing any of them fixed exactly one screen.
 *
 * ## One floor, whatever the row holds
 *
 * `layout.settingRowMinHeight` — 72, against the content row's 56. Two families, two deliberate
 * densities. At 56 a settings group's rhythm would be set by content length, with `Repeat` alone
 * beside `Notes`-plus-summary; at 72 both read as the same family.
 *
 * **A minimum, never a fixed height.** Longer content and larger text make the row taller, and
 * nothing is ever clipped to hold the measure.
 *
 * ## Where the secondary text goes
 *
 * `summary` sits **below** the label and is the row's current content, clamped to one line — a
 * collapsed row summarises, it never renders the value. `value` sits **right** of the label and
 * is the setting's current state. They are mutually exclusive; a row is one shape or the other.
 *
 * ## The selected tint
 *
 * Added 2026-08-16 (P2-43). A selected row carries an `accentSurface` fill **and** the check —
 * two carriers, because colour is never the only one. It is here rather than in the three
 * screens that pick one of a set, so a menu in the Add flow and a menu in the reschedule sheet
 * cannot disagree about what "chosen" looks like.
 *
 * On that fill the secondary ink moves to `textPrimary`: light `textSecondary` measures 4.45:1
 * against `accentSurface` and misses the gate, which `design-system.md` §0 states as the rule
 * and `contrast.test.ts` pins.
 */
export interface SettingRowProps {
  label: string;
  /** Below the label: this capability's current content, clamped to one line. */
  summary?: string;
  /** Right of the label: this setting's current state. */
  value?: string;
  /** Trailing text in place of a symbol — `Coming later` on an unbuilt capability. */
  note?: string;
  /**
   * **Undefined means "not a choice at all"** — a navigation row is neither selected nor
   * unselected, and saying so in ARIA is what made axe reject the screen. `true`/`false` mark a
   * row that participates in a choice, and only those carry state to assistive technology.
   */
  selected?: boolean;
  /**
   * `checkbox` when the row **toggles** — a reminder offset, which can be on or off
   * independently of its neighbours. `button` is right for navigating and for picking one of a
   * set, where `aria-selected` carries the state. The role is the difference between "this is
   * on" and "this is the one", and only the caller knows which it means.
   */
  role?: 'button' | 'checkbox';
  /**
   * **The row opens something** — a sheet, a screen, or itself. Only then does it get a
   * chevron.
   *
   * Opt-in, and deliberately so. Tied to "is this interactive", every selectable row grew one:
   * the reschedule sheet's `Today` committed a date and closed, while promising navigation that
   * never happened. §0's affordance rule makes that a bug rather than a preference, so a row
   * that *acts* — commits a choice, performs the action its label names — renders nothing, and
   * its label carries the meaning.
   */
  opens?: boolean;
  /** Rotates the chevron and exposes the state; for a row that opens in place. */
  expanded?: boolean;
  /**
   * Absent makes the row **inert** — not a control at all, read-only, no target, no chevron.
   * That is a different thing from `disabled`, which is a control the user cannot use *right
   * now* and which stays in the accessibility tree saying so. `Coming later` is inert; a
   * reminder offset past the three-per-activity limit is disabled.
   */
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}

export function SettingRow({
  label,
  summary,
  value,
  note,
  selected,
  role = 'button',
  opens = false,
  disabled = false,
  expanded,
  onPress,
  accessibilityLabel,
  testID,
}: SettingRowProps) {
  const theme = useTheme();
  const interactive = onPress !== undefined;
  /** The chosen row of a set. Its ink answers to `accentSurface`, not to `surface`. */
  const tinted = selected === true;

  const content = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        // The ≥ 8 pt rule between adjacent targets, applied here so no caller has to.
        gap: theme.space[4],
        paddingVertical: theme.space[5],
        // Full-bleed, so the tint is the row rather than a badge sitting inside one.
        ...(tinted ? { backgroundColor: theme.colors.accentSurface } : {}),
        // One measure for every utility row, inert ones included — a list that changed height
        // depending on which rows happened to be controls would be the same defect again.
        minHeight: theme.layout.settingRowMinHeight,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <View style={{ flex: 1, gap: theme.space[1] }}>
        <Text variant="subhead" color={interactive ? 'textPrimary' : 'textSecondary'}>
          {label}
        </Text>
        {summary === undefined ? null : (
          <Text
            variant="footnote"
            color={tinted ? 'textPrimary' : interactive ? 'textSecondary' : 'textMuted'}
            numberOfLines={1}
          >
            {summary}
          </Text>
        )}
      </View>

      {/**
       * **The value is state, not an action — `textSecondary` in both schemes.** In
       * `textAction` it resolved plum in light and near-white in dark, so the two themes
       * disagreed about which part of the row was the loud one. The value communicates state;
       * the chevron communicates navigation. That reads the same at any time of day.
       *
       * This is a rule about *this* row on `surface`/`surfaceRaised`, not a universal one:
       * semantic role first, contrast gate second, token third. On light `accentSurface`,
       * `textSecondary` is 4.45:1 and the correct token there is `textPrimary`.
       */}
      {value === undefined ? null : (
        <Text variant="subhead" color={tinted ? 'textPrimary' : 'textSecondary'}>
          {value}
        </Text>
      )}
      {note === undefined ? null : (
        <Text variant="footnote" color="textMuted">
          {note}
        </Text>
      )}

      {/**
       * **`accentControl`, and only on the symbol.** The frames colour their trailing actions
       * `#AD748C` — our dark `accentDeep`, 4.43:1 on `surfaceRaised` and under the 4.5 gate
       * P2-40 holds text to. A symbol is non-text UI and answers to 3:1, which `accentControl`
       * clears in both schemes on both surfaces. So the accent lands where the frames put it
       * without placing sub-AA ink on a word.
       */}
      {/**
       * The trailing slot answers **what will happen**, never "is this tappable":
       * check → this is the selected/on one; chevron → this opens something; nothing → the
       * label already said it. An unchecked toggle and a committing choice both render nothing.
       */}
      {selected === true ? (
        <View aria-hidden>
          <Check size={20} color={theme.colors.accentControl} />
        </View>
      ) : opens && interactive && note === undefined && role !== 'checkbox' ? (
        <View
          aria-hidden
          style={
            expanded === undefined
              ? undefined
              : { transform: [{ rotate: expanded ? '90deg' : '0deg' }] }
          }
        >
          <ChevronRight size={20} color={theme.colors.accentControl} />
        </View>
      ) : null}
    </View>
  );

  /** Bottom rules, so a list closes on its last row rather than needing one on its container. */
  const divider = {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  } as const;

  if (!interactive) {
    return (
      <View
        style={divider}
        accessibilityLabel={accessibilityLabel ?? spoken(label, summary, value, note)}
        testID={testID}
      >
        {content}
      </View>
    );
  }

  return (
    <Touchable
      square={false}
      accessibilityRole={role}
      accessibilityLabel={accessibilityLabel ?? spoken(label, summary, value, note)}
      /**
       * `selected` is deliberately **not** put in `accessibilityState` for a button: React
       * Native Web maps it straight to `aria-selected`, which ARIA does not allow there and axe
       * rejects as critical. The button's state travels as `aria-pressed` below; only a checkbox
       * has a state slot here.
       */
      accessibilityState={{
        ...(role === 'checkbox' && selected !== undefined ? { checked: selected } : {}),
        disabled,
        ...(expanded === undefined ? {} : { expanded }),
      }}
      /**
       * **`aria-pressed`, not `aria-selected`.** ARIA does not allow `aria-selected` on
       * `button` — axe rejects it as critical, and it was being emitted on every row including
       * plain navigation ones. `aria-pressed` is valid on a button and is the right meaning for
       * "this is the chosen one of the set". A checkbox reports `checked` through
       * `accessibilityState`, which React Native Web does map for that role.
       */
      {...(role === 'checkbox' || selected === undefined
        ? {}
        : { 'aria-pressed': selected })}
      {...(expanded === undefined ? {} : { 'aria-expanded': expanded })}
      disabled={disabled}
      onPress={onPress}
      style={divider}
      testID={testID}
    >
      {content}
    </Touchable>
  );
}

/** One spoken name from whichever slots the row is using. */
function spoken(
  label: string,
  summary: string | undefined,
  value: string | undefined,
  note: string | undefined,
): string {
  return [label, summary, value, note].filter(Boolean).join(', ');
}
