import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";

/**
 * State of the DM relay: which bot DM answers which person. Pure and free of discord.js,
 * so `client.ts` can read the config at import time and the routing rules are testable.
 */

/** Plain messages without a Reply are routed only within this window. */
export const RELAY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A Reply still finds its sender this long after the relayed message. */
export const RELAY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** Oldest entries go first past this many, so the store file stays small. */
export const RELAY_MAX_LINKS = 20_000;
/** Relayed DMs one sender may start within RELAY_RATE_WINDOW_MS. */
export const RELAY_RATE_MAX = 20;
export const RELAY_RATE_WINDOW_MS = 10 * 60 * 1000;

const ON = ["true", "1", "yes", "on"];
const OFF = ["false", "0", "no", "off"];

/**
 * Parses `DISCORD_DM_RELAY` (case-insensitive). Unset or empty is off. Any other value
 * throws, like DISCORD_MCP_READ_ONLY: a typo must not silently change what the bot does.
 */
export function dmRelayEnabled(): boolean {
  const raw = process.env.DISCORD_DM_RELAY?.trim() ?? "";
  const value = raw.toLowerCase();
  if (value === "" || OFF.includes(value)) return false;
  if (ON.includes(value)) return true;
  throw new Error(
    `Invalid DISCORD_DM_RELAY: "${raw}". Accepted: true/false, 1/0, yes/no or on/off.`,
  );
}

/** Where the relay keeps its links: `DISCORD_DM_RELAY_STORE`, else `~/.discord-mcp/dm-relay.json`. */
export function dmRelayStorePath(): string {
  const raw = process.env.DISCORD_DM_RELAY_STORE?.trim();
  return raw ? raw : join(homedir(), ".discord-mcp", "dm-relay.json");
}

/**
 * The HTTP header, lowercased, in which a trusted gateway names the caller's Discord user
 * ID (`DISCORD_DM_RELAY_CALLER_HEADER`). Unset means the server does not know its callers.
 */
export function dmRelayCallerHeader(): string | undefined {
  const raw = process.env.DISCORD_DM_RELAY_CALLER_HEADER?.trim().toLowerCase();
  if (!raw) return undefined;
  if (!/^[a-z0-9-]+$/.test(raw))
    throw new Error(
      `Invalid DISCORD_DM_RELAY_CALLER_HEADER: "${raw}". Use a header name such as x-discord-user-id.`,
    );
  return raw;
}

/** A bot message in `owner`'s DM whose replies go to `peer`. */
export interface RelayLink {
  owner: string;
  peer: string;
  at: number;
}

/** Someone who relayed a message to the owner, and when they last did. */
export interface RelayContact {
  peer: string;
  at: number;
}

export interface RelayState {
  version: 1;
  links: Record<string, RelayLink>;
  contacts: Record<string, RelayContact[]>;
  /** Messages people wrote that the relay forwarded, kept to hide them from DM reads. */
  sources: Record<string, number>;
  /** The relay's own notices to people (asking for a Reply, a failed delivery), skipped as answer targets. */
  notices: Record<string, number>;
}

export type RelayRoute =
  { kind: "peer"; peer: string } | { kind: "ambiguous"; peers: string[] } | { kind: "none" };

export function emptyRelayState(): RelayState {
  return { version: 1, links: {}, contacts: {}, sources: {}, notices: {} };
}

/**
 * Records bot messages sent to `owner` on behalf of `peer`: a Reply to any of them goes
 * back to `peer`, and `peer` becomes a recent contact of `owner`.
 */
export function recordRelay(
  state: RelayState,
  messageIds: string[],
  owner: string,
  peer: string,
  now: number,
): void {
  for (const id of messageIds) state.links[id] = { owner, peer, at: now };
  const contacts = (state.contacts[owner] ?? []).filter((c) => c.peer !== peer);
  contacts.push({ peer, at: now });
  state.contacts[owner] = contacts;
}

/**
 * Finds who a DM from `author` is for.
 * - A Reply goes to the sender of the relayed message it answers. A Reply to any other
 *   message belongs to no relay: guessing would leak an answer meant for someone else.
 * - A plain message is routed only when the bot's latest message in that DM is a relayed
 *   one from the last 24 hours, so an answer to some other bot DM (a notification, a
 *   report) never travels. `recentBotMessageIds` lists the bot's messages newest first;
 *   the relay's own notices are skipped by ID, never by content. The message goes to that
 *   sender, unless several people relayed to the author within the window: then it is
 *   ambiguous.
 */
export function resolveRelay(
  state: RelayState,
  author: string,
  replyToId: string | undefined,
  recentBotMessageIds: string[] | undefined,
  now: number,
): RelayRoute {
  if (replyToId) {
    const link = state.links[replyToId];
    return link && link.owner === author && now - link.at <= RELAY_RETENTION_MS
      ? { kind: "peer", peer: link.peer }
      : { kind: "none" };
  }
  const lastBotMessageId = recentBotMessageIds?.find((id) => !(id in state.notices));
  const last = lastBotMessageId ? state.links[lastBotMessageId] : undefined;
  if (!last || last.owner !== author || now - last.at > RELAY_WINDOW_MS) return { kind: "none" };
  const recent = (state.contacts[author] ?? []).filter((c) => now - c.at <= RELAY_WINDOW_MS);
  if (recent.length > 1)
    return { kind: "ambiguous", peers: recent.sort((a, b) => b.at - a.at).map((c) => c.peer) };
  return { kind: "peer", peer: last.peer };
}

