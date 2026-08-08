/// <reference types="expo/types" />

// Expo's own `expo-env.d.ts` carries this same reference, and Expo **regenerates and
// git-ignores it**: running `expo start` rewrites the file and writes an `apps/mobile/.gitignore`
// entry for it. P0-19 committed that file so `pnpm typecheck` would work in CI without
// anyone having started Expo first; P0-22 found that Expo simply undoes that on the next
// dev-server run, leaving a dirty tree and a decision that only holds until someone opens
// the app.
//
// So the reference lives here instead, in a file Expo does not manage. CI keeps its types —
// `__DEV__` in `src/lib/apiClient.ts` is one of them — the generated file stays generated,
// and nothing has to be re-litigated after every `expo start`.
