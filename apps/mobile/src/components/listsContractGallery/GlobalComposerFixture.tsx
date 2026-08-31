import { useEffect } from 'react';
import { ComposeScreen } from '@/features/compose/components/ComposeScreen';
import { useComposeDraft } from '@/stores/composeDraft';

/** Global List-item composer with a deterministic unselected destination catalogue. */
export function GlobalComposerFixture() {
  const openDraft = useComposeDraft((state) => state.open);
  const chooseObject = useComposeDraft((state) => state.chooseObject);
  const setTitle = useComposeDraft((state) => state.setTitle);
  const setNotes = useComposeDraft((state) => state.setNotes);

  useEffect(() => {
    openDraft();
    chooseObject('listItem');
    setTitle('Try Zahav');
    setNotes('Ask about the tasting menu');
  }, [chooseObject, openDraft, setNotes, setTitle]);

  return (
    <ComposeScreen
      onClose={() => {}}
      today="2026-08-28"
      timezone="America/New_York"
      listDestinations={{
        lists: [
          { listId: 'lst_gallery_groceries', title: 'Groceries' },
          { listId: 'lst_gallery_restaurants', title: 'Restaurants to try' },
        ],
        status: 'success',
        refetch: () => {},
      }}
      onCreateList={() => {}}
    />
  );
}
