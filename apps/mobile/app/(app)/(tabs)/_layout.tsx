import { navIcons, useBreakpoint, useTheme } from '@od/ui';
import { Tabs, useRouter, useSegments } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
      onSelect={(tab) => router.navigate(tab.path)}
      onAdd={() => {
        openDraft();
        router.push('/compose');
      }}
    >
      <Tabs
        screenOptions={{
          headerShown: false,
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
          tabBarStyle: rail
            ? { display: 'none' }
            : {
                backgroundColor: theme.colors.surfaceRaised,
                borderTopColor: theme.colors.border,
                height: theme.space[11] + insets.bottom,
                paddingTop: theme.space[2],
                paddingBottom: insets.bottom + theme.space[2],
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
      </Tabs>
    </ShellFrame>
  );
}
