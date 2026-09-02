import { useRouter } from 'expo-router';
import { AnytimeScreen } from '@/features/agenda/components/AnytimeScreen';
import { followUpNavigation } from '@/lib/followUpNavigation';

/** P2-19 registers this pushed route; P2-39 replaces the loading stub with its list. */
export default function AnytimeRoute() {
  const router = useRouter();
  return (
    <AnytimeScreen
      followUp={followUpNavigation(router)}
      onBack={() => router.back()}
      onOpenAgendaItem={({ activityId }) => router.push(`/activity/${activityId}`)}
    />
  );
}
