import { navIcons, useBreakpoint, useTheme } from '@od/ui';
import { type Href, Tabs, useRouter, useSegments } from 'expo-router';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { tabBarBottomOffset } from '@/components/globalAddLayout';
import { ShellFrame } from '@/features/shell/components/ShellFrame';
import { tabs } from '@/features/shell/model/tabs';
import { useComposeDraft } from '@/stores/composeDraft';

/**
 * The three-tab shell: Today · Plans · Lists (P1-23).
 *
 * The chrome — the rail, the tab bar and the one global Add button — is `ShellFrame`, so this
 * file stays what a route file should be: it resolves router state, and renders one component
 * (`tech-stack.md` §3.2).
 *
 * `draft.open()` before navigating resets the flow to the object step with nothing selected,
 * so a chooser can never inherit the previous session's target.
 *
 * There is **no auth guard and no `(auth)` group** — Phase 4 adds both, and adding them is a
 * change to `(app)/_layout.tsx` alone because no screen inside here reads a session.
 */
export default function TabsLayout() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const segments = useSegments();
  const openDraft = useComposeDraft((s) => s.open);

  /**
   * The active tab, read off the segments rather than tracked in state.
   *
   * Inside `(tabs)` the last segment is the route name, except at the group's index where
   * there is no trailing segment at all — which is Today.
   */
  const last = segments[segments.length - 1];
  const activeName = last === undefined || last === '(tabs)' ? 'index' : (last as string);

  /** From `medium` up the rail replaces the bar, so the navigator's own bar is hidden. */
  const rail = useBreakpoint() !== 'compact';

  return (
    <ShellFrame
      activeName={activeName}
      /**
       * `tab.path` is a `string`, and Expo Router's typed routes want one of its generated
       * literals. The cast is here, in the route file, rather than by giving
       * `model/tabs.ts` an `Href` type: that module is pure data about the three nouns and
       * importing a router type into it would make the one place the tab list is asserted
       * depend on generated output. Navigation belongs to this layer; so does knowing that
       * these three paths are real routes — `tabs.test.ts` pins them.
       */
      onSelect={(tab) => router.navigate(tab.path as Href)}
      onAdd={() => {
        openDraft();
        router.push('/compose');
      }}
    >
      <Tabs
        screenOptions={{
          headerShown: false,
          freezeOnBlur: Platform.OS !== 'web',
          tabBarActiveTintColor: theme.colors.accent,
          tabBarInactiveTintColor: theme.colors.textSecondary,
          /**
           * Height is stated rather than left to the navigator's default.
           *
           * React Navigation's web default is a 48 pt bar. That is not enough for a 28 pt
           * icon slot above an 18 pt label line, and the way it comes up short is quiet: the
           * navigator squeezes the label's own box to 9 pt and sets `overflow: hidden` on it,
           * so the labels render as clipped half-words rather than as a layout that visibly
           * overflows. Caught in the first 390 pt screenshot, measured in the browser.
           *
           * 64 pt leaves 56 pt of content after the padding, which fits both with room to
           * spare at larger dynamic-type sizes. The bottom inset is added on top so the bar
           * clears the home indicator rather than sitting under it.
           */
          /**
           * **A floating capsule** — founder, 2026-08-17. `radius.pill` is the radius table's
           * value for "things that behave like pills", which is what a detached bar is; a
           * full-width bar with a hairline above it is the shape this replaces.
           *
           * Detaching it means it no longer occupies layout, so it is `position: absolute` with
           * a gutter on three sides, and every scrolling tab reserves its height plus that
           * margin through `bottomChromeScrollPadding`. It keeps its own elevation instead of
           * the top border, because a capsule has no edge to rule.
           */
          tabBarStyle: rail
            ? { display: 'none' }
            : {
                position: 'absolute',
                /**
                 * **A margin, not `left`/`right`** — the fix for the founder's 2026-08-18 report
                 * that the capsule was still full-width on an iPhone while correct on web.
                 *
                 * `BottomTabBar` puts `styles.bottom` — `{ start: 0, end: 0, bottom: 0 }` — in
                 * the style array before this object. Yoga resolves the *logical* edges `start`
                 * and `end` ahead of the physical `left` and `right`, so on native `start: 0`
                 * won and the `left`/`right` written here were discarded. React Native Web maps
                 * `start`/`end` to `inset-inline-*`, a different CSS property that our `left`
                 * and `right` outrank — which is exactly why this looked fixed in a browser and
                 * unchanged on the device.
                 *
                 * A horizontal margin has no such contest: it insets a `start: 0, end: 0` box
                 * identically under Yoga and CSS, so both platforms now get one capsule.
                 */
                marginHorizontal: theme.space[7],
                bottom: tabBarBottomOffset(insets.bottom),
                backgroundColor: theme.colors.surfaceRaised,
                borderTopWidth: 0,
                borderRadius: theme.radius.pill,
                height: theme.space[11],
                paddingTop: theme.space[2],
                paddingBottom: theme.space[2],
                ...theme.elevation('e2'),
              },
          tabBarLabelStyle: theme.font('footnote'),
        }}
      >
        {tabs.map((tab) => {
          const Icon = navIcons[tab.name as keyof typeof navIcons];
          return (
            <Tabs.Screen
              key={tab.name}
              name={tab.name}
              options={{
                title: tab.label,
                // The label carries the meaning; the icon is a recognition aid beside it.
                tabBarIcon: ({ color }: { color: string }) => (
                  <Icon size={22} color={color} />
                ),
              }}
            />
          );
        })}
        <Tabs.Screen name="lists-contract-tab-gallery" options={{ href: null }} />
      </Tabs>
    </ShellFrame>
  );
}
