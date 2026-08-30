import {
  MAX_ADDRESS_LEN,
  MAX_INGREDIENTS,
  MAX_NOTES_LEN,
  MAX_TITLE_LEN,
} from '@od/shared/constants';
import type { ListItemState, ListSubItem, ProgressValue } from '@od/shared/types';
import {
  Button,
  Checkbox,
  Field,
  IconButton,
  MoreHorizontal,
  Plus,
  Row,
  RowGroup,
  SettingRow,
  Sheet,
  Text,
  type Theme,
  useTheme,
} from '@od/ui';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
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

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    subItem: {
      gap: theme.space[1],
      paddingVertical: theme.space[2],
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    subItemRow: {
      minHeight: theme.layout.rowMinHeight,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.space[2],
    },
    subItemFields: { flex: 1, minWidth: 0, gap: theme.space[1] },
    subItemActions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'flex-end',
      gap: theme.space[2],
    },
    deleteRow: {
      minHeight: theme.layout.hitTarget,
      justifyContent: 'center',
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
      paddingVertical: theme.space[3],
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
  const [addingPlace, setAddingPlace] = useState(place !== undefined);
  const [subItems, setSubItems] = useState<readonly ListSubItem[]>(
    item.features?.subItems?.entries ?? [],
  );
  const [openSubItemMenu, setOpenSubItemMenu] = useState<string>();
  const previousItem = useRef(item);

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
    setAddingPlace((current) =>
      changedItem || current === (previousPlace !== undefined)
        ? nextPlace !== undefined
        : current,
    );
    previousItem.current = item;
  }, [item]);

  const commit = (patch: ReturnType<typeof titlePatch>) => {
    if (patch !== undefined) void actions.save(item, patch);
  };
  const episodeValue = (): ProgressValue => {
    const seasonNumber = itemNumber(season);
    const episodeNumber = itemNumber(episode);
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
            onChangeText={setProgressText}
            onBlur={() =>
              commit(
                progressPatch(
                  item,
                  progressText.trim() === ''
                    ? undefined
                    : { kind: 'text', value: progressText.trim() },
                ),
              )
            }
          />
        ) : (
          <View style={{ flexDirection: 'row', gap: theme.space[3] }}>
            <View style={{ flex: 1 }}>
              <Field
                label="Season"
                value={season}
                onChangeText={setSeason}
                onBlur={() => commit(progressPatch(item, episodeValue()))}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Field
                label="Episode"
                value={episode}
                onChangeText={setEpisode}
                onBlur={() => commit(progressPatch(item, episodeValue()))}
              />
            </View>
          </View>
        )}
      </View>
    ),
    place: () => (
      <View key="place">
        {!addingPlace ? (
          <SettingRow
            label="Place"
            value="Add"
            opens
            onPress={() => setAddingPlace(true)}
          />
        ) : (
          <View style={{ gap: theme.space[3] }}>
            <Field
              label="Place"
              value={placeLabel}
              onChangeText={setPlaceLabel}
              onBlur={() => commit(placePatch(item, placeLabel, placeAddress))}
            />
            <Field
              label="Address"
              value={placeAddress}
              onChangeText={setPlaceAddress}
              onBlur={() => commit(placePatch(item, placeLabel, placeAddress))}
              maxLength={MAX_ADDRESS_LEN}
            />
          </View>
        )}
      </View>
    ),
    subItems: (config) => (
      <View key="subItems" style={{ gap: theme.space[3] }} testID="sub-items-editor">
        <Text variant="sectionLabel" color="textSecondary">
          {config.sectionLabel}
        </Text>
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
            commit(subItemsPatch(item, next));
          }}
          renderItem={(entry, index) => {
            const name = entry.title.trim() || config.singularLabel;
            const menuOpen = openSubItemMenu === entry.id;
            const move = (to: number) => {
              const next = moveSubItem(subItems, index, to);
              setSubItems(next);
              setOpenSubItemMenu(undefined);
              commit(subItemsPatch(item, next));
            };
            return (
              <View testID={`sub-item-${entry.id}`} style={styles.subItem}>
                <View style={styles.subItemRow}>
                  <View style={styles.subItemFields}>
                    <Field
                      label={config.singularLabel}
                      value={entry.title}
                      hideLabel
                      appearance="bare"
                      placeholder={config.singularLabel}
                      onChangeText={(value) =>
                        setSubItems((rows) =>
                          rows.map((row) =>
                            row.id === entry.id ? { ...row, title: value } : row,
                          ),
                        )
                      }
                      onBlur={() =>
                        commit(
                          subItemsPatch(
                            item,
                            subItems.filter((row) => row.title.trim() !== ''),
                          ),
                        )
                      }
                    />
                    {config.secondaryLabel === undefined ? null : (
                      <Field
                        label={config.secondaryLabel}
                        value={entry.secondary ?? ''}
                        hideLabel
                        appearance="bare"
                        textVariant="footnote"
                        placeholder={config.secondaryLabel}
                        onChangeText={(value) =>
                          setSubItems((rows) =>
                            rows.map((row) =>
                              row.id === entry.id ? { ...row, secondary: value } : row,
                            ),
                          )
                        }
                        onBlur={() => commit(subItemsPatch(item, subItems))}
                      />
                    )}
                  </View>
                  <IconButton
                    icon={MoreHorizontal}
                    label={`More actions for ${name}`}
                    onPress={() => setOpenSubItemMenu(menuOpen ? undefined : entry.id)}
                    testID={`sub-item-${entry.id}-menu`}
                  />
                </View>
                {menuOpen ? (
                  <View
                    style={styles.subItemActions}
                    testID={`sub-item-${entry.id}-actions`}
                  >
                    <Button
                      label={`Move ${name} up`}
                      accessibilityLabel={`Move ${name} up`}
                      variant="ghost"
                      size="sm"
                      disabled={index === 0}
                      onPress={() => move(index - 1)}
                    />
                    <Button
                      label={`Move ${name} down`}
                      accessibilityLabel={`Move ${name} down`}
                      variant="ghost"
                      size="sm"
                      disabled={index === subItems.length - 1}
                      onPress={() => move(index + 1)}
                    />
                    <Button
                      label={`Remove ${name}`}
                      variant="ghost"
                      size="sm"
                      onPress={() => {
                        const next = subItems.filter((_, at) => at !== index);
                        setSubItems(next);
                        setOpenSubItemMenu(undefined);
                        commit(subItemsPatch(item, next));
                      }}
                    />
                  </View>
                ) : null}
              </View>
            );
          }}
        />
        <Button
          label={`Add ${config.singularLabel}`}
          variant="ghost"
          size="sm"
          icon={Plus}
          flush
          disabled={subItems.length >= MAX_INGREDIENTS}
          onPress={() => setSubItems((rows) => appendSubItem(rows, newLocalId('sub')))}
        />
      </View>
    ),
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Item details"
      detent="large"
      testID={testID}
    >
      <View style={{ gap: theme.space[5] }}>
        <Field
          label="Title"
          value={title}
          onChangeText={setTitle}
          onBlur={() => commit(titlePatch(item, title))}
          maxLength={MAX_TITLE_LEN}
          testID="item-sheet-title"
        />
        <Field
          label="Note"
          optional
          value={note}
          onChangeText={setNote}
          onBlur={() => commit(notePatch(item, note))}
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
            <Row
              title="Done"
              leading={
                <Checkbox
                  checked={item.state === 'done'}
                  label="Done"
                  onChange={(checked) =>
                    void actions.save(item, { state: checked ? 'done' : 'open' })
                  }
                  testID="item-state-checkbox"
                />
              }
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

        <View style={styles.deleteRow}>
          <Button
            label="Delete item"
            variant="dangerGhost"
            size="sm"
            flush
            onPress={() => {
              actions.remove(item);
              onClose();
            }}
            testID="item-sheet-delete"
          />
        </View>
      </View>
    </Sheet>
  );
}
