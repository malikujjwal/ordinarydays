import { MAX_UPDATE_BODY_LEN } from '@od/shared/constants';
import type { ActivityUpdate } from '@od/shared/types';
import { Button, Field, Text, type Theme, useTheme } from '@od/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ActionRow } from '@/features/activity/components/ActionRow';
import { SectionFrame } from '@/features/activity/components/SectionFrame';
import { UpdateRow } from '@/features/activity/components/UpdateRow';
import { UpdateRowBody } from '@/features/activity/components/UpdateRowBody';
import type { PendingUpdate } from '@/features/activity/hooks/useActivityUpdates';
import { peekRows } from '@/features/activity/model/planSections';

/**
 * The plan's activity feed, newest first (P3-40, `plans-and-lists.md` §2.1 row 9).
 *
 * The first page arrives embedded in the detail response; older entries page through the
 * cursor **only when revealed** — `Show earlier updates` appears after the peek is expanded,
 * so opening a plan never issues a second request. The composer is one field whose final
 * action is `Post update`; posting is optimistic and the entry appears at the head without
 * reflowing the rest of the screen. A `system` entry renders de-emphasised with no author
 * name and no delete affordance — the entry text is the event.
 */
export interface UpdatesSectionProps {
  updates: readonly ActivityUpdate[];
  /** Optimistic entries awaiting their response, rendered at the head (P3-40). */
  pending?: readonly PendingUpdate[];
  /** `2 days ago` — derived by the caller so this component never reads a clock. */
  relativeTime: (createdAt: string) => string;
  /** P3-40's composer write; absent renders the read-only shell with no affordance. */
  onPost?: (body: string) => Promise<boolean>;
  isPosting?: boolean;
  /** Swipe/hover Delete on the caller's own `user` entries; never offered on `system`. */
  onDelete?: (update: ActivityUpdate) => void;
  /** Older-history continuation: present means more entries exist past the shown page. */
  hasOlder?: boolean;
  onLoadOlder?: () => void;
  isLoadingOlder?: boolean;
  /** Increments when the screen-owned scroll viewport reaches its pagination threshold. */
  paginationSignal?: number;
  /** §5.3 failure copy for the last post/delete/page that did not land. */
  errorMessage?: string;
}

export function UpdatesSection({
  updates,
  pending = [],
  relativeTime,
  onPost,
  isPosting = false,
  onDelete,
  hasOlder = false,
  onLoadOlder,
  isLoadingOlder = false,
  paginationSignal = 0,
  errorMessage,
}: UpdatesSectionProps) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [expanded, setExpanded] = useState(false);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const handledPaginationSignal = useRef(paginationSignal);
  const { shown, showAllCount } = peekRows(updates, expanded);

  const submit = useCallback(async () => {
    if (onPost === undefined || draft.trim() === '' || isPosting) return;
    const posted = await onPost(draft);
    if (posted) {
      setDraft('');
      setComposing(false);
    }
  }, [draft, isPosting, onPost]);
  const cancel = useCallback(() => {
    setDraft('');
    setComposing(false);
  }, []);
  const startComposing = useCallback(() => setComposing(true), []);
  const showAll = useCallback(() => setExpanded(true), []);
  const handleSubmit = useCallback(() => void submit(), [submit]);
  useEffect(() => {
    if (!expanded) {
      handledPaginationSignal.current = paginationSignal;
      return;
    }
    if (handledPaginationSignal.current === paginationSignal) return;
    handledPaginationSignal.current = paginationSignal;
    if (!hasOlder || isLoadingOlder || onLoadOlder === undefined) return;
    onLoadOlder();
  }, [expanded, hasOlder, isLoadingOlder, onLoadOlder, paginationSignal]);

  return (
    <SectionFrame
      label="Updates"
      trailing={String(updates.length + pending.length)}
      testID="section-updates"
    >
      {errorMessage === undefined ? null : (
        <View
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          testID="updates-error"
        >
          <Text variant="footnote" color="danger">
            {errorMessage}
          </Text>
        </View>
      )}
      {pending.map((entry) => (
        <UpdateRowBody
          key={entry.localId}
          body={entry.body}
          trailing="Just now"
          muted={false}
          testID={`update-pending-${entry.localId}`}
        />
      ))}
      {shown.map((update) => (
        <UpdateRow
          key={update.updateId}
          update={update}
          relativeTime={relativeTime(update.createdAt)}
          {...(onDelete === undefined || update.kind !== 'user' ? {} : { onDelete })}
        />
      ))}
      {showAllCount === undefined ? null : (
        <ActionRow
          label={`Show all ${showAllCount}`}
          accessibilityLabel={`Show all ${showAllCount}`}
          variant="subhead"
          onPress={showAll}
          testID="updates-show-all"
        />
      )}
      {onPost === undefined ? null : composing ? (
        <View style={styles.composer} testID="update-composer">
          <Field
            label="Update"
            accessibilityLabel="Update"
            value={draft}
            onChangeText={setDraft}
            autoFocus
            maxLength={MAX_UPDATE_BODY_LEN}
            testID="update-composer-body"
          />
          <View style={styles.actions}>
            <Button
              label="Cancel"
              variant="ghost"
              onPress={cancel}
              testID="update-composer-cancel"
            />
            <View style={styles.grow}>
              <Button
                label="Post update"
                onPress={handleSubmit}
                disabled={draft.trim() === ''}
                loading={isPosting}
                fullWidth
                testID="update-composer-post"
              />
            </View>
          </View>
        </View>
      ) : (
        <ActionRow
          label="+ Write an update"
          accessibilityLabel="Write an update"
          onPress={startComposing}
          testID="updates-add"
        />
      )}
    </SectionFrame>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    composer: { gap: theme.space[3] },
    actions: { flexDirection: 'row', gap: theme.space[3] },
    grow: { flex: 1 },
  });
