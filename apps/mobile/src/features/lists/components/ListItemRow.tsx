import type { ListItemPlanState, ListItemView } from '@od/shared/types';
import { Checkbox, Chip, MapPin, Text, Touchable, useTheme } from '@od/ui';
import type { Theme } from '@od/ui/theme';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  checkboxChecked,
  checkboxLabel,
  mayShowPlanStateLine,
  progressLabel,
  type RowList,
  rowBodyLabel,
  shownPlace,
  showsCheckbox,
  stateLabel,
  subItemCount,
} from '../model/listItemRow';

export interface ListItemRowProps {
  list: RowList;
  item: ListItemView;
  viewerPlan?: ListItemPlanState;
  planStateLine?: string;
  /** The unabbreviated spoken variant (`7:00 PM`), per `interaction-contract.md` §6.2. */
  planStateLineSpoken?: string;
  onOpen?: () => void;
  onToggleChecked?: (next: boolean) => boolean | undefined | Promise<boolean | undefined>;
  onOpenLocation?: () => void;
  onOpenPlan?: () => void;
  testID?: string;
}

export function ListItemRow({
  list,
  item,
  viewerPlan,
  planStateLine,
  planStateLineSpoken,
  onOpen,
  onToggleChecked,
  onOpenLocation,
  onOpenPlan,
  testID,
}: ListItemRowProps) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const checkable = showsCheckbox(list);
  const groupedStages =
    list.itemStateMode.mode === 'stages' && list.itemStateMode.groupByState;
  const committedChecked = checkboxChecked(item);
  const [checked, setChecked] = useState(committedChecked);
  const committedCheckedRef = useRef(committedChecked);
  const pendingToggles = useRef(0);
  const toggleRevision = useRef(0);
  const deferredCommittedUpdate = useRef(false);

  useEffect(() => {
    committedCheckedRef.current = committedChecked;
    /*
     * An acknowledgement for tap one may render while tap two is still being committed.
     * In that window the local value is newer than the prop. Replacing it here makes the
     * next physical tap invert the intermediate acknowledgement instead of what the person
     * can see they most recently chose (true → false → an unexpected false).
     */
    if (pendingToggles.current === 0) {
      setChecked(committedChecked);
      deferredCommittedUpdate.current = false;
    } else {
      deferredCommittedUpdate.current = true;
    }
  }, [committedChecked]);

  const toggleChecked = (next: boolean) => {
    const revision = toggleRevision.current + 1;
    toggleRevision.current = revision;
    pendingToggles.current += 1;
    setChecked(next);
    if (onToggleChecked === undefined) {
      pendingToggles.current -= 1;
      return;
    }
    void Promise.resolve(onToggleChecked(next))
      .then((accepted) => {
        if (accepted === false && toggleRevision.current === revision) {
          setChecked(committedCheckedRef.current);
        }
      })
      .catch(() => {
        if (toggleRevision.current === revision) {
          setChecked(committedCheckedRef.current);
        }
      })
      .finally(() => {
        pendingToggles.current = Math.max(0, pendingToggles.current - 1);
        if (pendingToggles.current === 0 && deferredCommittedUpdate.current) {
          deferredCommittedUpdate.current = false;
          setChecked(committedCheckedRef.current);
        }
      });
  };
  const place = shownPlace(list, item);
  const stage = groupedStages ? undefined : stateLabel(list, item);
  const progress = progressLabel(list, item);
  const subItems = subItemCount(list, item);
  const stateLine = mayShowPlanStateLine(viewerPlan) ? planStateLine : undefined;
  const id = (suffix: string) =>
    testID === undefined ? {} : { testID: `${testID}-${suffix}` };

  return (
    <View testID={testID} style={styles.row}>
      {checkable ? (
        <Checkbox
          checked={checked}
          label={checkboxLabel(item.title, checked)}
          disabled={onToggleChecked === undefined}
          {...(onToggleChecked === undefined ? {} : { onChange: toggleChecked })}
          {...id('checkbox')}
        />
      ) : groupedStages ? (
        <View
          aria-hidden
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          {...id('leading-marker')}
          style={styles.leading}
        >
          <View style={styles.marker} />
        </View>
      ) : null}
      <View pointerEvents="box-none" style={styles.content}>
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={rowBodyLabel(list, item)}
          disabled={onOpen === undefined}
          {...(onOpen === undefined ? {} : { onPress: onOpen })}
          {...id('body')}
          style={styles.body}
        >
          <View style={styles.titleGroup}>
            <View style={styles.titleBounds}>
              <Text
                variant="bodyStrong"
                color={checkable && checked ? 'textSecondary' : 'textPrimary'}
                struck={checkable && checked}
                numberOfLines={0}
                {...id('title')}
              >
                {item.title}
              </Text>
            </View>
            {item.sourceLabel === undefined ? null : (
              <Text variant="subhead" color="textMuted">{`— ${item.sourceLabel}`}</Text>
            )}
          </View>
          {item.note === undefined ? null : (
            <Text
              variant="subhead"
              color="textSecondary"
              numberOfLines={1}
              {...id('note')}
            >
              {item.note}
            </Text>
          )}
          {stage === undefined &&
          progress === undefined &&
          place === undefined &&
          subItems === undefined ? null : (
            <View
              style={styles.metadata}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              aria-hidden
              {...id('metadata')}
            >
              {stage === undefined ? null : <Chip label={stage} {...id('state')} />}
              {progress === undefined ? null : (
                <Text variant="subhead" color="textSecondary" {...id('progress')}>
                  {progress}
                </Text>
              )}
              {place === undefined ? null : (
                <Text variant="subhead" color="textSecondary" {...id('place')}>
                  {place.address ?? place.label}
                </Text>
              )}
              {subItems === undefined ? null : (
                <Text variant="subhead" color="textSecondary" {...id('sub-items')}>
                  {subItems}
                </Text>
              )}
            </View>
          )}
        </Touchable>

        {stateLine === undefined ? null : (
          <Touchable
            accessibilityRole="link"
            accessibilityLabel={`${planStateLineSpoken ?? stateLine}, open plan`}
            disabled={onOpenPlan === undefined}
            {...(onOpenPlan === undefined ? {} : { onPress: onOpenPlan })}
            {...id('plan-state')}
            style={styles.planState}
          >
            <Text variant="subhead" color="accent">
              {stateLine}
            </Text>
          </Touchable>
        )}
      </View>
      {place === undefined ? null : (
        <Touchable
          square
          accessibilityRole="button"
          accessibilityLabel={`${place.address ?? place.label}, open in Maps`}
          disabled={onOpenLocation === undefined}
          {...(onOpenLocation === undefined ? {} : { onPress: onOpenLocation })}
          {...id('location')}
          style={styles.maps}
        >
          <MapPin size={20} color={theme.colors.accent} />
        </Touchable>
      )}
    </View>
  );
}

