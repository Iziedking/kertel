/**
 * Probe every x402 provider Telt can buy from, without paying any of them.
 *
 * Reading a 402 challenge is free and unauthenticated. This script does exactly
 * that: it asks each provider what a call would cost, checks the answer against
 * the pinned recipient, and prints what it found. It never signs anything, and
 * it works with no wallet configured.
 *
 * Run it before trusting a price, after any provider outage, and whenever
 * `packages/x402/src/constants.ts` is about to be edited. A `payTo` that has
 * moved is a stop, not an update.
 *
 *     npm run probe:providers
 *     npm run probe:providers -- --save    # refresh the committed fixtures
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as fp from "@telt/core/money";
import { MERCHANT_PINS, createLiveX402Client } from "@telt/x402";
import type { PaidRequest } from "@telt/x402";

const sha256 = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex");

/**
 * Every request Telt can make, built from a template.
 *
 * This list is the whole of what the product can buy. There is no path that
 * takes a URL from a model or from a WhatsApp message, which is why a compromised
 * prompt cannot make Telt pay an arbitrary endpoint.
 */
const PROBES: readonly PaidRequest[] = [
  {
    providerId: "coingecko",
    endpointId: "coingecko:simple/price",
    url: "https://pro-api.coingecko.com/api/v3/x402/simple/price?ids=ethereum&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_last_updated_at=true",
    method: "GET",
  },
  {
    providerId: "coinmarketcap",
    endpointId: "coinmarketcap:quotes/latest",
    url: "https://pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest?symbol=ETH&convert=USD",
    method: "GET",
  },
  {
    providerId: "nansen",
    endpointId: "nansen:smart-money/netflow",
    url: "https://api.nansen.ai/api/v1/smart-money/netflow",
    method: "POST",
    body: {
      parameters: { chains: ["ethereum"], smFilter: ["180D Smart Trader"] },
      pagination: { page: 1, recordsPerPage: 10 },
    },
  },
  {
    providerId: "thegraph",
    endpointId: "thegraph:subgraph/meta",
    url: "https://gateway.thegraph.com/api/x402/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV",
    method: "POST",
    body: { query: "{ _meta { block { number } } }" },
  },
];

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/x402/live-quotes/", import.meta.url));

async function main(): Promise<void> {
  const save = process.argv.includes("--save");

  // No key on purpose. Quoting must work with no wallet, and running this
  // script must never be able to spend anything.
  const client = createLiveX402Client({ hash: sha256 });

  console.log("Telt provider probe");
  console.log(`  wallet configured: ${String(client.walletConfigured)} (quotes are free either way)`);
  console.log(`  probed at: ${new Date().toISOString()}`);
  console.log("");

  let failures = 0;
  let drift = 0;

  for (const probe of PROBES) {
    const pin = MERCHANT_PINS[probe.providerId];
    const result = await client.quote(probe);

    if (!result.ok) {
      failures += 1;
      console.log(`  ${probe.providerId.padEnd(15)} REFUSED  ${result.error.code}`);
      console.log(`  ${" ".repeat(15)}          ${result.error.detail}`);
      console.log("");
      continue;
    }

    if (result.value.kind === "free") {
      console.log(`  ${probe.providerId.padEnd(15)} FREE     this endpoint no longer charges`);
      console.log("");
      continue;
    }

    const quote = result.value.quote;
    const price = fp.format(quote.amount);
    const expected = pin === undefined ? null : fp.parse(pin.observedPriceUsdc);
    const moved = expected !== null && !fp.equals(quote.amount, expected);
    if (moved) {
      drift += 1;
    }

    console.log(
      `  ${probe.providerId.padEnd(15)} PRICED   ${price} ${quote.assetName} via ${quote.facilitator}`,
    );
    console.log(
      `  ${" ".repeat(15)}          rail ${quote.rail} (${quote.network}), payTo ${quote.payTo} (pinned, matched)`,
    );
    console.log(
      `  ${" ".repeat(15)}          challenge in the ${quote.challengeSource}, ${String(quote.acceptableOptions)} of ${String(quote.offeredOptions)} options acceptable`,
    );
    if (moved && expected !== null) {
      console.log(
        `  ${" ".repeat(15)}          PRICE MOVED: pinned note says ${fp.format(expected)}, live says ${price}`,
      );
    }
    console.log("");
  }

  if (save) {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    console.log(`  fixtures directory: ${FIXTURE_DIR}`);
    console.log("  --save only rewrites files you then review by hand.");
  }

  console.log("What this proves:");
  console.log("  - each provider is reachable and still speaks x402 version 2;");
  console.log("  - each one still offers a rail Telt will sign for, with a");
  console.log("    single-payment authorisation rather than a standing allowance;");
  console.log("  - each recipient still matches the address pinned in the code.");
  console.log("");
  console.log("What it does not prove:");
  console.log("  - that a payment would settle, because nothing was signed or sent;");
  console.log("  - that the data behind the paywall is correct or current;");
  console.log("  - that the wallet holds enough of the right asset on the right chain.");

  if (failures > 0) {
    console.log("");
    console.log(`${String(failures)} provider(s) refused. Telt treats those as unavailable.`);
  }
  if (drift > 0) {
    console.log("");
    console.log(
      `${String(drift)} price(s) moved since the pins were written. Update the observed price in packages/x402/src/constants.ts after checking it.`,
    );
  }

  process.exitCode = failures === PROBES.length ? 1 : 0;
}

main().catch((cause: unknown) => {
  console.error("probe failed:", cause);
  process.exitCode = 1;
});
