import { useTheme } from '../theme/index';
import type { DateSurfaceProps, TimeSurfaceProps } from './pickerSurface';

/**
 * The **web** calendar and clock surfaces — `<input type="date">` and `<input type="time">`,
 * per `design-system.md` §6.
 *
 * The browser's own control is the right answer here rather than a rendered calendar grid: it
 * is keyboard-navigable, localised, and already the one every user of this app has used
 * before. The props are imported from the native fork so the two cannot drift — a change to
 * one signature stops the other compiling.
 */

/**
 * Both inputs share their box. Written as a hook rather than a `StyleSheet` because these are
 * DOM elements, not React Native ones, and `StyleSheet.create` produces RN styles
 * (`coding-standards.md` §8.7 covers the RN case; this is the exception it does not).
 */
function useInputStyle(): React.CSSProperties {
  const theme = useTheme();
  return {
    fontFamily: theme.font('body').fontFamily,
    fontSize: theme.type.body.size,
    lineHeight: `${theme.type.body.lineHeight}px`,
    color: theme.colors.textPrimary,
    backgroundColor: theme.colors.surfaceRaised,
    borderRadius: theme.radius.lg,
    border: `1px solid ${theme.colors.border}`,
    padding: theme.space[4],
    minHeight: theme.layout.hitTarget,
    width: '100%',
  };
}

export function DateSurface({ label, value, onChange, min, max }: DateSurfaceProps) {
  const style = useInputStyle();

  return (
    <input
      type="date"
      aria-label={label}
      value={value ?? ''}
      {...(min === undefined ? {} : { min })}
      {...(max === undefined ? {} : { max })}
      onChange={(event) => {
        /**
         * An empty string is what the browser reports when the field is cleared from inside
         * the control. Clearing is the picker's own `Clear` affordance — a surface that
         * emitted `''` here would be reporting "no date" as a date.
         */
        if (event.target.value !== '') onChange(event.target.value);
      }}
      style={style}
    />
  );
}

export function TimeSurface({
  label,
  value,
  onChange,
  minuteInterval,
}: TimeSurfaceProps) {
  const style = useInputStyle();

  return (
    <input
      type="time"
      aria-label={label}
      value={value ?? ''}
      /** Seconds, which is what the attribute takes — 5 minutes is 300 of them. */
      step={minuteInterval * 60}
      onChange={(event) => {
        if (event.target.value !== '') onChange(event.target.value);
      }}
      style={style}
    />
  );
}
