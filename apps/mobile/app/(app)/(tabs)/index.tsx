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
      onAdd={() => {
        openDraft();
        router.push('/compose');
      }}
      onAddTask={(date) => {
        openTodayTask(date);
        router.push('/compose');
      }}
      onOpenAnytime={() => router.push('/anytime')}
      onOpenAgendaItem={({ activityId, occurrenceDate, isPast, status }) =>
        router.push(
          (isPast && status === 'scheduled'
            ? {
                pathname: '/activity/[id]',
                params: {
                  id: activityId,
                  resolvePassed: '1',
                  ...(occurrenceDate === undefined ? {} : { occurrenceDate }),
                },
              }
            : `/activity/${activityId}`) as Href,
        )
      }
    />
  );
}
