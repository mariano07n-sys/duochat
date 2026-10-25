import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { createChatServer } from "../src/server.js";

class TestClient {
  constructor(ws) {
    this.ws = ws;
    this.queue = [];
    this.closeInfo = null;
    ws.on("message", (raw) => {
      try {
        this.queue.push(JSON.parse(raw.toString()));
      } catch {
        // ignore
      }
    });
    ws.on("close", (code, reason) => {
      this.closeInfo = { code, reason: reason.toString() };
    });
  }

  send(message) {
    this.ws.send(JSON.stringify(message));
  }

  async waitFor(predicate, timeout = 2000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      const index = this.queue.findIndex(predicate);
      if (index !== -1) return this.queue.splice(index, 1)[0];
      await delay(10);
    }
    throw new Error(`Timeout. Messages recus: ${JSON.stringify(this.queue)}`);
  }

  async waitClose(timeout = 2000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      if (this.closeInfo) return this.closeInfo;
      await delay(10);
    }
    throw new Error("Timeout en attendant la fermeture de la connexion");
  }

  close() {
    this.ws.close();
  }

  terminate() {
    this.ws.terminate();
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startServer(options = {}) {
  const chat = createChatServer({
    port: 0,
    host: "127.0.0.1",
    dataDir: options.dataDir ?? null,
    heartbeatMs: 0,
    log: null,
  });
  await chat.listen();
  return chat;
}

async function connect(port, options = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const client = new TestClient(ws);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  client.send({
    t: "join",
    roomKey: options.roomKey ?? "salon-secret",
    name: options.name ?? "Alice",
    userId: options.userId ?? "alice-1234",
  });
  return client;
}

async function fixture(t, options = {}) {
  const chat = await startServer(options);
  const { port } = chat.address();
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.terminate();
    await chat.close();
  });
  return {
    chat,
    port,
    async connect(joinOptions) {
      const client = await connect(port, joinOptions);
      clients.push(client);
      return client;
    },
  };
}

test("rejoint un salon, diffuse les messages et met a jour la presence", async (t) => {
  const { connect: open } = await fixture(t);

  const alice = await open({ name: "Alice", userId: "alice-1234" });
  const helloAlice = await alice.waitFor((m) => m.t === "hello");
  assert.equal(helloAlice.self.name, "Alice");
  assert.deepEqual(helloAlice.history, []);
  assert.equal(helloAlice.users.length, 1);

  const bob = await open({ name: "Bob", userId: "bob-56789" });
  const helloBob = await bob.waitFor((m) => m.t === "hello");
  assert.equal(helloBob.users.length, 2);

  const presence = await alice.waitFor((m) => m.t === "presence");
  assert.deepEqual(
    presence.users.map((user) => user.name).sort(),
    ["Alice", "Bob"],
  );
  const system = await alice.waitFor((m) => m.t === "system");
  assert.match(system.text, /Bob a rejoint/);

  bob.send({ t: "msg", text: "Salut Alice" });
  const receivedByAlice = await alice.waitFor((m) => m.t === "msg");
  const echoForBob = await bob.waitFor((m) => m.t === "msg");
  assert.equal(receivedByAlice.text, "Salut Alice");
  assert.equal(receivedByAlice.id, echoForBob.id);
  assert.equal(receivedByAlice.name, "Bob");
  assert.match(receivedByAlice.color, /^#[0-9a-f]{6}$/);
  assert.equal(typeof receivedByAlice.ts, "number");

  bob.close();
  const leavePresence = await alice.waitFor(
    (m) => m.t === "presence" && m.users.length === 1,
  );
  assert.equal(leavePresence.users[0].name, "Alice");
});

test("partage une reference fichier:ligne", async (t) => {
  const { connect: open } = await fixture(t);
  const alice = await open({ name: "Alice", userId: "alice-1234" });
  const bob = await open({ name: "Bob", userId: "bob-56789" });
  await alice.waitFor((m) => m.t === "hello");
  await bob.waitFor((m) => m.t === "hello");
  await alice.waitFor((m) => m.t === "presence");

  alice.send({ t: "msg", kind: "location", meta: { file: "src/app.ts", line: 42 } });
  const message = await bob.waitFor((m) => m.t === "msg");
  assert.equal(message.kind, "location");
  assert.deepEqual(message.meta, { file: "src/app.ts", line: 42 });
  assert.equal(message.text, "src/app.ts:42");

  alice.send({ t: "msg", kind: "location", meta: { file: "src/app.ts", line: 0 } });
  const error = await alice.waitFor((m) => m.t === "error");
  assert.equal(error.code, "invalid_location");
});

test("l'historique est persiste et recharge apres redemarrage", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "duochat-history-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const first = await startServer({ dataDir });
  const firstPort = first.address().port;
  const alice = await connect(firstPort, { name: "Alice", userId: "alice-1234" });
  await alice.waitFor((m) => m.t === "hello");
  alice.send({ t: "msg", text: "Premier message" });
  alice.send({ t: "msg", text: "Deuxieme message" });
  await alice.waitFor((m) => m.t === "msg" && m.text === "Premier message");
  await alice.waitFor((m) => m.t === "msg" && m.text === "Deuxieme message");
  alice.close();
  await delay(100);
  await first.close();

  const second = await startServer({ dataDir });
  t.after(() => second.close());
  const bob = await connect(second.address().port, {
    name: "Bob",
    userId: "bob-56789",
  });
  const hello = await bob.waitFor((m) => m.t === "hello");
  assert.deepEqual(
    hello.history.map((message) => message.text),
    ["Premier message", "Deuxieme message"],
  );
});

