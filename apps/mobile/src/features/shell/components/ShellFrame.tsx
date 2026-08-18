import { useBreakpoint, useTheme } from '@od/ui';
import { type ReactNode, useEffect } from 'react';
import { Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AddButton } from '@/features/shell/components/AddButton';
import { NavRail } from '@/features/shell/components/NavRail';
import { OfflineBar } from '@/features/shell/components/OfflineBar';
import { type TabDefinition, tabs } from '@/features/shell/model/tabs';

const editableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'SELECT' ||
    target.tagName === 'TEXTAREA'
  );
};

/**
 * The shell's chrome around whatever navigator is showing (P1-23).
 *
 * Two responsibilities, and the reason they live here rather than in the route file:
 *
 * - **The global Add button is wired once.** P1-23's edge case: *"The FAB opens the same
 *   global chooser modally from every tab. Wire it once in the layout, not three times; a tab
 *   must never replace it with a title-first or inferred route."* It is a sibling of
 *   `children`, so it is the same control in the same place whichever tab is rendered, and no
 *   tab can substitute its own.
 * - **The bottom tab bar becomes a left rail from `medium` up** (`design-system.md` §8). The
 *   navigator's own bar is hidden by the caller at those widths; this component supplies the
 *   rail beside the content.
 *
 * It is a component rather than JSX inside `(tabs)/_layout.tsx` because `testing.md` §9
 * excludes route files from coverage on the grounds that their logic belongs in the components
 * they compose — and "the FAB is present on every tab" is exactly the kind of structural claim
 * that needs a test rather than a promise.
 */
export interface ShellFrameProps {
  /** The active route's name within the `(tabs)` group. */
  activeName: string;
  onSelect: (tab: TabDefinition) => void;
  onAdd: () => void;
  children: ReactNode;
}

export function ShellFrame({ activeName, onSelect, onAdd, children }: ShellFrameProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const rail = useBreakpoint() !== 'compact';

  useEffect(() => {
    if (Platform.OS !== 'web') return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        editableTarget(event.target) ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.key.toLowerCase() !== 't'
      ) {
        return;
      }

      const today = tabs.find(({ name }) => name === 'index');
      if (today === undefined) return;
      event.preventDefault();
      onSelect(today);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onSelect]);

  return (
    <View style={{ flex: 1, flexDirection: rail ? 'row' : 'column' }}>
      {rail ? <NavRail activeName={activeName} onSelect={onSelect} /> : null}

      <View style={{ flex: 1 }}>
        {/*
          §5.4's bar sits above the screen content and below any header the screen renders its
          own of, so it never covers what it is explaining. In the flow rather than absolutely
          positioned: it is persistent, and content should move down for it rather than hide
          under it.
        */}
        <OfflineBar />
        {children}
      </View>

      <View
        style={{
          // In `style`, not as a prop: `props.pointerEvents` is deprecated in RN 0.81.
          pointerEvents: 'box-none',
          position: 'absolute',
          right: theme.space[5],
          /**
           * Clear of the tab bar when there is one. With the rail there is no bar, so the
           * button sits on the ordinary bottom gutter instead of floating a bar's height above
           * nothing.
           */
          bottom: rail
            ? insets.bottom + theme.space[5]
            : insets.bottom + theme.space[11] + theme.space[5],
        }}
      >
        <AddButton onPress={onAdd} />
      </View>
    </View>
  );
}
