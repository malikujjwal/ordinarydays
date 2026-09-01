import { MAX_TITLE_LEN } from '@od/shared/constants';
import { type ListTemplateChoice, listTemplateChoices } from '@od/shared/lists';
import { Button, Field, Sheet, Text, useTheme } from '@od/ui';
import { useState } from 'react';
import { View } from 'react-native';
import { useCreateList } from '../hooks/useCreateList';
import { ListTypeCard } from './ListTypeCard';

/**
 * `New list` — type first, title second (§P3-26,
 * [`plans-and-lists.md`](../../../../../docs/01-product/plans-and-lists.md) §5.4, ADR-032).
 *
 * ```
 * ┌──────────────────────────────────────────┐   ┌──────────────────────────────────────────┐
 * │  Choose a list type                  ✕   │   │  Movies to watch                     ✕   │
 * │                                          │   │  Status for movies                       │
 * │  Blank list — full-width leading card  › │ → │                                          │
 * │  Checklist        Groceries             │   │  List name                               │
 * │  Watch Later      Books to Read         │   │  ┌────────────────────────────────────┐  │
 * │  Places to Visit  Meal Ideas            │   │  │ Movies to watch                    │  │
 * │                                          │   │  └────────────────────────────────────┘  │
 * │                                          │   │  Back                      Create list   │
 * └──────────────────────────────────────────┘   └──────────────────────────────────────────┘
 * ```
 *
 * ## The order is the product rule, not a layout preference
 *
 * Step one has **no title field at all**, so there is no text for anything to classify, and
 * `CLAUDE.md` rule 2 holds by construction rather than by a classifier being told not to run.
 * The user's tap on a visible type is the only input that sets `templateKey`; the title typed
 * on step two is data, and editing `Movies to watch` to `Watch repairs` changes nothing about
 * what was made. There is no matcher, ranking, debounce, `/suggest-template` call or model
 * call anywhere in this file — `check-forbidden.mjs`'s `no-template-suggester` fails the build
 * on one appearing in any package.
 *
 * Nothing is selected, recommended, pinned, reordered from history or hidden. The catalogue is
 * `listTemplateChoices()` rendered in its own fixed order, and this component has no prop
 * through which a suggestion could arrive. `Blank list` is a tap like every other type: there
 * is no no-selection fallback to `simple-list`.
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
   * The List that was made, including the title needed to select it before refetch completes.
   *
   * Callers such as P3-39's Plan flow may need the identity the moment it exists, which on
   * native is before the server has seen it. Global `Add list` simply dismisses Add after this
   * callback; it never opens or returns to a global List-item draft.
   */
  onCreated?: (created: { listId: string; title: string }) => void;
  /**
   * The Plan whose `Add list` opened the sheet (P3-39). It adds a context line naming the
   * Plan, prefixes the step-two title with `<Default title> · <Plan title>` (still editable),
   * and stamps `sourceActivityId` on the one confirmed write. It changes **nothing** about
   * the catalogue itself: same seven types, same order, nothing selected — a Plan's type,
   * title, duration and participants do not rank, hide or pre-select a style.
   */
  source?: { activityId: string; planTitle: string };
}

export function NewListSheet({ open, onClose, onCreated, source }: NewListSheetProps) {
  const theme = useTheme();
  const create = useCreateList();
  /**
   * `undefined` is "no style chosen yet" — a state this component renders rather than one it
   * has to avoid producing, which is what makes "nothing is pre-selected" structural.
   */
  const [style, setStyle] = useState<ListTemplateChoice>();
  const [title, setTitle] = useState('');
  const choices = listTemplateChoices();
  const blank = choices[0];
  const typedChoices = choices.slice(1);

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

  /** The step-two prefill: `<Default title> · <Plan title>` for a sourced create (§P3-39). */
  function prefillFor(choice: ListTemplateChoice): string {
    if (source === undefined) return choice.defaultTitle;
    return `${choice.defaultTitle} · ${source.planTitle}`.slice(0, MAX_TITLE_LEN);
  }

  async function confirm() {
    if (style === undefined) return;
    const createdTitle = title.trim();
    const listId =
      source === undefined
        ? await create.create(style.templateKey, createdTitle)
        : await create.create(style.templateKey, createdTitle, {
            sourceActivityId: source.activityId,
          });
    if (listId === undefined) return; // The banner is showing; the step stays put.
    back();
    onCreated?.({ listId, title: createdTitle });
    onClose();
  }

  return (
    <Sheet
      open={open}
      onClose={close}
      title={style === undefined ? 'Choose a list type' : style.chooserLabel}
      /* The focused keyboard consumes half a phone; keep the title field in the body. */
      detent="large"
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
        <View
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={{ gap: theme.space[1] }}
          testID="new-list-error"
        >
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
        <View testID="list-style-chooser" style={{ gap: theme.space[4] }}>
          {source === undefined ? null : (
            /* The §P3-39 context line: it names the Plan and nothing more — no type is
             * highlighted, hidden or reordered because of what the Plan is. */
            <Text variant="subhead" color="textPrimary" testID="new-list-source-context">
              For {source.planTitle}
            </Text>
          )}
          <Text variant="subhead" color="textSecondary">
            Choose Blank when you want a list without a category or item details.
          </Text>
          {blank === undefined ? null : (
            <View testID="list-style-leading">
              <ListTypeCard
                choice={blank}
                leading
                onPress={() => {
                  setStyle(blank);
                  setTitle(prefillFor(blank));
                }}
              />
            </View>
          )}
          <View
            testID="list-style-grid"
            style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[3] }}
          >
            {typedChoices.map((choice) => (
              <View key={choice.templateKey} style={{ flexBasis: '47%', flexGrow: 1 }}>
                <ListTypeCard
                  choice={choice}
                  onPress={() => {
                    setStyle(choice);
                    setTitle(prefillFor(choice));
                  }}
                />
              </View>
            ))}
          </View>
        </View>
      ) : (
        <View style={{ gap: theme.space[5] }} testID="new-list-title-step">
          {/* The record's exact `summary`, never a description generated from capabilities. */}
          <Text variant="subhead" color="textSecondary" testID="new-list-style-summary">
            {style.summary}
          </Text>
          <Field
            label="List name"
            accessibilityLabel={`List name, pre-filled with ${prefillFor(style)}`}
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
