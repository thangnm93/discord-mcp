import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { discord } from "../src/client.js";
import { createServer } from "../src/server.js";

// The caller's ID travels in the tools/call _meta from the client to the tool, over a
// transport with no headers: the path a gateway running the server over stdio uses.

const SENDER = "111111111111111111";
const RECIPIENT = "222222222222222222";
const KEY = "gateway/discordUserId";
const dir = mkdtempSync(join(tmpdir(), "relay-meta-"));

let client: Client;

before(async () => {
  process.env.DISCORD_DM_RELAY = "true";
  process.env.DISCORD_DM_RELAY_CALLER_META = KEY;
  process.env.DISCORD_DM_RELAY_STORE = join(dir, "relay.json");
  mock.method(discord, "isReady", () => true);
  mock.method(
    discord.users,
    "fetch",
    async () =>
      ({ username: "recipient", send: async () => ({ id: "999999999999999999" }) }) as never,
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer("0.0.0-test").connect(serverSide);
  client = new Client({ name: "relay-meta-test", version: "1" });
  await client.connect(clientSide);
});

after(async () => {
  await client.close();
  mock.restoreAll();
  rmSync(dir, { recursive: true, force: true });
});

async function send(meta: Record<string, unknown> | undefined) {
  const result = (await client.callTool({
    name: "discord_send_dm",
    arguments: { user_id: RECIPIENT, content: "hi", relay_to: SENDER },
    ...(meta ? { _meta: meta } : {}),
  })) as { isError?: boolean; content: { text: string }[] };
  return { isError: Boolean(result.isError), text: result.content[0].text };
}

test("without headers, relay_to must match the caller named in _meta", async () => {
  const missing = await send(undefined);
  assert.equal(missing.isError, true);
  assert.match(missing.text, /no valid caller in the _meta key gateway\/discordUserId/);

  const other = await send({ [KEY]: "333333333333333333" });
  assert.equal(other.isError, true);
  assert.match(other.text, /must be your own Discord user ID \(333333333333333333\)/);

  const self = await send({ [KEY]: SENDER });
  assert.equal(self.isError, false, self.text);
  assert.match(self.text, /Answers will be relayed to user 111111111111111111/);
});
