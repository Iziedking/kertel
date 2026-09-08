// Generated from packages/core. Run node scripts/build-verifier.mjs; do not edit.

// packages/core/src/money/fixed-point.ts
var FixedPointError = class extends Error {
  name = "FixedPointError";
};
var MAX_SCALE = 38;
var DECIMAL_LITERAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
function assertScale(scale) {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    throw new FixedPointError(
      `scale must be an integer between 0 and ${MAX_SCALE}, received ${String(scale)}`
    );
  }
}
function pow10(exponent) {
  return 10n ** BigInt(exponent);
}
function parse(input, scale) {
  if (typeof input !== "string") {
    throw new FixedPointError(`expected a decimal string, received ${typeof input}`);
  }
  if (!DECIMAL_LITERAL.test(input)) {
    throw new FixedPointError(`not a plain decimal string: ${JSON.stringify(input)}`);
  }
  const negative = input.startsWith("-");
  const unsigned = negative ? input.slice(1) : input;
  const dot = unsigned.indexOf(".");
  const whole = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fraction = dot === -1 ? "" : unsigned.slice(dot + 1);
  const naturalScale = fraction.length;
  assertScale(naturalScale);
  const magnitude = BigInt(whole + fraction);
  const parsed = {
    atoms: negative ? -magnitude : magnitude,
    scale: naturalScale
  };
  return scale === void 0 ? parsed : rescale(parsed, scale, "trunc", { exactOnly: true });
}
function format(value) {
  assertScale(value.scale);
  const negative = value.atoms < 0n;
  const digits = (negative ? -value.atoms : value.atoms).toString();
  if (value.scale === 0) {
    return negative ? `-${digits}` : digits;
  }
  const padded = digits.padStart(value.scale + 1, "0");
  const whole = padded.slice(0, padded.length - value.scale);
  const fraction = padded.slice(padded.length - value.scale);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
function divideWithRounding(numerator, denominator, rounding) {
  if (denominator === 0n) {
    throw new FixedPointError("division by zero");
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) {
    return quotient;
  }
  const negative = numerator < 0n !== denominator < 0n;
  switch (rounding) {
    case "trunc":
      return quotient;
    case "floor":
      return negative ? quotient - 1n : quotient;
    case "ceil":
      return negative ? quotient : quotient + 1n;
    default: {
      const never = rounding;
      throw new FixedPointError(`unhandled rounding mode ${String(never)}`);
    }
  }
}
function rescale(value, scale, rounding, options) {
  assertScale(scale);
  if (scale === value.scale) {
    return value;
  }
  if (scale > value.scale) {
    return { atoms: value.atoms * pow10(scale - value.scale), scale };
  }
  const divisor = pow10(value.scale - scale);
  if (options?.exactOnly === true && value.atoms % divisor !== 0n) {
    throw new FixedPointError(
      `rescaling ${format(value)} to scale ${String(scale)} would lose precision`
    );
  }
  return { atoms: divideWithRounding(value.atoms, divisor, rounding), scale };
}

// packages/core/src/attest/attestation.ts
var ATTESTATION_VERSION = "TELT-ATTESTATION-1";
function canonicalize(attestation) {
  const payments = attestation.payments.map(
    (payment) => `${payment.provider}:${payment.network}:${payment.transaction ?? "none"}:${format(payment.amount)}`
  ).sort();
  return [
    attestation.binding ? "TELT-ATTESTATION-2" : ATTESTATION_VERSION,
    `symbol=${attestation.symbol}`,
    `goal=${attestation.goal}`,
    `at=${attestation.at}`,
    `agent=${attestation.agent.toLowerCase()}`,
    `provenance=${attestation.provenance}`,
    `spent=${format(attestation.spent)}`,
    `decision=${attestation.decision}`,
    `order=${attestation.order ?? "none"}`,
    ...attestation.binding ? [`researchRunId=${attestation.binding.researchRunId}`, `decisionDigest=${attestation.binding.decisionDigest}`, `proposalHash=${attestation.binding.proposalHash}`] : [],
    ...payments.map((line) => `payment=${line}`)
  ].join("\n");
}
function serialize(signed) {
  return `${canonicalize(signed.attestation)}
sig=${signed.signature}`;
}
function deserialize(text) {
  if (text.length > 64e3) return null;
  const lines = text.split("\n").map((line) => line.trim().replace(/^[>|\s]+/, "")).filter((line) => line !== "");
  const start = lines.findIndex((line) => line === ATTESTATION_VERSION || line === "TELT-ATTESTATION-2");
  if (start === -1) return null;
  const after = lines.findIndex((line, i) => i > start && (line === ATTESTATION_VERSION || line === "TELT-ATTESTATION-2"));
  const body = lines.slice(start + 1, after === -1 ? void 0 : after);
  const fields = /* @__PURE__ */ new Map();
  const payments = [];
  for (const line of body) {
    const split = line.indexOf("=");
    if (split <= 0) continue;
    const key = line.slice(0, split);
    const value = line.slice(split + 1);
    if (key === "payment") {
      payments.push(value);
    } else {
      if (fields.has(key)) return null;
      fields.set(key, value);
    }
    if (key === "sig") break;
  }
  const required = ["symbol", "goal", "at", "agent", "provenance", "spent", "decision", "sig"];
  for (const key of required) {
    if (!fields.has(key)) return null;
  }
  const isV2 = lines[start] === "TELT-ATTESTATION-2";
  if (isV2 && ["researchRunId", "decisionDigest", "proposalHash"].some((key) => !fields.get(key))) return null;
  const parsedPayments = [];
  for (const entry of payments) {
    const parts = entry.split(":");
    if (parts.length !== 4) return null;
    const [provider, network, transaction, amount] = parts;
    if (!/^\d+(\.\d+)?$/.test(amount)) return null;
    parsedPayments.push({
      provider,
      network,
      transaction: transaction === "none" ? null : transaction,
      amount: parse(amount)
    });
  }
  const spent = fields.get("spent") ?? "";
  if (!/^\d+(\.\d+)?$/.test(spent)) return null;
  const order = fields.get("order") ?? "none";
  return {
    attestation: {
      ...isV2 ? { binding: { researchRunId: fields.get("researchRunId"), decisionDigest: fields.get("decisionDigest"), proposalHash: fields.get("proposalHash") } } : {},
      symbol: fields.get("symbol") ?? "",
      goal: fields.get("goal") ?? "",
      at: fields.get("at") ?? "",
      agent: fields.get("agent") ?? "",
      provenance: fields.get("provenance") ?? "",
      payments: parsedPayments,
      spent: parse(spent),
      decision: fields.get("decision") ?? "",
      order: order === "none" ? null : order
    },
    signature: fields.get("sig") ?? ""
  };
}
function explorerUrl(payment) {
  if (payment.transaction === null) return null;
  if (payment.network.startsWith("bsc")) {
    return `https://bscscan.com/tx/${payment.transaction}`;
  }
  if (payment.network.startsWith("base")) {
    return `https://basescan.org/tx/${payment.transaction}`;
  }
  return null;
}
function checkOffline(signed, recovered) {
  const checks = [];
  const claimed = signed.attestation.agent.toLowerCase();
  checks.push(
    recovered === null ? {
      name: "signature",
      status: "fail",
      detail: "The signature could not be read at all, so nothing here is attributable."
    } : recovered.toLowerCase() === claimed ? {
      name: "signature",
      status: "pass",
      detail: `Signed by ${claimed}. This verifies the signature against the claimed address, not the identity or payment.`
    } : {
      name: "signature",
      status: "fail",
      detail: `Signed by ${recovered.toLowerCase()}, which is NOT the ${claimed} this claims. Treat it as forged.`
    }
  );
  const paid = signed.attestation.payments.filter((payment) => payment.transaction !== null);
  checks.push({
    name: "evidence was paid for",
    status: "info",
    detail: paid.length > 0 ? `${String(paid.length)} claimed payment reference(s). Not checked against the chain. A reference alone does not prove a payment or delivery.` : "No payment is claimed. This signature does not prove which sources were read."
  });
  checks.push({
    name: "order",
    status: "info",
    detail: signed.attestation.order === null ? "Research only. No order is claimed against this evidence." : `Order ${signed.attestation.order} is claimed, not verified. Only the account holder can check it against Binance.`
  });
  checks.push({ name: "evidence content", status: "info", detail: "The evidence digest is signed. The original provider payloads and their origin have not been verified." });
  checks.push({ name: "research timing", status: "info", detail: "The stated time is not independently timestamped. A payment block time does not date this off-chain decision." });
  return checks;
}
function renderAttestationBlock(signed) {
  const lines = ["Signed evidence receipt"];
  const paid = signed.attestation.payments.filter((payment) => payment.transaction !== null);
  if (paid.length === 0) {
    lines.push(
      "  Nothing was bought for this, so there is no payment to check. The signature below still identifies the signing key and the claims it signed. It does not authenticate those claims."
    );
  } else {
    lines.push(
      `  Claimed research spend: ${format(signed.attestation.spent)} USD equivalent. Payment references below require independent verification:`
    );
    for (const payment of paid) {
      const url = explorerUrl(payment);
      lines.push(
        `    ${payment.provider} ${format(payment.amount)} on ${payment.network}` + (url === null ? ` tx ${payment.transaction ?? ""}` : `
      ${url}`)
      );
    }
    lines.push(
      `  Claimed payer and signer: ${signed.attestation.agent.toLowerCase()}. The signature alone does not verify payment, source authenticity, or pre-trade timing.`
    );
  }
  lines.push("");
  lines.push("  Verify with telt_verify, or at https://telt.site/verify");
  lines.push("");
  lines.push(serialize(signed));
  return lines.join("\n");
}
export {
  ATTESTATION_VERSION,
  canonicalize,
  checkOffline,
  deserialize,
  explorerUrl,
  renderAttestationBlock,
  serialize
};
