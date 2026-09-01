import { MAX_UPDATE_BODY_LEN } from '@od/shared/constants';
import type { ActivityUpdate } from '@od/shared/types';
import { Button, Field, Text, useTheme } from '@od/ui';
import { useState } from 'react';
import { View } from 'react-native';
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
  errorMessage,
}: UpdatesSectionProps) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const { shown, showAllCount } = peekRows(updates, expanded);

  async function submit() {
    if (onPost === undefined || draft.trim() === '' || isPosting) return;
    const posted = await onPost(draft);
    if (posted) {
      setDraft('');
      setComposing(false);
    }
  }

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
          {...(onDelete === undefined || update.kind !== 'user'
            ? {}
            : { onDelete: () => onDelete(update) })}
        />
      ))}
      {showAllCount === undefined ? null : (
        <ActionRow
          label={`Show all ${showAllCount}`}
          accessibilityLabel={`Show all ${showAllCount}`}
          variant="subhead"
          onPress={() => setExpanded(true)}
          testID="updates-show-all"
        />
      )}
      {expanded && hasOlder && onLoadOlder !== undefined ? (
        <ActionRow
          label={isLoadingOlder ? 'Loading…' : 'Show earlier updates'}
          accessibilityLabel="Show earlier updates"
          variant="subhead"
          onPress={onLoadOlder}
          disabled={isLoadingOlder}
          testID="updates-load-older"
        />
      ) : null}
      {onPost === undefined ? null : composing ? (
        <View style={{ gap: theme.space[3] }} testID="update-composer">
          <Field
            label="Update"
            accessibilityLabel="Update"
            value={draft}
            onChangeText={setDraft}
            autoFocus
            maxLength={MAX_UPDATE_BODY_LEN}
            testID="update-composer-body"
          />
          <View style={{ flexDirection: 'row', gap: theme.space[3] }}>
            <Button
              label="Cancel"
              variant="ghost"
              onPress={() => {
                setDraft('');
                setComposing(false);
              }}
              testID="update-composer-cancel"
            />
            <View style={{ flex: 1 }}>
              <Button
                label="Post update"
                onPress={() => void submit()}
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
          onPress={() => setComposing(true)}
          testID="updates-add"
        />
      )}
    </SectionFrame>
  );
}
