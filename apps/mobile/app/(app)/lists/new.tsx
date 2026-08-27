import { EmptyState, Text, useTheme } from '@od/ui';
import { useRouter } from 'expo-router';
import { View } from 'react-native';

/**
 * `/lists/new` — **a stub**. P3-26 builds the template-first creation sheet here.
 *
 * The route exists so P3-25's `+ New list` has somewhere real to go: a header action wired to
 * nothing is an action that looks broken, and one wired to a screen that creates something
 * would be P3-25 quietly doing P3-26's job. This screen creates nothing and mints no id.
 *
 * When P3-26 lands, the sheet opens on P3-07's **bundled** catalogue projection with no style
 * selected and no title field, because the style is chosen before the title exists (ADR-032).
 */
export default function NewListRoute() {
  const router = useRouter();
  const theme = useTheme();

  return (
    <View
      testID="new-list-stub"
      style={{ flex: 1, justifyContent: 'center', padding: theme.space[5] }}
    >
      <EmptyState
        heading="Choosing a style comes next"
        body="Creating a list arrives with the style chooser."
        action={{ label: 'Back', onPress: () => router.back() }}
      />
      <Text variant="footnote" color="textDisabled" align="center">
        P3-26
      </Text>
    </View>
  );
}