test("isole les salons et valide les entrees", async (t) => {
  const { connect: open } = await fixture(t);

  const alice = await open({ name: "Alice", userId: "alice-1234", roomKey: " salon-a " });
  await alice.waitFor((m) => m.t === "hello");
  const bob = await open({ name: "Bob", userId: "bob-56789", roomKey: "salon-b" });
  await bob.waitFor((m) => m.t === "hello");

  alice.send({ t: "msg", text: "Message prive A" });
  await alice.waitFor((m) => m.t === "msg");
  await delay(250);
  assert.equal(
    bob.queue.some((m) => m.t === "msg"),
    false,
    "Bob ne doit pas recevoir les messages du salon A",
  );

  alice.send({ t: "msg", text: "x".repeat(4001) });
  const error = await alice.waitFor((m) => m.t === "error");
  assert.equal(error.code, "too_long");

  alice.send({ t: "msg", text: "   " });
  await delay(100);
  assert.equal(alice.queue.some((m) => m.t === "msg" && m.text === ""), false);

  const shortKey = await open({ roomKey: "123", name: "Eve", userId: "eve-123456" });
  const joinError = await shortKey.waitFor((m) => m.t === "error");
  assert.equal(joinError.code, "invalid_room_key");
  const closeInfo = await shortKey.waitClose();
  assert.equal(closeInfo.code, 4400);
});

test("relaie l'indicateur de frappe et l'arrete a l'envoi", async (t) => {
  const { connect: open } = await fixture(t);
  const alice = await open({ name: "Alice", userId: "alice-1234" });
  const bob = await open({ name: "Bob", userId: "bob-56789" });
  await alice.waitFor((m) => m.t === "hello");
  await bob.waitFor((m) => m.t === "hello");
  await alice.waitFor((m) => m.t === "presence");

  alice.send({ t: "typing", on: true });
  const typing = await bob.waitFor((m) => m.t === "typing");
  assert.equal(typing.name, "Alice");
  assert.equal(typing.on, true);

  alice.send({ t: "msg", text: "coucou" });
  const typingOff = await bob.waitFor((m) => m.t === "typing" && m.on === false);
  assert.equal(typingOff.userId, "alice-1234");
  const message = await bob.waitFor((m) => m.t === "msg");
  assert.equal(message.text, "coucou");
});

test("une identite reste unique avec plusieurs fenetres", async (t) => {
  const { connect: open } = await fixture(t);
  const bob = await open({ name: "Bob", userId: "bob-56789" });
  await bob.waitFor((m) => m.t === "hello");

  const aliceWindow1 = await open({ name: "Alice", userId: "alice-1234" });
  await aliceWindow1.waitFor((m) => m.t === "hello");
  const aliceWindow2 = await open({ name: "Alice", userId: "alice-1234" });
  const helloWindow2 = await aliceWindow2.waitFor((m) => m.t === "hello");
  assert.equal(helloWindow2.users.filter((user) => user.id === "alice-1234").length, 1);

  await bob.waitFor((m) => m.t === "presence");
  aliceWindow1.close();
  await delay(150);
  aliceWindow2.send({ t: "msg", text: "toujours la" });
  const message = await bob.waitFor((m) => m.t === "msg");
  assert.equal(message.text, "toujours la");
});

test("limite le debit de messages", async (t) => {
  const { connect: open } = await fixture(t);
  const alice = await open({ name: "Alice", userId: "alice-1234" });
  await alice.waitFor((m) => m.t === "hello");

  for (let i = 0; i < 25; i++) {
    alice.send({ t: "msg", text: `spam ${i}` });
  }
  const error = await alice.waitFor((m) => m.t === "error", 3000);
  assert.equal(error.code, "rate_limited");
});

test("expose un endpoint de sante", async (t) => {
  const { chat, port } = await fixture(t);
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.uptime, "number");
  assert.equal(chat.stats().connections, 0);
});
