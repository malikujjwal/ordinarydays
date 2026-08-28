import { useRouter } from 'expo-router';
import { NewListSheet } from '@/features/lists/components/NewListSheet';

/**
 * `/lists/new` — the template-first creation sheet (P3-26).
 *
 * Thin by rule (`tech-stack.md` §3.2): it owns navigation and nothing else. Both exits return
 * to the Lists index, where the list the user just made is already a row — on native because
 * the create committed its own visible row before syncing, on web because the mutation
 * invalidated the index query.
 *
 * The sheet itself takes `open`/`onClose`/`onCreated` rather than reaching for the router,
 * because P3-27's no-destination flow and P3-39's `Add list` open the same component from
 * inside their own surfaces, where there is no route to go back from.
 */
export default function NewListRoute() {
  const router = useRouter();

  return <NewListSheet open onClose={() => router.back()} />;
}
