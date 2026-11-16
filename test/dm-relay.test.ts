import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageCreateOptions } from "discord.js";
import {
  RELAY_MAX_LINKS,
  RELAY_RETENTION_MS,
  RELAY_WINDOW_MS,
  RelayStore,
  dmRelayEnabled,
  emptyRelayState,
  loadRelayState,
  pruneRelay,
  recordRelay,
  resolveRelay,
  saveRelayState,
} from "../src/dmRelayStore.js";
import { handleRelayDm, splitContent, type RelayDeps } from "../src/dmRelay.js";

const SENDER = "111111111111111111";
const RECIPIENT = "222222222222222222";
const OTHER = "333333333333333333";
const MSG = "444444444444444444";
const T0 = 1_800_000_000_000;

const dir = mkdtempSync(join(tmpdir(), "dm-relay-"));
process.env.DISCORD_DM_RELAY_STORE = join(dir, "tool-store.json");
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

afterEach(() => {
  mock.restoreAll();
  delete process.env.DISCORD_DM_RELAY;
});

// ─── Config ────────────────────────────────────────────────────────────────────

test("DISCORD_DM_RELAY is off unless set, and a typo stops the server", () => {
  delete process.env.DISCORD_DM_RELAY;
  assert.equal(dmRelayEnabled(), false);
  for (const on of ["true", "1", "YES", " on "]) {
    process.env.DISCORD_DM_RELAY = on;
    assert.equal(dmRelayEnabled(), true, on);
  }
  for (const off of ["", "false", "0", "no", "Off"]) {
    process.env.DISCORD_DM_RELAY = off;
    assert.equal(dmRelayEnabled(), false, off);
  }
  process.env.DISCORD_DM_RELAY = "enabled";
  assert.throws(() => dmRelayEnabled(), /Invalid DISCORD_DM_RELAY: "enabled"/);
});

// ─── Routing rules ─────────────────────────────────────────────────────────────

test("a Reply to a relayed message goes to its sender", () => {
  const state = emptyRelayState();
  recordRelay(state, [MSG], RECIPIENT, SENDER, T0);
  assert.deepEqual(resolveRelay(state, RECIPIENT, MSG, T0 + 1000), { kind: "peer", peer: SENDER });
});

test("a Reply only counts in the DM it was sent to", () => {
  const state = emptyRelayState();
  recordRelay(state, [MSG], RECIPIENT, SENDER, T0 - 2 * RELAY_WINDOW_MS);
  assert.deepEqual(resolveRelay(state, OTHER, MSG, T0), { kind: "none" });
});

test("a plain message goes to the only person who relayed within the window", () => {
  const state = emptyRelayState();
  recordRelay(state, [MSG], RECIPIENT, SENDER, T0);
  assert.deepEqual(resolveRelay(state, RECIPIENT, undefined, T0 + RELAY_WINDOW_MS), {
    kind: "peer",
    peer: SENDER,
  });
  assert.deepEqual(resolveRelay(state, RECIPIENT, undefined, T0 + RELAY_WINDOW_MS + 1), {
    kind: "none",
  });
});

test("a plain message is ambiguous when several people relayed recently, newest first", () => {
  const state = emptyRelayState();
  recordRelay(state, ["1"], RECIPIENT, SENDER, T0);
  recordRelay(state, ["2"], RECIPIENT, OTHER, T0 + 10);
  assert.deepEqual(resolveRelay(state, RECIPIENT, undefined, T0 + 20), {
    kind: "ambiguous",
    peers: [OTHER, SENDER],
  });
  assert.deepEqual(resolveRelay(state, RECIPIENT, "1", T0 + 20), { kind: "peer", peer: SENDER });
});

test("a Reply still routes after the window, until retention ends", () => {
  const state = emptyRelayState();
  recordRelay(state, [MSG], RECIPIENT, SENDER, T0);
  recordRelay(state, ["x"], RECIPIENT, OTHER, T0 + RELAY_RETENTION_MS - 10);
  assert.deepEqual(resolveRelay(state, RECIPIENT, MSG, T0 + RELAY_RETENTION_MS), {
    kind: "peer",
    peer: SENDER,
  });
  assert.deepEqual(
    resolveRelay(state, RECIPIENT, MSG, T0 + RELAY_RETENTION_MS + 1),
    { kind: "none" },
    "an expired link is not guessed from the recent contact",
  );
});

