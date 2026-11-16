import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { discord } from "../src/client.js";
import { startHttpServer } from "../src/http.js";
import { createServer } from "../src/server.js";

// The gateway header travels from the HTTP request to the tool: the end-to-end path of
// DISCORD_DM_RELAY_CALLER_HEADER, which unit tests of the tool cannot reach.

const TOKEN = randomBytes(24).toString("hex");
const SENDER = "111111111111111111";
const RECIPIENT = "222222222222222222";
const dir = mkdtempSync(join(tmpdir(), "relay-http-"));

let server: Server;
let url: URL;
const logs = mock.method(console, "error", () => {});

before(async () => {
  process.env.DISCORD_DM_RELAY = "true";
  process.env.DISCORD_DM_RELAY_CALLER_HEADER = "x-discord-user-id";
  process.env.DISCORD_DM_RELAY_STORE = join(dir, "relay.json");
  mock.method(discord, "isReady", () => true);
  mock.method(
    discord.users,
    "fetch",
    async () =>
      ({ username: "recipient", send: async () => ({ id: "999999999999999999" }) }) as never,
  );
  server = await startHttpServer(
    { host: "127.0.0.1", port: 0, token: TOKEN, allowedHosts: ["127.0.0.1"] },
    () => createServer("0.0.0-test"),
  );
  url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  logs.mock.restore();
  mock.restoreAll();
  rmSync(dir, { recursive: true, force: true });
});

async function callAs(caller: string | undefined, relay_to: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` };
  if (caller) headers["X-Discord-User-Id"] = caller;
  const client = new Client({ name: "relay-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  try {
    const result = (await client.callTool({
      name: "discord_send_dm",
      arguments: { user_id: RECIPIENT, content: "hi", relay_to },
    })) as { isError?: boolean; content: { text: string }[] };
    return { isError: Boolean(result.isError), text: result.content[0].text };
  } finally {
    await client.close();
  }
}

test("over http, relay_to must match the gateway header", async () => {
  const missing = await callAs(undefined, SENDER);
  assert.equal(missing.isError, true);
  assert.match(missing.text, /no valid caller in the x-discord-user-id header/);

  const other = await callAs("333333333333333333", SENDER);
  assert.equal(other.isError, true);
  assert.match(other.text, /must be your own Discord user ID \(333333333333333333\)/);

  const self = await callAs(SENDER, SENDER);
  assert.equal(self.isError, false, self.text);
  assert.match(self.text, /Answers will be relayed to user 111111111111111111/);
});
