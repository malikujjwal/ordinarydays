import type { DefaultSlot, List, ListBehaviour } from '@od/shared/types';
import { RowGroup, SettingRow, Sheet, Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import type { ListSettings } from '../hooks/useListSettings';
import { behaviourChangeConfirmation } from '../model/behaviourConfirmation';
import {
  BEHAVIOUR_CHOICE_LABELS,
  BEHAVIOUR_GAINS,
  BEHAVIOUR_PRESENTATION_NOTE,
  CAPABILITY_LABELS,
  CAPABILITY_MEANINGS,
  NO_SLOT_LABEL,
  SLOT_CLEARS_PROFILE_DEFAULT,
  SLOT_LABELS,
  SLOT_MEANINGS,
  showsCapabilityControls,
} from '../model/listSettings';

/**
 * `⋯ → List settings` — the client half of P3-09
 * ([`plans-and-lists.md`](../../../../../docs/01-product/plans-and-lists.md) §5.5, §P3-32).
 *
 * ## A settings surface, not a wizard
 *
 * Every control writes on its own, immediately. There is no `Save`, no step order and no draft
 * to lose: §P3-32 states it outright, and it is what makes closing the sheet mid-flight
 * harmless. The one thing that interrupts is the §1a.1 confirmation, and only for a behaviour
 * change that would actually destroy something.
 *
 * ## There is no Rename here
 *
 * §5.6 puts renaming inline on the header title and §P3-32 forbids duplicating it in this sheet.
 * `ListSettingsSheet.test.tsx` asserts the absence, so re-adding a row fails a test rather than
 * shipping two ways to do one thing.
 *
 * ## There is no "type" control either
 *
 * §5.5: "`Show checkboxes` is described to the user as a display setting, because that is what it
 * is. It is never presented as changing the list's type, and the sheet contains no 'type' control
 * of any kind." So the two capability rows say what they do to the *display*, the behaviour rows
 * name the concrete result — `Turn this into a watchlist` — and nothing here is labelled `Kind`
 * or `Type`.
 *
 * ## The capability rows exist only on a `collection`
 *
 * Read from the row's own `behaviour` (`showsCapabilityControls`). A `watch` list keeps its
 * stored flags and its items keep their `checked` values — turning the list back into a
 * collection restores exactly what was there — but until then they drive no control, no count and
 * no bulk action here or in the `⋯` menu.
 *
 * ## What the behaviour section promises, and what it asks
 *
 * An **upgrade** previews what is gained and applies on the tap, with the six-second Undo. A
 * **downgrade** asks the server first and renders its answer: the dialog's field list and item
 * count are the server's own, because a count taken from a paginated cache would be wrong in the
 * one sentence that must not be. Both are told that the name, icon and empty-list words stay as
 * they are (ADR-032), because a user who suspects their list is about to be re-styled will not
 * touch the control at all.
 */
export interface ListSettingsSheetProps {
  open: boolean;
  onClose: () => void;
  list: List;
  /** The writes, their optimistic overlay and the server's pending confirmation. */
  settings: ListSettings;
  testID?: string;
}

const BEHAVIOURS: readonly ListBehaviour[] = ['collection', 'watch', 'meals'];
const SLOTS: readonly DefaultSlot[] = ['groceries', 'watch', 'meals'];

export function ListSettingsSheet({
  open,
  onClose,
  list,
  settings,
  testID = 'list-settings',
}: ListSettingsSheetProps) {
  const theme = useTheme();
  const { confirmation } = settings;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="List settings"
      detent="large"
      testID={testID}
    >
      {confirmation === undefined ? (
        <View style={{ gap: theme.space[5] }}>
          {showsCapabilityControls(list) ? (
            <RowGroup label="Display" testID="list-settings-capabilities">
              {(['checkable', 'supportsLocation'] as const).map((capability) => (
                <SettingRow
                  key={capability}
                  label={CAPABILITY_LABELS[capability]}
                  summary={CAPABILITY_MEANINGS[capability]}
                  role="checkbox"
                  selected={list.capabilities[capability]}
                  /*
                   * The state is **spoken**, not left to the check glyph. React Native Web does
                   * not map `accessibilityState.checked` onto a `Pressable`, so a row that said
                   * only "Show checkboxes, checkbox" would carry its state in colour and an icon
                   * alone — `design-system.md` §5.1's one prohibition. `ReminderSheet` names its
                   * rows the same way for the same reason.
                   */
                  accessibilityLabel={`${CAPABILITY_LABELS[capability]}, ${
                    list.capabilities[capability] ? 'on' : 'off'
                  }`}
                  onPress={() =>
                    settings.setCapability(capability, !list.capabilities[capability])
                  }
                  testID={`list-settings-${capability}`}
                />
              ))}
            </RowGroup>
          ) : null}

          {/* §5.5's label for the slot, and §5.8's plain words for what each one means. */}
          <View style={{ gap: theme.space[2] }}>
            <RowGroup label="Use as my default for" testID="list-settings-slot">
              {SLOTS.map((slot) => (
                <SettingRow
                  key={slot}
                  label={SLOT_LABELS[slot]}
                  summary={SLOT_MEANINGS[slot]}
                  selected={list.slot === slot}
                  onPress={() => settings.setSlot(slot)}
                  testID={`list-settings-slot-${slot}`}
                />
              ))}
              <SettingRow
                label={NO_SLOT_LABEL}
                selected={list.slot === null}
                onPress={() => settings.setSlot(null)}
                testID="list-settings-slot-none"
              />
            </RowGroup>
            <Text variant="footnote" color="textSecondary">
              {SLOT_CLEARS_PROFILE_DEFAULT}
            </Text>
          </View>

          <View style={{ gap: theme.space[2] }}>
            <RowGroup label="What this list is for" testID="list-settings-behaviour">
              {BEHAVIOURS.filter((behaviour) => behaviour !== list.behaviour).map(
                (behaviour) => (
                  <SettingRow
                    key={behaviour}
                    label={BEHAVIOUR_CHOICE_LABELS[behaviour]}
                    /*
                     * The gain, previewed before the tap, for the additive direction only.
                     * Arriving at `collection` has no summary here because what it would cost is
                     * the server's answer and not a sentence this component may compose.
                     */
                    {...(BEHAVIOUR_GAINS[behaviour] === undefined
                      ? {}
                      : { summary: BEHAVIOUR_GAINS[behaviour] })}
                    disabled={settings.busy}
                    onPress={() => settings.changeBehaviour(behaviour)}
                    testID={`list-settings-behaviour-${behaviour}`}
                  />
                ),
              )}
            </RowGroup>
            <Text variant="footnote" color="textSecondary">
              {BEHAVIOUR_PRESENTATION_NOTE}
            </Text>
          </View>
        </View>
      ) : (
        /*
         * Rendered **inside** this sheet rather than stacked on top of it: the decision belongs
         * to the surface that asked the question, and cancelling has to land the user back on the
         * settings they were changing rather than on the list. `ConfirmDialog` owns the §1a.1
         * shape either way — `Cancel` first, the verb repeated, the `Keeps:` line.
         */
        <ConfirmDialog
          open
          embedded
          confirmation={behaviourChangeConfirmation(list, confirmation)}
          busy={settings.busy}
          onCancel={settings.cancelBehaviour}
          onConfirm={settings.confirmBehaviour}
          testID="list-behaviour-confirm"
        />
      )}
    </Sheet>
  );
}
