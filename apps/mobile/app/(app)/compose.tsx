import { useRouter } from 'expo-router';
import { ComposeScreen } from '@/features/compose/components/ComposeScreen';

/**
 * The Add flow, presented modally (P1-24).
 *
 * Thin by rule (`tech-stack.md` §3.2): it reads no params, owns no data, and renders one
 * feature component. The only thing it supplies is `onClose`, so `ComposeScreen` never has to
 * know it is a route — which is what lets Phase 9's share-sheet entry point mount the same
 * component from somewhere that is not a route at all.
 *
 * `router.back()` rather than a push to a tab: the modal must return to whichever tab opened
 * it, and pushing would rewrite the user's position in the stack.
 */
export default function ComposeRoute() {
  const router = useRouter();
  return <ComposeScreen onClose={() => router.back()} />;
}
