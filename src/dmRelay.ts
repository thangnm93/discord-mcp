import { DiscordAPIError, Events, type Message, type MessageCreateOptions } from "discord.js";
import { discord, ensureConnected } from "./client.js";
import { RelayRateLimiter, RelayStore, dmRelayStorePath, type RelayRoute } from "./dmRelayStore.js";

/**
 * DM relay: a DM sent with `relay_to` names its sender, and the recipient's answers come
 * back to that sender as DMs from the bot, in both directions. Opt-in through
 * DISCORD_DM_RELAY, since it keeps the bot connected and stores who wrote to whom.
 */

/** Discord's limit for the content of one message. */
const MAX_CONTENT = 2000;
/** How long to wait before retrying a failed connection while the relay runs. */
const RECONNECT_DELAY_MS = 60_000;
/** How far back a plain message looks for the bot's latest message in the DM. */
const HISTORY_LOOKBACK = 20;

/** Marks for the relay's own notices. For people only: the relay tells notices apart by ID. */
const AMBIGUOUS_PREFIX = "🔁 ";
const FAILURE_PREFIX = "⚠️ ";

let store: RelayStore | null = null;
let limiter: RelayRateLimiter | null = null;

/** The process-wide store, created on first use from DISCORD_DM_RELAY_STORE. */
export function dmRelayStore(): RelayStore {
  store ??= new RelayStore(dmRelayStorePath());
  return store;
}

/** The process-wide rate limit on relayed DMs per sender. */
export function dmRelayLimiter(): RelayRateLimiter {
  limiter ??= new RelayRateLimiter();
  return limiter;
}

/** The first line of a DM sent on someone's behalf. */
export function relayHeader(sender: string): string {
  return `📨 From <@${sender}>. Reply to this message to answer them.`;
}

/** The first line of a forwarded answer. */
export function forwardHeader(author: string): string {
  return `📩 <@${author}> answered. Reply to this message to answer them.`;
}

/** Splits text into chunks Discord accepts, preferring line breaks. */
export function splitContent(text: string, max = MAX_CONTENT): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = rest.lastIndexOf("\n", max);
    const at = cut > max / 2 ? cut : max;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  if (rest.length || chunks.length === 0) chunks.push(rest);
  return chunks;
}

/** What a relay handler needs from Discord, so tests can stand in for it. */
export interface RelayDeps {
  store: Pick<RelayStore, "record" | "recordSource" | "recordNotice" | "resolve">;
  /** Sends one message to a user's DM and returns its id. */
  sendDm(userId: string, options: MessageCreateOptions): Promise<string>;
  /** The ids of the bot's messages just before `message` in its DM, newest first. */
  recentBotMessageIds(message: IncomingDm): Promise<string[]>;
}

export type IncomingDm = Pick<
  Message,
  "id" | "author" | "content" | "attachments" | "reference"
> & {
  inGuild(): boolean;
  reply(content: string): Promise<{ id: string }>;
  react(emoji: string): Promise<unknown>;
};

/** Mentions in relayed text render as names but never ping anyone. */
const NO_PINGS = { parse: [] } as MessageCreateOptions["allowedMentions"];

/** Runs a store write whose failure must not stop the relay, logging it instead. */
async function bestEffort(what: string, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (err) {
    console.error(`DM relay could not ${what}: ${(err as Error).message}`);
  }
}

/**
 * Forwards a DM sent to the bot to the person it answers. Ignores bots, server messages
 * and DMs that belong to no relay. Asks the author to use Reply when several people
 * relayed to them recently. Reacts ✅ once delivered, or explains why it was not.
 */
