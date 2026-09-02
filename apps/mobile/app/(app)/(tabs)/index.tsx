import { type Href, useRouter } from 'expo-router';
import { TodayScreen } from '@/features/agenda/components/TodayScreen';
import { useComposeDraft } from '@/stores/composeDraft';

/** Thin Today route: the feature owns the projection; this edge owns pushed navigation. */
export default function TodayTab() {
  const router = useRouter();
  const openDraft = useComposeDraft((state) => state.open);
  const openTodayTask = useComposeDraft((state) => state.openTodayTask);
  return (
    <TodayScreen
      followUp={{
        openActivity: (activityId) => router.push(`/activity/${activityId}`),
        openCompose: () => router.push('/compose'),
      }}
      onAdd={() => {
        openDraft();
        router.push('/compose');
      }}
      onAddTask={(date) => {
        openTodayTask(date);
        router.push('/compose');
      }}
      onOpenAnytime={() => router.push('/anytime')}
      /**
       * The occurrence travels **whenever the row has one**, not only on the passed-plan path.
       *
       * It used to ride along only with `resolvePassed`, so detail opened from a recurring row
       * knew which series it was looking at but not which day of it — and a completion recorded
       * there had no occurrence to attach to. Scope is a property of the row that was tapped;
       * the passed-plan prompt is a separate question about that same row.
       */
      onOpenAgendaItem={({ activityId, occurrenceDate, isPast, status }) =>
        router.push({
          pathname: '/activity/[id]',
          params: {
            id: activityId,
            ...(isPast && status === 'scheduled' ? { resolvePassed: '1' } : {}),
            ...(occurrenceDate === undefined ? {} : { occurrenceDate }),
          },
        } as Href)
      }
    />
  );
}
