import { navIcons, Text, Touchable, useTheme } from '@od/ui';
import { View } from 'react-native';
import { type TabDefinition, tabs } from '@/features/shell/model/tabs';

/**
 * The left rail that replaces the bottom tab bar from `medium` up (`design-system.md` §8).
 *
 * The mock's rail, in its order: the `Ordinary Days` wordmark in serif `title`, then the same
 * three nouns as `body` labels, the active one carried on a `surfaceSunken` pill.
 *
 * **The same three tabs, not a different set.** The rail is a second *presentation* of
 * `model/tabs.ts`, never a second list — a rail that could hold a fourth destination is how a
 * fourth noun arrives without anyone deciding to add one (`agent-playbook.md` §10 trigger 8).
 *
 * Two things §8 describes that are deliberately absent, both because their subject does not
 * exist yet rather than because the rail is unfinished:
 *
 * - **`People`, after a gap.** People is Phase 7. A rail entry now would be a visible
 *   destination that goes nowhere.
 * - **The signed-in name at the rail's foot.** There is no session in Phase 1 — the user ID is
 *   a constant behind `IdentityProvider` (P1-01) and there is no display name to render.
 */
export interface NavRailProps {
  /** The active route's name within the `(tabs)` group — `index`, `plans` or `lists`. */
  activeName: string;
  onSelect: (tab: TabDefinition) => void;
}

export function NavRail({ activeName, onSelect }: NavRailProps) {
  const theme = useTheme();

  return (
    <View
      /**
       * `role`, not `accessibilityRole`: React Native's `accessibilityRole` union has no
       * `navigation` member — it predates the ARIA landmark set — while the newer `role` prop
       * takes ARIA roles directly and is what reaches the DOM as `role="navigation"`.
       */
      role="navigation"
      testID="nav-rail"
      style={{
        width: 220,
        backgroundColor: theme.colors.surface,
        borderRightWidth: 1,
        borderRightColor: theme.colors.border,
        paddingHorizontal: theme.space[5],
        paddingTop: theme.space[8],
        gap: theme.space[7],
      }}
    >
      <Text variant="title" color="textDisplay">
        Ordinary Days
      </Text>

      <View style={{ gap: theme.space[2] }}>
        {tabs.map((tab) => {
          const Icon = navIcons[tab.name as keyof typeof navIcons];
          const active = tab.name === activeName;

          return (
            <Touchable
              key={tab.name}
              accessibilityRole="link"
              accessibilityLabel={tab.label}
              accessibilityState={{ selected: active }}
              /**
               * The web half of the same statement, for the reason written out on `Chip`:
               * React Native Web maps `accessibilityState.selected` only for roles where
               * `aria-selected` is legal, and `link` is not one of them. `aria-current="page"`
               * is what ARIA gives the active entry in a navigation landmark.
               */
              {...(active ? { 'aria-current': 'page' } : {})}
              onPress={() => onSelect(tab)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.space[4],
                paddingHorizontal: theme.space[4],
                borderRadius: theme.radius.md,
                backgroundColor: active ? theme.colors.surfaceSunken : 'transparent',
              }}
            >
              <Icon
                size={20}
                color={active ? theme.colors.accent : theme.colors.textSecondary}
              />
              <Text variant="body" color={active ? 'textDisplay' : 'textSecondary'}>
                {tab.label}
              </Text>
            </Touchable>
          );
        })}
      </View>
    </View>
  );
}