export async function handleRelayDm(message: IncomingDm, deps: RelayDeps): Promise<void> {
  if (message.author.bot || message.inGuild()) return;
  const author = message.author.id;
  const replyTo = message.reference?.messageId;
  const recent = replyTo ? undefined : await deps.recentBotMessageIds(message);
  const route: RelayRoute = await deps.store.resolve(author, replyTo, recent);
  if (route.kind === "none") return;
  if (route.kind === "ambiguous") {
    await notify(
      message,
      deps,
      `${AMBIGUOUS_PREFIX}Several people wrote to you through me recently: ${route.peers.map((p) => `<@${p}>`).join(", ")}. Use Reply on the message you are answering, so I know who it is for.`,
    );
    return;
  }

  const files = [...message.attachments.values()].map((a) => ({ attachment: a.url, name: a.name }));
  const body =
    message.content || (files.length ? "" : "(a sticker or embed, which cannot be relayed)");
  const chunks = splitContent(`${forwardHeader(author)}\n${body}`.trimEnd());
  // Fail closed: a forwarded message must be hidden from DM reads, so it is marked before
  // anything leaves. When the store cannot take the mark, nothing is forwarded.
  try {
    await deps.store.recordSource(message.id);
  } catch (err) {
    // The details stay in the server log: they can name paths the author must not see.
    console.error(`DM relay could not mark a forwarded message: ${(err as Error).message}`);
    await notify(
      message,
      deps,
      `${FAILURE_PREFIX}I could not deliver this to <@${route.peer}>: the relay cannot save it right now. Please try again later.`,
    );
    return;
  }
  const sent: string[] = [];
  try {
    for (const [i, content] of chunks.entries()) {
      const last = i === chunks.length - 1;
      sent.push(...(await sendChunk(deps, route.peer, content, last ? files : [])));
    }
  } catch (err) {
    console.error(`DM relay could not deliver to ${route.peer}: ${(err as Error).message}`);
    if (sent.length)
      await bestEffort("save a partial delivery", () =>
        deps.store.record(sent, route.peer, author),
      );
    await notify(
      message,
      deps,
      `${FAILURE_PREFIX}I could not deliver this to <@${route.peer}>: ${publicReason(err)}`,
    );
    return;
  }
  // Delivered: a store failure from here on must not hide that from the author.
  await bestEffort("save a delivery", () => deps.store.record(sent, route.peer, author));
  await message.react("✅").catch(() => {});
}

/**
 * What a person may read about a failed delivery: Discord's own explanation, such as a
 * recipient who closed their DMs, and nothing from inside the server.
 */
function publicReason(err: unknown): string {
  return err instanceof DiscordAPIError ? err.message : "something went wrong on my side";
}

/**
 * Replies to the author with one of the relay's own notices and records its ID, so a later
 * plain message never takes the notice for the message being answered. If the ID cannot
 * be saved, the notice counts as a bot message outside the relay: plain messages after it
 * are not relayed, which fails safe.
 */
async function notify(message: IncomingDm, deps: RelayDeps, content: string): Promise<void> {
  const notice = await message.reply(content);
  await bestEffort("mark a notice", () => deps.store.recordNotice(notice.id));
}

/**
 * Sends a chunk with its files. When Discord refuses the upload, sends their links
 * instead, over as many messages as they need. Returns the ids of the messages sent.
 */
async function sendChunk(
  deps: RelayDeps,
  userId: string,
  content: string,
  files: { attachment: string; name: string }[],
): Promise<string[]> {
  if (!files.length) return [await deps.sendDm(userId, { content, allowedMentions: NO_PINGS })];
  try {
    return [await deps.sendDm(userId, { content, files, allowedMentions: NO_PINGS })];
  } catch {
    const links = files.map((f) => f.attachment).join("\n");
    const ids: string[] = [];
    for (const part of splitContent(`${content}\n${links}`))
      ids.push(await deps.sendDm(userId, { content: part, allowedMentions: NO_PINGS }));
    return ids;
  }
}

/** Sends through the live client. */
async function sendDm(userId: string, options: MessageCreateOptions): Promise<string> {
  const user = await discord.users.fetch(userId);
  return (await user.send(options)).id;
}

/** Reads the bot's messages just before `message` in its DM through the live client. */
async function recentBotMessageIds(message: IncomingDm): Promise<string[]> {
  const live = message as unknown as Message;
  const history = await live.channel.messages.fetch({
    before: message.id,
    limit: HISTORY_LOOKBACK,
    cache: false,
  });
  const botId = discord.user?.id;
  return [...history.values()]
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
    .filter((m) => m.author.id === botId)
    .map((m) => m.id);
}

let started = false;

/**
 * Starts listening for DMs and keeps the bot connected: the relay must hear answers even
 * when no tool runs. Checks the store first, so a store that cannot be written shows up
 * at startup. Call once, only with DISCORD_DM_RELAY on.
 */
export function startDmRelay(): void {
  if (started) return;
  started = true;
  const relayStore = dmRelayStore();
  relayStore.ready().then(
    () => console.error(`DM relay store ready: ${relayStore.path}`),
    (err) =>
      console.error(
        `DM relay store ${relayStore.path} is not usable, relayed DMs will be refused until it is: ${(err as Error).message}`,
      ),
  );
  const deps: RelayDeps = { store: relayStore, sendDm, recentBotMessageIds };
  discord.on(Events.MessageCreate, (message) => {
    handleRelayDm(message, deps).catch((err) =>
      console.error("DM relay error:", (err as Error).message),
    );
  });
  const connect = () => {
    ensureConnected().then(
      () => console.error("DM relay listening for DMs."),
      (err) => {
        console.error(`DM relay could not connect, retrying in 60s: ${(err as Error).message}`);
        setTimeout(connect, RECONNECT_DELAY_MS).unref();
      },
    );
  };
  discord.on(Events.Invalidated, () => setTimeout(connect, RECONNECT_DELAY_MS).unref());
  connect();
}
