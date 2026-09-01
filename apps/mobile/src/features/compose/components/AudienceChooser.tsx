import { Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import { ChooserRow } from '@/features/compose/components/ChooserRow';
import type { DraftAudience } from '@/stores/composeDraft';

/**
 * The required audience step of the `Plan this item` flow (P3-34,
 * `plans-and-lists.md` §6 step 2).
 *
 * ```
 * Who is this plan for?
 *
 * Just me                     ›
 * ```
 *
 * **Nothing is pre-selected.** `Just me` is a real, visible choice the user must tap; the
 * form does not open until they have. In this personal phase it is the only row — Phase 6
 * expands the same step to the final unselected `Just me` / `Choose people` pair — and it is
 * still a step rather than a default, because an audience nobody chose is exactly the kind of
 * inferred intent `CLAUDE.md` rule 2 forbids.
 *
 * > **New copy.** `plans-and-lists.md` §6 names the choices (`Just me` / `Choose people`) but
 * > no heading or subtitle. `Who is this plan for?` and the row subtitle are added in this PR
 * > and flagged for the founder to confirm or replace.
 */
export interface AudienceChooserProps {
  onChoose: (audience: DraftAudience) => void;
}

export function AudienceChooser({ onChoose }: AudienceChooserProps) {
  const theme = useTheme();

  return (
    <View testID="audience-chooser" style={{ gap: theme.space[5] }}>
      <Text variant="title" color="textDisplay" accessibilityRole="header">
        Who is this plan for?
      </Text>

      <View>
        <ChooserRow
          label="Just me"
          subtitle="A private plan, only visible to you"
          onPress={() => onChoose({ mode: 'just_me' })}
          testID="audience-just-me"
        />
      </View>
    </View>
  );
}
