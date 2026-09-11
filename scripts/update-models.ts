#!/usr/bin/env bun
/**
 * Developer script to manually download and refresh the models.dev catalog.
 *
 * Usage:
 *   bun scripts/update-models.ts
 *   bun scripts/update-models.ts --force
 *   bun scripts/update-models.ts --ttl=24h
 */

import { refreshModelCatalog, getCatalogStatus } from "../src/index.ts";

const args = process.argv.slice(2);
const force = args.includes("--force") || !args.some((a) => a.startsWith("--ttl"));

let customTtlMs: number | undefined;
for (const arg of args) {
  if (arg.startsWith("--ttl=")) {
    const val = arg.slice(6);
    if (val.endsWith("h")) {
      customTtlMs = parseFloat(val) * 60 * 60 * 1000;
    } else if (val.endsWith("m")) {
      customTtlMs = parseFloat(val) * 60 * 1000;
    } else {
      customTtlMs = parseFloat(val);
    }
  }
}

console.log("\x1b[36m[Agent Accelerator]\x1b[0m Checking models catalog from https://models.dev/api.json...");
const startTime = Date.now();

try {
  const result = await refreshModelCatalog({ force, ttlMs: customTtlMs });
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  const ttlHours = (result.ttlMs / (1000 * 60 * 60)).toFixed(1);

  if (result.fromCache) {
    console.log(
      `\x1b[32m✓\x1b[0m Models catalog is already fresh (within ${ttlHours}h TTL).`
    );
  } else {
    console.log(
      `\x1b[32m✓\x1b[0m Successfully downloaded and cached \x1b[1m${result.modelCount.toLocaleString()}\x1b[0m models ` +
      `across \x1b[1m${result.providerCount}\x1b[0m providers in ${duration}s.`
    );
  }
  console.log(`  \x1b[90mCache location: ${result.cachePath}\x1b[0m`);
  console.log(`  \x1b[90mTTL: ${ttlHours} hours\x1b[0m`);
  if (result.expiresAt) {
    console.log(`  \x1b[90mNext refresh after: ${new Date(result.expiresAt).toLocaleString()}\x1b[0m`);
  }
} catch (error: any) {
  console.error(`\x1b[31m✖ Failed to refresh model catalog:\x1b[0m`, error.message || error);
  process.exit(1);
}
