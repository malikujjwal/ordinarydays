import { Button, Checkbox, ChevronDown, Text, Touchable, useTheme } from '@od/ui';
import { View } from 'react-native';
import {
  addSelectedLabel,
  addSelectedPendingLabel,
  CHOOSE_OR_CREATE,
  destinationLead,
} from '@/lib/destinationCopy';

/**
 * The ingredient rows with their selection checkboxes, the always-visible destination row,
 * and the one named action (P3-43, `plans-and-lists.md` §5.8, §7.3).
 *
 * - **Every ingredient starts unchecked.** The caller owns the selection; this component
 *   never pre-selects a row.
 * - **The destination is visible before the write, including when nothing was asked**
 *   (§5.8: silent step one means the app does not ask, not that it does not say). The row
 *   reads the list's name with a `▾` that opens the picker for a one-off change, or
 *   `Choose or create a list` when nothing holds the slot.
 * - **The action names the count and the list.** Until a destination exists it reads
 *   `Add n selected` and is disabled; nothing is written until it is tapped.
 * - A row already added (`addedToListId`) reads `Added` and cannot be added twice from the
 *   same meal (§7.3 step 5).
 *
 * Used by the Meal's detail screen (writes through P3-17's action) and by the Meal creation
 * form (where the save carries the write). Neither path constructs provenance or calls the
 * ordinary bulk route — the server does that from the selected `ingredientId`s.
 *
 * ## Two layouts (2026-09-10)
 *
 * `stacked` — the creation form's: the labelled destination field above the rows, and the
 * action (when there is one) full width below. `footer` — Activity detail's: the rows
 * first, then one line at the section's foot with a quiet `To Groceries ▾` destination
 * control and, **only once at least one row is selected**, a secondary `Add n to <list>`
 * button beside it. No disabled `Add 0 to …` bar, no separate lead label above the rows.
 */
export interface IngredientRow {
  readonly ingredientId: string;
  readonly name: string;
  readonly quantity?: string | undefined;
  readonly addedToListId?: string | undefined;
}

export interface IngredientPickerProps {
  rows: readonly IngredientRow[];
  selected: ReadonlySet<string>;
  onToggle: (ingredientId: string, selected: boolean) => void;
  /** The resolved destination's title, or nothing when nothing is chosen or capable yet. */
  destinationTitle: string | undefined;
  /** The `▾` (or the `Choose or create a list` row): opens the destination picker. */
  onChangeDestination: () => void;
  /**
   * The named action. Absent on the creation form, where the save button carries the write
   * (`Save plan and add 3 items to Groceries`) and this control only collects the selection.
   */
  onAdd?: (ingredientIds: readonly string[]) => void;
  busy?: boolean;
  /** `Added` rows are the meal's; on a form nothing has been added yet. */
  addedLabel?: string;
  /** The destination row's lead; the creation form passes its §4 table label. */
  lead?: string;
  /** `stacked` (default, the creation form) or `footer` (Activity detail). */
  layout?: 'stacked' | 'footer';
  testID?: string;
}

