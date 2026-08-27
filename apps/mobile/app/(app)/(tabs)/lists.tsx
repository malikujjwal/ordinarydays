import { type Href, useRouter } from 'expo-router';
import { ListsScreen } from '@/features/lists/components/ListsScreen';
import { useListIndexMutations } from '@/features/lists/hooks/useListIndexMutations';

/**
 * `/lists` — the Lists tab (P3-25).
 *
 * Thin by rule (`tech-stack.md` §3.2): read the clock, own the mutations, render one feature
 * component. `now` is resolved **here** because `coding-standards.md` §4.3 keeps the real clock
 * at the edge; every card's `Updated today` line is computed from the value this passes down.
 *
 * ## The mutations live here, and creation does not
 *
 * Archive, restore and delete are settings writes on a row the index already holds, so the tab
 * owns them. **Creation is not here at all** — `+ New list` opens P3-26's route and this file
 * creates nothing, which is what keeps the read path and the durable-create path from growing
 * into each other before P3-26 gives the second one an outbox.
 *
 * The platform-resolved mutation hook keeps web online-first and makes native actions durable
 * through SQLite plus the transactional outbox. This route remains unaware of either adapter.
 */
export default function ListsTab() {
  const router = useRouter();
  const { onArchive, onRestore, onDelete } = useListIndexMutations();

  return (
    <ListsScreen
      now={new Date()}
      onOpenList={(listId) => router.push(`/lists/${listId}` as Href)}
      onNewList={() => router.push('/lists/new' as Href)}
      onArchive={onArchive}
      onRestore={onRestore}
      onDelete={onDelete}
    />
  );
}
