import { EventEmitter } from "node:events";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import type { ChatMessage, HelloMessage, LocationMeta, UserIdentity } from "./protocol";
import {
  cleanLine,
  cleanText,
  colorFor,
  LIMITS,
  sanitizeMessage,
  type ChatTransport,
  type ClientCredentials,
  type ClientStatus,
} from "./transport";

export const PUBLIC_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://nostr.mom",
  "wss://relay.snort.social",
];

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const MESSAGE_KIND = 4446;
const SIGNAL_KIND = 24446;
const SUBSCRIPTION_ID = "duochat";
const HISTORY_SETTLE_MS = 2500;
const CONNECT_WATCHDOG_MS = 15_000;
const PRESENCE_INTERVAL_MS = 30_000;
const PRESENCE_TTL_MS = 80_000;
const PRESENCE_REPLY_GAP_MS = 5000;
const TYPING_THROTTLE_MS = 4000;
const RELAY_MUTE_MS = 10 * 60_000;
const PING_INTERVAL_MS = 30_000;
const MAX_SEEN = 2000;
const LATE_HISTORY_MS = 60_000;
const SIGNAL_MAX_AGE_MS = 60_000;
const SKEW_PROBE_MS = 3000;

interface RoomSecrets {
  tag: string;
  key: Buffer;
}

interface RelayConnection {
  url: string;
  socket: WebSocket | null;
  ready: boolean;
  eose: boolean;
  attempt: number;
  retryTimer: NodeJS.Timeout | null;
  pingTimer: NodeJS.Timeout | null;
  mutedUntil: number;
}

interface Peer {
  user: UserIdentity;
  lastSeen: number;
}

export function deriveRoom(roomKey: string): RoomSecrets {
  const ikm = Buffer.from(roomKey.trim(), "utf8");
  const salt = Buffer.from("duochat/v1", "utf8");
  return {
    tag: Buffer.from(hkdfSync("sha256", ikm, salt, "room-tag", 32)).toString("hex"),
    key: Buffer.from(hkdfSync("sha256", ikm, salt, "room-key", 32)),
  };
}

export function encryptPayload(key: Buffer, data: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64");
}

