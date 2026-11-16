import { AsyncLocalStorage } from "async_hooks";
import { dmRelayCallerHeader, dmRelayCallerMetaKey } from "./dmRelayStore.js";

/**
 * Who is calling a tool, as far as the server can tell. Only a trusted gateway in front of
 * the server can say: in the header named by DISCORD_DM_RELAY_CALLER_HEADER (http), or in
 * the request `_meta` key named by DISCORD_DM_RELAY_CALLER_META (any transport, stdio too).
 */
export interface Caller {
  /** The caller's Discord user ID, as the gateway gave it. */
  discordUserId?: string;
}

type Headers = Record<string, string | string[] | undefined>;

const storage = new AsyncLocalStorage<Caller>();

/** Runs a tool call with its caller available to `currentCaller()`. */
export function runAsCaller<T>(caller: Caller, fn: () => Promise<T>): Promise<T> {
  return storage.run(caller, fn);
}

/** The caller of the tool call in progress; empty outside one, or when nothing names it. */
export function currentCaller(): Caller {
  return storage.getStore() ?? {};
}

/**
 * Reads the caller from a request: the configured header, the configured `_meta` key, or
 * both. Fails closed: a malformed value, or two sources that disagree, name nobody.
 */
export function callerFromRequest(request: { headers?: Headers; meta?: unknown }): Caller {
  const values: string[] = [];
  const header = dmRelayCallerHeader();
  if (header && request.headers) {
    const raw = request.headers[header];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (value) values.push(value);
  }
  const key = dmRelayCallerMetaKey();
  if (key && request.meta && typeof request.meta === "object") {
    const raw = (request.meta as Record<string, unknown>)[key];
    if (raw !== undefined) values.push(typeof raw === "string" ? raw.trim() : "");
  }
  if (values.length === 0) return {};
  const [first] = values;
  if (!/^\d{17,20}$/.test(first) || values.some((v) => v !== first)) return {};
  return { discordUserId: first };
}

/** Reads the caller from request headers alone. */
export function callerFromHeaders(headers: Headers | undefined): Caller {
  return callerFromRequest({ headers });
}
