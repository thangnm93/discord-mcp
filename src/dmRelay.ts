import { Events, type Message, type MessageCreateOptions } from "discord.js";
import { discord, ensureConnected } from "./client.js";
import { RelayStore, dmRelayStorePath, type RelayRoute } from "./dmRelayStore.js";

/**
 * DM relay: a DM sent with `relay_to` names its sender, and the recipient's answers come
 * back to that sender as DMs from the bot, in both directions. Opt-in through
 * DISCORD_DM_RELAY, since it keeps the bot connected and stores who wrote to whom.
 */

/** Discord's limit for the content of one message. */
const MAX_CONTENT = 2000;
/** How long to wait before retrying a failed connection while the relay runs. */
const RECONNECT_DELAY_MS = 60_000;

let store: RelayStore | null = null;

/** The process-wide store, created on first use from DISCORD_DM_RELAY_STORE. */
export function dmRelayStore(): RelayStore {
  store ??= new RelayStore(dmRelayStorePath());
  return store;
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
  store: Pick<RelayStore, "record" | "resolve">;
  /** Sends one message to a user's DM and returns its id. */
  sendDm(userId: string, options: MessageCreateOptions): Promise<string>;
}

type IncomingDm = Pick<Message, "author" | "content" | "attachments" | "reference"> & {
  inGuild(): boolean;
  reply(content: string): Promise<unknown>;
  react(emoji: string): Promise<unknown>;
};

/** Mentions in relayed text render as names but never ping anyone. */
const NO_PINGS = { parse: [] } as MessageCreateOptions["allowedMentions"];

/**
 * Forwards a DM sent to the bot to the person it answers. Ignores bots, server messages
 * and DMs that belong to no relay. Asks the author to use Reply when several people
 * relayed to them recently. Reacts ✅ once delivered, or explains why it was not.
 */
export async function handleRelayDm(message: IncomingDm, deps: RelayDeps): Promise<void> {
  if (message.author.bot || message.inGuild()) return;
  const author = message.author.id;
  const route: RelayRoute = await deps.store.resolve(author, message.reference?.messageId);
  if (route.kind === "none") return;
  if (route.kind === "ambiguous") {
    await message.reply(
      `Several people wrote to you through me recently: ${route.peers.map((p) => `<@${p}>`).join(", ")}. Use Reply on the message you are answering, so I know who it is for.`,
    );
    return;
  }

  const files = [...message.attachments.values()].map((a) => ({ attachment: a.url, name: a.name }));
  const body =
    message.content || (files.length ? "" : "(a sticker or embed, which cannot be relayed)");
  const chunks = splitContent(`${forwardHeader(author)}\n${body}`.trimEnd());
  const sent: string[] = [];
  try {
    for (const [i, content] of chunks.entries()) {
      const last = i === chunks.length - 1;
      sent.push(await sendChunk(deps, route.peer, content, last ? files : []));
    }
  } catch (err) {
    if (sent.length) await deps.store.record(sent, route.peer, author);
    await message.reply(
      `⚠️ I could not deliver this to <@${route.peer}>: ${(err as Error).message}`,
    );
    return;
  }
  await deps.store.record(sent, route.peer, author);
  await message.react("✅").catch(() => {});
}

/** Sends a chunk with its files; when Discord refuses the upload, sends their links instead. */
async function sendChunk(
  deps: RelayDeps,
  userId: string,
  content: string,
  files: { attachment: string; name: string }[],
): Promise<string> {
  if (!files.length) return deps.sendDm(userId, { content, allowedMentions: NO_PINGS });
  try {
    return await deps.sendDm(userId, { content, files, allowedMentions: NO_PINGS });
  } catch {
    const links = files.map((f) => f.attachment).join("\n");
    return deps.sendDm(userId, {
      content: splitContent(`${content}\n${links}`)[0],
      allowedMentions: NO_PINGS,
    });
  }
}

/** Sends through the live client. */
async function sendDm(userId: string, options: MessageCreateOptions): Promise<string> {
  const user = await discord.users.fetch(userId);
  return (await user.send(options)).id;
}

let started = false;

/**
 * Starts listening for DMs and keeps the bot connected: the relay must hear answers even
 * when no tool runs. Call once at startup, only with DISCORD_DM_RELAY on.
 */
export function startDmRelay(): void {
  if (started) return;
  started = true;
  const deps: RelayDeps = { store: dmRelayStore(), sendDm };
  discord.on(Events.MessageCreate, (message) => {
    handleRelayDm(message, deps).catch((err) =>
      console.error("DM relay error:", (err as Error).message),
    );
  });
  discord.on(Events.Invalidated, () => setTimeout(connect, RECONNECT_DELAY_MS).unref());
  const connect = () => {
    ensureConnected().then(
      () => console.error(`DM relay listening, store: ${dmRelayStore().path}`),
      (err) => {
        console.error(`DM relay could not connect, retrying in 60s: ${(err as Error).message}`);
        setTimeout(connect, RECONNECT_DELAY_MS).unref();
      },
    );
  };
  connect();
}
