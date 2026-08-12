export interface NetInfoState {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
}

const netInfo = {
  addEventListener: (_listener: (state: NetInfoState) => void) => () => undefined,
};

export default netInfo;
