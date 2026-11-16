import { AsyncLocalStorage } from "async_hooks";
import { dmRelayCallerHeader } from "./dmRelayStore.js";

/**
 * Who is calling a tool, as far as the server can tell. Only a trusted gateway in front of
 * the HTTP transport can say, through the header named by DISCORD_DM_RELAY_CALLER_HEADER.
 */
export interface Caller {
  /** The caller's Discord user ID, from the gateway header. */
  discordUserId?: string;
}

const storage = new AsyncLocalStorage<Caller>();

/** Runs a tool call with its caller available to `currentCaller()`. */
export function runAsCaller<T>(caller: Caller, fn: () => Promise<T>): Promise<T> {
  return storage.run(caller, fn);
}

/** The caller of the tool call in progress; empty outside one, or when nothing names it. */
export function currentCaller(): Caller {
  return storage.getStore() ?? {};
}

/** Reads the caller from request headers. A missing or malformed value names nobody. */
export function callerFromHeaders(
  headers: Record<string, string | string[] | undefined> | undefined,
): Caller {
  const name = dmRelayCallerHeader();
  if (!name || !headers) return {};
  const raw = headers[name];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value && /^\d{17,20}$/.test(value) ? { discordUserId: value } : {};
}
