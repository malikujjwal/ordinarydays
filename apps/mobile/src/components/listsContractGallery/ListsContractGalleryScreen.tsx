import { ThemeProvider } from '@od/ui';
import { ContractFrame } from './ContractFrame';

export interface ListsContractGalleryScreenProps {
  frame?: string;
  scheme?: string;
}

/** Development-only production-component gallery for P3-33 screenshot contracts. */
export function ListsContractGalleryScreen({
  frame = 'overview',
  scheme = 'light',
}: ListsContractGalleryScreenProps) {
  const enabled = __DEV__ || process.env.EXPO_PUBLIC_CONTRACT_GALLERY === '1';
  if (!enabled) return null;
  return (
    <ThemeProvider scheme={scheme === 'dark' ? 'dark' : 'light'}>
      <ContractFrame frame={frame} />
    </ThemeProvider>
  );
}
