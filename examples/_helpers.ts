// Small helpers the examples share. No side effects, so the offline demos can import them
// (`_shared.ts` sets the model list of the live examples and must not be imported by them).
import { telemetryBus } from "agent-accelerator";

/** Prints one line on stderr and exits with code 1. */
export const fail = (err: unknown): never => {
  console.error(`\n✖ ${(err as { message?: string } | undefined)?.message ?? err}\n`);
  process.exit(1);
};

/** Prints a check mark, or ends the demo with code 1 when the contract does not hold. */
export function check(ok: boolean, what: string): void {
  if (!ok) fail(new Error(`contract broken: ${what}`));
  console.log(`✓ ${what}`);
}

/** The model after `--live`, or undefined for the offline run; `--live` without a model fails (`example` is the hint). */
export function liveModel(example: string): string | undefined {
  const at = process.argv.indexOf("--live");
  if (at < 0) return undefined;
  const model = process.argv[at + 1];
  if (!model) fail(new Error(`--live needs a model, e.g. --live ${example}`));
  return model;
}

/** What a `scheduled_action.delivered` event carries: the action, its run file and how the run ended. */
export type Delivery = { id: string; file: string; status: string };

/** Resolves with the next delivery of the scheduled action `id`; rejects after `ms`. */
export function nextDelivery(id: string, ms = 30_000): Promise<Delivery> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out after ${ms / 1000}s waiting for the delivery of ${id}`));
    }, ms);
    const off = telemetryBus.onEvent((e) => {
      const data = e.data as Delivery | undefined;
      if (e.code !== "scheduled_action.delivered" || data?.id !== id) return;
      clearTimeout(timer);
      off();
      resolve(data);
    });
  });
}
