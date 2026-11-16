import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZodError } from "zod";
import { callerFromHeaders, callerFromRequest, runAsCaller } from "../src/caller.js";
import { discord } from "../src/client.js";
import { dmRelayLimiter, dmRelayStore } from "../src/dmRelay.js";
import { RELAY_RATE_MAX } from "../src/dmRelayStore.js";
import dm from "../src/tools/dm.js";

const SENDER = "111111111111111111";
const RECIPIENT = "222222222222222222";
const SENT_ID = "999999999999999999";

const dir = mkdtempSync(join(tmpdir(), "dm-relay-tool-"));
const storePath = join(dir, "relay.json");
process.env.DISCORD_DM_RELAY_STORE = storePath;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

afterEach(() => {
  mock.restoreAll();
  delete process.env.DISCORD_DM_RELAY;
  delete process.env.DISCORD_DM_RELAY_CALLER_HEADER;
  delete process.env.DISCORD_DM_RELAY_CALLER_META;
});

const sendDm = () => dm.handlers.get("discord_send_dm")!;
const readDms = () => dm.handlers.get("discord_read_dms")!;
const textOf = (result: { content: { text?: string }[] }) =>
  result.content.map((c) => c.text ?? "").join("\n");

let nextId = 100;
function stubUser(history: { id: string; content: string }[] = []) {
  const sent: unknown[] = [];
  const messages = new Map(
    history.map((m, i) => [
      m.id,
      {
        id: m.id,
        content: m.content,
        createdTimestamp: i,
        createdAt: new Date(i),
        author: { id: SENDER, username: "someone" },
        webhookId: null,
        embeds: [],
      },
    ]),
  );
  mock.method(
    discord.users,
    "fetch",
    async () =>
      ({
        username: "recipient",
        send: async (payload: unknown) => {
          sent.push(payload);
          return { id: sent.length === 1 ? SENT_ID : String(nextId++) };
        },
        createDM: async () => ({ messages: { fetch: async () => messages } }),
      }) as never,
  );
  return sent;
}

test("send_dm advertises relay_to as an optional snowflake", () => {
  const definition = dm.definitions.find((d) => d.name === "discord_send_dm");
  const schema = definition!.inputSchema as {
    required: string[];
    properties: Record<string, { pattern?: string; description?: string }>;
  };
  assert.deepEqual(schema.required, ["user_id", "content"]);
  assert.ok(schema.properties.relay_to.pattern);
  assert.match(schema.properties.relay_to.description ?? "", /DISCORD_DM_RELAY=true/);
});

test("send_dm without relay_to sends the content unchanged", async () => {
  const sent = stubUser();
  await sendDm()({ user_id: RECIPIENT, content: "plain" });
  assert.deepEqual(sent, ["plain"]);
});

test("relay_to is refused while the relay is off, before reaching Discord", async () => {
  const sent = stubUser();
  await assert.rejects(
    sendDm()({ user_id: RECIPIENT, content: "hi", relay_to: SENDER }),
    /DISCORD_DM_RELAY=true/,
  );
  assert.equal(sent.length, 0);
});

test("relay_to equal to user_id is refused", async () => {
  await assert.rejects(
    sendDm()({ user_id: RECIPIENT, content: "hi", relay_to: RECIPIENT }),
    (err: unknown) => err instanceof ZodError && /relay_to must differ/.test(err.message),
  );
});

test("with the relay on, the DM names its sender and the link is saved", async () => {
  process.env.DISCORD_DM_RELAY = "true";
  const sent = stubUser();
  const result = await sendDm()({
    user_id: RECIPIENT,
    content: "Can you check?",
    relay_to: SENDER,
  });
  const payload = sent[0] as { content: string; allowedMentions: unknown };
  assert.match(payload.content, new RegExp(`^📨 From <@${SENDER}>\\..*\\nCan you check\\?$`));
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.match(textOf(result), new RegExp(`relayed to user ${SENDER}`));
  const saved = JSON.parse(readFileSync(storePath, "utf8"));
  assert.equal(saved.links[SENT_ID].owner, RECIPIENT);
  assert.equal(saved.links[SENT_ID].peer, SENDER);
});

test("content that no longer fits with the relay header is refused with the overflow", async () => {
  process.env.DISCORD_DM_RELAY = "true";
  const sent = stubUser();
  await assert.rejects(
    sendDm()({ user_id: RECIPIENT, content: "z".repeat(2000), relay_to: SENDER }),
    /Shorten content by \d+/,
  );
  assert.equal(sent.length, 0);
});

test("a store that cannot be written refuses relay_to before the DM goes out", async () => {
  process.env.DISCORD_DM_RELAY = "true";
  const sent = stubUser();
  mock.method(dmRelayStore(), "ready", async () => {
    throw new Error("EROFS: read-only file system");
  });
  await assert.rejects(sendDm()({ user_id: RECIPIENT, content: "hi", relay_to: SENDER }), /EROFS/);
  assert.equal(sent.length, 0);
});

test("a link that fails to save after sending is reported, not thrown, so nobody resends", async () => {
  process.env.DISCORD_DM_RELAY = "true";
  const sent = stubUser();
  mock.method(dmRelayStore(), "record", async () => {
    throw new Error("disk full");
  });
  const result = await sendDm()({ user_id: RECIPIENT, content: "hi", relay_to: SENDER });
  assert.equal(sent.length, 1);
  assert.match(textOf(result), /^✅ DM sent/);
  assert.match(textOf(result), /could not be saved \(disk full\).*Do not resend/);
});

