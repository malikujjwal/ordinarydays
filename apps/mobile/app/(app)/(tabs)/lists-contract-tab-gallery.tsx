import { useLocalSearchParams } from 'expo-router';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { ListsContractGalleryScreen } from '@/components/ListsContractGalleryScreen';

const CONTRACT_INSETS = { top: 0, right: 0, bottom: 34, left: 0 } as const;

/** Hidden development route: real tab chrome around deterministic Lists-index fixtures. */
export default function ListsContractTabGalleryRoute() {
  const params = useLocalSearchParams<{ frame?: string; scheme?: string }>();
  return (
    <SafeAreaInsetsContext.Provider value={CONTRACT_INSETS}>
      <ListsContractGalleryScreen
        {...(params.frame === undefined ? {} : { frame: params.frame })}
        {...(params.scheme === undefined ? {} : { scheme: params.scheme })}
      />
    </SafeAreaInsetsContext.Provider>
  );
}
