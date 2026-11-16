import { z } from "zod";
import { discord } from "../client.js";
import { buildEmbed, embedFieldsShape } from "../embeds.js";
import { currentCaller } from "../caller.js";
import { dmRelayLimiter, dmRelayStore, relayHeader } from "../dmRelay.js";
import { dmRelayCallerSource, dmRelayEnabled } from "../dmRelayStore.js";
import {
  defineTool,
  defineModule,
  snowflake,
  intIn,
  structured,
  messageAuthor,
  messageAuthorShape,
} from "./define.js";

/** Discord's limit for the content of one message. */
const MAX_DM_CONTENT = 2000;

const userId = snowflake.describe("Discord user ID (snowflake) of the DM recipient.");

/**
 * Checks that the caller may send a DM for `relayTo`. When a gateway names callers
 * (DISCORD_DM_RELAY_CALLER_HEADER or DISCORD_DM_RELAY_CALLER_META), relay_to must be that
 * person; otherwise relay_to is taken on trust. Either way, one sender gets a bounded number per window.
 */
function authorizeRelay(relayTo: string): void {
  if (!dmRelayEnabled())
    throw new Error(
      "relay_to needs the DM relay, which is off on this server. Start it with DISCORD_DM_RELAY=true, or send without relay_to.",
    );
  const source = dmRelayCallerSource();
  if (source) {
    const caller = currentCaller().discordUserId;
    if (!caller)
      throw new Error(
        `relay_to needs to know who is calling, and this request names no valid caller in ${source}. Call through the gateway that sets it.`,
      );
    if (caller !== relayTo)
      throw new Error(
        `relay_to must be your own Discord user ID (${caller}): a DM cannot be sent on behalf of someone else.`,
      );
  }
  const slot = dmRelayLimiter().take(relayTo);
  if (!slot.ok)
    throw new Error(
      `Too many relayed DMs from user ${relayTo}: wait ${Math.ceil(slot.retryInMs / 1000)}s, or send without relay_to.`,
    );
}

/**
 * Whether the caller may see relayed messages in this DM. Only the person the DM is with
 * may, and only when a gateway proves who is calling.
 */
function canReadRelayed(dmUserId: string): boolean {
  return Boolean(dmRelayCallerSource()) && currentCaller().discordUserId === dmUserId;
}
const messageId = snowflake.describe("ID of the target message within the DM conversation.");