test("relayed DMs per sender are rate limited", async () => {
  process.env.DISCORD_DM_RELAY = "true";
  stubUser();
  const limiter = dmRelayLimiter();
  const other = "333333333333333333";
  for (let i = 0; i < RELAY_RATE_MAX; i++) assert.equal(limiter.take(other).ok, true);
  await assert.rejects(
    sendDm()({ user_id: RECIPIENT, content: "hi", relay_to: other }),
    /Too many relayed DMs from user 333333333333333333: wait \d+s/,
  );
});

test("behind a gateway header, relay_to must be the caller", async () => {
  process.env.DISCORD_DM_RELAY = "true";
  process.env.DISCORD_DM_RELAY_CALLER_HEADER = "X-Discord-User-Id";
  const sent = stubUser();
  const call = (relay_to: string) => () =>
    sendDm()({ user_id: RECIPIENT, content: "hi", relay_to });

  await assert.rejects(call(SENDER)(), /no valid caller in the x-discord-user-id header/);
  const caller = callerFromHeaders({ "x-discord-user-id": "444444444444444444" });
  await assert.rejects(runAsCaller(caller, call(SENDER)), /must be your own Discord user ID/);
  assert.equal(sent.length, 0);

  const self = callerFromHeaders({ "x-discord-user-id": SENDER });
  const result = await runAsCaller(self, call(SENDER));
  assert.match(textOf(result), /relayed to user/);
});

test("callerFromHeaders ignores a malformed or missing header", () => {
  process.env.DISCORD_DM_RELAY_CALLER_HEADER = "x-discord-user-id";
  assert.deepEqual(callerFromHeaders({ "x-discord-user-id": "abc" }), {});
  assert.deepEqual(callerFromHeaders({}), {});
  assert.deepEqual(callerFromHeaders({ "x-discord-user-id": [SENDER, "x"] }), {
    discordUserId: SENDER,
  });
  delete process.env.DISCORD_DM_RELAY_CALLER_HEADER;
  assert.deepEqual(callerFromHeaders({ "x-discord-user-id": SENDER }), {}, "no header configured");
});

test("read_dms hides relayed messages unless a gateway header shows the caller is that user", async () => {
  process.env.DISCORD_DM_RELAY = "true";
  await dmRelayStore().record(["700000000000000001"], RECIPIENT, SENDER);
  await dmRelayStore().recordSource("700000000000000002");
  stubUser([
    { id: "700000000000000000", content: "a notification" },
    { id: "700000000000000001", content: "📨 From someone" },
    { id: "700000000000000002", content: "their answer" },
  ]);
  const hidden = (await readDms()({ user_id: RECIPIENT })).structuredContent as {
    messages: { id: string }[];
    hidden_relayed?: number;
  };
  assert.deepEqual(
    hidden.messages.map((m) => m.id),
    ["700000000000000000"],
  );
  assert.equal(hidden.hidden_relayed, 2);

  process.env.DISCORD_DM_RELAY_CALLER_HEADER = "x-discord-user-id";
  const owner = callerFromHeaders({ "x-discord-user-id": RECIPIENT });
  const shown = (await runAsCaller(owner, () => readDms()({ user_id: RECIPIENT })))
    .structuredContent as { messages: unknown[]; hidden_relayed?: number };
  assert.equal(shown.messages.length, 3);
  assert.equal(shown.hidden_relayed, undefined);
});

test("read_dms fails closed when the relay store cannot be read", async () => {
  process.env.DISCORD_DM_RELAY = "true";
  stubUser([{ id: "700000000000000009", content: "maybe relayed" }]);
  mock.method(dmRelayStore(), "isRelayed", async () => {
    throw new Error("store unreadable");
  });
  await assert.rejects(readDms()({ user_id: RECIPIENT }), /store unreadable/);
});

test("callerFromRequest reads the _meta key, and fails closed on a bad or conflicting value", () => {
  process.env.DISCORD_DM_RELAY_CALLER_META = "gateway/discordUserId";
  const meta = (value: unknown) => ({ meta: { "gateway/discordUserId": value } });
  assert.deepEqual(callerFromRequest(meta(SENDER)), { discordUserId: SENDER });
  assert.deepEqual(callerFromRequest(meta(Number(SENDER))), {}, "not a string");
  assert.deepEqual(callerFromRequest(meta("abc")), {});
  assert.deepEqual(callerFromRequest({ meta: { other: SENDER } }), {});
  assert.deepEqual(callerFromRequest({}), {});

  process.env.DISCORD_DM_RELAY_CALLER_HEADER = "x-discord-user-id";
  const both = (header: string, metaValue: string) => ({
    headers: { "x-discord-user-id": header },
    meta: { "gateway/discordUserId": metaValue },
  });
  assert.deepEqual(callerFromRequest(both(SENDER, SENDER)), { discordUserId: SENDER });
  assert.deepEqual(callerFromRequest(both(SENDER, RECIPIENT)), {}, "sources disagree");
  assert.deepEqual(callerFromRequest(both("bad", SENDER)), {}, "one source is malformed");
});

test("behind a _meta gateway, relay_to must be the caller and read_dms shows them their DM", async () => {
  process.env.DISCORD_DM_RELAY = "true";
  process.env.DISCORD_DM_RELAY_CALLER_META = "gateway/discordUserId";
  const sent = stubUser();
  await assert.rejects(
    sendDm()({ user_id: RECIPIENT, content: "hi", relay_to: SENDER }),
    /no valid caller in the _meta key gateway\/discordUserId/,
  );
  const self = callerFromRequest({ meta: { "gateway/discordUserId": SENDER } });
  const result = await runAsCaller(self, () =>
    sendDm()({ user_id: RECIPIENT, content: "hi", relay_to: SENDER }),
  );
  assert.match(textOf(result), /relayed to user/);
  assert.equal(sent.length, 1);
});
