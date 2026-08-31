import type { ListItemPlanState, ListItemView } from '@od/shared/types';
import { Checkbox, Chip, Text, Touchable, type as typeScale, useTheme } from '@od/ui';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
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
  onOpen,
  onToggleChecked,
  onOpenLocation,
  onOpenPlan,
  testID,
}: ListItemRowProps) {
  const theme = useTheme();
  const checkable = showsCheckbox(list);
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
  const stage = stateLabel(list, item);
  const progress = progressLabel(list, item);
  const subItems = subItemCount(list, item);
  const stateLine = mayShowPlanStateLine(viewerPlan) ? planStateLine : undefined;
  const id = (suffix: string) =>
    testID === undefined ? {} : { testID: `${testID}-${suffix}` };
  const dimmed = checkable && checked;
  /**
   * The Today row grammar, adopted whole (founder, 2026-08-31): no divider — spacing does
   * the job the border used to do — `bodyStrong` titles over `footnote` metadata, and the
   * 44 pt leading control lifted so its 24 pt glyph centres on the title's first line
   * rather than on the row. The lift derivation is `AgendaRow`'s, from the same two tokens.
   */
  const leadingLift = (theme.layout.hitTarget - typeScale.bodyStrong.lineHeight) / 2;

  return (
    <View
      testID={testID}
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingTop: theme.space[4],
        paddingBottom: theme.space[4] + theme.space[1],
      }}
    >
      {checkable ? (
        <View style={{ marginTop: -leadingLift }}>
          <Checkbox
            checked={checked}
            label={checkboxLabel(item.title, checked)}
            disabled={onToggleChecked === undefined}
            {...(onToggleChecked === undefined ? {} : { onChange: toggleChecked })}
            {...id('checkbox')}
          />
        </View>
      ) : null}
      <View
        pointerEvents="box-none"
        style={{
          flex: 1,
          minWidth: 0,
          gap: theme.space[2],
          paddingLeft: checkable ? theme.space[2] : 0,
        }}
      >
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={rowBodyLabel(list, item)}
          disabled={onOpen === undefined}
          {...(onOpen === undefined ? {} : { onPress: onOpen })}
          {...id('body')}
          style={{
            alignItems: 'flex-start',
            alignSelf: 'stretch',
            justifyContent: 'flex-start',
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'baseline',
              flexWrap: 'wrap',
              gap: theme.space[2],
            }}
          >
            <Text
              variant="bodyStrong"
              color={dimmed ? 'textMuted' : 'textPrimary'}
              struck={dimmed}
            >
              {item.title}
            </Text>
            {item.sourceLabel === undefined ? null : (
              <Text variant="footnote" color="textMuted">{`— ${item.sourceLabel}`}</Text>
            )}
          </View>
          {item.note === undefined ? null : (
            <Text
              variant="footnote"
              color={dimmed ? 'textMuted' : 'textSecondary'}
              numberOfLines={1}
            >
              {item.note}
            </Text>
          )}
        </Touchable>

        {stage === undefined &&
        progress === undefined &&
        subItems === undefined ? null : (
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: theme.space[2],
            }}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            aria-hidden
            {...id('metadata')}
          >
            {stage === undefined ? null : <Chip label={stage} {...id('state')} />}
            {progress === undefined ? null : (
              <Text variant="footnote" color="textMuted">
                {progress}
              </Text>
            )}
            {subItems === undefined ? null : (
              <Text variant="footnote" color="textMuted">
                {subItems}
              </Text>
            )}
          </View>
        )}

        {place === undefined ? null : (
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={`${place.address ?? place.label}, open in Maps`}
            disabled={onOpenLocation === undefined}
            {...(onOpenLocation === undefined ? {} : { onPress: onOpenLocation })}
            {...id('location')}
            style={{ alignItems: 'flex-start', alignSelf: 'stretch' }}
          >
            <Text variant="footnote" color="textSecondary">
              {place.address ?? place.label}
            </Text>
          </Touchable>
        )}

        {stateLine === undefined ? null : (
          <Touchable
            accessibilityRole="link"
            accessibilityLabel={`${stateLine}, open plan`}
            disabled={onOpenPlan === undefined}
            {...(onOpenPlan === undefined ? {} : { onPress: onOpenPlan })}
            {...id('plan-state')}
            style={{ alignItems: 'flex-start', alignSelf: 'stretch' }}
          >
            <Text variant="subhead" color="accent">
              {stateLine}
            </Text>
          </Touchable>
        )}
      </View>
    </View>
  );
}
