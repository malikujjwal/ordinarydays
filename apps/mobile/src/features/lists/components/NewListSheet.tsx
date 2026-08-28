import { MAX_TITLE_LEN } from '@od/shared/constants';
import { type ListTemplateChoice, listTemplateChoices } from '@od/shared/lists';
import { Button, ChevronRight, Field, Row, Sheet, Text, useTheme } from '@od/ui';
import { useState } from 'react';
import { View } from 'react-native';
import { useCreateList } from '../hooks/useCreateList';

/**
 * `New list` — style first, title second (§P3-26,
 * [`plans-and-lists.md`](../../../../../docs/01-product/plans-and-lists.md) §5.4, ADR-032).
 *
 * ```
 * ┌──────────────────────────────────────────┐   ┌──────────────────────────────────────────┐
 * │  Choose a list style                 ✕   │   │  Movies to watch                     ✕   │
 * │                                          │   │  Status for movies                       │
 * │  Blank        A plain list             › │ → │                                          │
 * │  Checklist    Items have checkboxes    › │   │  List name                               │
 * │  Groceries    Checkboxes for shopping  › │   │  ┌────────────────────────────────────┐  │
 * │  …                                       │   │  │ Movies to watch                    │  │
 * │                                          │   │  └────────────────────────────────────┘  │
 * │                                          │   │  Back                      Create list   │
 * └──────────────────────────────────────────┘   └──────────────────────────────────────────┘
 * ```
 *
 * ## The order is the product rule, not a layout preference
 *
 * Step one has **no title field at all**, so there is no text for anything to classify, and
 * `CLAUDE.md` rule 2 holds by construction rather than by a classifier being told not to run.
 * The user's tap on a visible style is the only input that sets `templateKey`; the title typed
 * on step two is data, and editing `Movies to watch` to `Watch repairs` changes nothing about
 * what was made. There is no matcher, ranking, debounce, `/suggest-template` call or model
 * call anywhere in this file — `check-forbidden.mjs`'s `no-template-suggester` fails the build
 * on one appearing in any package.
 *
 * Nothing is selected, recommended, pinned, reordered from history or hidden. The catalogue is
 * `listTemplateChoices()` rendered in its own fixed order, and this component has no prop
 * through which a suggestion could arrive. `Blank` is a tap like every other style: there is no
 * no-selection fallback to `simple-list`.
 *
 * ## It ships with the app
 *
 * The projection is **bundled**, so the sheet opens and creates on a first launch with no
 * network. It never calls `GET /v1/list-templates`; that route exposes the same module to
 * clients that are not this one (§P3-06).
 *
 * ## Where the write goes
 *
 * `useCreateList` resolves per platform: native commits the visible row and a queued
 * `['list','create']` intent in one SQLite transaction, web runs an online mutation. Either
 * way this component's only write is behind `Create list`, and that label names it.
 */
export interface NewListSheetProps {
  open: boolean;
  /** Dismisses without writing. Supplied by the caller; this component never navigates. */
  onClose: () => void;
  /**
   * The list that was made, by id.
   *
   * P3-27's no-destination flow (§5.4 rule 5) returns to the ListItem form with this list
   * visibly selected, and P3-39 opens the same sheet from a Plan. Both need the identity the
   * moment it exists, which on native is before the server has seen it.
   */
  onCreated?: (listId: string) => void;
}

export function NewListSheet({ open, onClose, onCreated }: NewListSheetProps) {
  const theme = useTheme();
  const create = useCreateList();
  /**
   * `undefined` is "no style chosen yet" — a state this component renders rather than one it
   * has to avoid producing, which is what makes "nothing is pre-selected" structural.
   */
  const [style, setStyle] = useState<ListTemplateChoice>();
  const [title, setTitle] = useState('');

  /** §5.4 rule 1: `Back` retains nothing, so the chooser is never returned to pre-selected. */
  function back() {
    setStyle(undefined);
    setTitle('');
    create.dismissError();
  }

  function close() {
    back();
    onClose();
  }

  async function confirm() {
    if (style === undefined) return;
    const listId = await create.create(style.templateKey, title.trim());
    if (listId === undefined) return; // The banner is showing; the step stays put.
    back();
    onCreated?.(listId);
    onClose();
  }

  return (
    <Sheet
      open={open}
      onClose={close}
      title={style === undefined ? 'Choose a list style' : style.chooserLabel}
      detent={style === undefined ? 'large' : 'fit'}
      testID="new-list-sheet"
      actions={
        style === undefined ? undefined : (
          <View style={{ flexDirection: 'row', gap: theme.space[3] }}>
            <Button label="Back" variant="ghost" onPress={back} testID="new-list-back" />
            <View style={{ flex: 1 }}>
              <Button
                label="Create list"
                accessibilityLabel={`Create list ${title.trim()}`}
                onPress={() => void confirm()}
                /* §5.4 rule 3: the trimmed title, and nothing else, gates the write. */
                disabled={title.trim() === ''}
                loading={create.isCreating}
                fullWidth
                testID="new-list-create"
              />
            </View>
          </View>
        )
      }
    >
      {create.errorMessage === undefined ? null : (
        <View style={{ gap: theme.space[1] }} testID="new-list-error">
          <Text variant="footnote" color="danger">
            {create.errorMessage}
          </Text>
          {create.errorRequestId === undefined ? null : (
            <Text variant="footnote" color="textSecondary" selectable>
              {create.errorRequestId}
            </Text>
          )}
        </View>
      )}

      {style === undefined ? (
        <View testID="list-style-chooser">
          {listTemplateChoices().map((choice) => (
            <Row
              key={choice.templateKey}
              title={choice.chooserLabel}
              subtitle={choice.summary}
              subtitleTone="explanatory"
              /*
               * §5.4 rule 6's exact announcement, `<style>. <description>`. It is spelled into
               * the name rather than left to `accessibilityHint`, which React Native Web drops
               * — a sentence only iOS users hear is not the sentence the rule asks for.
               *
               * No row carries a selected state, in ARIA or otherwise: a chooser row navigates
               * to the next step, and none of them is ever chosen here.
               */
              accessibilityLabel={`${choice.chooserLabel}. ${choice.summary}`}
              onPress={() => {
                setStyle(choice);
                // §5.4 rule 2: the prefill is the record's own editable default title, which
                // is a different field from the label that was just tapped.
                setTitle(choice.defaultTitle);
              }}
              trailing={
                <View
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                >
                  <ChevronRight size={20} color={theme.colors.textSecondary} />
                </View>
              }
              testID={`list-style-${choice.templateKey}`}
            />
          ))}
        </View>
      ) : (
        <View style={{ gap: theme.space[5] }} testID="new-list-title-step">
          {/* The record's exact `summary`, never a description generated from capabilities. */}
          <Text variant="subhead" color="textSecondary" testID="new-list-style-summary">
            {style.summary}
          </Text>
          <Field
            label="List name"
            accessibilityLabel={`List name, pre-filled with ${style.defaultTitle}`}
            value={title}
            onChangeText={setTitle}
            autoFocus
            maxLength={MAX_TITLE_LEN}
            testID="new-list-title"
          />
        </View>
      )}
    </Sheet>
  );
}