export function decryptPayload(key: Buffer, content: unknown): unknown {
  if (typeof content !== "string" || content.length > 200_000) return null;
  try {
    const raw = Buffer.from(content, "base64");
    if (raw.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const text = Buffer.concat([
      decipher.update(raw.subarray(12, raw.length - 16)),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export class PublicClient extends EventEmitter implements ChatTransport {
  readonly backend = "public" as const;

  status: ClientStatus = "offline";
  statusDetail = "";

  private credentials: ClientCredentials | null = null;
  private room: RoomSecrets | null = null;
  private self: UserIdentity | null = null;
  private readonly secretKey = generateSecretKey();
  private relays = new Map<string, RelayConnection>();
  private stopped = true;
  private skewMs = 0;
  private clockState: Promise<void> = Promise.resolve();
  private helloSent = false;
  private settleTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private presenceTimer: NodeJS.Timeout | null = null;
  private pendingHistory = new Map<string, ChatMessage>();
  private seen = new Set<string>();
  private peers = new Map<string, Peer>();
  private lastPresenceAt = 0;
  private typingOn = false;
  private lastTypingSentAt = 0;

  constructor(
    private readonly userId: string,
    private readonly log: (line: string) => void = () => {},
  ) {
    super();
  }

  configure(credentials: ClientCredentials): void {
    this.credentials = {
      url: "",
      roomKey: credentials.roomKey.trim(),
      name: credentials.name.trim().slice(0, LIMITS.name) || "Moi",
    };
  }

  isConnected(): boolean {
    return this.status === "connected" && this.openRelays().length > 0;
  }

  connect(): void {
    const credentials = this.credentials;
    if (!credentials?.roomKey) {
      this.setStatus("error", "Aucun salon configuré.");
      return;
    }
    this.teardown();
    this.stopped = false;
    this.room = deriveRoom(credentials.roomKey);
    this.self = { id: this.userId, name: credentials.name, color: colorFor(this.userId) };
    this.helloSent = false;
    this.pendingHistory.clear();
    this.peers.clear();
    this.setStatus("connecting", "Connexion au réseau DuoChat…");

    this.calibrateClock();
    for (const url of PUBLIC_RELAYS) {
      const connection: RelayConnection = {
        url,
        socket: null,
        ready: false,
        eose: false,
        attempt: 0,
        retryTimer: null,
        pingTimer: null,
        mutedUntil: 0,
      };
      this.relays.set(url, connection);
      this.openRelay(connection);
    }
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      if (!this.helloSent && !this.stopped) {
        this.setStatus("offline", "Réseau DuoChat injoignable, nouvelle tentative automatique…");
      }
    }, CONNECT_WATCHDOG_MS);
  }

  disconnect(): void {
    if (this.isConnected()) this.sendSignal({ t: "presence", state: "leave" });
    this.stopped = true;
    this.teardown();
    this.setStatus("offline", "Déconnecté.");
  }

  sendText(text: string): boolean {
    const clean = cleanText(text);
    if (!clean) return false;
    return this.publishMessage({ kind: "text", text: clean });
  }

  sendLocation(meta: LocationMeta): boolean {
    return this.publishMessage({ kind: "location", meta });
  }

  setTyping(on: boolean): void {
    if (!this.isConnected()) return;
    const now = Date.now();
    if (on && this.typingOn && now - this.lastTypingSentAt < TYPING_THROTTLE_MS) return;
    if (!on && !this.typingOn) return;
    this.typingOn = on;
    this.lastTypingSentAt = now;
    this.sendSignal({ t: "typing", on });
  }

  dispose(): void {
    if (this.isConnected()) this.sendSignal({ t: "presence", state: "leave" });
    this.stopped = true;
    this.teardown();
    this.removeAllListeners();
  }

  private now(): number {
    return Date.now() + this.skewMs;
  }

  // Les horodatages circulent dans l'horloge des relais ; l'interface, elle, raisonne en heure locale.
  private toLocalTs(networkTs: number): number {
    return networkTs - this.skewMs;
  }

  private openRelays(): RelayConnection[] {
    return [...this.relays.values()].filter(
      (relay) => relay.ready && relay.socket?.readyState === WebSocket.OPEN,
    );
  }

  private publishMessage(
    draft: { kind: "text"; text: string } | { kind: "location"; meta: LocationMeta },
  ): boolean {
    const self = this.self;
    if (!self || !this.isConnected()) return false;
    // L'horloge des relais est mesurée à la connexion : un message part une fois ce calibré connu.
    const message = sanitizeMessage({
      ...draft,
      id: randomUUID(),
      userId: self.id,
      name: self.name,
      color: self.color,
      ts: this.now(),
    });
    if (!message) return false;
    if (!this.publish(MESSAGE_KIND, message)) return false;
    this.remember(message.id);
    this.typingOn = false;
    this.emit("message", { ...message, ts: this.toLocalTs(message.ts) });
    return true;
  }

  private sendSignal(payload: Record<string, unknown>): boolean {
    const self = this.self;
    if (!self) return false;
    return this.publish(SIGNAL_KIND, {
      ...payload,
      userId: self.id,
      name: self.name,
      color: self.color,
    });
  }

  private publish(kind: number, payload: unknown): boolean {
    const room = this.room;
    const open = this.openRelays();
    const now = Date.now();
    const unmuted = open.filter((relay) => relay.mutedUntil <= now);
    const relays = unmuted.length > 0 ? unmuted : open;
    if (!room || relays.length === 0) return false;
    const event = finalizeEvent(
      {
        kind,
        created_at: Math.floor(this.now() / 1000),
        tags: [["t", room.tag]],
        content: encryptPayload(room.key, payload),
      },
      this.secretKey,
    );
    const frame = JSON.stringify(["EVENT", event]);
    let sent = 0;
    for (const relay of relays) {
      try {
        relay.socket?.send(frame);
        sent++;
      } catch (error) {
        this.log(`${relay.url}: envoi impossible (${String(error)})`);
      }
    }
    return sent > 0;
  }

  private openRelay(relay: RelayConnection): void {
    if (this.stopped || this.relays.get(relay.url) !== relay) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(relay.url, { handshakeTimeout: 10_000, maxPayload: 1024 * 1024 });
    } catch (error) {
      this.log(`${relay.url}: ${String(error)}`);
      this.scheduleRelayRetry(relay);
      return;
    }
    relay.socket = socket;

    socket.on("open", () => {
      if (relay.socket !== socket) return;
      relay.attempt = 0;
      relay.ready = true;
      relay.eose = false;
      const tag = this.room?.tag;
      if (!tag) return;
      socket.send(
        JSON.stringify([
          "REQ",
          SUBSCRIPTION_ID,
          { kinds: [MESSAGE_KIND], "#t": [tag], limit: LIMITS.history },
          { kinds: [SIGNAL_KIND], "#t": [tag] },
        ]),
      );
      relay.pingTimer = setInterval(() => {
        try {
          socket.ping();
        } catch {
          // la fermeture sera traitée par l'événement close
        }
      }, PING_INTERVAL_MS);
    });

    socket.on("message", (data) => {
      if (relay.socket !== socket) return;
      this.onRelayFrame(relay, data.toString());
    });

    socket.on("error", (error) => {
      if (relay.socket === socket) this.log(`${relay.url}: ${error.message}`);
    });

    socket.on("close", () => {
      if (relay.socket !== socket) return;
      this.resetRelay(relay);
      this.scheduleRelayRetry(relay);
      this.onRelayLost();
    });
  }

  private resetRelay(relay: RelayConnection): void {
    relay.socket = null;
    relay.ready = false;
    relay.eose = false;
    if (relay.pingTimer) {
      clearInterval(relay.pingTimer);
      relay.pingTimer = null;
    }
  }

  private scheduleRelayRetry(relay: RelayConnection): void {
    if (this.stopped || this.relays.get(relay.url) !== relay) return;
    const delay =
      Math.min(60_000, 1000 * 2 ** Math.min(relay.attempt, 6)) + Math.round(Math.random() * 500);
    relay.attempt++;
    if (relay.retryTimer) clearTimeout(relay.retryTimer);
    relay.retryTimer = setTimeout(() => {
      relay.retryTimer = null;
      this.openRelay(relay);
    }, delay);
  }

  private onRelayLost(): void {
    if (this.stopped || this.openRelays().length > 0) return;
    this.typingOn = false;
    if (this.helloSent) {
      this.setStatus("offline", "Connexion perdue, reconnexion automatique…");
    }
  }

  private onRelayFrame(relay: RelayConnection, raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(frame) || typeof frame[0] !== "string") return;

    switch (frame[0]) {
      case "EVENT":
        if (frame[1] === SUBSCRIPTION_ID) this.onEvent(frame[2]);
        break;
      case "EOSE":
        if (frame[1] === SUBSCRIPTION_ID) this.onEndOfStored(relay);
        break;
      case "CLOSED":
        this.log(`${relay.url}: abonnement fermé (${String(frame[2] ?? "")})`);
        if (frame[1] === SUBSCRIPTION_ID) this.onEndOfStored(relay);
        break;
      case "OK":
        if (frame[2] === false) {
          const reason = String(frame[3] ?? "");
          this.log(`${relay.url}: refusé (${reason})`);
          // Un relais qui limite le débit finit par bannir : on le laisse respirer.
          if (/rate|limit|banned|blocked|spam/i.test(reason)) {
            relay.mutedUntil = Date.now() + RELAY_MUTE_MS;
          }
        }
        break;
      case "NOTICE":
        this.log(`${relay.url}: ${String(frame[1] ?? "")}`);
        break;
      default:
        break;
    }
  }

  private onEvent(raw: unknown): void {
    const room = this.room;
    if (!room || !raw || typeof raw !== "object") return;
    const event = raw as {
      id?: unknown;
      kind?: unknown;
      tags?: unknown;
      content?: unknown;
      created_at?: unknown;
    };
    const tagged =
      Array.isArray(event.tags) &&
      event.tags.some((tag) => Array.isArray(tag) && tag[0] === "t" && tag[1] === room.tag);
    if (!tagged) return;

    const payload = decryptPayload(room.key, event.content);
    if (!payload) return;

    if (event.kind === MESSAGE_KIND) {
      const message = sanitizeMessage(payload);
      if (!message || this.seen.has(message.id)) return;
      message.ts = this.toLocalTs(message.ts);
      this.remember(message.id);
      if (!this.helloSent) {
        this.pendingHistory.set(message.id, message);
        return;
      }
      // Ancien message livré tardivement par un relais lent : déjà hors de l'historique affiché.
      if (this.now() - message.ts > LATE_HISTORY_MS) return;

      if (message.userId !== this.userId) {
        this.emit("typing", { userId: message.userId, name: message.name, on: false });
      }
      this.emit("message", message);
    } else if (event.kind === SIGNAL_KIND) {
      // Certains relais conservent malgré tout les événements éphémères : on ignore les signaux périmés.
      if (typeof event.created_at !== "number" || event.created_at * 1000 < this.now() - SIGNAL_MAX_AGE_MS) {
        return;
      }
      if (typeof event.id === "string") {
        const key = `signal:${event.id}`;
        if (this.seen.has(key)) return;
        this.remember(key);
      }
      this.onSignal(payload as Record<string, unknown>);
    }
  }

  private onSignal(data: Record<string, unknown>): void {
    const userId = cleanLine(data.userId, 64);
    const name = cleanLine(data.name, LIMITS.name);
    if (!userId || !name || userId === this.userId) return;

    if (data.t === "typing") {
      if (this.helloSent) this.emit("typing", { userId, name, on: Boolean(data.on) });
      return;
    }
    if (data.t !== "presence") return;

    if (data.state === "leave") {
      this.removePeer(userId);
      return;
    }

    const color =
      typeof data.color === "string" && /^#[0-9a-f]{6}$/i.test(data.color)
        ? data.color
        : colorFor(userId);
    const isNew = !this.peers.has(userId);
    this.peers.set(userId, { user: { id: userId, name, color }, lastSeen: Date.now() });
    if (!this.helloSent) return;

    if (data.fresh === true) {
      this.emit("system", { text: `${name} a rejoint le salon.`, ts: Date.now() });
    }
    if (!isNew) return;
    this.emitPresence();
    if (Date.now() - this.lastPresenceAt > PRESENCE_REPLY_GAP_MS) this.announcePresence();
  }

  private removePeer(userId: string): void {
    const peer = this.peers.get(userId);
    if (!peer) return;
    this.peers.delete(userId);
    this.emit("typing", { userId, name: peer.user.name, on: false });
    if (this.helloSent) {
      this.emit("system", { text: `${peer.user.name} a quitté le salon.`, ts: Date.now() });
    }
    this.emitPresence();
  }

  private onEndOfStored(relay: RelayConnection): void {
    relay.eose = true;
    if (!this.helloSent) {
      if ([...this.relays.values()].every((known) => known.eose)) {
        this.finishHistory();
      } else if (!this.settleTimer) {
        this.settleTimer = setTimeout(() => {
          this.settleTimer = null;
          this.finishHistory();
        }, HISTORY_SETTLE_MS);
      }
      return;
    }
    if (this.status !== "connected") {
      this.setStatus("connected");
      this.announcePresence();
      this.emitPresence();
    }
  }

  private finishHistory(): void {
    const self = this.self;
    if (this.helloSent || this.stopped || !self) return;
    this.helloSent = true;
    this.clearTimer("settleTimer");
    this.clearTimer("watchdogTimer");

    const history = [...this.pendingHistory.values()]
      .sort((a, b) => a.ts - b.ts)
      .slice(-LIMITS.history);
    this.pendingHistory.clear();

    this.setStatus("connected");
    const hello: HelloMessage = {
      t: "hello",
      self,
      users: this.currentUsers(),
      history,
      serverTime: Date.now(),
    };
    this.emit("hello", hello);
    this.announcePresence(true);
    this.presenceTimer = setInterval(() => this.presenceTick(), PRESENCE_INTERVAL_MS);
  }

  private presenceTick(): void {
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    for (const [userId, peer] of this.peers) {
      if (peer.lastSeen < cutoff) this.removePeer(userId);
    }
    this.announcePresence();
  }

  private announcePresence(fresh = false): void {
    if (this.sendSignal({ t: "presence", state: "here", fresh })) this.lastPresenceAt = Date.now();
  }

  private currentUsers(): UserIdentity[] {
    const users = this.self ? [this.self] : [];
    for (const peer of this.peers.values()) users.push(peer.user);
    return users;
  }

  private emitPresence(): void {
    if (this.status === "connected") this.emit("presence", this.currentUsers());
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > MAX_SEEN) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  // Les relais rejettent les événements datés dans le futur : on se cale sur leur horloge.
  private calibrateClock(): Promise<void> {
    const calibrated = this.measureClockSkew();
    this.clockState = Promise.race([calibrated, wait(SKEW_PROBE_MS)]);
    void calibrated.catch(() => undefined);
    return this.clockState;
  }

  private async measureClockSkew(): Promise<void> {
    const probes = PUBLIC_RELAYS.map(async (url) => {
      const started = Date.now();
      const response = await fetch(url.replace(/^wss:/, "https:"), {
        method: "HEAD",
        signal: AbortSignal.timeout(5000),
      });
      const header = response.headers.get("date");
      const serverTime = header ? Date.parse(header) : NaN;
      if (!Number.isFinite(serverTime)) throw new Error("date absente");
      const local = started + (Date.now() - started) / 2;
      return serverTime + 500 - local;
    });
    try {
      const skew = await Promise.any(probes);
      this.skewMs = Math.abs(skew) > 30_000 ? Math.round(skew) : 0;
      if (this.skewMs) this.log(`horloge locale décalée de ${Math.round(this.skewMs / 1000)} s`);
    } catch {
      this.skewMs = 0;
    }
  }

  private clearTimer(name: "settleTimer" | "watchdogTimer" | "presenceTimer"): void {
    const timer = this[name];
    if (!timer) return;
    clearTimeout(timer);
    clearInterval(timer);
    this[name] = null;
  }

  private teardown(): void {
    this.clearTimer("settleTimer");
    this.clearTimer("watchdogTimer");
    this.clearTimer("presenceTimer");
    this.typingOn = false;
    for (const relay of this.relays.values()) {
      if (relay.retryTimer) clearTimeout(relay.retryTimer);
      relay.retryTimer = null;
      const socket = relay.socket;
      this.resetRelay(relay);
      if (!socket) continue;
      socket.removeAllListeners();
      socket.on("error", () => {});
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(["CLOSE", SUBSCRIPTION_ID]));
          socket.close();
        } else {
          socket.terminate();
        }
      } catch {
        // déjà fermé
      }
    }
    this.relays.clear();
  }

  private setStatus(status: ClientStatus, detail = ""): void {
    if (this.status === status && this.statusDetail === detail) return;
    this.status = status;
    this.statusDetail = detail;
    this.emit("status", status, detail);
  }
}
