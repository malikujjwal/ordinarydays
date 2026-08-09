import { Newsreader_500Medium } from '@expo-google-fonts/newsreader';
import { useFonts } from 'expo-font';

/**
 * Loads the product's one serif (`design-system.md` §3).
 *
 * **Font loading lives in the app, not in `@od/ui`.** The design system package is a leaf
 * that imports no workspace package and nothing from Expo; it names the *role* (`serif`) and
 * the app hands it a resolved family. That is what keeps `@od/ui` extractable and testable
 * under plain jsdom.
 *
 * **Text never blocks on it.** `useFonts` reports `false` while loading and the app renders
 * anyway: `ThemeProvider` falls back to the platform serif — Georgia and its stack — until
 * the family name arrives, so a cold start shows the right words in roughly the right shape
 * rather than showing nothing. Newsreader then swaps in.
 *
 * One weight, not the variable font: both serif roles (`display` and `title`) are weight
 * 500, so a variable axis would ship a range nothing varies across. Recorded in
 * `tech-stack.md` §2.2.
 */

/** The family name to hand `ThemeProvider`, or `undefined` while the file is still loading. */
export function useSerifFamily(): string | undefined {
  const [loaded] = useFonts({ Newsreader_500Medium });
  return loaded ? 'Newsreader_500Medium' : undefined;
}