/** Tool definitions for direct messages. */
const tools = [
  defineTool({
    name: "discord_send_dm",
    description:
      "Send a private direct message to a user by their user ID. Use discord_send_message to post in a server channel instead. Set relay_to to send on behalf of a person: the DM opens with their name, and the recipient's answers reach them as DMs from the bot, in both directions, when the server runs with DISCORD_DM_RELAY=true. Behind a gateway that names callers (a header or request _meta), relay_to must be the caller's own ID; each sender may start a limited number of relayed DMs per 10 minutes. Requires the bot to share at least one server with the user, and the user must allow DMs from server members (otherwise Discord rejects the send). Returns the new message ID.",
    annotations: {
      title: "Send DM",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    schema: z
      .object({
        user_id: userId,
        content: z.string().describe("Plain-text body of the DM (max 2000 characters)."),
        relay_to: snowflake
          .optional()
          .describe(
            "Optional. Discord user ID (snowflake) of the person the DM is sent for, normally the caller. Their name heads the DM, which leaves less room for content, and the recipient's answers are relayed to them. Needs DISCORD_DM_RELAY=true on the server.",
          ),
      })
      .refine(
        (args) => args.relay_to !== args.user_id,
        "relay_to must differ from user_id: the recipient's answers would come back to them.",
      ),
    handle: async ({ user_id, content, relay_to }) => {
      const text = relay_to ? `${relayHeader(relay_to)}\n${content}` : content;
      if (relay_to && text.length > MAX_DM_CONTENT)
        throw new Error(
          `The DM is ${text.length} characters with the relay header; Discord accepts ${MAX_DM_CONTENT}. Shorten content by ${text.length - MAX_DM_CONTENT}.`,
        );
      if (relay_to) {
        authorizeRelay(relay_to);
        // Before sending: a DM whose link cannot be saved would get answers nobody receives.
        await dmRelayStore().ready();
      }
      const user = await discord.users.fetch(user_id);
      const sent = await user.send(
        relay_to ? { content: text, allowedMentions: { parse: [] } } : content,
      );
      let relayNote = "";
      if (relay_to) {
        // The DM is out: a failure from here on is reported, never thrown, or a retry would send it twice.
        try {
          await dmRelayStore().record([sent.id], user_id, relay_to);
          relayNote = ` Answers will be relayed to user ${relay_to}.`;
        } catch (err) {
          relayNote = ` ⚠️ The relay link could not be saved (${(err as Error).message}), so answers to this DM will not be relayed. Do not resend it.`;
        }
      }
      return {
        content: [
          {
            type: "text",
            text: `✅ DM sent to ${user.username} (message id: ${sent.id}).${relayNote}`,
          },
        ],
      };
    },
  }),
  defineTool({
    name: "discord_send_dm_embed",
    description:
      "Send a rich embed as a private direct message to a user. Use discord_send_dm for plain text, or discord_send_embed to post an embed in a channel. Requires the bot to share a server with the user, and the user must allow DMs from server members. Returns the new message ID.",
    annotations: {
      title: "Send DM embed",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    schema: z.object({
      user_id: userId,
      content: z.string().optional().describe("Optional plain text shown above the embed."),
      ...embedFieldsShape,
    }),
    handle: async ({ user_id, content, ...embedArgs }) => {
      const user = await discord.users.fetch(user_id);
      const sent = await user.send({
        content: content || undefined,
        embeds: [buildEmbed(embedArgs)],
      });
      return {
        content: [
          { type: "text", text: `✅ DM embed sent to ${user.username} (message id: ${sent.id}).` },
        ],
      };
    },
  }),
  defineTool({
    name: "discord_edit_dm",
    description:
      "Edit the text content of a DM message previously sent by this bot. Only the bot's own DM messages can be edited. Use discord_edit_dm_embed for embed messages. Returns a confirmation.",
    annotations: {
      title: "Edit DM",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      user_id: userId,
      message_id: messageId,
      content: z
        .string()
        .describe(
          "New plain-text content that fully replaces the existing message (max 2000 characters).",
        ),
    }),
    handle: async ({ user_id, message_id, content }) => {
      const user = await discord.users.fetch(user_id);
      const dm = await user.createDM();
      const msg = await dm.messages.fetch({ message: message_id, cache: false });
      if (msg.author.id !== discord.user?.id)
        throw new Error("Can only edit messages sent by the bot.");
      await msg.edit(content);
      return {
        content: [
          { type: "text", text: `✅ DM message ${message_id} edited for ${user.username}.` },
        ],
      };
    },
  }),
  defineTool({
    name: "discord_edit_dm_embed",
    description:
      "Replace the embed on a DM message previously sent by this bot. Full replace, not merge: provided fields are applied and omitted fields are dropped. Omitting content, or passing an empty string, keeps the message's current text; this tool cannot clear it. Use discord_edit_dm to change only the text, or discord_edit_embed for a message in a server channel. Returns a confirmation.",
    annotations: {
      title: "Edit DM embed",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: z.object({
      user_id: userId,
      message_id: messageId,
      content: z.string().optional().describe("Optional new plain text shown above the embed."),
      ...embedFieldsShape,
    }),
    handle: async ({ user_id, message_id, content, ...embedArgs }) => {
      const user = await discord.users.fetch(user_id);
      const dm = await user.createDM();
      const msg = await dm.messages.fetch({ message: message_id, cache: false });
      if (msg.author.id !== discord.user?.id)
        throw new Error("Can only edit embeds sent by the bot.");
      await msg.edit({
        content: content || undefined,
        embeds: [buildEmbed(embedArgs)],
      });
      return {
        content: [
          {
            type: "text",
            text: `✅ DM embed edited on message ${message_id} for ${user.username}.`,
          },
        ],
      };
    },
  }),
  defineTool({
    name: "discord_delete_dm",
    description:
      "Permanently delete a DM message previously sent by this bot. IRREVERSIBLE. The bot can only delete its own DM messages, not the recipient's. Returns a confirmation.",
    annotations: {
      title: "Delete DM",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    schema: z.object({
      user_id: userId,
      message_id: messageId,
    }),
    handle: async ({ user_id, message_id }) => {
      const user = await discord.users.fetch(user_id);
      const dm = await user.createDM();
      const msg = await dm.messages.fetch({ message: message_id, cache: false });
      if (msg.author.id !== discord.user?.id)
        throw new Error("Can only delete messages sent by the bot.");
      await msg.delete();
      return {
        content: [
          { type: "text", text: `✅ DM message ${message_id} deleted for ${user.username}.` },
        ],
      };
    },
  }),
  defineTool({
    name: "discord_read_dms",
    description:
      "Read the most recent messages from the bot's DM conversation with a user, oldest-to-newest. Returns { messages: [...] } with id, author, content, embed count, timestamp. With the DM relay on, messages relayed between people are left out and counted in hidden_relayed, unless a gateway (header or request _meta) shows the caller is that user. Read-only.",
    annotations: { title: "Read DMs", readOnlyHint: true, openWorldHint: true },
    schema: z.object({
      user_id: userId,
      limit: intIn(1, 100)
        .default(20)
        .describe("How many recent messages to fetch (1–100). Default 20."),
    }),
    outputSchema: z.object({
      messages: z.array(
        z.object({
          id: z.string(),
          author: z.string(),
          ...messageAuthorShape,
          content: z.string(),
          embeds: z.number(),
          timestamp: z.string(),
        }),
      ),
      hidden_relayed: z.number().optional(),
    }),
    handle: async ({ user_id, limit }) => {
      const user = await discord.users.fetch(user_id);
      const dm = await user.createDM();
      const messages = await dm.messages.fetch({ limit, cache: false });
      let visible = [...messages.values()];
      let hidden = 0;
      if (dmRelayEnabled() && !canReadRelayed(user_id)) {
        const relayed = await Promise.all(visible.map((m) => dmRelayStore().isRelayed(m.id)));
        hidden = relayed.filter(Boolean).length;
        visible = visible.filter((_, i) => !relayed[i]);
      }
      const result = visible
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map((m) => ({
          id: m.id,
          author: m.author.username,
          ...messageAuthor(m.author.id, m.webhookId),
          content: m.content,
          embeds: m.embeds.length,
          timestamp: m.createdAt.toISOString(),
        }));
      return structured({ messages: result, ...(hidden ? { hidden_relayed: hidden } : {}) });
    },
  }),
  defineTool({
    name: "discord_reply_dm",
    description:
      "Reply to a specific message in a DM, attaching a quoted reply reference. Unlike the edit/delete DM tools, this works on the bot's messages and the user's alike, though Discord refuses some system messages as reply targets. Use discord_send_dm for a standalone DM with no reference. Returns the new reply's message ID.",
    annotations: {
      title: "Reply to DM",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    schema: z.object({
      user_id: userId,
      message_id: messageId,
      content: z.string().describe("Plain-text body of the reply (max 2000 characters)."),
    }),
    handle: async ({ user_id, message_id, content }) => {
      const user = await discord.users.fetch(user_id);
      const dm = await user.createDM();
      const target = await dm.messages.fetch({ message: message_id, cache: false });
      const sent = await target.reply(content);
      return {
        content: [
          { type: "text", text: `✅ DM reply sent to ${user.username} (message id: ${sent.id}).` },
        ],
      };
    },
  }),
];

export default defineModule(tools);
