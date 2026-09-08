/**
 * What OpenPulse actually returns, paid for once.
 *
 * The adapters in `packages/providers/src/openpulse.ts` were written against a
 * plausible shape, because the endpoints were confirmed to exist and to charge
 * before anyone had paid to see a success payload. They read defensively as a
 * result: an unrecognised field returns null rather than a guess.
 *
 * This buys one of each so those shapes can be pinned to what really arrives.
 *
 * IT SPENDS REAL MONEY — about two cents, from the wallet in TELT_X402_PRIVATE_KEY.
 * That is the point of it, and it is why it is a script you run deliberately
 * rather than part of the test suite.
 *
 *   npx tsx scripts/probe-openpulse.ts
 */

process.loadEnvFile?.(".env");

import { createLiveX402Client } from "../packages/x402/src/live.js";
import { sha256 } from "../apps/telt/src/infra/hash.js";

const ENDPOINTS = [
  ["sentiment", "https://safety.openpulsechain.com/api/v1/sentiment/ETH"],
  [
    "safety",
    "https://safety.openpulsechain.com/api/v1/token/0x4200000000000000000000000000000000000006/safety",
  ],
] as const;

async function main(): Promise<void> {
  const key = process.env["TELT_X402_PRIVATE_KEY"];
  if (key === undefined || key.trim() === "") {
    console.log("No TELT_X402_PRIVATE_KEY, so there is nothing to buy with.");
    return;
  }

  const client = createLiveX402Client({ privateKey: key, hash: sha256 });
  let spentAtoms = 0n;

  for (const [name, url] of ENDPOINTS) {
    console.log(`\n=== ${name} ===`);
    const request = { providerId: "openpulse" as const, endpointId: `openpulse:${name}`, url, method: "GET" as const };

    const quote = await client.quote(request);
    if (!quote.ok) {
      console.log("quote refused:", quote.error.code, "-", quote.error.detail);
      continue;
    }
    if (quote.value.kind !== "payment_required") {
      console.log("no charge for this one:", quote.value.kind);
      continue;
    }

    const q = quote.value.quote;
    console.log(
      `price ${String(q.amount.atoms)}e-${String(q.amount.scale)} on ${q.rail}, paying ${q.payTo}`,
    );

    // The approval a human would normally give. Here the script is the human,
    // and it approves exactly what the live challenge asked for and no more.
    const paid = await client.pay(request, {
      quote: q,
      approvedAmount: q.amount,
      approvedAt: Date.now(),
    });

    if (!paid.ok) {
      console.log("payment refused:", paid.error.code, "-", paid.error.detail);
      continue;
    }

    spentAtoms += q.amount.atoms;
    console.log("settled tx:", paid.value.settlement?.transaction ?? "(the facilitator reported none)");
    console.log("PAYLOAD:");
    console.log(JSON.stringify(paid.value.body, null, 2).slice(0, 1500));
  }

  console.log(`\nSpent ${String(spentAtoms)} cents in total.`);
  console.log("Paste the payloads back so the adapters can be pinned to the real field names.");
}

void main().catch((cause: unknown) => {
  console.error(cause);
  process.exitCode = 1;
});
