import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { ListDetailScreen } from '@/features/lists/components/ListDetailScreen';

/**
 * `/lists/:listId` — one list and its items (P3-27).
 *
 * Thin by rule (`tech-stack.md` §3.2): it reads the route parameter, owns navigation, and
 * renders one feature component. Everything the screen writes — the inline add, the bulk
 * actions, archive, the item sheet's field edits — is behind hooks the screen resolves per
 * platform, so this file knows about neither SQLite nor TanStack.
 *
 * `onOpenActivity` is the item sheet's provenance row (P3-29, §7.5). `push`, not `replace`: the
 * source meal is somewhere the user goes and comes **back** from, unlike the duplicate that
 * takes an activity's place in the stack.
 */
export default function ListDetailRoute() {
  const { listId } = useLocalSearchParams<{ listId: string }>();
  const router = useRouter();

  if (listId === undefined) return null;

  return (
    <ListDetailScreen
      listId={listId}
      onBack={() => router.back()}
      onOpenActivity={(activityId) => router.push(`/activity/${activityId}` as Href)}
    />
  );
}
