import {
  MAX_ADDRESS_LEN,
  MAX_INGREDIENTS,
  MAX_NOTES_LEN,
  MAX_TITLE_LEN,
} from '@od/shared/constants';
import type { ListItemState, ListSubItem, ProgressValue } from '@od/shared/types';
import {
  Button,
  Check,
  ChevronDown,
  ChevronUp,
  Field,
  IconButton,
  interactionTiming,
  MapPin,
  MoreHorizontal,
  Plus,
  RowGroup,
  SettingRow,
  Sheet,
  Text,
  type Theme,
  Touchable,
  Trash,
  useTheme,
} from '@od/ui';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { newLocalId } from '@/lib/localIds';
import type { ListItemRow } from '@/lib/sqlite/listItemsRepository';
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
  testID?: string;
}

const STATES: readonly ListItemState[] = ['open', 'active', 'done'];
function useDebouncedAction() {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<(() => void) | undefined>(undefined);

  const cancel = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const flush = useCallback(() => {
    cancel();
    const action = pending.current;
    pending.current = undefined;
    action?.();
  }, [cancel]);
  const schedule = useCallback(
    (action: () => void) => {
      pending.current = action;
      cancel();
      timer.current = setTimeout(flush, interactionTiming.fieldAutosave);
    },
    [cancel, flush],
  );
  const now = useCallback(
    (action: () => void) => {
      pending.current = action;
      flush();
    },
    [flush],
  );

  useEffect(
    () => () => {
      cancel();
      pending.current = undefined;
    },
    [cancel],
  );

  return { schedule, flush, now } as const;
}

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
      justifyContent: 'center',
      gap: theme.space[1],
    },
    subItemFields: { flex: 1, minWidth: 0, gap: theme.space[1] },
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
      alignItems: 'center',
      gap: theme.space[2],
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
  });

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
  const styles = useMemo(() => createStyles(theme), [theme]);
  const actions = useListItemActions({
    onSaved: onChanged,
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
  const [editingPlace, setEditingPlace] = useState(false);
  const [subItems, setSubItems] = useState<readonly ListSubItem[]>(
    item.features?.subItems?.entries ?? [],
  );
  const [openSubItemMenu, setOpenSubItemMenu] = useState<string>();
  const [editingSubItem, setEditingSubItem] = useState<string>();
  const previousItem = useRef(item);
  const latestItem = useRef(item);
  const lastRequestedTitle = useRef(item.title);
  latestItem.current = item;
  const titleSave = useDebouncedAction();
  const noteSave = useDebouncedAction();
  const progressSave = useDebouncedAction();
  const placeSave = useDebouncedAction();
  const subItemsSave = useDebouncedAction();

  const close = () => {
    titleSave.flush();
    noteSave.flush();
    progressSave.flush();
    placeSave.flush();
    subItemsSave.flush();
    onClose();
  };

  const selectedSubItem = subItems.find((entry) => entry.id === openSubItemMenu);

  useEffect(() => {
    const previous = previousItem.current;
    const changedItem = previous.itemId !== item.itemId;
    if (changedItem || previous.title !== item.title) {
      lastRequestedTitle.current = item.title;
    }
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
    setTitle((current) =>
      changedItem || current === previous.title ? item.title : current,
    );
    setNote((current) =>
      changedItem || current === (previous.note ?? '') ? (item.note ?? '') : current,
    );
    setSubItems((current) =>
      changedItem || JSON.stringify(current) === JSON.stringify(previousSubItems)
        ? nextSubItems
        : current,
    );
    setProgressText((current) =>
      changedItem || current === previousProgressText ? nextProgressText : current,
    );
    setSeason((current) =>
      changedItem || current === previousSeason ? nextSeason : current,
    );
    setEpisode((current) =>
      changedItem || current === previousEpisode ? nextEpisode : current,
    );
    setAddingProgress((current) =>
      changedItem || current === (previousProgress !== undefined)
        ? nextProgress !== undefined
        : current,
    );
    setPlaceLabel((current) =>
      changedItem || current === (previousPlace?.label ?? '')
        ? (nextPlace?.label ?? '')
        : current,
    );
    setPlaceAddress((current) =>
      changedItem || current === (previousPlace?.address ?? '')
        ? (nextPlace?.address ?? '')
        : current,
    );
    setEditingPlace((current) => (changedItem ? false : current));
    previousItem.current = item;
  }, [item]);

  const commit = (patch: ReturnType<typeof titlePatch>) => {
    if (patch !== undefined) void actions.save(latestItem.current, patch);
  };
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
            value={progressText}
            onChangeText={(value) => {
              setProgressText(value);
              progressSave.schedule(() =>
                commit(
                  progressPatch(
                    latestItem.current,
                    value.trim() === ''
                      ? undefined
                      : { kind: 'text', value: value.trim() },
                  ),
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
                onChangeText={(value) => {
                  setSeason(value);
                  progressSave.schedule(() =>
                    commit(
                      progressPatch(latestItem.current, episodeValue(value, episode)),
                    ),
                  );
                }}
                onBlur={progressSave.flush}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Field
                label="Episode"
                value={episode}
                onChangeText={(value) => {
                  setEpisode(value);
                  progressSave.schedule(() =>
                    commit(
                      progressPatch(latestItem.current, episodeValue(season, value)),
                    ),
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
        <View style={styles.featureHeading}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="caption" color="textMuted">
              Place
            </Text>
          </View>
          {place === undefined || editingPlace ? null : (
            <Button
              label="Edit"
              accessibilityLabel="Edit place"
              variant="ghost"
              size="sm"
              flush
              onPress={() => setEditingPlace(true)}
            />
          )}
        </View>
        {editingPlace ? (
          <View style={{ gap: theme.space[3] }}>
            <Field
              label="Place"
              value={placeLabel}
              onChangeText={(value) => {
                setPlaceLabel(value);
                placeSave.schedule(() =>
                  commit(placePatch(latestItem.current, value, placeAddress)),
                );
              }}
              onBlur={placeSave.flush}
            />
            <Field
              label="Address"
              value={placeAddress}
              onChangeText={(value) => {
                setPlaceAddress(value);
                placeSave.schedule(() =>
                  commit(placePatch(latestItem.current, placeLabel, value)),
                );
              }}
              onBlur={placeSave.flush}
              maxLength={MAX_ADDRESS_LEN}
            />
          </View>
        ) : place === undefined ? (
          <SettingRow
            label="Place"
            value="Add"
            icon={MapPin}
            iconTone="neutral"
            density="compact"
            opens
            onPress={() => setEditingPlace(true)}
          />
        ) : (
          <SettingRow
            label={place.label.trim() || 'Place'}
            {...(place.address?.trim() ? { summary: place.address.trim() } : {})}
            icon={MapPin}
            iconTone="neutral"
            density="compact"
            opens
            onPress={() => setEditingPlace(true)}
          />
        )}
      </View>
    ),
    subItems: (config) => (
      <View key="subItems" testID="sub-items-editor">
        <View style={styles.subItemHeading}>
          <View style={{ flex: 1, minWidth: 0 }}>
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
            setOpenSubItemMenu(undefined);
            subItemsSave.now(() => commit(subItemsPatch(latestItem.current, next)));
          }}
          renderItem={(entry) => {
            const name = entry.title.trim() || config.singularLabel;
            return (
              <View testID={`sub-item-${entry.id}`} style={styles.subItem}>
                <View style={styles.subItemRow}>
                  {editingSubItem === entry.id ? (
                    <View style={styles.subItemFields}>
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
                            subItemsSave.schedule(() =>
                              commit(subItemsPatch(latestItem.current, next)),
                            );
                          }
                        }}
                        onBlur={() => {
                          const next = subItems.filter((row) => row.title.trim() !== '');
                          setSubItems(next);
                          if (!next.some((row) => row.id === entry.id)) {
                            setEditingSubItem(undefined);
                          }
                          subItemsSave.now(() =>
                            commit(subItemsPatch(latestItem.current, next)),
                          );
                        }}
                      />
                      {config.secondaryLabel === undefined ? null : (
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
                              subItemsSave.schedule(() =>
                                commit(subItemsPatch(latestItem.current, next)),
                              );
                            }
                          }}
                          onBlur={subItemsSave.flush}
                        />
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
                      <Text variant="subhead" color="textPrimary" numberOfLines={2}>
                        {name}
                      </Text>
                      {entry.secondary?.trim() ? (
                        <Text variant="footnote" color="textSecondary">
                          {entry.secondary}
                        </Text>
                      ) : null}
                    </Touchable>
                  )}
                  <IconButton
                    icon={MoreHorizontal}
                    label={`More actions for ${name}`}
                    onPress={() =>
                      setOpenSubItemMenu((current) =>
                        current === entry.id ? undefined : entry.id,
                      )
                    }
                    testID={`sub-item-${entry.id}-menu`}
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
    <>
      <Sheet
        open={open}
        onClose={close}
        title="Item details"
        detent="fit"
        testID={testID}
      >
        <View style={{ gap: theme.space[5], paddingBottom: theme.space[1] }}>
          <Field
            label="Title"
            value={title}
            onChangeText={(value) => {
              setTitle(value);
              const nextTitle = value.trim();
              if (nextTitle === '' || nextTitle === lastRequestedTitle.current) {
                // Replace a pending valid edit with an intentional no-op. In particular,
                // blurring an invalid blank and restoring the last requested title must not
                // issue the same PATCH again while its refresh is still on the way back.
                titleSave.schedule(() => undefined);
                return;
              }
              lastRequestedTitle.current = nextTitle;
              titleSave.schedule(() => {
                const current = latestItem.current;
                const patch = titlePatch(current, value);
                if (patch === undefined) return;
                void actions.save(current, patch).then((accepted) => {
                  if (!accepted && lastRequestedTitle.current === nextTitle) {
                    lastRequestedTitle.current = latestItem.current.title;
                  }
                });
              });
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
              noteSave.schedule(() => commit(notePatch(latestItem.current, value)));
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
                    onPress: () => onOpenSource(provenance.sourceActivityId as string),
                  })}
            />
          )}

          {list.itemStateMode.mode === 'none' ? null : list.itemStateMode.mode ===
            'checkbox' ? (
            <RowGroup label="State" testID="item-state-editor">
              <SettingRow
                label={item.state === 'done' ? 'Mark as not done' : 'Mark as done'}
                summary={item.state === 'done' ? 'Completed' : 'Not completed'}
                icon={Check}
                iconTone="success"
                density="compact"
                onPress={() =>
                  void actions.save(item, {
                    state: item.state === 'done' ? 'open' : 'done',
                  })
                }
                testID="item-state-action"
              />
            </RowGroup>
          ) : (
            <RowGroup label="State" testID="item-state-editor">
              {STATES.map((state) => (
                <SettingRow
                  key={state}
                  label={stageLabels[state]}
                  selected={item.state === state}
                  onPress={() => void actions.save(item, { state })}
                />
              ))}
            </RowGroup>
          )}

          {visitEnabledFeatureEditors(list.featureConfig, item.features, featureEditors)}

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

      {!open || selectedSubItem === undefined ? null : (
        <Sheet
          open
          onClose={() => setOpenSubItemMenu(undefined)}
          title={`${selectedSubItem.title.trim() || 'Sub-item'} actions`}
          testID="sub-item-actions"
        >
          <View>
            <SettingRow
              label={`Move ${selectedSubItem.title.trim() || 'Sub-item'} up`}
              icon={ChevronUp}
              density="compact"
              disabled={subItems.indexOf(selectedSubItem) === 0}
              onPress={() => {
                const from = subItems.indexOf(selectedSubItem);
                const next = moveSubItem(subItems, from, from - 1);
                setSubItems(next);
                setOpenSubItemMenu(undefined);
                subItemsSave.now(() => commit(subItemsPatch(latestItem.current, next)));
              }}
            />
            <SettingRow
              label={`Move ${selectedSubItem.title.trim() || 'Sub-item'} down`}
              icon={ChevronDown}
              density="compact"
              disabled={subItems.indexOf(selectedSubItem) === subItems.length - 1}
              onPress={() => {
                const from = subItems.indexOf(selectedSubItem);
                const next = moveSubItem(subItems, from, from + 1);
                setSubItems(next);
                setOpenSubItemMenu(undefined);
                subItemsSave.now(() => commit(subItemsPatch(latestItem.current, next)));
              }}
            />
            <SettingRow
              label={`Remove ${selectedSubItem.title.trim() || 'Sub-item'}`}
              icon={Trash}
              density="compact"
              danger
              separated
              onPress={() => {
                const next = subItems.filter((entry) => entry.id !== selectedSubItem.id);
                setSubItems(next);
                setOpenSubItemMenu(undefined);
                subItemsSave.now(() => commit(subItemsPatch(latestItem.current, next)));
              }}
            />
          </View>
        </Sheet>
      )}
    </>
  );
}
