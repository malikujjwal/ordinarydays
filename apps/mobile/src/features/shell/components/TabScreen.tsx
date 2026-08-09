import { EmptyState, Text, useTheme } from '@od/ui';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * A tab's chrome: the screen title, and its body (P1-23).
 *
 * Headerless navigators, so each screen owns its own header — which is what lets Today's
 * header carry a date and Lists' carry a `New list` action without fighting a shared one.
 *
 * In Phase 1 all three bodies are placeholders. The heading of each is the canonical
 * empty-state heading from `interaction-contract.md` §5.2, which is truthful — there is
 * nothing on any of them — and the guidance line names the phase that fills it, per P1-23.
 * The real guidance copy from §5.2 lands with the data source, because a line telling the
 * user to add something they then cannot see would be worse than one that says so.
 */
export interface TabScreenProps {
  title: string;
  emptyHeading: string;
  emptyBody: string;
  testID: string;
}

export function TabScreen({ title, emptyHeading, emptyBody, testID }: TabScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface }} testID={testID}>
      <View
        style={{
          paddingTop: insets.top + theme.space[5],
          paddingHorizontal: theme.space[5],
          paddingBottom: theme.space[3],
        }}
      >
        <Text variant="display" color="textDisplay" accessibilityRole="header">
          {title}
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          // Clear of the tab bar and the FAB sitting above it.
          paddingBottom: insets.bottom + theme.space[11],
        }}
      >
        <EmptyState heading={emptyHeading} body={emptyBody} />
      </ScrollView>
    </View>
  );
}
