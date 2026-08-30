import { Button, Field, IconTile, Plus, Text, useTheme } from '@od/ui';
import { useState } from 'react';
import { View } from 'react-native';

export interface InlineListItemEditorProps {
  isAdding: boolean;
  errorMessage?: string;
  errorRequestId?: string;
  onChange?: () => void;
  onAdd: (title: string) => Promise<string | undefined>;
}

/** The List-owned rapid-entry row: one title, one write, then the same focused field. */
export function InlineListItemEditor({
  isAdding,
  errorMessage,
  errorRequestId,
  onChange,
  onAdd,
}: InlineListItemEditorProps) {
  const theme = useTheme();
  const [title, setTitle] = useState('');
  const disabled = title.trim() === '' || isAdding;

  async function commit() {
    const trimmedTitle = title.trim();
    if (trimmedTitle === '' || isAdding) return;
    const itemId = await onAdd(trimmedTitle);
    if (itemId !== undefined) setTitle('');
  }

  return (
    <View testID="list-inline-add" style={{ gap: theme.space[2] }}>
      <View
        style={{
          minHeight: theme.layout.rowMinHeight,
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space[3],
        }}
      >
        <IconTile icon={Plus} tint="task" size={36} treatment="dashed" />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Field
            label="Item title"
            value={title}
            hideLabel
            autoFocus
            appearance="bare"
            hint="Return adds another"
            maxLength={200}
            onChangeText={(next) => {
              setTitle(next);
              onChange?.();
            }}
            onSubmitEditing={() => void commit()}
            testID="list-inline-add-title"
          />
        </View>
        <Button
          label="Add"
          variant="ghost"
          size="sm"
          disabled={disabled}
          loading={isAdding}
          onPress={() => void commit()}
          testID="list-inline-add-commit"
        />
      </View>
      {errorMessage === undefined ? null : (
        <View accessibilityRole="alert" style={{ gap: theme.space[1] }}>
          <Text variant="footnote" color="danger">
            {errorMessage}
          </Text>
          {errorRequestId === undefined ? null : (
            <Text variant="footnote" color="textSecondary" selectable>
              {errorRequestId}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}
