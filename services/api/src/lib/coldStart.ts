/**
 * Process-lifetime cold-start flag shared by health and the request logger.
 *
 * Lambda (and `tsx watch`) create a fresh module graph per execution environment. The first
 * request that graph serves is a cold start; every later request on the same graph is warm.
 * Health reports the value in its body; the request logger records the same bit on the
 * completion line. One module owns the bit so the two cannot disagree.
 */
let coldStart = true;

export function readColdStart(): boolean {
  return coldStart;
}

export function markWarm(): void {
  coldStart = false;
}
