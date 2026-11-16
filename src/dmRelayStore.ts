import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";

/**
 * State of the DM relay: which bot DM answers which person. Pure and free of discord.js,
 * so `client.ts` can read the config at import time and the routing rules are testable.
 */

/** Plain messages without a Reply go to the only person who relayed to the author within this window. */
export const RELAY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A Reply still finds its sender this long after the relayed message. */
export const RELAY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** Oldest links go first past this many, so the store file stays small. */
export const RELAY_MAX_LINKS = 20_000;

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
}

export type RelayRoute =
  { kind: "peer"; peer: string } | { kind: "ambiguous"; peers: string[] } | { kind: "none" };

export function emptyRelayState(): RelayState {
  return { version: 1, links: {}, contacts: {} };
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
 * Finds who a DM from `author` is for. A Reply goes to the sender of the relayed message
 * it answers, and a Reply to any other message belongs to no relay: guessing would leak
 * an answer meant for someone else. A plain message goes to the only person who relayed
 * to `author` within the window; several candidates make it ambiguous.
 */
export function resolveRelay(
  state: RelayState,
  author: string,
  replyToId: string | undefined,
  now: number,
): RelayRoute {
  if (replyToId) {
    const link = state.links[replyToId];
    return link && link.owner === author && now - link.at <= RELAY_RETENTION_MS
      ? { kind: "peer", peer: link.peer }
      : { kind: "none" };
  }
  const recent = (state.contacts[author] ?? []).filter((c) => now - c.at <= RELAY_WINDOW_MS);
  if (recent.length === 1) return { kind: "peer", peer: recent[0].peer };
  if (recent.length > 1)
    return { kind: "ambiguous", peers: recent.sort((a, b) => b.at - a.at).map((c) => c.peer) };
  return { kind: "none" };
}

/** Drops links past retention, then the oldest links past the cap, and contacts past the window. */
export function pruneRelay(state: RelayState, now: number): void {
  const kept = Object.entries(state.links)
    .filter(([, link]) => now - link.at <= RELAY_RETENTION_MS)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, RELAY_MAX_LINKS);
  state.links = Object.fromEntries(kept);
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
  return { version: 1, links: parsed.links, contacts: parsed.contacts ?? {} };
}

/** Writes the state through a temporary file, so a crash mid-write leaves the old file whole. */
export async function saveRelayState(path: string, state: RelayState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

/**
 * The relay state behind one file. Loads on first use; every change is pruned and saved
 * before it resolves, one save at a time.
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
    this.loading ??= loadRelayState(this.path).then((state) => (this.state = state));
    return this.loading;
  }

  async record(messageIds: string[], owner: string, peer: string): Promise<void> {
    const state = await this.current();
    const now = this.now();
    recordRelay(state, messageIds, owner, peer, now);
    pruneRelay(state, now);
    const save = this.queue.then(() => saveRelayState(this.path, state));
    this.queue = save.catch(() => {});
    await save;
  }

  async resolve(author: string, replyToId: string | undefined): Promise<RelayRoute> {
    return resolveRelay(await this.current(), author, replyToId, this.now());
  }
}
