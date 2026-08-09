/**
 * A stand-in for `@react-native-community/datetimepicker` under test. See the alias note in
 * `vitest.config.ts`.
 *
 * It is reached by exactly one test — the fork-parity check in `pickers.test.tsx`, which
 * imports the **native** `pickerSurface.tsx` to compare its export set against the web one.
 * Every other test resolves `pickerSurface.web.tsx`, because this suite runs on the target the
 * web build ships.
 *
 * The library is a native module: on iOS it renders a real `UIDatePicker` and there is nothing
 * for jsdom to render even in principle. The wheel is asserted by Maestro on the simulator
 * (P1-29), not here. Kept as a visible file rather than a `vi.mock` in the setup, for the same
 * reason `svg-stub.tsx` is: a stub hidden in a setup file is one nobody finds.
 */
interface StubProps {
  [key: string]: unknown;
}

export default function DateTimePicker({ accessibilityLabel, mode }: StubProps) {
  // `data-*`, not `aria-label`: a bare `div` has no role that supports one, and the real
  // component's accessible name comes from the platform control, which is not this.
  return <div data-picker={String(mode)} data-label={String(accessibilityLabel)} />;
}
