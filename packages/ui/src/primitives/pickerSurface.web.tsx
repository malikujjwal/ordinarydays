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
    /**
     * **`border-box`, and it is load-bearing.**
     *
     * These are raw DOM inputs, so they take the browser's default `content-box` rather than
     * the `border-box` React Native Web applies to everything it renders. With `width: 100%`
     * plus 12 pt of padding and a 1 pt border on each side, the input measured **26 px wider
     * than the box it sits in** — the sheet's content width was 766 px and the control was
     * 792 px, so its right edge cleared the card entirely and the picker appeared to spill out
     * of the dialog.
     *
     * The one line that has to change when a DOM element borrows RN's layout assumptions, and
     * the reason the comment above this hook is worth reading.
     */
    boxSizing: 'border-box',
    fontFamily: theme.font('body').fontFamily,
    fontSize: theme.type.body.size,
    lineHeight: `${theme.type.body.lineHeight}px`,
    color: theme.colors.textPrimary,
    backgroundColor: theme.colors.surfaceInput,
    borderRadius: theme.radius.lg,
    border: `1px solid ${theme.colors.borderSubtle}`,
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
