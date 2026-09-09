import type { ComponentType } from 'react';
import { useEffect, useRef } from 'react';
import { Animated, View } from 'react-native';
import { Check, ChevronRight, type IconProps } from '../icons/index';
import { useMotion, useTheme } from '../theme/index';
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
interface SettingRowBaseProps {
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
  /** Renders the shared token-owned switch and gives the row `switch` semantics. */
  switchValue?: boolean;
  /**
   * `checkbox` when the row **toggles** — a reminder offset, which can be on or off
   * independently of its neighbours. `button` is right for navigating and for picking one of a
   * set, where `aria-selected` carries the state. The role is the difference between "this is
   * on" and "this is the one", and only the caller knows which it means.
   */
  role?: 'button' | 'checkbox' | 'switch';
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
  /** Transient action menus use the content-row floor without creating another row family. */
  density?: 'standard' | 'compact';
  /** Destructive action ink; never a filled row. */
  danger?: boolean;
  /** Token separation before a consequential action such as Delete or Remove. */
  separated?: boolean;
  /**
   * Absent makes the row **inert** — not a control at all, read-only, no target, no chevron.
   * That is a different thing from `disabled`, which is a control the user cannot use *right
   * now* and which stays in the accessibility tree saying so. `Coming later` is inert; a
   * reminder offset past the three-per-activity limit is disabled.
   */
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  /** Extra spoken consequence/context that must not change the control's short name. */
  accessibilityHint?: string;
  testID?: string;
}

type SettingRowIconProps =
  | {
      /** Omitting the icon also omits its presentation; a tone alone has no visible meaning. */
      icon?: undefined;
      iconTone?: never;
    }
  | {
      /** Recognition aid for compact action-menu rows; the label remains the accessible name. */
      icon: ComponentType<IconProps>;
      /** Optional semantic soft tile for detail controls; callers never choose raw icon colours. */
      iconTone?: 'neutral' | 'success' | 'danger';
    };

export type SettingRowProps = SettingRowBaseProps & SettingRowIconProps;

