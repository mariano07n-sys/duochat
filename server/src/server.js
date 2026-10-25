import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";

export const LIMITS = Object.freeze({
  name: 32,
  text: 4000,
  file: 512,
  roomKeyMin: 6,
  roomKeyMax: 128,
  history: 200,
  payload: 64 * 1024,
  membersPerRoom: 32,
  socketsPerMember: 5,
  budget: 30,
  budgetRefillPerSecond: 6,
});

const COLORS = [
  "#22d3ee",
  "#a78bfa",
  "#34d399",
  "#fbbf24",
  "#fb7185",
  "#60a5fa",
  "#f472b6",
  "#2dd4bf",
];

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const RATE_NOTICE_MS = 2000;
const SAVE_DEBOUNCE_MS = 400;
const EMPTY_ROOM_TTL_MS = 60_000;
const JOIN_TIMEOUT_MS = 15_000;

function clean(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL_CHARS, "").trim().slice(0, max);
}

function cleanFile(value) {
  return clean(value, LIMITS.file).replace(/[\r\n\t]/g, "");
}

function cleanText(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS, "")
    .trim()
    .slice(0, LIMITS.text);
}

function hashRoomKey(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

function colorFor(userId) {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return COLORS[hash % COLORS.length];
}

function presence(room) {
  return [...room.members.values()].map(({ id, name, color }) => ({ id, name, color }));
}

function isValidHistoryEntry(entry) {
  return (
    entry &&
    typeof entry === "object" &&
    typeof entry.id === "string" &&
    typeof entry.userId === "string" &&
    typeof entry.name === "string" &&
    typeof entry.color === "string" &&
    typeof entry.text === "string" &&
    typeof entry.ts === "number" &&
    (entry.kind === "text" || entry.kind === "location") &&
    (entry.kind !== "location" ||
      (entry.meta &&
        typeof entry.meta.file === "string" &&
        Number.isInteger(entry.meta.line)))
  );
}

/**
 * @param {{
 *   port?: number,
 *   host?: string,
 *   dataDir?: string | null,
 *   heartbeatMs?: number,
 *   log?: Pick<Console, "info" | "error"> | null,
 * }} [options]
 */
export function createChatServer(options = {}) {
  const {
    port = 8787,
    host = "0.0.0.0",
    dataDir = null,
    heartbeatMs = 30_000,
    log = console,
  } = options;

  if (dataDir) mkdirSync(dataDir, { recursive: true });

  /** @type {Map<string, any>} */
  const rooms = new Map();

  const httpServer = createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/healthz")) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          uptime: Math.round(process.uptime()),
          connections: wss.clients.size,
          rooms: rooms.size,
        }),
      );
      return;
    }
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("DuoChat relay is running. Connect with the DuoChat VS Code extension.\n");
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found\n");
  });

  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: LIMITS.payload,
    clientTracking: true,
  });

  function send(socket, message) {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify(message));
    }
  }

  function sendError(socket, code, message) {
    send(socket, { t: "error", code, message });
  }

  function broadcast(room, message, exceptSocket) {
    for (const member of room.members.values()) {
      for (const socket of member.sockets) {
        if (socket !== exceptSocket) send(socket, message);
      }
    }
  }

  function loadHistory(roomId) {
    if (!dataDir) return [];
    try {
      const raw = JSON.parse(readFileSync(path.join(dataDir, `room-${roomId}.json`), "utf8"));
      if (!raw || !Array.isArray(raw.messages)) return [];
      return raw.messages.filter(isValidHistoryEntry).slice(-LIMITS.history);
    } catch {
      return [];
    }
  }

  function getRoom(roomId) {
    let room = rooms.get(roomId);
    if (!room) {
      room = {
        id: roomId,
        members: new Map(),
        messages: loadHistory(roomId),
        saveTimer: null,
        emptyTimer: null,
      };
      rooms.set(roomId, room);
    }
    return room;
  }

  function saveRoom(room) {
    if (!dataDir) return;
    try {
      const file = path.join(dataDir, `room-${room.id}.json`);
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, messages: room.messages }), "utf8");
      renameSync(tmp, file);
    } catch (error) {
      log?.error?.("[duochat] impossible d'ecrire l'historique:", error.message);
    }
  }

  function scheduleSave(room) {
    if (!dataDir || room.saveTimer) return;
    room.saveTimer = setTimeout(() => {
      room.saveTimer = null;
      saveRoom(room);
    }, SAVE_DEBOUNCE_MS);
    room.saveTimer.unref?.();
  }

  function scheduleEmptyCleanup(room) {
    if (room.emptyTimer) return;
    room.emptyTimer = setTimeout(() => {
      room.emptyTimer = null;
      if (room.members.size === 0) {
        if (room.saveTimer) {
          clearTimeout(room.saveTimer);
          room.saveTimer = null;
        }
        saveRoom(room);
        rooms.delete(room.id);
      }
    }, EMPTY_ROOM_TTL_MS);
    room.emptyTimer.unref?.();
  }

  function cancelEmptyCleanup(room) {
    if (room.emptyTimer) {
      clearTimeout(room.emptyTimer);
      room.emptyTimer = null;
    }
  }

  function makeBudget() {
    return { tokens: LIMITS.budget, last: Date.now() };
  }

  function takeBudget(conn, cost) {
    const now = Date.now();
    const refill = ((now - conn.budget.last) / 1000) * LIMITS.budgetRefillPerSecond;
    conn.budget.last = now;
    conn.budget.tokens = Math.min(LIMITS.budget, conn.budget.tokens + refill);
    if (conn.budget.tokens < cost) return false;
    conn.budget.tokens -= cost;
    return true;
  }

  function rejectRate(conn) {
    const now = Date.now();
    if (now - conn.lastRateNotice < RATE_NOTICE_MS) return;
    conn.lastRateNotice = now;
    sendError(conn.socket, "rate_limited", "Doucement : trop de messages en peu de temps.");
  }

  function closeWithError(conn, code, message, closeCode) {
    sendError(conn.socket, code, message);
    conn.socket.close(closeCode, message.slice(0, 120));
  }

  function handleJoin(conn, payload) {
    if (conn.member) {
      sendError(conn.socket, "already_joined", "Vous êtes déjà connecté à un salon.");
      return;
    }

    const roomKey = typeof payload.roomKey === "string" ? payload.roomKey.trim() : "";
    if (roomKey.length < LIMITS.roomKeyMin || roomKey.length > LIMITS.roomKeyMax) {
      closeWithError(
        conn,
        "invalid_room_key",
        `La clé du salon doit contenir entre ${LIMITS.roomKeyMin} et ${LIMITS.roomKeyMax} caractères.`,
        4400,
      );
      return;
    }

    const name = clean(payload.name, LIMITS.name) || "Anonyme";
    let userId = clean(payload.userId, 64);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(userId)) userId = randomUUID();

    const room = getRoom(hashRoomKey(roomKey));
    let member = room.members.get(userId);
    const isNewMember = !member;

    if (isNewMember && room.members.size >= LIMITS.membersPerRoom) {
      closeWithError(conn, "room_full", "Ce salon est complet.", 4403);
      return;
    }
    if (member && member.sockets.size >= LIMITS.socketsPerMember) {
      closeWithError(
        conn,
        "too_many_windows",
        "Trop de fenêtres connectées avec la même identité.",
        4403,
      );
      return;
    }

    let nameChanged = false;
    if (!member) {
      member = {
        id: userId,
        name,
        color: colorFor(userId),
        sockets: new Set(),
        typing: false,
      };
      room.members.set(userId, member);
    } else if (member.name !== name) {
      member.name = name;
      nameChanged = true;
    }

    member.sockets.add(conn.socket);
    conn.room = room;
    conn.member = member;
    if (conn.joinTimer) {
      clearTimeout(conn.joinTimer);
      conn.joinTimer = null;
    }
    cancelEmptyCleanup(room);

    send(conn.socket, {
      t: "hello",
      self: { id: member.id, name: member.name, color: member.color },
      users: presence(room),
      history: room.messages,
      serverTime: Date.now(),
    });

    if (isNewMember) {
      broadcast(room, { t: "presence", users: presence(room) }, conn.socket);
      broadcast(
        room,
        { t: "system", text: `${member.name} a rejoint le salon.`, ts: Date.now() },
        conn.socket,
      );
      log?.info?.(`[duochat] ${member.name} a rejoint (${room.members.size} en ligne)`);
    } else if (nameChanged) {
      broadcast(room, { t: "presence", users: presence(room) });
    }
  }

  function handleMessage(conn, payload) {
    if (!conn.member || !conn.room) {
      sendError(conn.socket, "not_joined", "Rejoignez d'abord un salon.");
      return;
    }
    if (!takeBudget(conn, 3)) {
      rejectRate(conn);
      return;
    }

    const rawText = typeof payload.text === "string" ? payload.text : "";
    if (rawText.length > LIMITS.text) {
      sendError(conn.socket, "too_long", `Message trop long (${LIMITS.text} caractères max).`);
      return;
    }

    let kind = "text";
    let text = cleanText(rawText);
    let meta;

    if (payload.kind === "location") {
      const file = cleanFile(payload.meta?.file);
      const line = Number(payload.meta?.line);
      if (!file || !Number.isInteger(line) || line < 1 || line > 1_000_000) {
        sendError(conn.socket, "invalid_location", "Référence de fichier invalide.");
        return;
      }
      kind = "location";
      meta = { file, line };
      text = `${file}:${line}`;
    } else if (!text) {
      return;
    }

    const member = conn.member;
    if (member.typing) {
      member.typing = false;
      broadcast(conn.room, {
        t: "typing",
        userId: member.id,
        name: member.name,
        on: false,
      });
    }

    const message = {
      t: "msg",
      id: randomUUID(),
      userId: member.id,
      name: member.name,
      color: member.color,
      text,
      kind,
      ts: Date.now(),
    };
    if (meta) message.meta = meta;

    conn.room.messages.push(message);
    if (conn.room.messages.length > LIMITS.history) {
      conn.room.messages.splice(0, conn.room.messages.length - LIMITS.history);
    }
    scheduleSave(conn.room);
    broadcast(conn.room, message);
  }

  function handleTyping(conn, payload) {
    if (!conn.member || !conn.room) return;
    if (!takeBudget(conn, 1)) return;

    const member = conn.member;
    const on = payload.on === true;
    if (member.typing === on) return;
    member.typing = on;
    broadcast(conn.room, {
      t: "typing",
      userId: member.id,
      name: member.name,
      on,
    });
  }

  function detach(conn) {
    if (!conn.room || !conn.member) return;
    const room = conn.room;
    const member = conn.member;
    conn.room = null;
    conn.member = null;

    member.sockets.delete(conn.socket);
    if (member.sockets.size > 0) return;

    if (member.typing) {
      broadcast(room, {
        t: "typing",
        userId: member.id,
        name: member.name,
        on: false,
      });
    }
    room.members.delete(member.id);
    broadcast(room, { t: "presence", users: presence(room) });
    broadcast(room, {
      t: "system",
      text: `${member.name} a quitté le salon.`,
      ts: Date.now(),
    });
    log?.info?.(`[duochat] ${member.name} a quitte (${room.members.size} en ligne)`);

    if (room.members.size === 0) scheduleEmptyCleanup(room);
  }

  wss.on("connection", (socket) => {
    const conn = {
      socket,
      room: null,
      member: null,
      budget: makeBudget(),
      lastRateNotice: 0,
      joinTimer: setTimeout(() => {
        if (!conn.member) {
          closeWithError(conn, "join_timeout", "Délai de connexion dépassé.", 4408);
        }
      }, JOIN_TIMEOUT_MS),
    };
    conn.joinTimer.unref?.();

    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
    });

    socket.on("message", (data) => {
      let payload;
      try {
        payload = JSON.parse(data.toString());
      } catch {
        sendError(socket, "invalid_json", "Message JSON invalide.");
        return;
      }
      if (!payload || typeof payload !== "object") {
        sendError(socket, "invalid_message", "Message invalide.");
        return;
      }

      switch (payload.t) {
        case "join":
          handleJoin(conn, payload);
          break;
        case "msg":
          handleMessage(conn, payload);
          break;
        case "typing":
          handleTyping(conn, payload);
          break;
        default:
          sendError(socket, "unknown_type", "Type de message inconnu.");
      }
    });

    socket.on("close", () => {
      if (conn.joinTimer) clearTimeout(conn.joinTimer);
      detach(conn);
    });

    socket.on("error", (error) => {
      log?.error?.("[duochat] erreur websocket:", error.message);
    });
  });

  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          for (const socket of wss.clients) {
            if (socket.isAlive === false) {
              socket.terminate();
              continue;
            }
            socket.isAlive = false;
            socket.ping();
          }
        }, heartbeatMs)
      : null;
  heartbeat?.unref?.();

  async function listen() {
    await new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, host, () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
    return httpServer.address();
  }

  async function close() {
    if (heartbeat) clearInterval(heartbeat);
    for (const room of rooms.values()) {
      if (room.saveTimer) clearTimeout(room.saveTimer);
      if (room.emptyTimer) clearTimeout(room.emptyTimer);
      room.saveTimer = null;
      room.emptyTimer = null;
      saveRoom(room);
    }
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(() => resolve()));
    await new Promise((resolve) => httpServer.close(() => resolve()));
    rooms.clear();
  }

  return {
    httpServer,
    wss,
    listen,
    close,
    address: () => httpServer.address(),
    stats: () => ({ connections: wss.clients.size, rooms: rooms.size }),
  };
}
