import { EmptyState } from '@od/ui';
import { TabScreen } from '@/components/TabScreen';

/** Lists. Phase 3 (P3-01 onward) fills it; the tab exists now so the three nouns are stable. */
export default function ListsTab() {
  return (
    <TabScreen title="Lists" testID="lists-screen">
      <EmptyState heading="No lists yet" body="Lists arrive in Phase 3." />
    </TabScreen>
  );
}
