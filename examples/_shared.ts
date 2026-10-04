export const fail = (err: any): never => {
  console.error(`\n\u2716 ${err?.message ?? err}\n`);
  process.exit(1);
};

// v0.4.0: provider warnings go to telemetry bus + optional sink (console.warn kept for compat).
// Attach in demos to show warnings without scraping stdout.
export function attachWarnSink(prefix = "[warn]"): void {
  (globalThis as any).__agentAccelWarnSink = (msg: string) => {
    console.log(`${prefix} ${msg}`);
  };
}
