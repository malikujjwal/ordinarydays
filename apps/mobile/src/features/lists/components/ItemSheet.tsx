import {
  MAX_ADDRESS_LEN,
  MAX_FREE_TEXT_LEN,
  MAX_INGREDIENTS,
  MAX_NOTES_LEN,
  MAX_TITLE_LEN,
} from '@od/shared/constants';
import { Button, Chip, Close, Field, IconButton, Sheet, Text, useTheme } from '@od/ui';
import { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { newLocalId } from '@/lib/localIds';
import type { ListItemRow } from '@/lib/sqlite/listItemsRepository';
import { useListItemActions } from '../hooks/useListItemActions';
import {
  type IngredientRow,
  ingredientRows,
  ingredientsPatch,
  itemProvenance,
  itemSheetFields,
  notePatch,
  placePatch,
  provenanceLine,
  type RowList,
  titlePatch,
  watchDetails,
  watchNumber,
  watchPatch,
} from '../model/itemSheet';
import { WATCH_STATUS_LABELS, WATCH_STATUSES } from '../model/listItemRow';
import { openInMaps } from '../model/openInMaps';

/**
 * The sheet a row body opens (U1) —
 * [`plans-and-lists.md`](../../../../../docs/01-product/plans-and-lists.md) §5.6, §5.7, §7.5,
 * §8.1; §P3-29.
 *
 * ```
 * ┌──────────────────────────────────────────┐
 * │  Severance                           ✕   │
 * │  Title    [ Severance             ]      │
 * │  Note     [                       ]      │
 * │  From Sunday dinner                   ›  │  navigable while it resolves (§7.5)
 * │  Movie · Show                            │  watch
 * │  Want to watch · Watching · Watched      │    any → any, manual (§8.1)
 * │  Season [ 2 ]  Episode [ 4 ]             │    shows only
 * │  Mark as watched                         │
 * │                              Delete      │
 * └──────────────────────────────────────────┘
 * ```
 *
 * ## The field set is the list's, and the template key is never consulted
 *
 * `itemSheetFields` decides it from `behaviour` and `capabilities` — the values copied onto the
 * List row at creation (ADR-032) — exactly as P3-28's row renderer does. A place on a
 * `supportsLocation: false` list is **absent**, not disabled, which is what §5.7's "capabilities
 * change what renders" means and what the render matrix asserts.
 *
 * That also settles the migration fence: a `503` while P3-09 migrates a behaviour keeps the
 * last committed projection, so the `list` handed here still says the old behaviour and this
 * sheet still draws the old behaviour's fields. Nothing needs to detect the migration, because
 * nothing here reads anything that would change mid-migration.
 *
 * ## Every edit is one PATCH, and there is no Save
 *
 * Text commits on blur, controls commit on tap, and each sends the one field it changed
 * (§5.11.5: no `If-Match`, last write wins per field). A rejected write reverts **that** field
 * to its committed value and shows the toast with `Retry`; the rest of the sheet is untouched,
 * because the rest of the sheet was never part of that write.
 *
 * ## Two §5.6 actions are missing on purpose
 *
 * `Plan this item` arrives with P3-33 and `Add ingredients to…` with P3-42. Both are **absent**
 * rather than disabled: a control that names a flow the build does not have is a promise, and
 * §5.6 offers actions when they can be taken.
 *
 * ## Delete asks nothing
 *
 * §4.1 gives a single-item delete no confirmation and a six-second Undo, so `ConfirmDialog`
 * does not appear in this file and `ItemSheet.test.tsx` asserts its absence rather than its
 * arrangement — re-adding one fails the test.
 */
export interface ItemSheetProps {
  open: boolean;
  /** The list's own two fields. Nothing else is reachable, which is ADR-032 at the prop. */
  list: RowList;
  item: ListItemRow;
  onClose: () => void;
  /**
   * Re-reads the projection after an accepted field edit. On native that is a SQLite re-read,
   * because the edit is already committed there.
   */
  onChanged: () => void;
  /**
   * Re-reads the projection after the delete, or after its Undo.
   *
   * Separate from {@link onChanged} because the delete is an online write on both platforms, so
   * a native re-read of committed rows would still find the row it just removed.
   */
  onRemoved: () => void;
  /**
   * Opens the item's source Activity (§7.5).
   *
   * Called **only** after the probe says it still resolves, so a caller never navigates to a
   * screen that has nothing to show. Absent leaves the row plain text from the start.
   */
  onOpenSource?: (activityId: string) => void;
  testID?: string;
}

export function ItemSheet({
  open,
  list,
  item,
  onClose,
  onChanged,
  onRemoved,
  onOpenSource,
  testID = 'item-sheet',
}: ItemSheetProps) {
  const theme = useTheme();
  const actions = useListItemActions({ onSaved: onChanged, onRemoved });
  const fields = itemSheetFields(list, item);
  const watch = watchDetails(item);
  const provenance = itemProvenance(item);

  const [title, setTitle] = useState(item.title);
  const [note, setNote] = useState(item.note ?? '');
  const [placeLabel, setPlaceLabel] = useState(item.location?.label ?? '');
  const [placeAddress, setPlaceAddress] = useState(item.location?.address ?? '');
  const [season, setSeason] = useState(
    watch?.season === undefined ? '' : String(watch.season),
  );
  const [episode, setEpisode] = useState(
    watch?.episode === undefined ? '' : String(watch.episode),
  );
  const [ingredients, setIngredients] = useState<readonly IngredientRow[]>(() =>
    ingredientRows(item),
  );
  /**
   * §7.5's degradation, and the only state in this component that is not a field.
   *
   * `false` once a navigation attempt has met a `404`. It is deliberately **not** reset by a
   * refresh: the Activity is gone, and offering the row again on the next render would ask the
   * user to discover the same dead end twice.
   */
  const [sourceResolves, setSourceResolves] = useState(true);

  /*
   * Re-seed when the sheet opens on a different item. Not on every `item` change: the row
   * behind this sheet re-renders after each save, and adopting it mid-edit would overwrite what
   * the user is typing with what they typed a moment ago.
   */
  const seeded = useRef<string | undefined>(undefined);
  const key = open ? item.itemId : undefined;
  useEffect(() => {
    if (key === undefined || seeded.current === key) return;
    seeded.current = key;
    setTitle(item.title);
    setNote(item.note ?? '');
    setPlaceLabel(item.location?.label ?? '');
    setPlaceAddress(item.location?.address ?? '');
    const details = watchDetails(item);
    setSeason(details?.season === undefined ? '' : String(details.season));
    setEpisode(details?.episode === undefined ? '' : String(details.episode));
    setIngredients(ingredientRows(item));
    setSourceResolves(true);
  }, [key, item]);

  /**
   * `interaction-contract.md` §7.3: focus returns to the triggering element on close.
   *
   * Web only, and the section it comes from is titled "Web equivalents". The sheet primitive
   * supplies the trap and the roles (P3-26); what it cannot know is which element opened it, so
   * the caller's row is remembered here and given focus back when the sheet goes away.
   */
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (open) {
      opener.current ??= document.activeElement;
      return;
    }
    const previous = opener.current;
    opener.current = null;
    if (previous instanceof HTMLElement) previous.focus();
  }, [open]);

  const id = (suffix: string) => ({ testID: `${testID}-${suffix}` });

  /**
   * Sends one field, and puts it back if it was refused — by the builder or by the server.
   *
   * `undefined` covers both refusals, and both want the same repair: a title emptied to
   * nothing, and a blur that changed nothing, both leave the box showing what is committed.
   */
  async function commit(
    changes: Parameters<typeof actions.save>[1] | undefined,
    revert: () => void,
  ) {
    if (changes === undefined) {
      revert();
      return;
    }
    if (!(await actions.save(item, changes))) revert();
  }

  function commitIngredients(next: readonly IngredientRow[]) {
    setIngredients(next);
    void commit(ingredientsPatch(item, next), () => setIngredients(ingredientRows(item)));
  }

  async function openSource(activityId: string) {
    if (await actions.sourceResolves(activityId)) {
      onOpenSource?.(activityId);
      return;
    }
    setSourceResolves(false);
  }

  const provenanceNavigable =
    provenance?.sourceActivityId !== undefined &&
    sourceResolves &&
    onOpenSource !== undefined;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      /*
       * The **committed** title, so the heading keeps naming the thing while the field beneath
       * it is being retyped, and the dialog has a real accessible name rather than `Dialog`.
       */
      title={item.title}
      detent="large"
      testID={testID}
      actions={
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
          <Button
            label="Delete"
            accessibilityLabel={`Delete ${item.title}`}
            variant="danger"
            onPress={() => {
              // No dialog (§4.1). The write goes now; the toast carries the six seconds back.
              actions.remove(item);
              onClose();
            }}
            {...id('delete')}
          />
        </View>
      }
    >
      <Field
        label="Title"
        value={title}
        onChangeText={setTitle}
        maxLength={MAX_TITLE_LEN}
        /*
         * §7.3's "focus moves to the sheet's first control on open", and web is the platform
         * that section governs. On native the same prop would open the keyboard over an item
         * the user may have opened only to read — `Field`'s own note says as much.
         */
        autoFocus={Platform.OS === 'web'}
        onBlur={() => {
          void commit(titlePatch(item, title), () => setTitle(item.title));
        }}
        {...id('title')}
      />

      <Field
        label="Note"
        value={note}
        onChangeText={setNote}
        multiline
        maxLength={MAX_NOTES_LEN}
        onBlur={() => {
          void commit(notePatch(item, note), () => setNote(item.note ?? ''));
        }}
        {...id('note')}
      />

      {/*
       * §7.5's provenance row. Text in v1 on the row itself; here it is the one place the
       * source meal becomes navigable — while it still resolves.
       */}
      {provenance === undefined ? null : provenanceNavigable ? (
        <Button
          label={provenanceLine(provenance)}
          variant="ghost"
          flush
          size="sm"
          onPress={() => void openSource(provenance.sourceActivityId as string)}
          {...id('provenance')}
        />
      ) : (
        <Text variant="subhead" color="textSecondary" {...id('provenance')}>
          {provenanceLine(provenance)}
        </Text>
      )}

      {fields.place ? (
        <View style={{ gap: theme.space[4] }} {...id('place')}>
          <Field
            label="Place"
            value={placeLabel}
            onChangeText={setPlaceLabel}
            maxLength={MAX_FREE_TEXT_LEN}
            onBlur={() => {
              void commit(placePatch(item, placeLabel, placeAddress), () =>
                setPlaceLabel(item.location?.label ?? ''),
              );
            }}
            {...id('place-label')}
          />
          <Field
            label="Address"
            value={placeAddress}
            onChangeText={setPlaceAddress}
            maxLength={MAX_ADDRESS_LEN}
            onBlur={() => {
              void commit(placePatch(item, placeLabel, placeAddress), () =>
                setPlaceAddress(item.location?.address ?? ''),
              );
            }}
            {...id('place-address')}
          />
          {/*
           * §5.7's tap-through, as its own control: the address itself is an input here, and a
           * box cannot also be a button. The spoken name is the row's, so both surfaces
           * announce the same destination.
           */}
          {item.location === undefined ? null : (
            <Button
              label="Open in Maps"
              accessibilityLabel={`${item.location.address ?? item.location.label}, open in Maps`}
              variant="ghost"
              flush
              size="sm"
              onPress={() => void openInMaps(item.location)}
              {...id('open-in-maps')}
            />
          )}
        </View>
      ) : null}

      {fields.watch && watch !== undefined ? (
        <View style={{ gap: theme.space[4] }} {...id('watch')}>
          <View style={{ gap: theme.space[2] }}>
            <Text variant="footnote" color="textSecondary">
              Kind
            </Text>
            <View style={{ flexDirection: 'row', gap: theme.space[2] }}>
              {(['movie', 'show'] as const).map((kind) => (
                <Chip
                  key={kind}
                  label={kind === 'movie' ? 'Movie' : 'Show'}
                  selected={watch.mediaKind === kind}
                  onPress={() => {
                    void commit(watchPatch(item, { mediaKind: kind }), () => undefined);
                  }}
                  testID={`${testID}-media-${kind}`}
                />
              ))}
            </View>
          </View>

          {/*
           * §8.1's "any → any: manual, from item detail". Three chips, one selected, and no
           * transition rule between them — the app never decides a show is finished.
           */}
          <View style={{ gap: theme.space[2] }}>
            <Text variant="footnote" color="textSecondary">
              Status
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
              {WATCH_STATUSES.map((status) => (
                <Chip
                  key={status}
                  label={WATCH_STATUS_LABELS[status]}
                  selected={watch.watchStatus === status}
                  onPress={() => {
                    void commit(
                      watchPatch(item, { watchStatus: status }),
                      () => undefined,
                    );
                  }}
                  testID={`${testID}-status-${status}`}
                />
              ))}
            </View>
          </View>

          {fields.progress ? (
            <View
              style={{ flexDirection: 'row', gap: theme.space[4] }}
              {...id('progress')}
            >
              <View style={{ flex: 1 }}>
                <Field
                  label="Season"
                  value={season}
                  onChangeText={setSeason}
                  keyboardType="number-pad"
                  onBlur={() => {
                    void commit(watchPatch(item, { season: watchNumber(season) }), () =>
                      setSeason(watch.season === undefined ? '' : String(watch.season)),
                    );
                  }}
                  {...id('season')}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Field
                  label="Episode"
                  value={episode}
                  onChangeText={setEpisode}
                  keyboardType="number-pad"
                  onBlur={() => {
                    void commit(watchPatch(item, { episode: watchNumber(episode) }), () =>
                      setEpisode(
                        watch.episode === undefined ? '' : String(watch.episode),
                      ),
                    );
                  }}
                  {...id('episode')}
                />
              </View>
            </View>
          ) : null}

          {/*
           * §8.1's named shortcut for the one transition the app may never make on its own.
           * Absent once the item is `watched` — the status chips above still allow any → any,
           * and a button whose write is already true is a control with nothing to do.
           */}
          {watch.watchStatus === 'watched' ? null : (
            <Button
              label="Mark as watched"
              variant="secondary"
              onPress={() => {
                void commit(
                  watchPatch(item, { watchStatus: 'watched' }),
                  () => undefined,
                );
              }}
              {...id('mark-watched')}
            />
          )}
        </View>
      ) : null}

      {fields.ingredients ? (
        <View style={{ gap: theme.space[4] }} {...id('ingredients')}>
          <Text variant="footnote" color="textSecondary">
            Ingredients
          </Text>
          {ingredients.map((ingredient, index) => (
            <View
              key={ingredient.ingredientId}
              style={{
                flexDirection: 'row',
                alignItems: 'flex-end',
                gap: theme.space[3],
              }}
            >
              <View style={{ flex: 2 }}>
                <Field
                  label="Ingredient"
                  value={ingredient.name}
                  onChangeText={(next) =>
                    setIngredients((rows) =>
                      rows.map((row, at) =>
                        at === index ? { ...row, name: next } : row,
                      ),
                    )
                  }
                  maxLength={MAX_FREE_TEXT_LEN}
                  onBlur={() => commitIngredients(ingredients)}
                  testID={`${testID}-ingredient-name-${String(index)}`}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Field
                  label="Quantity"
                  value={ingredient.quantity}
                  onChangeText={(next) =>
                    setIngredients((rows) =>
                      rows.map((row, at) =>
                        at === index ? { ...row, quantity: next } : row,
                      ),
                    )
                  }
                  maxLength={MAX_FREE_TEXT_LEN}
                  onBlur={() => commitIngredients(ingredients)}
                  testID={`${testID}-ingredient-quantity-${String(index)}`}
                />
              </View>
              <IconButton
                /* `Close` rather than a bin: the package has no trash glyph, and drawing one
                   is `ui` work with its own task (P3-45's shape). The label carries the verb. */
                icon={Close}
                label={`Remove ${ingredient.name === '' ? 'ingredient' : ingredient.name}`}
                onPress={() =>
                  commitIngredients(ingredients.filter((_, at) => at !== index))
                }
                testID={`${testID}-ingredient-remove-${String(index)}`}
              />
            </View>
          ))}
          {ingredients.length >= MAX_INGREDIENTS ? null : (
            <Button
              label="Add an ingredient"
              variant="ghost"
              flush
              onPress={() =>
                /*
                 * Local only: a nameless row is not an ingredient, so nothing is written until
                 * one is typed. `ingredientsPatch` drops it if the user changes their mind.
                 */
                setIngredients((rows) => [
                  ...rows,
                  { ingredientId: newLocalId('ing'), name: '', quantity: '' },
                ])
              }
              {...id('add-ingredient')}
            />
          )}
        </View>
      ) : null}
    </Sheet>
  );
}
