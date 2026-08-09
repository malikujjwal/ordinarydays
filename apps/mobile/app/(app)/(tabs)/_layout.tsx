import { navIcons, useTheme } from '@od/ui';
import { Tabs, useRouter } from 'expo-router';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AddButton } from '@/features/shell/components/AddButton';
import { tabs } from '@/features/shell/model/tabs';
import { useComposeDraft } from '@/stores/composeDraft';

/**
 * The three-tab shell: Today · Plans · Lists (P1-23).
 *
 * ## The FAB is wired once, here
 *
 * P1-23's edge case, restated because it is the whole reason this file owns the button:
 * *"The FAB opens the same global chooser modally from every tab. Wire it once in the layout,
 * not three times; a tab must never replace it with a title-first or inferred route."* Three
 * copies is three places for one of them to acquire a preselected target, and the third copy
 * is always the one nobody reads. It sits as a sibling of the navigator, so it is the same
 * control in the same place regardless of which tab is showing.
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
  const openDraft = useComposeDraft((s) => s.open);

  return (
    <View style={{ flex: 1 }}>
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
          tabBarStyle: {
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

      <View
        style={{
          // In `style`, not as a prop: `props.pointerEvents` is deprecated in RN 0.81.
          pointerEvents: 'box-none',
          position: 'absolute',
          right: theme.space[5],
          // Above the tab bar, itself above the home indicator.
          bottom: insets.bottom + theme.space[11] + theme.space[5],
        }}
      >
        <AddButton
          onPress={() => {
            openDraft();
            router.push('/compose');
          }}
        />
      </View>
    </View>
  );
}
