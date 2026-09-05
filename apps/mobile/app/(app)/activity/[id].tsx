import type { ActivityDetailTarget } from '@od/shared/types';
import { useNavigation, usePreventRemove } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { ActivityDetailScreen } from '@/features/activity/components/ActivityDetailScreen';
import { AttachmentPickerSheet } from '@/features/attachments/components/AttachmentPickerSheet';
import { AddListToPlanSheet } from '@/features/lists/components/AddListToPlanSheet';
import { DestinationSheet } from '@/features/lists/components/DestinationSheet';
import { useViewer } from '@/hooks/useViewer';
import { followUpNavigation } from '@/lib/followUpNavigation';
import { activityKey } from '@/lib/queryKeys';
import { getActiveNativeState } from '@/lib/sqlite/nativeState';
import { useComposeDraft } from '@/stores/composeDraft';

/**
 * `/activity/:id` (P1-26).
 *
 * Thin by rule (`tech-stack.md` §3.2): read the param, resolve today, render one feature
 * component. `today` is resolved **here** rather than inside the screen because
 * `coding-standards.md` §4.3 bans implicit-now calls in pure logic and in anything that has
 * to be testable — the route is the edge, so this is where the real clock is allowed to be
 * read. When `packages/shared/src/time/` and its `useClock()` provider land, this line is
 * the only one that changes.
 */
export default function ActivityDetailRoute() {
  const { id, resolvePassed, occurrenceDate } = useLocalSearchParams<{
    id: string;
    resolvePassed?: string;
    occurrenceDate?: string;
  }>();
  const router = useRouter();
  const navigation = useNavigation();
  const [notesGuard, setNotesGuard] = useState({
    blocked: false,
    requestLeave: (leave: () => void) => leave(),
  });
  usePreventRemove(notesGuard.blocked, ({ data }) => {
    notesGuard.requestLeave(() => navigation.dispatch(data.action));
  });
  useEffect(() => {
    if (Platform.OS !== 'web' || !notesGuard.blocked || typeof window === 'undefined')
      return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
  }, [notesGuard.blocked]);
  const openPrepTask = useComposeDraft((s) => s.openPrepTask);
  // `Add list` (P3-39): the sheet is composed here because features may not import each
  // other — the route is the point where the activity feature meets the lists feature.
  const [listSource, setListSource] = useState<{
    activityId: string;
    planTitle: string;
  }>();
  // `Add photo` (P3-41): same reason — the attachments feature meets the activity feature here.
  const [attachmentSheetOpen, setAttachmentSheetOpen] = useState(false);
  // P3-43: the Meal's ingredient destination — this operation's one-off choice lives here.
  const [ingredientDestination, setIngredientDestination] = useState<string>();
  const [choosingDestination, setChoosingDestination] = useState(false);
  const queryClient = useQueryClient();
  // The owner-only photo actions need to know who is looking; a direct route load has not
  // passed through a tab that fills `['me']`, so the route asks (P3-42).
  useViewer();
  const activityId = id ?? '';
  const target: ActivityDetailTarget =
    occurrenceDate === undefined
      ? { kind: 'activity', activityId }
      : { kind: 'occurrence', activityId, date: occurrenceDate };

  return (
    <>
      <ActivityDetailScreen
        key={JSON.stringify(target)}
        target={target}
        onNotesGuardChange={setNotesGuard}
        followUp={followUpNavigation(router)}
        today={format(new Date(), 'yyyy-MM-dd')}
        onBack={() => router.back()}
        {...(resolvePassed === '1'
          ? {
              resolutionOccurrenceDate: occurrenceDate ?? null,
              onResolutionProjectionChange: (resolved: boolean) =>
                router.setParams({ resolvePassed: resolved ? '0' : '1' }),
            }
          : {})}
        /**
         * `replace`, not `push`: the copy takes the original's place in the stack, so Back from
         * it returns where the user came from rather than to the row they just duplicated. Two
         * detail screens for two versions of one thing is a stack nobody asked for.
         */
        onOpenActivity={(next) => router.replace(`/activity/${next}` as Href)}
        // The LISTS and PREP rows (P3-37): a plan's own List or child is somewhere the user
        // goes and comes **back** from, so `push`, unlike the duplicate's replace above.
        onOpenList={(listId) => router.push(`/lists/${listId}` as Href)}
        onOpenChild={(childId) => router.push(`/activity/${childId}` as Href)}
        // `+ Add prep task` (P3-38): the parent fixes the relationship; the modal opens on the
        // Task form directly, never the global chooser.
        onAddPrepTask={() => {
          openPrepTask(activityId);
          router.push('/compose');
        }}
        onAddList={(planTitle) => setListSource({ activityId, planTitle })}
        onAddAttachment={() => setAttachmentSheetOpen(true)}
        ingredientDestination={ingredientDestination}
        onChooseIngredientDestination={() => setChoosingDestination(true)}
      />
      <DestinationSheet
        open={choosingDestination}
        slot="groceries"
        current={ingredientDestination}
        onChoose={setIngredientDestination}
        onClose={() => setChoosingDestination(false)}
      />
      {/* The parent detail's refresh rides the process-wide MutationCache seam
          (`refreshActivityDetails` on the sourced `['list','create']`), not this route. */}
      {listSource === undefined ? null : (
        <AddListToPlanSheet
          open
          source={listSource}
          onClose={() => setListSource(undefined)}
        />
      )}
      {/* Each confirmed photo reconciles through the detail owner for this platform. */}
      <AttachmentPickerSheet
        open={attachmentSheetOpen}
        activityId={activityId}
        onClose={() => setAttachmentSheetOpen(false)}
        onConfirmed={(attachment) => {
          const native = getActiveNativeState();
          if (native === undefined) {
            void queryClient.invalidateQueries({ queryKey: activityKey(activityId) });
            return;
          }
          void native.sync
            .pullActivity({ kind: 'activity', activityId: attachment.activityId })
            .catch((error: unknown) => {
              if (__DEV__) {
                console.info('native_attachment_reconciliation_failed', {
                  activityId: attachment.activityId,
                  message: error instanceof Error ? error.message : String(error),
                });
              }
            });
        }}
      />
    </>
  );
}
