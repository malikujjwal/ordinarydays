import { useLocalSearchParams } from 'expo-router';
import { ListsContractGalleryScreen } from '@/components/listsContractGallery/ListsContractGalleryScreen';

/** Development-only parameter adapter for the production-component Lists gallery. */
export default function ListsContractGalleryRoute() {
  const params = useLocalSearchParams<{ frame?: string; scheme?: string }>();
  return (
    <ListsContractGalleryScreen
      {...(params.frame === undefined ? {} : { frame: params.frame })}
      {...(params.scheme === undefined ? {} : { scheme: params.scheme })}
    />
  );
}
