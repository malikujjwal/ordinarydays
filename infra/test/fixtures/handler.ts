/**
 * A trivial entry point for the `NodeLambda` assertion tests.
 *
 * `NodejsFunction` bundles its entry with esbuild at synth time, so a construct test needs
 * a real file to point at. `services/api/src/index.ts` does not exist until P0-13, and
 * pointing a test at the API's entry would couple this construct's tests to the API's build
 * anyway.
 */
export const handler = async (): Promise<{ statusCode: number }> => {
  return { statusCode: 200 };
};
