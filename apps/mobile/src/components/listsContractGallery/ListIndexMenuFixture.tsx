import { ListIndexMenu } from '@/features/lists/components/ListIndexMenu';
import { OverviewFixture } from './OverviewFixture';

/** Compact Lists-index action menu over production index content. */
export function ListIndexMenuFixture() {
  return (
    <>
      <OverviewFixture />
      <ListIndexMenu
        open
        onClose={() => {}}
        showingArchived
        archivedCount={3}
        onToggleArchived={() => {}}
      />
    </>
  );
}
