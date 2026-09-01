import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { ListDetailScreen } from '@/features/lists/components/ListDetailScreen';
import { useComposeDraft } from '@/stores/composeDraft';

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
 *
 * `onPlanItem` (P3-34) is the route acting as the composition point between two features that
 * must not import each other: the lists screen hands over a structural copy source, and this
 * file enters the compose store's bridge flow and pushes the modal. The store opens on the
 * unselected Plan-kind step; nothing from the source selects anything.
 */
export default function ListDetailRoute() {
  const { listId } = useLocalSearchParams<{ listId: string }>();
  const router = useRouter();
  const openPlanForItem = useComposeDraft((s) => s.openPlanForItem);

  if (listId === undefined) return null;

  return (
    <ListDetailScreen
      listId={listId}
      onBack={() => router.back()}
      onOpenActivity={(activityId) => router.push(`/activity/${activityId}` as Href)}
      onPlanItem={({ listId: sourceListId, featureConfig, item }) => {
        openPlanForItem({
          listId: sourceListId,
          itemId: item.itemId,
          list: { featureConfig },
          item: {
            title: item.title,
            ...(item.note === undefined ? {} : { note: item.note }),
            ...(item.features === undefined ? {} : { features: item.features }),
            state: item.state,
          },
        });
        router.push('/compose');
      }}
    />
  );
}