export function IngredientPicker({
  rows,
  selected,
  onToggle,
  destinationTitle,
  onChangeDestination,
  onAdd,
  busy = false,
  addedLabel = 'Added',
  lead = destinationLead('groceries'),
  layout = 'stacked',
  testID = 'ingredient-picker',
}: IngredientPickerProps) {
  const theme = useTheme();
  const selectable = rows.filter(
    (row) => row.addedToListId === undefined && row.name.trim() !== '',
  );
  const chosen = selectable.filter((row) => selected.has(row.ingredientId));
  const count = chosen.length;
  const placeholder = CHOOSE_OR_CREATE;

  const footer = layout === 'footer';
  const addLabel =
    destinationTitle === undefined
      ? addSelectedPendingLabel(count)
      : addSelectedLabel(count, destinationTitle);
  // The destination row above is the only way to choose one, and the add button is disabled
  // while none is resolved — so this path adds and never opens the picker.
  const add = () => onAdd?.(chosen.map((row) => row.ingredientId));

  return (
    <View style={{ gap: theme.space[4] }} testID={testID}>
      {/** The destination row: always visible, always changeable, always specific (§5.8). */}
      {footer ? null : (
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={
            destinationTitle === undefined
              ? placeholder
              : `${lead} ${destinationTitle}. Change`
          }
          onPress={onChangeDestination}
          testID={`${testID}-destination`}
        >
          <View style={{ gap: theme.space[1] }}>
            <Text variant="footnoteStrong" color="textSecondary">
              {lead}
            </Text>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                minHeight: theme.layout.hitTarget,
                paddingHorizontal: theme.space[4],
                borderRadius: theme.radius.md,
                backgroundColor: theme.colors.surfaceInput,
              }}
            >
              <Text
                variant="body"
                color={destinationTitle === undefined ? 'textAction' : 'textPrimary'}
                testID={`${testID}-destination-name`}
              >
                {destinationTitle ?? placeholder}
              </Text>
              <ChevronDown size={20} color={theme.colors.textSecondary} />
            </View>
          </View>
        </Touchable>
      )}

      <View style={{ gap: theme.space[2] }}>
        {rows.map((row) => {
          const added = row.addedToListId !== undefined;
          const title =
            row.quantity === undefined || row.quantity === ''
              ? row.name
              : `${row.name} (${row.quantity})`;
          return (
            <View
              key={row.ingredientId}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.space[3],
                minHeight: theme.layout.hitTarget,
              }}
              testID={`${testID}-row-${row.ingredientId}`}
            >
              {added ? (
                <View style={{ width: theme.layout.hitTarget }} />
              ) : (
                <Checkbox
                  checked={selected.has(row.ingredientId)}
                  label={title}
                  onChange={(next) => onToggle(row.ingredientId, next)}
                  testID={`${testID}-check-${row.ingredientId}`}
                />
              )}
              {/* The checkbox already carries the title as its name; the visible text is
                  hidden from assistive tech so the row is announced once. */}
              <View
                style={{ flex: 1 }}
                accessibilityElementsHidden={!added}
                importantForAccessibility={added ? 'auto' : 'no-hide-descendants'}
              >
                <Text variant="body" color={added ? 'textMuted' : 'textPrimary'}>
                  {title}
                </Text>
              </View>
              {added ? (
                <Text
                  variant="footnote"
                  color="textMuted"
                  testID={`${testID}-added-${row.ingredientId}`}
                >
                  {addedLabel}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>

      {footer ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: theme.space[3],
          }}
        >
          {/** Still always visible and changeable (§5.8) — just one quiet line now. */}
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={
              destinationTitle === undefined
                ? placeholder
                : `${lead} ${destinationTitle}. Change`
            }
            onPress={onChangeDestination}
            testID={`${testID}-destination`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.space[2],
              minHeight: theme.layout.hitTarget,
              flexShrink: 1,
            }}
          >
            <Text
              variant="subhead"
              color={destinationTitle === undefined ? 'textAction' : 'textSecondary'}
              testID={`${testID}-destination-name`}
            >
              {destinationTitle === undefined ? placeholder : `To ${destinationTitle}`}
            </Text>
            <ChevronDown size={16} color={theme.colors.textSecondary} />
          </Touchable>
          {onAdd === undefined || count === 0 ? null : (
            <Button
              label={addLabel}
              variant="secondary"
              contentSized
              disabled={destinationTitle === undefined || busy}
              loading={busy}
              onPress={add}
              testID={`${testID}-add`}
            />
          )}
        </View>
      ) : onAdd === undefined ? null : (
        <Button
          label={addLabel}
          size="lg"
          fullWidth
          disabled={count === 0 || destinationTitle === undefined || busy}
          loading={busy}
          onPress={add}
          testID={`${testID}-add`}
        />
      )}
    </View>
  );
}
