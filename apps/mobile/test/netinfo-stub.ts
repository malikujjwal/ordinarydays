export interface NetInfoState {
  type?: string;
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
}

let configured: unknown;
let listener: ((state: NetInfoState) => void) | undefined;

export function configuredNetInfo(): unknown {
  return configured;
}

export function resetConfiguredNetInfo(): void {
  configured = undefined;
  listener = undefined;
}

export function emitNetInfoState(state: NetInfoState): void {
  listener?.(state);
}

const netInfo = {
  configure: (configuration: unknown) => {
    configured = configuration;
  },
  addEventListener: (next: (state: NetInfoState) => void) => {
    listener = next;
    return () => {
      if (listener === next) listener = undefined;
    };
  },
};

export default netInfo;
