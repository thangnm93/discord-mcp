import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZodError } from "zod";
import { discord } from "../src/client.js";
import dm from "../src/tools/dm.js";

const SENDER = "111111111111111111";
const RECIPIENT = "222222222222222222";

const dir = mkdtempSync(join(tmpdir(), "dm-relay-tool-"));
const storePath = join(dir, "relay.json");
process.env.DISCORD_DM_RELAY_STORE = storePath;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

afterEach(() => {
  mock.restoreAll();
  delete process.env.DISCORD_DM_RELAY;
});

const sendDm = () => dm.handlers.get("discord_send_dm")!;
const textOf = (result: { content: { text?: string }[] }) =>
  result.content.map((c) => c.text ?? "").join("\n");

function stubUser() {
  const sent: unknown[] = [];
  mock.method(
    discord.users,
    "fetch",
    async () =>
      ({
        username: "recipient",
        send: async (payload: unknown) => {
          sent.push(payload);
          return { id: "999999999999999999" };
        },
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
  assert.deepEqual(saved.links["999999999999999999"], {
    owner: RECIPIENT,
    peer: SENDER,
    at: saved.links["999999999999999999"].at,
  });
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
