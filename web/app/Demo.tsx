"use client";

import { FormEvent, useState } from "react";
import Icon from "./Icon";

type DemoResult = {
  readonly ok: true;
  readonly question: string;
  readonly symbol: string;
  readonly market: { readonly bestBid: string; readonly bestAsk: string; readonly averagePrice: string | null; readonly spreadBps: number; readonly observedAt: string; readonly source: string };
  readonly verdict: { readonly action: "BUY_CANDIDATE" | "NO_TRADE" | "INSUFFICIENT_EVIDENCE"; readonly confidence: number; readonly because: string; readonly risks: readonly string[] };
  readonly model: string;
  readonly cached: boolean;
  readonly boundaries: readonly string[];
};

const API = process.env.NEXT_PUBLIC_TELT_API_URL ?? "https://mcp.telt.site";
const SUGGESTIONS = [
  "Is there enough evidence to buy ETH?",
  "What does the BTC spread tell us right now?",
  "Should I consider BNB from this market snapshot?",
] as const;

export default function Demo() {
  const [question, setQuestion] = useState<string>(SUGGESTIONS[0]);
  const [result, setResult] = useState<DemoResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function run(event: FormEvent) {
    event.preventDefault();
    const message = question.trim();
    if (!message || loading) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${API}/demo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const body = (await response.json()) as DemoResult | { readonly ok?: false; readonly error?: string };
      if (!response.ok || body.ok !== true) {
        throw new Error("error" in body && body.error ? body.error : "Telt could not complete this look.");
      }
      setResult(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Telt could not complete this look.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="demo">
      <div className="demo-header">
        <span className="pill"><span className="status-dot" /> LIVE BACKEND · BINANCE + CLAUDE</span>
        <span className="demo-safety">Market read only · no order endpoint</span>
      </div>
      <div className="demo-grid">
        <div className="demo-story">
          <p className="eyebrow">ASK TELT</p>
          <h3>Put the agent on the spot.</h3>
          <p>Telt reads the live Binance book, gives Claude only the observed evidence, then checks the answer before showing it.</p>
          <form onSubmit={run} className="demo-form">
            <label htmlFor="demo-question">Your market question</label>
            <textarea id="demo-question" maxLength={500} value={question} onChange={(event) => setQuestion(event.target.value)} disabled={loading} />
            <div className="prompt-chips" aria-label="Example questions">
              {SUGGESTIONS.map((suggestion) => (
                <button type="button" key={suggestion} onClick={() => setQuestion(suggestion)} disabled={loading}>{suggestion.includes("ETH") ? "ETH setup" : suggestion.includes("BTC") ? "BTC spread" : "BNB snapshot"}</button>
              ))}
            </div>
            <button className="button primary demo-submit" disabled={loading || question.trim() === ""}>
              {loading ? "Telt is reading the market…" : "Run live analysis"}
              {!loading && <Icon name="arrow" />}
            </button>
          </form>
          <div className="demo-steps" aria-label="Agent path">
            <span className={loading ? "active" : ""}>01 · Read Binance</span>
            <span className={loading ? "active" : ""}>02 · Reason with Claude</span>
            <span>03 · Validate the verdict</span>
          </div>
        </div>
        <div className="demo-result" aria-live="polite" aria-busy={loading}>
          <p className="eyebrow">THE LIVE DECISION</p>
          {loading && <div className="demo-wait"><span className="thinking-ring" /><h3>Reading evidence before answering.</h3><p>Binance market snapshot, then a constrained model verdict. This usually takes a few seconds.</p></div>}
          {!loading && error && <div className="demo-error"><h3>The look did not complete.</h3><p>{error}</p><button type="button" className="button secondary" onClick={(event) => void run(event)}>Try again</button></div>}
          {!loading && !error && result === null && <div className="demo-empty"><h3>No canned answer here.</h3><p>Run a question to create a fresh market snapshot and a checked model verdict.</p></div>}
          {!loading && !error && result !== null && (
            <>
              <div className="verdict-head">
                <span className={`verdict-badge ${result.verdict.action.toLowerCase()}`}>{result.verdict.action.replaceAll("_", " ")}</span>
                <span className="confidence">{Math.round(result.verdict.confidence)} / 100 confidence</span>
              </div>
              <h3>{result.symbol} at {result.market.bestAsk} USDT</h3>
              <p className="verdict-reason">{result.verdict.because}</p>
              <div className="market-facts">
                <div><span>Best bid</span><strong>{result.market.bestBid}</strong></div>
                <div><span>Best ask</span><strong>{result.market.bestAsk}</strong></div>
                <div><span>Spread</span><strong>{result.market.spreadBps.toFixed(2)} bps</strong></div>
              </div>
              {result.verdict.risks.length > 0 && <div className="risk-list"><strong>What could change the view</strong><ul>{result.verdict.risks.map((risk) => <li key={risk}>{risk}</li>)}</ul></div>}
              <div className="receipt live-receipt">
                <details><summary>Inspect source and limits</summary><p>{result.market.source}<br />Observed {new Date(result.market.observedAt).toLocaleString()}<br />Model {result.model}{result.cached ? " · cached under 60 seconds" : ""}</p><ul>{result.boundaries.map((item) => <li key={item}>{item}</li>)}</ul></details>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="demo-foot">The website uses the same Telt backend offered to ChatGPT over MCP. This public route can analyze market data; it cannot access an account or place an order.</div>
    </div>
  );
}
