import { useRouter } from 'expo-router';
import { PlansScreen } from '@/features/plans/components/PlansScreen';
import { useComposeDraft } from '@/stores/composeDraft';

/**
 * Plans — the flat activity list from P1-16, the one real screen in this phase's shell.
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
