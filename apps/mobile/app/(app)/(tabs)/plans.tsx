import { useRouter } from 'expo-router';
import { PlansScreen } from '@/features/agenda/components/PlansScreen';
import { useComposeDraft } from '@/stores/composeDraft';

/**
 * Plans Upcoming: the bounded multi-day agenda projection introduced in P2-32.
 *
 * Thin by rule (`tech-stack.md` §3.2): it resolves navigation and renders one component.
 */
export default function PlansTab() {
  const router = useRouter();
  const openDraft = useComposeDraft((s) => s.open);

  return (
    <PlansScreen
      onOpen={(activityId) => router.push(`/activity/${activityId}`)}
      onAdd={() => {
        openDraft();
        router.push('/compose');
      }}
    />
  );
}