export function SettingRow({
  label,
  summary,
  value,
  note,
  selected,
  switchValue,
  role = 'button',
  opens = false,
  disabled = false,
  expanded,
  icon: Icon,
  iconTone,
  density = 'standard',
  danger = false,
  separated = false,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: SettingRowProps) {
  const theme = useTheme();
  const interactive = onPress !== undefined;
  /** The chosen row of a set. Its ink answers to `accentSurface`, not to `surface`. */
  const tinted = selected === true && switchValue === undefined;
  const effectiveRole = switchValue === undefined ? role : 'switch';
  const compact = density === 'compact';
  const rowMinHeight = compact
    ? theme.layout.rowMinHeight
    : theme.layout.settingRowMinHeight;
  const iconColor =
    iconTone === 'success'
      ? theme.colors.success
      : iconTone === 'danger' || danger
        ? theme.colors.danger
        : theme.colors.textSecondary;
  const iconSurface =
    iconTone === 'success'
      ? theme.colors.successSurface
      : iconTone === 'danger'
        ? theme.colors.accentSurface
        : theme.colors.surfaceSunken;

  const content = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        // The ≥ 8 pt rule between adjacent targets, applied here so no caller has to.
        gap: theme.space[4],
        paddingVertical: compact ? theme.space[2] : theme.space[5],
        // Full-bleed, so the tint is the row rather than a badge sitting inside one.
        ...(tinted ? { backgroundColor: theme.colors.accentSurface } : {}),
        // One measure for every utility row, inert ones included — a list that changed height
        // depending on which rows happened to be controls would be the same defect again.
        minHeight: rowMinHeight,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {Icon === undefined ? null : (
        <View
          aria-hidden
          testID={testID === undefined ? undefined : `${testID}-icon`}
          style={
            iconTone === undefined
              ? { width: 24, alignItems: 'center' }
              : {
                  width: 36,
                  height: 36,
                  flexShrink: 0,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: theme.radius.md,
                  backgroundColor: iconSurface,
                }
          }
        >
          <Icon size={20} color={iconColor} />
        </View>
      )}
      <View style={{ flex: 1, gap: theme.space[1] }}>
        <Text
          variant="subhead"
          color={danger ? 'danger' : interactive ? 'textPrimary' : 'textSecondary'}
        >
          {label}
        </Text>
        {summary === undefined ? null : (
          <Text
            variant="footnote"
            color={tinted ? 'textPrimary' : interactive ? 'textSecondary' : 'textMuted'}
            numberOfLines={compact ? undefined : 1}
          >
            {summary}
          </Text>
        )}
      </View>

      {/**
       * **The value takes `textAction` when the row opens, and `textSecondary` when it does
       * not** — amended 2026-08-16 (P2-43, founder: *"would having the choices on the right in
       * a different colour be more readable?"*).
       *
       * The earlier rule was `textSecondary` unconditionally, on the reasoning that a value
       * reports state while the chevron reports navigation, and that `textAction` "resolved
       * plum in light and near-white in dark, so the two themes disagreed about which part of
       * the row was the loud one". **That second half is now false**: P2-43 gave dark
       * `textAction` a readable mulberry, so the token means the same thing in both schemes and
       * the objection it rested on is gone.
       *
       * What survives is the distinction, and `opens` is exactly it (§0's affordance table:
       * accent text means an action). A row that opens something is offering to change the
       * value beside it, so the value is part of the affordance and is inked as one. A row that
       * *commits* — the reschedule sheet's date rows — renders no chevron and no accent, and its
       * value stays the state report it is. That is also what keeps this safe on an overlay:
       * dark `textAction` clears 4.5:1 on every surface, asserted in `contrast.test.ts`.
       *
       * On a selected row the ground is `accentSurface` and the ink steps up to `textPrimary`:
       * semantic role first, contrast gate second, exact token third.
       */}
      {value === undefined ? null : (
        <Text
          variant="subhead"
          color={
            tinted ? 'textPrimary' : opens && interactive ? 'textAction' : 'textSecondary'
          }
        >
          {value}
        </Text>
      )}
      {note === undefined ? null : (
        <Text variant="footnote" color="textMuted">
          {note}
        </Text>
      )}

      {switchValue === undefined ? null : <SwitchIndicator checked={switchValue} />}

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
      {switchValue !== undefined ? null : selected === true ? (
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
    // The role-bearing wrapper owns the target floor; the content repeats it so inert rows and
    // interactive rows retain identical rhythm.
    minHeight: rowMinHeight,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    ...(separated
      ? {
          marginTop: theme.space[3],
          borderTopWidth: 1,
          borderTopColor: theme.colors.border,
        }
      : {}),
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
      accessibilityRole={effectiveRole}
      accessibilityLabel={accessibilityLabel ?? spoken(label, summary, value, note)}
      {...(accessibilityHint === undefined ? {} : { accessibilityHint })}
      /**
       * `selected` is deliberately **not** put in `accessibilityState` for a button: React
       * Native Web maps it straight to `aria-selected`, which ARIA does not allow there and axe
       * rejects as critical. The button's state travels as `aria-pressed` below; only a checkbox
       * has a state slot here.
       */
      accessibilityState={{
        ...(effectiveRole === 'switch'
          ? { checked: switchValue }
          : effectiveRole === 'checkbox' && selected !== undefined
            ? { checked: selected }
            : {}),
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
      {...(effectiveRole !== 'button' || selected === undefined
        ? {}
        : { 'aria-pressed': selected })}
      {...(effectiveRole === 'switch'
        ? { 'aria-checked': switchValue }
        : effectiveRole === 'checkbox' && selected !== undefined
          ? { 'aria-checked': selected }
          : {})}
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

function SwitchIndicator({ checked }: { checked: boolean }) {
  const theme = useTheme();
  const motion = useMotion();
  const progress = useRef(new Animated.Value(checked ? 1 : 0)).current;
  const travel =
    theme.layout.switchTrackWidth -
    theme.layout.switchInset * 2 -
    theme.layout.switchThumbSize;

  useEffect(() => {
    if (motion.duration.switch === 0) {
      progress.setValue(checked ? 1 : 0);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: checked ? 1 : 0,
      duration: motion.duration.switch,
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [checked, motion.duration.switch, progress]);

  return (
    <Animated.View
      aria-hidden
      style={{
        width: theme.layout.switchTrackWidth,
        height: theme.layout.switchTrackHeight,
        padding: theme.layout.switchInset,
        borderRadius: theme.radius.pill,
        backgroundColor: progress.interpolate({
          inputRange: [0, 1],
          outputRange: [theme.colors.switchTrackOff, theme.colors.switchTrackOn],
        }),
        justifyContent: 'center',
      }}
    >
      <Animated.View
        style={{
          width: theme.layout.switchThumbSize,
          height: theme.layout.switchThumbSize,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.switchThumb,
          transform: [
            {
              translateX: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [0, travel],
              }),
            },
          ],
        }}
      />
    </Animated.View>
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
