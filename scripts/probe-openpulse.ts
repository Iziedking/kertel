/**
 * What OpenPulse actually returns, paid for once.
 *
 * The adapters were written defensively because these payloads had not been
 * bought when they were written. This buys one of each so the shapes can be
 * pinned to what really arrives rather than to what seemed plausible.
 */
process.loadEnvFile?.(".env");

import { createLiveX402Client } from "../packages/x402/src/live.js";
import { sha256 } from "../apps/telt/src/infra/hash.js";

const ENDPOINTS = [
  ["sentiment", "https://safety.openpulsechain.com/api/v1/sentiment/ETH"],
  ["safety", "https://safety.openpulsechain.com/api/v1/token/0x4200000000000000000000000000000000000006/safety"],
] as const;

async function main(): Promise<void> {
  const key = process.env["TELT_X402_PRIVATE_KEY"];
  if (key === undefined || key === "") {
    console.log("no wallet configured; nothing to buy with");
    return;
  }
  const client = createLiveX402Client({ privateKey: key, hash: sha256 });

  for (const [name, url] of ENDPOINTS) {
    console.log(`\n=== ${name} ===`);
    const quote = await client.quote({ providerId: "openpulse", endpointId: `openpulse:${name}`, url, method: "GET" });
    if (!quote.ok) {
      console.log("quote refused:", quote.error.code, quote.error.detail);
      continue;
    }
    console.log("quote keys:", Object.keys(quote.value).join(", "));
    console.log(JSON.stringify(quote.value, (_k, v) => (typeof v === "bigint" ? String(v) : v), 2).slice(0, 900));
  }
}

void main().catch((cause: unknown) => { console.error(cause); process.exitCode = 1; });
