import {
  MAX_ADDRESS_LEN,
  MAX_FREE_TEXT_LEN,
  MAX_INGREDIENTS,
  MAX_NOTES_LEN,
  MAX_TITLE_LEN,
} from '@od/shared/constants';
import { watchEpisode, watchSeason } from '@od/shared/schemas';
import type { ListItemState, ListSubItem, ProgressValue } from '@od/shared/types';
import {
  Button,
  Diamond,
  Field,
  IconButton,
  Plus,
  SettingRow,
  Sheet,
  Text,
  type Theme,
  Touchable,
  Trash,
  useTheme,
} from '@od/ui';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Platform,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { newLocalId } from '@/lib/localIds';
import type { ListItemRow } from '@/lib/sqlite/listItemsRepository';
import { useItemAutosave } from '../hooks/useItemAutosave';
import { useListItemActions } from '../hooks/useListItemActions';
import {
  type ListItemFeatureEditorVisitor,
  visitEnabledFeatureEditors,
} from '../model/featureRegistry';
import {
  appendSubItem,
  itemNumber,
  itemProvenance,
  moveSubItem,
  notePatch,
  placePatch,
  progressPatch,
  provenanceLine,
  type RowList,
  subItemsPatch,
  titlePatch,
} from '../model/itemSheet';
import { ReorderableList } from './ReorderableList';

export interface ItemSheetProps {
  open: boolean;
  list: RowList;
  item: ListItemRow;
  onClose: () => void;
  onChanged: () => void;
  onRemoved: () => void;
  onOpenSource?: (activityId: string) => void;
  /**
   * Opens the `Plan this item` flow (P3-34): the unselected Plan-kind chooser, then the
   * required audience step, then the form. The action closes this sheet first — the flow is a
   * modal route, and a sheet left open underneath would receive the Back gesture.
   *
   * It hands up the sheet's **current** title and note: `close()` flushes the debounced
   * saves asynchronously, so the caller's own `item` may still hold the pre-edit values for
   * a render — and the bridge must copy what the user is looking at, not what the store last
   * settled.
   */
  onPlanItem?: (draft: { title: string; note?: string }) => void;
  testID?: string;
}

export function ItemSheet(props: ItemSheetProps) {
  return <ItemSheetEditor key={props.item.itemId} {...props} />;
}

const STATES: readonly ListItemState[] = ['open', 'active', 'done'];
const validSeason = (value: string) =>
  value.trim() === '' || watchSeason.safeParse(itemNumber(value)).success;
const validEpisode = (value: string) =>
  value.trim() === '' || watchEpisode.safeParse(itemNumber(value)).success;
const createStyles = (theme: Theme) =>
  StyleSheet.create({
    subItem: {
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    subItemRow: {
      minHeight: theme.layout.rowMinHeight,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.space[2],
    },
    subItemBody: {
      flex: 1,
      minWidth: 0,
      minHeight: theme.layout.hitTarget,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.space[3],
    },
    subItemTitle: { flex: 1, minWidth: 0 },
    subItemFields: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.space[3],
    },
    subItemTitleField: { flex: 2, minWidth: 0 },
    subItemSecondaryField: { flex: 1, minWidth: 0 },
    content: { gap: theme.space[5], paddingBottom: theme.space[1] },
    stateControls: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[3] },
    stateChoice: {
      flexGrow: 1,
      flexShrink: 1,
      minWidth: theme.layout.hitTarget * 2,
      padding: theme.space[3],
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: theme.radius.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    selectedChoice: {
      borderColor: theme.colors.textAction,
      backgroundColor: theme.colors.surfaceSunken,
    },
    saveStatus: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: theme.space[3],
      paddingBottom: theme.space[3],
    },
    statusText: { flexShrink: 1 },
    featureSection: { gap: theme.space[3] },
    featureHeading: {
      minHeight: theme.layout.hitTarget,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.space[2],
    },
    subItemHeading: {
      minHeight: theme.layout.hitTarget,
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: theme.space[2],
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
  });

