import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordAPIError, type MessageCreateOptions } from "discord.js";
import {
  RELAY_MAX_LINKS,
  RELAY_RETENTION_MS,
  RELAY_WINDOW_MS,
  RelayRateLimiter,
  RelayStore,
  dmRelayCallerHeader,
  dmRelayCallerMetaKey,
  dmRelayCallerSource,
  dmRelayEnabled,
  emptyRelayState,
  loadRelayState,
  pruneRelay,
  recordRelay,
  resolveRelay,
  saveRelayState,
} from "../src/dmRelayStore.js";
import { handleRelayDm, splitContent, type IncomingDm, type RelayDeps } from "../src/dmRelay.js";

const SENDER = "111111111111111111";
const RECIPIENT = "222222222222222222";
const OTHER = "333333333333333333";
const MSG = "444444444444444444";
const INCOMING = "888888888888888888";
const T0 = 1_800_000_000_000;

const dir = mkdtempSync(join(tmpdir(), "dm-relay-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

afterEach(() => {
  mock.restoreAll();
  delete process.env.DISCORD_DM_RELAY;
  delete process.env.DISCORD_DM_RELAY_CALLER_HEADER;
  delete process.env.DISCORD_DM_RELAY_CALLER_META;
});

// ─── Config ────────────────────────────────────────────────────────────────────

test("DISCORD_DM_RELAY is off unless set, and a typo stops the server", () => {
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

test("DISCORD_DM_RELAY_CALLER_HEADER is lowercased, and a malformed name stops the server", () => {
  assert.equal(dmRelayCallerHeader(), undefined);
  process.env.DISCORD_DM_RELAY_CALLER_HEADER = " X-Discord-User-Id ";
  assert.equal(dmRelayCallerHeader(), "x-discord-user-id");
  process.env.DISCORD_DM_RELAY_CALLER_HEADER = "x discord";
  assert.throws(() => dmRelayCallerHeader(), /Invalid DISCORD_DM_RELAY_CALLER_HEADER/);
});

test("DISCORD_DM_RELAY_CALLER_META takes a _meta key, and the source names what is set", () => {
  assert.equal(dmRelayCallerMetaKey(), undefined);
  assert.equal(dmRelayCallerSource(), undefined);
  process.env.DISCORD_DM_RELAY_CALLER_META = "gateway/discordUserId";
  assert.equal(dmRelayCallerMetaKey(), "gateway/discordUserId");
  assert.equal(dmRelayCallerSource(), "the _meta key gateway/discordUserId");
  process.env.DISCORD_DM_RELAY_CALLER_HEADER = "x-discord-user-id";
  assert.equal(
    dmRelayCallerSource(),
    "the x-discord-user-id header or the _meta key gateway/discordUserId",
  );
  process.env.DISCORD_DM_RELAY_CALLER_META = "bad key";
  assert.throws(() => dmRelayCallerMetaKey(), /Invalid DISCORD_DM_RELAY_CALLER_META/);
});

// ─── Routing rules ─────────────────────────────────────────────────────────────

test("a Reply to a relayed message goes to its sender", () => {
  const state = emptyRelayState();
  recordRelay(state, [MSG], RECIPIENT, SENDER, T0);
  assert.deepEqual(resolveRelay(state, RECIPIENT, MSG, undefined, T0 + 1000), {
    kind: "peer",
    peer: SENDER,
  });
});

test("a Reply only counts in the DM it was sent to", () => {
  const state = emptyRelayState();
  recordRelay(state, [MSG], RECIPIENT, SENDER, T0);
  assert.deepEqual(resolveRelay(state, OTHER, MSG, undefined, T0), { kind: "none" });
});

test("a Reply routes until retention ends, and is never guessed after", () => {
  const state = emptyRelayState();
  recordRelay(state, [MSG], RECIPIENT, SENDER, T0);
  recordRelay(state, ["x"], RECIPIENT, OTHER, T0 + RELAY_RETENTION_MS - 10);
  assert.deepEqual(resolveRelay(state, RECIPIENT, MSG, undefined, T0 + RELAY_RETENTION_MS), {
    kind: "peer",
    peer: SENDER,
  });
  assert.deepEqual(resolveRelay(state, RECIPIENT, MSG, undefined, T0 + RELAY_RETENTION_MS + 1), {
    kind: "none",
  });
});

test("a Reply to a message outside the relay is not guessed from recent contacts", () => {
  const state = emptyRelayState();
  recordRelay(state, [MSG], RECIPIENT, SENDER, T0);
  assert.deepEqual(resolveRelay(state, RECIPIENT, "555555555555555555", [MSG], T0 + 10), {
    kind: "none",
  });
});

test("a plain message goes to the sender of the bot's latest message when it is relayed", () => {
  const state = emptyRelayState();
  recordRelay(state, [MSG], RECIPIENT, SENDER, T0);
  assert.deepEqual(resolveRelay(state, RECIPIENT, undefined, [MSG], T0 + RELAY_WINDOW_MS), {
    kind: "peer",
    peer: SENDER,
  });
  assert.deepEqual(
    resolveRelay(state, RECIPIENT, undefined, [MSG], T0 + RELAY_WINDOW_MS + 1),
    { kind: "none" },
    "past the window",
  );
});

test("a plain message after some other bot DM is not relayed", () => {
  const state = emptyRelayState();
  recordRelay(state, [MSG], RECIPIENT, SENDER, T0);
  const notification = "999999999999999999";
  assert.deepEqual(resolveRelay(state, RECIPIENT, undefined, [notification, MSG], T0 + 10), {
    kind: "none",
  });
  assert.deepEqual(resolveRelay(state, RECIPIENT, undefined, undefined, T0 + 10), {
    kind: "none",
  });
});

test("a plain message is ambiguous when several people relayed recently, newest first", () => {
  const state = emptyRelayState();
  recordRelay(state, ["1"], RECIPIENT, SENDER, T0);
  recordRelay(state, ["2"], RECIPIENT, OTHER, T0 + 10);
  assert.deepEqual(resolveRelay(state, RECIPIENT, undefined, ["2"], T0 + 20), {
    kind: "ambiguous",
    peers: [OTHER, SENDER],
  });
  assert.deepEqual(resolveRelay(state, RECIPIENT, "1", undefined, T0 + 20), {
    kind: "peer",
    peer: SENDER,
  });
});

test("pruning drops expired links, sources and contacts, then the oldest past the cap", () => {
  const state = emptyRelayState();
  recordRelay(state, ["old"], RECIPIENT, SENDER, T0);
  state.sources.oldSource = T0;
  const now = T0 + RELAY_RETENTION_MS + 1;
  for (let i = 0; i <= RELAY_MAX_LINKS; i++)
    state.links[`n${i}`] = { owner: OTHER, peer: SENDER, at: now - i };
  pruneRelay(state, now);
  assert.equal(state.links.old, undefined);
  assert.equal(state.sources.oldSource, undefined);
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
  state.sources[INCOMING] = T0;
  await saveRelayState(path, state);
  assert.deepEqual(await loadRelayState(path), state);
});

test("a file that is not a relay store is refused instead of overwritten", async () => {
  const path = join(dir, "foreign.json");
  writeFileSync(path, JSON.stringify({ hello: "world" }));
  await assert.rejects(loadRelayState(path), /not a DM relay store/);
  await assert.rejects(new RelayStore(path).ready(), /not a DM relay store/);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { hello: "world" });
});

test("RelayStore loads again after a failed load instead of failing until restart", async () => {
  const path = join(dir, "recover.json");
  writeFileSync(path, "{ not json");
  const store = new RelayStore(path, () => T0);
  await assert.rejects(store.resolve(RECIPIENT, MSG));
  const state = emptyRelayState();
  recordRelay(state, [MSG], RECIPIENT, SENDER, T0);
  await saveRelayState(path, state);
  assert.deepEqual(await store.resolve(RECIPIENT, MSG), { kind: "peer", peer: SENDER });
});

test("RelayStore.ready fails on a path it cannot write", async () => {
  const blocker = join(dir, "a-file");
  writeFileSync(blocker, "");
  await assert.rejects(new RelayStore(join(blocker, "store.json")).ready());
});

test("RelayStore saves every record before it resolves, and knows relayed messages", async () => {
  const path = join(dir, "store.json");
  const store = new RelayStore(path, () => T0);
  await Promise.all([
    store.record(["a"], RECIPIENT, SENDER),
    store.record(["b"], RECIPIENT, OTHER),
    store.recordSource(INCOMING),
  ]);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(Object.keys(saved.links).sort(), ["a", "b"]);
  const reloaded = new RelayStore(path, () => T0);
  assert.deepEqual(await reloaded.resolve(RECIPIENT, "b"), { kind: "peer", peer: OTHER });
  assert.equal(await reloaded.isRelayed("a"), true);
  assert.equal(await reloaded.isRelayed(INCOMING), true);
  assert.equal(await reloaded.isRelayed("z"), false);
});

test("the rate limiter allows a burst per sender, then names the wait", () => {
  let now = T0;
  const limiter = new RelayRateLimiter(2, 1000, () => now);
  assert.equal(limiter.take(SENDER).ok, true);
  assert.equal(limiter.take(SENDER).ok, true);
  assert.equal(limiter.take(OTHER).ok, true, "other senders are counted apart");
  now += 400;
  assert.deepEqual(limiter.take(SENDER), { ok: false, retryInMs: 600 });
  now += 600;
  assert.equal(limiter.take(SENDER).ok, true);
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

test("a plain message looks past the relay's own notices by ID, never by content", () => {
  const state = emptyRelayState();
  recordRelay(state, [MSG], RECIPIENT, SENDER, T0);
  state.notices.notice1 = T0 + 5;
  assert.deepEqual(resolveRelay(state, RECIPIENT, undefined, ["notice1", MSG], T0 + 10), {
    kind: "peer",
    peer: SENDER,
  });
  assert.deepEqual(
    resolveRelay(state, RECIPIENT, undefined, ["alert", MSG], T0 + 10),
    { kind: "none" },
    "another bot message, whatever it starts with, stops the relay",
  );
});

interface Sent {
  userId: string;
  options: MessageCreateOptions;
}

type Route = Awaited<ReturnType<RelayDeps["store"]["resolve"]>>;

function fakeDeps(
  route: Route,
  opts: { failSend?: "discord" | "internal"; failRecord?: boolean; failSource?: boolean } = {},
) {
  const sent: Sent[] = [];
  const recorded: { ids: string[]; owner: string; peer: string }[] = [];
  const sources: string[] = [];
  const notices: string[] = [];
  const resolved: unknown[][] = [];
  let next = 900;
  const deps: RelayDeps = {
    store: {
      resolve: async (...args) => {
        resolved.push(args);
        return route;
      },
      record: async (ids, owner, peer) => {
        if (opts.failRecord) throw new Error("EROFS: read-only file system");
        recorded.push({ ids, owner, peer });
      },
      recordSource: async (id) => {
        if (opts.failSource) throw new Error("EROFS: read-only file system");
        sources.push(id);
      },
      recordNotice: async (id) => {
        if (opts.failSource) throw new Error("EROFS: read-only file system");
        notices.push(id);
      },
    },
    sendDm: async (userId, options) => {
      if (opts.failSend === "discord")
        throw new DiscordAPIError(
          { code: 50007, message: "Cannot send messages to this user" },
          50007,
          403,
          "POST",
          "https://discord.com/api/v10/channels/1/messages",
          {},
        );
      if (opts.failSend) throw new Error("connect ECONNREFUSED 10.0.0.12:443");
      sent.push({ userId, options });
      return String(next++);
    },
    recentBotMessageIds: async () => [MSG],
  };
  return { deps, sent, recorded, sources, notices, resolved };
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
    id: INCOMING,
    author: { id: RECIPIENT, bot: opts.bot ?? false },
    content: opts.content ?? "",
    attachments: new Map((opts.attachments ?? []).map((a, i) => [String(i), a])),
    reference: opts.replyTo ? { messageId: opts.replyTo } : null,
    inGuild: () => opts.guild ?? false,
    reply: async (text: string) => {
      calls.replies.push(text);
      return { id: `reply${calls.replies.length}` };
    },
    react: async (emoji: string) => calls.reactions.push(emoji),
  };
  return { message: message as unknown as IncomingDm, calls };
}

test("an answer is forwarded to the sender, recorded, and acknowledged", async () => {
  const { deps, sent, recorded, sources } = fakeDeps({ kind: "peer", peer: SENDER });
  const { message, calls } = fakeMessage({ content: "Done, see the PR.", replyTo: MSG });
  await handleRelayDm(message, deps);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].userId, SENDER);
  assert.match(String(sent[0].options.content), new RegExp(`^📩 <@${RECIPIENT}> answered`));
  assert.match(String(sent[0].options.content), /Done, see the PR\.$/);
  assert.deepEqual(sent[0].options.allowedMentions, { parse: [] });
  assert.deepEqual(recorded, [{ ids: ["900"], owner: SENDER, peer: RECIPIENT }]);
  assert.deepEqual(sources, [INCOMING], "the original is marked as forwarded");
  assert.deepEqual(calls.reactions, ["✅"]);
});

test("a Reply resolves without reading history; a plain message passes the bot's latest message", async () => {
  const reply = fakeDeps({ kind: "peer", peer: SENDER });
  await handleRelayDm(fakeMessage({ content: "a", replyTo: MSG }).message, reply.deps);
  assert.deepEqual(reply.resolved[0], [RECIPIENT, MSG, undefined]);
  const plain = fakeDeps({ kind: "peer", peer: SENDER });
  await handleRelayDm(fakeMessage({ content: "b" }).message, plain.deps);
  assert.deepEqual(plain.resolved[0], [RECIPIENT, undefined, [MSG]]);
});

test("a delivered answer still gets ✅ when the store cannot save its link", async () => {
  const errors = mock.method(console, "error", () => {});
  const { deps, sent } = fakeDeps({ kind: "peer", peer: SENDER }, { failRecord: true });
  const { message, calls } = fakeMessage({ content: "hi" });
  await handleRelayDm(message, deps);
  assert.equal(sent.length, 1);
  assert.deepEqual(calls.reactions, ["✅"]);
  assert.equal(calls.replies.length, 0);
  assert.ok(errors.mock.callCount() >= 1, "the store failure is logged");
});

test("attachments travel as files, and as links over several messages when the upload fails", async () => {
  const file = { url: "https://cdn.discordapp.com/a/b/shot.png", name: "shot.png" };
  const { deps, sent } = fakeDeps({ kind: "peer", peer: SENDER });
  await handleRelayDm(fakeMessage({ attachments: [file] }).message, deps);
  assert.deepEqual(sent[0].options.files, [{ attachment: file.url, name: file.name }]);

  const many = Array.from({ length: 30 }, (_, i) => ({
    url: `https://cdn.discordapp.com/attachments/1/2/${"f".repeat(80)}${i}.png`,
    name: `${i}.png`,
  }));
  const fallback = fakeDeps({ kind: "peer", peer: SENDER });
  const send = fallback.deps.sendDm;
  fallback.deps.sendDm = async (userId, options) => {
    if (options.files) throw new Error("Request entity too large");
    return send(userId, options);
  };
  await handleRelayDm(fakeMessage({ content: "here", attachments: many }).message, fallback.deps);
  assert.ok(fallback.sent.length >= 2, "links spill over into more messages");
  const text = fallback.sent.map((s) => String(s.options.content)).join("\n");
  for (const f of many) assert.ok(text.includes(f.url), `${f.name} is not lost`);
  assert.ok(fallback.sent.every((s) => String(s.options.content).length <= 2000));
  assert.equal(fallback.recorded[0].ids.length, fallback.sent.length, "every part is recorded");
});

test("a long answer is split, and every part is recorded", async () => {
  const { deps, sent, recorded } = fakeDeps({ kind: "peer", peer: SENDER });
  await handleRelayDm(fakeMessage({ content: "y".repeat(3500) }).message, deps);
  assert.equal(sent.length, 2);
  assert.ok(sent.every((s) => String(s.options.content).length <= 2000));
  assert.deepEqual(recorded[0].ids, ["900", "901"]);
});

test("an ambiguous plain message asks for a Reply, records the notice, and forwards nothing", async () => {
  const { deps, sent, notices } = fakeDeps({ kind: "ambiguous", peers: [OTHER, SENDER] });
  const { message, calls } = fakeMessage({ content: "ok" });
  await handleRelayDm(message, deps);
  assert.equal(sent.length, 0);
  assert.match(calls.replies[0], new RegExp(`<@${OTHER}>, <@${SENDER}>.*Use Reply`));
  assert.deepEqual(notices, ["reply1"]);
});

test("nothing is forwarded when the message cannot first be marked as relayed", async () => {
  mock.method(console, "error", () => {});
  const { deps, sent } = fakeDeps({ kind: "peer", peer: SENDER }, { failSource: true });
  const { message, calls } = fakeMessage({ content: "private answer" });
  await handleRelayDm(message, deps);
  assert.equal(sent.length, 0, "fails closed: an unmarked message would show in DM reads");
  assert.match(calls.replies[0], /could not deliver.*cannot save it right now/);
  assert.doesNotMatch(calls.replies[0], /EROFS/, "store details stay in the server log");
  assert.deepEqual(calls.reactions, []);
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

test("a failed delivery is explained to the author with a recorded notice", async () => {
  mock.method(console, "error", () => {});
  const { deps, sources, notices } = fakeDeps(
    { kind: "peer", peer: SENDER },
    { failSend: "discord" },
  );
  const { message, calls } = fakeMessage({ content: "hi" });
  await handleRelayDm(message, deps);
  assert.match(calls.replies[0], /could not deliver.*Cannot send messages to this user/);
  assert.deepEqual(notices, ["reply1"]);
  assert.deepEqual(sources, [INCOMING], "marked before the attempt, so it stays hidden");
  assert.deepEqual(calls.reactions, []);
});

test("an internal delivery error reaches the author only as a generic reason", async () => {
  const errors = mock.method(console, "error", () => {});
  const { deps } = fakeDeps({ kind: "peer", peer: SENDER }, { failSend: "internal" });
  const { message, calls } = fakeMessage({ content: "hi" });
  await handleRelayDm(message, deps);
  assert.match(calls.replies[0], /could not deliver.*something went wrong on my side/);
  assert.doesNotMatch(calls.replies[0], /ECONNREFUSED|10\.0\.0\.12/);
  assert.ok(
    errors.mock.calls.some((c) => String(c.arguments[0]).includes("ECONNREFUSED")),
    "the details are logged",
  );
});