test("a Reply to a message outside the relay is not guessed from recent contacts", () => {
  const state = emptyRelayState();
  recordRelay(state, [MSG], RECIPIENT, SENDER, T0);
  assert.deepEqual(resolveRelay(state, RECIPIENT, "555555555555555555", T0 + 10), {
    kind: "none",
  });
  assert.deepEqual(resolveRelay(state, RECIPIENT, undefined, T0 + 10), {
    kind: "peer",
    peer: SENDER,
  });
});

test("pruning drops expired links and contacts, then the oldest links past the cap", () => {
  const state = emptyRelayState();
  recordRelay(state, ["old"], RECIPIENT, SENDER, T0);
  const now = T0 + RELAY_RETENTION_MS + 1;
  for (let i = 0; i <= RELAY_MAX_LINKS; i++)
    state.links[`n${i}`] = { owner: OTHER, peer: SENDER, at: now - i };
  pruneRelay(state, now);
  assert.equal(state.links.old, undefined);
  assert.equal(Object.keys(state.links).length, RELAY_MAX_LINKS);
  assert.equal(state.links[`n${RELAY_MAX_LINKS}`], undefined, "the oldest link goes first");
  assert.equal(state.contacts[RECIPIENT], undefined);
});

// ─── Persistence ───────────────────────────────────────────────────────────────

test("the state survives a save and a load, and a missing file loads empty", async () => {
  const path = join(dir, "nested", "state.json");
  assert.deepEqual(await loadRelayState(path), emptyRelayState());
  const state = emptyRelayState();
  recordRelay(state, [MSG], RECIPIENT, SENDER, T0);
  await saveRelayState(path, state);
  assert.deepEqual(await loadRelayState(path), state);
});

test("a file that is not a relay store is refused instead of overwritten", async () => {
  const path = join(dir, "foreign.json");
  writeFileSync(path, JSON.stringify({ hello: "world" }));
  await assert.rejects(loadRelayState(path), /not a DM relay store/);
});

test("RelayStore saves every record before it resolves", async () => {
  const path = join(dir, "store.json");
  const store = new RelayStore(path, () => T0);
  await Promise.all([
    store.record(["a"], RECIPIENT, SENDER),
    store.record(["b"], RECIPIENT, OTHER),
  ]);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(Object.keys(saved.links).sort(), ["a", "b"]);
  assert.deepEqual(await new RelayStore(path, () => T0).resolve(RECIPIENT, "b"), {
    kind: "peer",
    peer: OTHER,
  });
});

// ─── Forwarding ────────────────────────────────────────────────────────────────

test("splitContent keeps chunks within the limit and prefers line breaks", () => {
  assert.deepEqual(splitContent("short"), ["short"]);
  const chunks = splitContent(`${"a".repeat(1500)}\n${"b".repeat(1500)}`);
  assert.deepEqual(
    chunks.map((c) => c.length),
    [1500, 1500],
  );
  assert.ok(splitContent("x".repeat(4500)).every((c) => c.length <= 2000));
});

interface Sent {
  userId: string;
  options: MessageCreateOptions;
}

function fakeDeps(route: Awaited<ReturnType<RelayDeps["store"]["resolve"]>>, failSend = false) {
  const sent: Sent[] = [];
  const recorded: { ids: string[]; owner: string; peer: string }[] = [];
  let next = 900;
  const deps: RelayDeps = {
    store: {
      resolve: async () => route,
      record: async (ids, owner, peer) => {
        recorded.push({ ids, owner, peer });
      },
    },
    sendDm: async (userId, options) => {
      if (failSend) throw new Error("Cannot send messages to this user");
      sent.push({ userId, options });
      return String(next++);
    },
  };
  return { deps, sent, recorded };
}