function ItemSheetEditor({
  open,
  list,
  item,
  onClose,
  onChanged,
  onRemoved,
  onOpenSource,
  onPlanItem,
  testID = 'item-sheet',
}: ItemSheetProps) {
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const retrySave = useRef<() => void>(() => undefined);
  const releaseFailed = useRef<() => void>(() => undefined);
  const actions = useListItemActions({
    onSaved: onChanged,
    inlineSaveFeedback: true,
    retrySave: () => retrySave.current(),
    releaseFailed: () => releaseFailed.current(),
    onRemoving: onChanged,
    onRemoved,
  });
  const provenance = itemProvenance(item);
  const progress = item.features?.progress;
  const place = item.features?.place;
  const [title, setTitle] = useState(item.title);
  const [note, setNote] = useState(item.note ?? '');
  const [progressText, setProgressText] = useState(
    progress?.kind === 'text' ? progress.value : '',
  );
  const [season, setSeason] = useState(
    progress?.kind === 'episode' && progress.season !== undefined
      ? String(progress.season)
      : '',
  );
  const [episode, setEpisode] = useState(
    progress?.kind === 'episode' && progress.episode !== undefined
      ? String(progress.episode)
      : '',
  );
  const [addingProgress, setAddingProgress] = useState(progress !== undefined);
  const [placeLabel, setPlaceLabel] = useState(place?.label ?? '');
  const [placeAddress, setPlaceAddress] = useState(place?.address ?? '');
  const [subItems, setSubItems] = useState<readonly ListSubItem[]>(
    item.features?.subItems?.entries ?? [],
  );
  const [editingSubItem, setEditingSubItem] = useState<string>();
  const previousItem = useRef(item);
  const autosave = useItemAutosave(item, actions.save);
  retrySave.current = autosave.retry;
  releaseFailed.current = autosave.releaseFailed;
  const titleSave = autosave.field('title');
  const noteSave = autosave.field('note');
  const progressSave = autosave.field('progress');
  const placeSave = autosave.field('place');
  const subItemsSave = autosave.field('subItems');
  const stateSave = autosave.field('state');
  const [selectedState, setSelectedState] = useState(item.state);
  const messages = {
    idle: 'Changes save automatically.',
    waiting: 'Changes waiting to save…',
    saving: 'Saving…',
    saved: Platform.OS === 'web' ? 'All changes saved' : 'Saved on this device',
    failed: 'Couldn’t save. Your changes are kept here.',
    invalid: 'Finish the required fields to save.',
  };
  const saveMessage = messages[autosave.status];
  useEffect(() => {
    if (Platform.OS !== 'web') AccessibilityInfo.announceForAccessibility(saveMessage);
  }, [saveMessage]);

  const close = () => {
    actions.finishEditing?.(autosave.status === 'failed');
    titleSave.flush();
    noteSave.flush();
    progressSave.flush();
    placeSave.flush();
    subItemsSave.flush();
    stateSave.flush();
    onClose();
  };

  useEffect(() => {
    const previous = previousItem.current;
    const changedItem = previous.itemId !== item.itemId;
    const previousProgress = previous.features?.progress;
    const previousPlace = previous.features?.place;
    const nextProgress = item.features?.progress;
    const nextPlace = item.features?.place;
    const previousProgressText =
      previousProgress?.kind === 'text' ? previousProgress.value : '';
    const nextProgressText = nextProgress?.kind === 'text' ? nextProgress.value : '';
    const previousSeason =
      previousProgress?.kind === 'episode' && previousProgress.season !== undefined
        ? String(previousProgress.season)
        : '';
    const nextSeason =
      nextProgress?.kind === 'episode' && nextProgress.season !== undefined
        ? String(nextProgress.season)
        : '';
    const previousEpisode =
      previousProgress?.kind === 'episode' && previousProgress.episode !== undefined
        ? String(previousProgress.episode)
        : '';
    const nextEpisode =
      nextProgress?.kind === 'episode' && nextProgress.episode !== undefined
        ? String(nextProgress.episode)
        : '';
    const previousSubItems = previous.features?.subItems?.entries ?? [];
    const nextSubItems = item.features?.subItems?.entries ?? [];

    // A refresh after saving one field may land while the user is typing another. Adopt
    // server truth only into fields that still equal the previous server value; a dirty
    // field belongs to the editor until its own blur commits it.
    if (!autosave.owns('state')) setSelectedState(item.state);
    setTitle((current) =>
      changedItem || (!autosave.owns('title') && current === previous.title)
        ? item.title
        : current,
    );
    setNote((current) =>
      changedItem || (!autosave.owns('note') && current === (previous.note ?? ''))
        ? (item.note ?? '')
        : current,
    );
    setSubItems((current) =>
      changedItem ||
      (!autosave.owns('subItems') &&
        JSON.stringify(current) === JSON.stringify(previousSubItems))
        ? nextSubItems
        : current,
    );
    setProgressText((current) =>
      changedItem || (!autosave.owns('progress') && current === previousProgressText)
        ? nextProgressText
        : current,
    );
    setSeason((current) =>
      changedItem || (!autosave.owns('progress') && current === previousSeason)
        ? nextSeason
        : current,
    );
    setEpisode((current) =>
      changedItem || (!autosave.owns('progress') && current === previousEpisode)
        ? nextEpisode
        : current,
    );
    setAddingProgress((current) =>
      changedItem || current === (previousProgress !== undefined)
        ? nextProgress !== undefined
        : current,
    );
    setPlaceLabel((current) =>
      changedItem || (!autosave.owns('place') && current === (previousPlace?.label ?? ''))
        ? (nextPlace?.label ?? '')
        : current,
    );
    setPlaceAddress((current) =>
      changedItem ||
      (!autosave.owns('place') && current === (previousPlace?.address ?? ''))
        ? (nextPlace?.address ?? '')
        : current,
    );
    previousItem.current = item;
  }, [item, autosave.owns]);

  const episodeValue = (seasonText = season, episodeText = episode): ProgressValue => {
    const seasonNumber = itemNumber(seasonText);
    const episodeNumber = itemNumber(episodeText);
    return {
      kind: 'episode',
      ...(progress?.kind === 'episode' && progress.mediaKind !== undefined
        ? { mediaKind: progress.mediaKind }
        : {}),
      ...(seasonNumber === undefined ? {} : { season: seasonNumber }),
      ...(episodeNumber === undefined ? {} : { episode: episodeNumber }),
    };
  };
  const stageLabels =
    list.itemStateMode.mode === 'stages'
      ? list.itemStateMode.labels
      : { open: 'Open', active: 'Active', done: 'Done' };
  const featureEditors: ListItemFeatureEditorVisitor<ReactNode> = {
    progress: (config) => (
      <View key="progress">
        {!addingProgress ? (
          <SettingRow
            label="Progress"
            value="Add"
            opens
            onPress={() => setAddingProgress(true)}
          />
        ) : config.kind === 'text' ? (
          <Field
            label="Progress"
            maxLength={MAX_FREE_TEXT_LEN}
            value={progressText}
            onChangeText={(value) => {
              setProgressText(value);
              progressSave.schedule((acknowledged) =>
                progressPatch(
                  acknowledged,
                  value.trim() === '' ? undefined : { kind: 'text', value: value.trim() },
                  true,
                ),
              );
            }}
            onBlur={progressSave.flush}
          />
        ) : (
          <View style={{ flexDirection: 'row', gap: theme.space[3] }}>
            <View style={{ flex: 1 }}>
              <Field
                label="Season"
                value={season}
                {...(!validSeason(season)
                  ? { error: 'Use a whole number from 0 to 1000.' }
                  : {})}
                onChangeText={(value) => {
                  setSeason(value);
                  if (!validSeason(value) || !validEpisode(episode))
                    progressSave.invalid();
                  else
                    progressSave.schedule((acknowledged) =>
                      progressPatch(acknowledged, episodeValue(value, episode), true),
                    );
                }}
                onBlur={progressSave.flush}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Field
                label="Episode"
                value={episode}
                {...(!validEpisode(episode)
                  ? { error: 'Use a whole number from 0 to 10000.' }
                  : {})}
                onChangeText={(value) => {
                  setEpisode(value);
                  if (!validSeason(season) || !validEpisode(value))
                    progressSave.invalid();
                  else
                    progressSave.schedule((acknowledged) =>
                      progressPatch(acknowledged, episodeValue(season, value), true),
                    );
                }}
                onBlur={progressSave.flush}
              />
            </View>
          </View>
        )}
      </View>
    ),
    place: () => (
      <View key="place" style={styles.featureSection}>
        <Text variant="caption" color="textSecondary">
          Place
        </Text>
        <View style={styles.featureSection}>
          <Field
            label="Name"
            maxLength={MAX_FREE_TEXT_LEN}
            value={placeLabel}
            {...(placeLabel.trim() === '' && placeAddress.trim() !== ''
              ? { error: 'Name is required when an address is present.' }
              : {})}
            onChangeText={(value) => {
              setPlaceLabel(value);
              if (value.trim() === '' && placeAddress.trim() !== '') placeSave.invalid();
              else
                placeSave.schedule((acknowledged) =>
                  placePatch(acknowledged, value, placeAddress, true),
                );
            }}
            onBlur={placeSave.flush}
          />
          <Field
            label="Address"
            value={placeAddress}
            onChangeText={(value) => {
              setPlaceAddress(value);
              if (placeLabel.trim() === '' && value.trim() !== '') placeSave.invalid();
              else
                placeSave.schedule((acknowledged) =>
                  placePatch(acknowledged, placeLabel, value, true),
                );
            }}
            onBlur={placeSave.flush}
            maxLength={MAX_ADDRESS_LEN}
          />
        </View>
      </View>
    ),
    subItems: (config) => (
      <View key="subItems" testID="sub-items-editor">
        <View style={styles.subItemHeading}>
          <View style={{ flexBasis: '33%', flexGrow: 1, minWidth: 0 }}>
            <Text variant="sectionLabel" color="textSecondary">
              {config.sectionLabel}
            </Text>
          </View>
          <Text variant="footnote" color="textSecondary">
            {subItems.length === 1 ? '1 item' : `${String(subItems.length)} items`}
          </Text>
          <Button
            label={`Add ${config.singularLabel.toLowerCase()}`}
            variant="ghost"
            size="sm"
            icon={Plus}
            flush
            disabled={subItems.length >= MAX_INGREDIENTS}
            onPress={() => {
              const id = newLocalId('sub');
              setSubItems((rows) => appendSubItem(rows, id));
              setEditingSubItem(id);
              subItemsSave.invalid();
            }}
          />
        </View>
        <ReorderableList
          items={subItems}
          keyOf={(entry) => entry.id}
          labelOf={(entry) => entry.title.trim() || config.singularLabel}
          rangeOf={() => ({ first: 0, last: Math.max(0, subItems.length - 1) })}
          handlePlacement="leading"
          handleAppearance="quiet"
          handleVisibility="persistent"
          onDrop={(itemId, to) => {
            const from = subItems.findIndex((entry) => entry.id === itemId);
            const next = moveSubItem(subItems, from, to);
            setSubItems(next);
            subItemsSave.now((acknowledged) => subItemsPatch(acknowledged, next, true));
          }}
          renderItem={(entry) => {
            const name = entry.title.trim() || config.singularLabel;
            return (
              <View testID={`sub-item-${entry.id}`} style={styles.subItem}>
                <View style={styles.subItemRow}>
                  {editingSubItem === entry.id ? (
                    <View style={styles.subItemFields}>
                      <View style={styles.subItemTitleField}>
                        <Field
                          label={config.singularLabel}
                          value={entry.title}
                          hideLabel
                          appearance="bare"
                          autoFocus
                          placeholder={config.singularLabel}
                          onChangeText={(value) => {
                            const next = subItems.map((row) =>
                              row.id === entry.id ? { ...row, title: value } : row,
                            );
                            setSubItems(next);
                            if (next.every((row) => row.title.trim() !== '')) {
                              subItemsSave.schedule((acknowledged) =>
                                subItemsPatch(acknowledged, next, true),
                              );
                            } else subItemsSave.invalid();
                          }}
                          onBlur={() => {
                            const next = subItems.filter(
                              (row) => row.title.trim() !== '',
                            );
                            setSubItems(next);
                            if (!next.some((row) => row.id === entry.id)) {
                              setEditingSubItem(undefined);
                            }
                            subItemsSave.now((acknowledged) =>
                              subItemsPatch(acknowledged, next, true),
                            );
                          }}
                        />
                      </View>
                      {config.secondaryLabel === undefined ? null : (
                        <View style={styles.subItemSecondaryField}>
                          <Field
                            label={config.secondaryLabel}
                            value={entry.secondary ?? ''}
                            hideLabel
                            appearance="bare"
                            textVariant="footnote"
                            placeholder={config.secondaryLabel}
                            onChangeText={(value) => {
                              const next = subItems.map((row) =>
                                row.id === entry.id ? { ...row, secondary: value } : row,
                              );
                              setSubItems(next);
                              if (next.every((row) => row.title.trim() !== '')) {
                                subItemsSave.schedule((acknowledged) =>
                                  subItemsPatch(acknowledged, next, true),
                                );
                              } else subItemsSave.invalid();
                            }}
                            onBlur={subItemsSave.flush}
                          />
                        </View>
                      )}
                    </View>
                  ) : (
                    <Touchable
                      square={false}
                      accessibilityRole="button"
                      accessibilityLabel={`Edit ${name}`}
                      onPress={() => setEditingSubItem(entry.id)}
                      style={styles.subItemBody}
                    >
                      <View style={styles.subItemTitle}>
                        <Text variant="subhead" color="textPrimary" numberOfLines={2}>
                          {name}
                        </Text>
                      </View>
                      {entry.secondary?.trim() ? (
                        <Text variant="footnote" color="textSecondary" numberOfLines={1}>
                          {entry.secondary}
                        </Text>
                      ) : null}
                    </Touchable>
                  )}
                  {/*
                   * A direct remove, not a `⋯` menu: the menu was a second `Sheet`, and iOS
                   * silently refuses to present a Modal while the item sheet's own Modal is
                   * up, so the button did nothing on device. Move up/down live on the drag
                   * handle's accessibility actions already.
                   */}
                  <IconButton
                    icon={Trash}
                    label={`Remove ${name}`}
                    onPress={() => {
                      const next = subItems.filter((row) => row.id !== entry.id);
                      setSubItems(next);
                      setEditingSubItem((current) =>
                        current === entry.id ? undefined : current,
                      );
                      subItemsSave.now((acknowledged) =>
                        subItemsPatch(acknowledged, next, true),
                      );
                    }}
                    testID={`sub-item-${entry.id}-remove`}
                  />
                </View>
              </View>
            );
          }}
        />
      </View>
    ),
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Item details"
      compactTitle={fontScale >= 2}
      detent="fit"
      testID={testID}
      headerAccessory={
        <View style={styles.saveStatus} testID="item-save-status">
          <View
            style={styles.statusText}
            accessibilityLiveRegion="polite"
            role={Platform.OS === 'web' ? 'status' : undefined}
          >
            <Text
              variant="footnote"
              color={autosave.status === 'failed' ? 'danger' : 'textSecondary'}
              numberOfLines={0}
            >
              {saveMessage}
            </Text>
          </View>
          {autosave.status === 'failed' ? (
            <Button label="Retry" size="sm" variant="ghost" onPress={autosave.retry} />
          ) : null}
        </View>
      }
    >
      <View style={styles.content}>
        <Field
          label="Title"
          value={title}
          onChangeText={(value) => {
            setTitle(value);
            if (value.trim() === '') titleSave.invalid();
            else
              titleSave.schedule((acknowledged) => titlePatch(acknowledged, value, true));
          }}
          onBlur={titleSave.flush}
          {...(title.trim() === '' ? { error: 'Title is required.' } : {})}
          maxLength={MAX_TITLE_LEN}
          testID="item-sheet-title"
        />
        <Field
          label="Note"
          optional
          value={note}
          onChangeText={(value) => {
            setNote(value);
            noteSave.schedule((acknowledged) => notePatch(acknowledged, value, true));
          }}
          onBlur={noteSave.flush}
          maxLength={MAX_NOTES_LEN}
          multiline
          testID="item-sheet-note"
        />

        {provenance === undefined ? null : (
          <SettingRow
            label={provenanceLine(provenance)}
            {...(provenance.sourceActivityId === undefined || onOpenSource === undefined
              ? {}
              : {
                  opens: true,
                  onPress: () => {
                    close();
                    onOpenSource(provenance.sourceActivityId as string);
                  },
                })}
          />
        )}

        {list.itemStateMode.mode === 'none' ? null : (
          <View style={styles.featureSection} testID="item-state-editor">
            <Text variant="caption" color="textSecondary">
              State
            </Text>
            <View style={styles.stateControls}>
              {(list.itemStateMode.mode === 'checkbox'
                ? (['open', 'done'] as const)
                : STATES
              ).map((state) => {
                const selected =
                  state === selectedState ||
                  (state === 'open' &&
                    selectedState === 'active' &&
                    list.itemStateMode.mode === 'checkbox');
                const label =
                  list.itemStateMode.mode === 'checkbox'
                    ? state === 'done'
                      ? 'Done'
                      : 'Not done'
                    : stageLabels[state];
                return (
                  <Touchable
                    key={state}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    accessibilityState={{ selected }}
                    aria-pressed={selected}
                    style={[
                      styles.stateChoice,
                      { flexBasis: theme.layout.hitTarget * 2 * fontScale },
                      selected && styles.selectedChoice,
                    ]}
                    testID={`item-state-${state}`}
                    onPress={() => {
                      setSelectedState(state);
                      stateSave.now(() => ({ state }));
                    }}
                  >
                    <Text
                      variant={selected ? 'footnoteStrong' : 'footnote'}
                      color={selected ? 'textAction' : 'textSecondary'}
                      numberOfLines={0}
                    >
                      {label}
                    </Text>
                  </Touchable>
                );
              })}
            </View>
          </View>
        )}

        {visitEnabledFeatureEditors(list.featureConfig, item.features, featureEditors)}

        {onPlanItem === undefined ? null : (
          <SettingRow
            label="Plan this item"
            icon={Diamond}
            iconTone="neutral"
            density="compact"
            separated
            opens
            onPress={() => {
              close();
              const draftTitle = title.trim();
              const draftNote = note.trim();
              /*
               * The drafts are the truth the user is looking at — the field is seeded from
               * the row and kept in sync, so a blank note draft means the item has no note
               * *now* (including one the user just cleared; falling back to the stored row
               * would resurrect it into the Plan). Title differs: blank is not a valid
               * title, so a cleared title falls back rather than bridging an invalid one.
               */
              onPlanItem({
                title: draftTitle === '' ? item.title : draftTitle,
                ...(draftNote === '' ? {} : { note: draftNote }),
              });
            }}
            testID="item-sheet-plan"
          />
        )}

        <SettingRow
          label="Delete item"
          icon={Trash}
          iconTone="danger"
          density="compact"
          danger
          separated
          onPress={() => {
            actions.remove(item);
            onClose();
          }}
          testID="item-sheet-delete"
        />
      </View>
    </Sheet>
  );
}
