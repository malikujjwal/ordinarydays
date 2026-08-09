/**
 * A stand-in for `react-native-safe-area-context` under test. See the alias note in
 * `vitest.config.ts`.
 *
 * ## Why a stub and not the real library
 *
 * Its package entry is `src/index.tsx` under the `react-native` condition this workspace
 * resolves on, which is untranspiled TypeScript. Its compiled `lib/module` build reaches into
 * `react-native/Libraries/Utilities/codegenNativeComponent`, which is Flow source, and the
 * `react-native` → `react-native-web` alias is anchored so it does not follow. Either route
 * ends in a parse error several modules from anything this repository wrote.
 *
 * A stub is the right answer rather than a workaround, for the same reason the SVG stub is:
 * **nothing in this suite asserts a safe-area inset.** The insets exist so a header clears the
 * notch and a FAB clears the home indicator, and both are judged by looking at a device or a
 * simulator, not by a number in jsdom. What the tests assert is what is *inside* the padding —
 * roles, labels, copy, and what a tap sends.
 *
 * The values below are an iPhone 14/15's, so a screen rendered in a test is laid out the way
 * it is in the 390 pt screenshots.
 *
 * Kept as a real file rather than a `vi.mock` in the setup, so that it is visible: a stub
 * hidden in `vitest.setup.ts` is one nobody finds when a test starts behaving oddly.
 */
import type { ReactNode } from 'react';

export interface EdgeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const insets: EdgeInsets = { top: 47, right: 0, bottom: 34, left: 0 };
const frame: Rect = { x: 0, y: 0, width: 390, height: 844 };

export const initialWindowMetrics = { insets, frame };

export const SafeAreaProvider = ({ children }: { children?: ReactNode }) => (
  <>{children}</>
);

export const SafeAreaView = ({ children }: { children?: ReactNode }) => (
  <div>{children}</div>
);

export const SafeAreaInsetsContext = {
  Provider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Consumer: ({ children }: { children: (value: EdgeInsets) => ReactNode }) => (
    <>{children(insets)}</>
  ),
};

export const useSafeAreaInsets = (): EdgeInsets => insets;
export const useSafeAreaFrame = (): Rect => frame;
