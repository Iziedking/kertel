/**
 * Structured logs, with the dangerous fields impossible to log by accident.
 *
 * A trading agent's log is a standing risk: it is the one place where a private
 * key, a phone number, a confirmation code and a raw provider payload all pass
 * within a few lines of each other, and it is the file most likely to be pasted
 * into a bug report. So redaction is not a convention here, it is the only way
 * a value gets out — `redact` walks every object before it is serialised, and a
 * key whose name matches a secret is replaced whatever its value is.
 *
 * JSON lines, one object per line, so the output pipes into anything. Kept
 * dependency-free deliberately: OpenClaw installs plugin dependencies with
 * `--ignore-scripts`, and a logger is not worth a supply-chain surface.
 */

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug" | "trace";

const ORDER: Readonly<Record<LogLevel, number>> = Object.freeze({
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
});

/**
 * Field names that never reach the log, whatever they hold.
 *
 * Matched on the key, not the value, because a value-based rule only catches
 * the secrets somebody thought to describe. Substring matching keeps
 * `privateKey`, `x402PrivateKey` and `KERTEL_X402_PRIVATE_KEY` all covered by
 * one entry.
 */
const SECRET_KEYS = [
  "privatekey",
  "secret",
  "token",
  "password",
  "authorization",
  "apikey",
  "api_key",
  "credential",
  "mnemonic",
  "seed",
  "signature",
  // The owner's phone number is a personal identifier and a routing secret.
  // Its hash is what belongs in an audit trail.
  "whatsapp",
  "phone",
  "e164",
  "msisdn",
  // A confirmation code in a log is a code somebody else can use.
  "confirmationcode",
  "plaintext",
] as const;

/** Raw provider bodies are large, attacker-influenced, and never worth logging. */
const BULK_KEYS = ["body", "rawtext", "payload", "normalized"] as const;

const MAX_STRING = 512;
const MAX_DEPTH = 6;

function isSecret(key: string): boolean {
  const lowered = key.toLowerCase();
  return SECRET_KEYS.some((needle) => lowered.includes(needle));
}

function isBulk(key: string): boolean {
  const lowered = key.toLowerCase();
  return BULK_KEYS.some((needle) => lowered === needle);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return "[deep]";
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...[truncated]` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => redact(entry, depth + 1));
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (isSecret(key)) {
        out[key] = "[redacted]";
      } else if (isBulk(key)) {
        out[key] = "[omitted]";
      } else {
        out[key] = redact(entry, depth + 1);
      }
    }
    return out;
  }
  // Functions, symbols, undefined. Nothing worth serialising.
  return undefined;
}

export type Logger = {
  error(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  trace(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
};

export type LoggerOptions = {
  readonly level: LogLevel;
  /** Injected so a test can capture lines instead of writing to stdout. */
  readonly write?: (line: string) => void;
  readonly now?: () => number;
};

export function createLogger(options: LoggerOptions, bindings: Record<string, unknown> = {}): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => Date.now());
  const threshold = ORDER[options.level];

  function emit(level: Exclude<LogLevel, "silent">, message: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] > threshold || threshold === 0) {
      return;
    }
    const line = {
      time: new Date(now()).toISOString(),
      level,
      msg: message,
      ...(redact(bindings) as Record<string, unknown>),
      ...(fields === undefined ? {} : (redact(fields) as Record<string, unknown>)),
    };
    write(JSON.stringify(line));
  }

  return {
    error: (message, fields) => { emit("error", message, fields); },
    warn: (message, fields) => { emit("warn", message, fields); },
    info: (message, fields) => { emit("info", message, fields); },
    debug: (message, fields) => { emit("debug", message, fields); },
    trace: (message, fields) => { emit("trace", message, fields); },
    child: (extra) => createLogger(options, { ...bindings, ...extra }),
  };
}