function createStyles(theme: Theme) {
  return StyleSheet.create({
    row: {
      minHeight: theme.layout.rowMinHeight + theme.space[5],
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.space[3],
      paddingVertical: theme.space[4],
      marginRight: theme.space[3],
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.borderSubtle,
    },
    leading: {
      width: theme.layout.hitTarget,
      height: theme.layout.hitTarget,
      alignItems: 'center',
      justifyContent: 'center',
    },
    marker: {
      width: theme.space[4],
      height: theme.space[4],
      borderRadius: theme.radius.pill,
      backgroundColor: theme.colors.accent,
    },
    content: { flex: 1, minWidth: 0, gap: theme.space[3] },
    body: { alignItems: 'flex-start', alignSelf: 'stretch', gap: theme.space[2] },
    titleGroup: {
      maxWidth: '100%',
      flexDirection: 'row',
      alignItems: 'baseline',
      flexWrap: 'wrap',
      gap: theme.space[2],
    },
    titleBounds: { maxWidth: '100%' },
    metadata: {
      alignSelf: 'stretch',
      alignItems: 'flex-start',
      gap: theme.space[2],
    },
    planState: { alignItems: 'flex-start', alignSelf: 'stretch' },
    maps: { width: theme.layout.hitTarget, alignItems: 'center' },
  });
}