/** Keeps the newest `max` entries of a record whose values carry a timestamp. */
function newest<T>(entries: [string, T][], at: (value: T) => number, now: number, max: number) {
  return Object.fromEntries(
    entries
      .filter(([, value]) => now - at(value) <= RELAY_RETENTION_MS)
      .sort(([, a], [, b]) => at(b) - at(a))
      .slice(0, max),
  );
}

/** Drops entries past retention, then the oldest past the cap, and contacts past the window. */
export function pruneRelay(state: RelayState, now: number): void {
  state.links = newest(Object.entries(state.links), (l) => l.at, now, RELAY_MAX_LINKS);
  state.sources = newest(Object.entries(state.sources), (at) => at, now, RELAY_MAX_LINKS);
  state.notices = newest(Object.entries(state.notices), (at) => at, now, RELAY_MAX_LINKS);
  for (const [owner, contacts] of Object.entries(state.contacts)) {
    const recent = contacts.filter((c) => now - c.at <= RELAY_WINDOW_MS);
    if (recent.length) state.contacts[owner] = recent;
    else delete state.contacts[owner];
  }
}

/** Reads a saved state, or an empty one when the file is missing. Anything unreadable throws. */
export async function loadRelayState(path: string): Promise<RelayState> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyRelayState();
    throw err;
  }
  const parsed = JSON.parse(text) as Partial<RelayState>;
  if (parsed.version !== 1 || typeof parsed.links !== "object" || !parsed.links)
    throw new Error(`${path} is not a DM relay store (version 1).`);
  return {
    version: 1,
    links: parsed.links,
    contacts: parsed.contacts ?? {},
    sources: parsed.sources ?? {},
    notices: parsed.notices ?? {},
  };
}

/** Writes the state through a temporary file, so a crash mid-write leaves the old file whole. */
export async function saveRelayState(path: string, state: RelayState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

/**
 * The relay state behind one file. Loads on first use, and loads again after a failed
 * load instead of failing until restart. Every change is pruned and saved before it
 * resolves, one save at a time.
 */
export class RelayStore {
  private state: RelayState | null = null;
  private loading: Promise<RelayState> | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}

  private async current(): Promise<RelayState> {
    if (this.state) return this.state;
    this.loading ??= loadRelayState(this.path).then(
      (state) => (this.state = state),
      (err) => {
        this.loading = null;
        throw err;
      },
    );
    return this.loading;
  }

  private async save(state: RelayState): Promise<void> {
    const save = this.queue.then(() => saveRelayState(this.path, state));
    this.queue = save.catch(() => {});
    await save;
  }

  /** Loads the file and writes it back, proving both work before a DM depends on them. */
  async ready(): Promise<void> {
    await this.save(await this.current());
  }

  async record(messageIds: string[], owner: string, peer: string): Promise<void> {
    const state = await this.current();
    const now = this.now();
    recordRelay(state, messageIds, owner, peer, now);
    pruneRelay(state, now);
    await this.save(state);
  }

  /** Marks a message someone wrote as forwarded by the relay. */
  async recordSource(messageId: string): Promise<void> {
    const state = await this.current();
    state.sources[messageId] = this.now();
    await this.save(state);
  }

  /** Marks one of the relay's own notices, so it never counts as the message being answered. */
  async recordNotice(messageId: string): Promise<void> {
    const state = await this.current();
    state.notices[messageId] = this.now();
    await this.save(state);
  }

  async resolve(
    author: string,
    replyToId: string | undefined,
    recentBotMessageIds?: string[],
  ): Promise<RelayRoute> {
    return resolveRelay(await this.current(), author, replyToId, recentBotMessageIds, this.now());
  }

  /** Whether a DM message is part of a relayed conversation: sent for someone, or forwarded. */
  async isRelayed(messageId: string): Promise<boolean> {
    const state = await this.current();
    return messageId in state.links || messageId in state.sources;
  }
}

/** Counts relayed DMs per sender over a sliding window, in memory. */
export class RelayRateLimiter {
  private readonly sent = new Map<string, number[]>();

  constructor(
    private readonly max = RELAY_RATE_MAX,
    private readonly windowMs = RELAY_RATE_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes one slot for `sender`, or returns the milliseconds until one frees up. */
  take(sender: string): { ok: true } | { ok: false; retryInMs: number } {
    const now = this.now();
    const recent = (this.sent.get(sender) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.max) {
      this.sent.set(sender, recent);
      return { ok: false, retryInMs: this.windowMs - (now - recent[0]) };
    }
    recent.push(now);
    this.sent.set(sender, recent);
    return { ok: true };
  }
}
