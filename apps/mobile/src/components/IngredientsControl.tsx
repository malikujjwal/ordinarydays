import { MAX_INGREDIENTS } from '@od/shared/constants';
import { Close as CloseIcon, Field, IconButton, Plus, Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import { type DraftIngredient, newIngredient } from '@/components/ingredientDraft';

export interface IngredientsControlProps {
  rows: DraftIngredient[];
  onChange: (rows: DraftIngredient[]) => void;
}

/**
 * Repeating name + quantity rows, each with a checkbox (`activities.md` §4.2).
 *
 * **The checkboxes default to unchecked and select nothing on their own.** They exist to
 * choose which ingredients a later, explicitly enabled list write would copy — "suggest,
 * never auto-create" — and in Phase 1 that write does not exist at all.
 */
export function IngredientsControl({ rows, onChange }: IngredientsControlProps) {
  const theme = useTheme();

  const update = (index: number, patch: Partial<DraftIngredient>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <View style={{ gap: theme.space[3] }} testID="compose-ingredients">
      <Text variant="footnoteStrong" color="textSecondary">
        Ingredients
      </Text>

      {rows.map((row, index) => (
        <View
          /**
           * The row's own id, not its index. Editing a name would otherwise remount the
           * field being typed into, and removing a row above would slide every checkbox
           * state up by one — which is the rule's actual point rather than a style note.
           */
          key={row.id}
          style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[3] }}
        >
          <View style={{ flex: 2 }}>
            <Field
              label={`Ingredient ${index + 1}`}
              hideLabel
              value={row.name}
              onChangeText={(name) => update(index, { name })}
              placeholder="Name"
              maxLength={120}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Field
              label={`Quantity ${index + 1}`}
              hideLabel
              value={row.quantity}
              onChangeText={(quantity) => update(index, { quantity })}
              placeholder="Quantity"
              maxLength={120}
            />
          </View>
          <IconButton
            icon={CloseIcon}
            label={`Remove ingredient ${index + 1}`}
            onPress={() => onChange(rows.filter((_, i) => i !== index))}
          />
        </View>
      ))}

      {/* Capped at the schema's own limit, so the row that would be rejected is never
          offered rather than being sent and 400ing on a field the user cannot see. */}
      {rows.length >= MAX_INGREDIENTS ? (
        <Hint>{`That's the most ingredients one meal can hold (${MAX_INGREDIENTS}).`}</Hint>
      ) : (
        <IconButton
          icon={Plus}
          label="Add an ingredient"
          onPress={() => onChange([...rows, newIngredient()])}
        />
      )}
    </View>
  );
}

function Hint({ children }: { children: string }) {
  const theme = useTheme();
  return (
    <View style={{ paddingTop: theme.space[2] }}>
      <Text variant="footnote" color="textSecondary">
        {children}
      </Text>
    </View>
  );
}
