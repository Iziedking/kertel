import { describe, expect, it, vi } from "vitest";

import { createPublicResearchClient } from "../src/demo-research.js";

function response(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("public research corroboration", () => {
  it("reads a live CoinGecko price and 24-hour change", async () => {
    const fetchImpl = vi.fn(async () => response({
      ethereum: { usd: 3500.1234, usd_24h_change: 2.345678, last_updated_at: 1_788_796_800 },
    }));
    const result = await createPublicResearchClient({ fetchImpl, now: () => 1_788_796_801_000 })("ETHUSDT");

    expect(result).toMatchObject({
      status: "live",
      provider: "coingecko",
      priceUsd: "3500.1234",
      change24hPct: "2.3457",
      observedAt: "2026-09-07T16:00:00.000Z",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("ids=ethereum");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("include_24hr_change=true");
  });

  it("fails closed when the provider returns malformed data", async () => {
    const result = await createPublicResearchClient({ fetchImpl: vi.fn(async () => response({ ethereum: {} })) })("ETHUSDT");
    expect(result).toMatchObject({ status: "unavailable", priceUsd: null, change24hPct: null });
  });

  it("keeps the demo available when CoinGecko is down", async () => {
    const fetchImpl = vi.fn(async () => response({ error: "rate limited" }, false, 429));
    const result = await createPublicResearchClient({ fetchImpl })("BTCUSDT");
    expect(result).toMatchObject({ status: "unavailable", reason: "CoinGecko answered 429." });
  });
});