function fakeMessage(opts: {
  content?: string;
  bot?: boolean;
  guild?: boolean;
  attachments?: { url: string; name: string }[];
  replyTo?: string;
}) {
  const calls = { replies: [] as string[], reactions: [] as string[] };
  const message = {
    author: { id: RECIPIENT, bot: opts.bot ?? false },
    content: opts.content ?? "",
    attachments: new Map((opts.attachments ?? []).map((a, i) => [String(i), a])),
    reference: opts.replyTo ? { messageId: opts.replyTo } : null,
    inGuild: () => opts.guild ?? false,
    reply: async (text: string) => calls.replies.push(text),
    react: async (emoji: string) => calls.reactions.push(emoji),
  };
  return { message: message as never, calls };
}

test("an answer is forwarded to the sender, recorded, and acknowledged", async () => {
  const { deps, sent, recorded } = fakeDeps({ kind: "peer", peer: SENDER });
  const { message, calls } = fakeMessage({ content: "Done, see the PR.", replyTo: MSG });
  await handleRelayDm(message, deps);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].userId, SENDER);
  assert.match(String(sent[0].options.content), new RegExp(`^📩 <@${RECIPIENT}> answered`));
  assert.match(String(sent[0].options.content), /Done, see the PR\.$/);
  assert.deepEqual(sent[0].options.allowedMentions, { parse: [] });
  assert.deepEqual(recorded, [{ ids: ["900"], owner: SENDER, peer: RECIPIENT }]);
  assert.deepEqual(calls.reactions, ["✅"]);
});

test("attachments travel as files, and as links when the upload fails", async () => {
  const file = { url: "https://cdn.discordapp.com/a/b/shot.png", name: "shot.png" };
  const { deps, sent } = fakeDeps({ kind: "peer", peer: SENDER });
  await handleRelayDm(fakeMessage({ attachments: [file] }).message, deps);
  assert.deepEqual(sent[0].options.files, [{ attachment: file.url, name: file.name }]);

  let first = true;
  const fallback = fakeDeps({ kind: "peer", peer: SENDER });
  const send = fallback.deps.sendDm;
  fallback.deps.sendDm = async (userId, options) => {
    if (first && options.files) {
      first = false;
      throw new Error("Request entity too large");
    }
    return send(userId, options);
  };
  await handleRelayDm(fakeMessage({ content: "here", attachments: [file] }).message, fallback.deps);
  assert.equal(fallback.sent.length, 1);
  assert.equal(fallback.sent[0].options.files, undefined);
  assert.match(String(fallback.sent[0].options.content), /here\nhttps:\/\/cdn\.discordapp\.com/);
});

test("a long answer is split, and every part is recorded", async () => {
  const { deps, sent, recorded } = fakeDeps({ kind: "peer", peer: SENDER });
  await handleRelayDm(fakeMessage({ content: "y".repeat(3500) }).message, deps);
  assert.equal(sent.length, 2);
  assert.ok(sent.every((s) => String(s.options.content).length <= 2000));
  assert.deepEqual(recorded[0].ids, ["900", "901"]);
});

test("an ambiguous plain message asks for a Reply and forwards nothing", async () => {
  const { deps, sent } = fakeDeps({ kind: "ambiguous", peers: [OTHER, SENDER] });
  const { message, calls } = fakeMessage({ content: "ok" });
  await handleRelayDm(message, deps);
  assert.equal(sent.length, 0);
  assert.match(calls.replies[0], new RegExp(`<@${OTHER}>, <@${SENDER}>.*Use Reply`));
});

test("bots, server messages and DMs outside a relay are ignored", async () => {
  for (const opts of [{ bot: true }, { guild: true }]) {
    const { deps, sent } = fakeDeps({ kind: "peer", peer: SENDER });
    const { message, calls } = fakeMessage({ content: "hi", ...opts });
    await handleRelayDm(message, deps);
    assert.equal(sent.length + calls.replies.length + calls.reactions.length, 0);
  }
  const { deps, sent } = fakeDeps({ kind: "none" });
  const { message, calls } = fakeMessage({ content: "hi" });
  await handleRelayDm(message, deps);
  assert.equal(sent.length + calls.replies.length, 0);
});

test("a failed delivery is explained to the author", async () => {
  const { deps } = fakeDeps({ kind: "peer", peer: SENDER }, true);
  const { message, calls } = fakeMessage({ content: "hi" });
  await handleRelayDm(message, deps);
  assert.match(calls.replies[0], /could not deliver.*Cannot send messages to this user/);
  assert.deepEqual(calls.reactions, []);
});
