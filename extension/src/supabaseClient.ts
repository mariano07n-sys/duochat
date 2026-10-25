import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  REALTIME_SUBSCRIBE_STATES,
  RealtimeClient,
  type RealtimeChannel,
  type WebSocketLikeConstructor,
} from "@supabase/realtime-js";
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

const REQUEST_TIMEOUT_MS = 10_000;
const SUBSCRIBE_TIMEOUT_MS = 15_000;
const TYPING_THROTTLE_MS = 1500;

type RpcResult =
  | { kind: "ok"; data: unknown }
  | { kind: "missing" }
  | { kind: "unauthorized"; detail: string }
  | { kind: "unavailable"; detail: string };

interface Session {
  url: string;
  apiKey: string;
  room: string;
  name: string;
  self: UserIdentity;
}

export function normalizeSupabaseUrl(value: string): string {
  let url = value.trim().replace(/\/+$/, "");
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/(rest|realtime)\/v1$/i, "");
}

export class SupabaseClient extends EventEmitter implements ChatTransport {
  readonly backend = "supabase" as const;

  status: ClientStatus = "offline";
  statusDetail = "";

  private credentials: ClientCredentials | null = null;
  private session: Session | null = null;
  private realtime: RealtimeClient | null = null;
  private channel: RealtimeChannel | null = null;
  private generation = 0;
  private stopped = true;
  private retryTimer: NodeJS.Timeout | null = null;
  private subscribeTimer: NodeJS.Timeout | null = null;
  private retryAttempt = 0;
  private historyEnabled = true;
  private historyNoticeShown = false;
  private presenceReady = false;
  private knownUsers = new Map<string, UserIdentity>();
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
      url: normalizeSupabaseUrl(credentials.url),
      apiKey: (credentials.apiKey ?? "").trim(),
      roomKey: credentials.roomKey.trim(),
      name: credentials.name.trim().slice(0, LIMITS.name) || "Moi",
    };
  }

  isConnected(): boolean {
    return this.status === "connected" && this.channel?.state === "joined";
  }

  connect(): void {
    const credentials = this.credentials;
    if (!credentials?.url || !credentials.apiKey || !credentials.roomKey) {
      this.setStatus("error", "Configuration Supabase incomplète.");
      return;
    }
    this.teardown();
    this.stopped = false;
    this.retryAttempt = 0;
    this.historyEnabled = true;
    this.session = {
      url: credentials.url,
      apiKey: credentials.apiKey,
      room: createHash("sha256").update(credentials.roomKey).digest("hex"),
      name: credentials.name,
      self: { id: this.userId, name: credentials.name, color: colorFor(this.userId) },
    };
    void this.start();
  }

  disconnect(): void {
    this.stopped = true;
    this.teardown();
    this.setStatus("offline", "Déconnecté.");
  }

  sendText(text: string): boolean {
    const clean = cleanText(text);
    if (!clean) return false;
    return this.publish({ kind: "text", text: clean });
  }

  sendLocation(meta: LocationMeta): boolean {
    return this.publish({ kind: "location", meta });
  }

  setTyping(on: boolean): void {
    if (!this.isConnected() || !this.session) return;
    const now = Date.now();
    if (on && this.typingOn && now - this.lastTypingSentAt < TYPING_THROTTLE_MS) return;
    if (!on && !this.typingOn) return;
    this.typingOn = on;
    this.lastTypingSentAt = now;
    void this.channel?.send({
      type: "broadcast",
      event: "typing",
      payload: { userId: this.userId, name: this.session.name, on },
    });
  }

  dispose(): void {
    this.stopped = true;
    this.teardown();
    this.removeAllListeners();
  }

  private publish(draft: { kind: "text"; text: string } | { kind: "location"; meta: LocationMeta }): boolean {
    const session = this.session;
    const channel = this.channel;
    if (!session || !channel || !this.isConnected()) return false;

    const message = sanitizeMessage({
      ...draft,
      id: randomUUID(),
      userId: session.self.id,
      name: session.self.name,
      color: session.self.color,
      ts: Date.now(),
    });
    if (!message) return false;

    this.typingOn = false;
    void channel
      .send({ type: "broadcast", event: "msg", payload: message })
      .then((result) => {
        if (result !== "ok") this.log(`diffusion du message: ${result}`);
      });
    this.emit("message", message);
    void this.persist(session, message);
    return true;
  }

  private async start(): Promise<void> {
    const generation = ++this.generation;
    const session = this.session;
    if (!session) return;
    this.setStatus(
      this.retryAttempt === 0 ? "connecting" : "offline",
      this.retryAttempt === 0 ? "Connexion à Supabase…" : "Reconnexion à Supabase…",
    );

    const probe = await this.rpc(session, "duochat_history", { p_room: session.room });
    if (generation !== this.generation || this.stopped) return;

    if (probe.kind === "unauthorized") {
      this.stopped = true;
      this.setStatus("error", probe.detail);
      return;
    }
    if (probe.kind === "unavailable") {
      this.scheduleRetry(probe.detail);
      return;
    }
    if (probe.kind === "missing") this.disableHistory();

    this.openChannel(generation, session, probe.kind === "ok" ? probe.data : []);
  }

  private openChannel(generation: number, session: Session, initialHistory: unknown): void {
    const realtimeUrl = `${session.url.replace(/^http/i, "ws")}/realtime/v1`;
    const realtime = new RealtimeClient(realtimeUrl, {
      transport: WebSocket as unknown as WebSocketLikeConstructor,
      params: { apikey: session.apiKey },
      accessToken: async () => session.apiKey,
      logger: () => {},
    });
    this.realtime = realtime;
    this.presenceReady = false;
    this.knownUsers.clear();

    const channel = realtime.channel(`duochat:${session.room}`, {
      config: {
        broadcast: { self: false, ack: false },
        presence: { key: this.userId, enabled: true },
      },
    });
    this.channel = channel;
    let pendingHistory: unknown = initialHistory;

    channel.on("broadcast", { event: "msg" }, ({ payload }) => {
      if (generation !== this.generation) return;
      const message = sanitizeMessage(payload);
      if (!message || message.userId === this.userId) return;
      this.emit("typing", { userId: message.userId, name: message.name, on: false });
      this.emit("message", message);
    });

    channel.on("broadcast", { event: "typing" }, ({ payload }) => {
      if (generation !== this.generation) return;
      const data = (payload ?? {}) as Record<string, unknown>;
      const userId = cleanLine(data.userId, 64);
      const name = cleanLine(data.name, LIMITS.name);
      if (!userId || !name || userId === this.userId) return;
      this.emit("typing", { userId, name, on: Boolean(data.on) });
    });

    channel.on("presence", { event: "sync" }, () => {
      if (generation !== this.generation) return;
      this.onPresenceSync();
    });

    this.armSubscribeTimeout(generation);
    channel.subscribe((status, error) => {
      if (generation !== this.generation || this.stopped) return;
      switch (status) {
        case REALTIME_SUBSCRIBE_STATES.SUBSCRIBED: {
          this.clearSubscribeTimer();
          const history = pendingHistory;
          pendingHistory = undefined;
          void this.onSubscribed(generation, session, history);
          break;
        }
        case REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR:
        case REALTIME_SUBSCRIBE_STATES.TIMED_OUT:
          if (error) this.log(`canal temps réel: ${error.message}`);
          this.typingOn = false;
          this.setStatus("offline", "Connexion perdue, reconnexion automatique…");
          this.armSubscribeTimeout(generation);
          break;
        case REALTIME_SUBSCRIBE_STATES.CLOSED:
          this.scheduleRetry("Canal temps réel fermé.");
          break;
        default:
          break;
      }
    });
  }

  private async onSubscribed(generation: number, session: Session, history: unknown): Promise<void> {
    const channel = this.channel;
    if (!channel) return;

    const tracked = await channel.track({
      userId: session.self.id,
      name: session.self.name,
      color: session.self.color,
    });
    if (tracked !== "ok") this.log(`présence: ${tracked}`);

    let messages: unknown = history;
    if (messages === undefined && this.historyEnabled) {
      const result = await this.rpc(session, "duochat_history", { p_room: session.room });
      if (result.kind === "missing") this.disableHistory();
      messages = result.kind === "ok" ? result.data : [];
    }
    if (generation !== this.generation || this.stopped) return;

    this.retryAttempt = 0;
    this.setStatus("connected");
    const hello: HelloMessage = {
      t: "hello",
      self: session.self,
      users: this.currentUsers(session.self),
      history: Array.isArray(messages)
        ? messages
            .map(sanitizeMessage)
            .filter((message): message is ChatMessage => message !== null)
            .slice(-LIMITS.history)
        : [],
      serverTime: Date.now(),
    };
    this.emit("hello", hello);
  }

  private onPresenceSync(): void {
    const session = this.session;
    if (!session) return;
    const users = this.currentUsers(session.self);
    const next = new Map(users.map((user) => [user.id, user]));

    if (this.presenceReady) {
      const now = Date.now();
      for (const user of users) {
        if (user.id !== this.userId && !this.knownUsers.has(user.id)) {
          this.emit("system", { text: `${user.name} a rejoint le salon.`, ts: now });
        }
      }
      for (const [id, user] of this.knownUsers) {
        if (id !== this.userId && !next.has(id)) {
          this.emit("typing", { userId: id, name: user.name, on: false });
          this.emit("system", { text: `${user.name} a quitté le salon.`, ts: now });
        }
      }
    }
    this.presenceReady = true;
    this.knownUsers = next;
    if (this.status === "connected") this.emit("presence", users);
  }

  private currentUsers(self: UserIdentity): UserIdentity[] {
    const users = new Map<string, UserIdentity>([[self.id, self]]);
    const state = this.channel?.presenceState() ?? {};
    for (const [key, metas] of Object.entries(state)) {
      const meta = (Array.isArray(metas) ? metas[0] : undefined) as Record<string, unknown> | undefined;
      const id = cleanLine(meta?.userId ?? key, 64);
      const name = cleanLine(meta?.name, LIMITS.name);
      if (!id || !name || users.has(id)) continue;
      const color =
        typeof meta?.color === "string" && /^#[0-9a-f]{6}$/i.test(meta.color)
          ? meta.color
          : colorFor(id);
      users.set(id, { id, name, color });
    }
    return [...users.values()];
  }

  private async persist(session: Session, message: ChatMessage): Promise<void> {
    if (!this.historyEnabled) return;
    const result = await this.rpc(session, "duochat_post", {
      p_room: session.room,
      p_message: message,
    });
    if (result.kind === "missing") this.disableHistory();
    else if (result.kind !== "ok") this.log(`historique non enregistré: ${result.detail}`);
  }

  private disableHistory(): void {
    this.historyEnabled = false;
    if (this.historyNoticeShown) return;
    this.historyNoticeShown = true;
    this.emit(
      "serverError",
      "history_unavailable",
      "Historique désactivé : exécutez le script SQL de DuoChat dans votre projet Supabase (voir le README).",
    );
  }

  private async rpc(session: Session, fn: string, body: unknown): Promise<RpcResult> {
    let response: Response;
    try {
      response = await fetch(`${session.url}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: {
          apikey: session.apiKey,
          Authorization: `Bearer ${session.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      this.log(`requête ${fn}: ${String(error)}`);
      return { kind: "unavailable", detail: "Projet Supabase injoignable." };
    }

    if (response.ok) {
      const text = await response.text();
      try {
        return { kind: "ok", data: text ? JSON.parse(text) : null };
      } catch {
        return { kind: "ok", data: null };
      }
    }

    let code = "";
    let message = "";
    try {
      const payload = (await response.json()) as { code?: string; message?: string };
      code = payload.code ?? "";
      message = payload.message ?? "";
    } catch {
      // corps non JSON
    }
    this.log(`requête ${fn}: HTTP ${response.status} ${code} ${message}`.trim());

    if (code === "PGRST202" || (response.status === 404 && !code)) return { kind: "missing" };
    if (response.status === 401 || response.status === 403) {
      return {
        kind: "unauthorized",
        detail: "Clé Supabase refusée : vérifiez la clé publique (anon / publishable).",
      };
    }
    if (response.status >= 500) {
      return {
        kind: "unavailable",
        detail: "Projet Supabase indisponible (en pause ?). Relancez-le depuis supabase.com.",
      };
    }
    return { kind: "ok", data: [] };
  }

  private armSubscribeTimeout(generation: number): void {
    this.clearSubscribeTimer();
    this.subscribeTimer = setTimeout(() => {
      this.subscribeTimer = null;
      if (generation !== this.generation || this.stopped || this.status === "connected") return;
      this.scheduleRetry("Le service temps réel de Supabase ne répond pas.");
    }, SUBSCRIBE_TIMEOUT_MS);
  }

  private scheduleRetry(detail: string): void {
    if (this.stopped) return;
    this.closeRealtime();
    const delay =
      Math.min(30_000, 1000 * 2 ** Math.min(this.retryAttempt, 5)) +
      Math.round(Math.random() * 400);
    this.retryAttempt++;
    this.setStatus("offline", `${detail} Nouvelle tentative dans ${Math.ceil(delay / 1000)} s.`);
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.start();
    }, delay);
  }

  private closeRealtime(): void {
    this.generation++;
    this.clearSubscribeTimer();
    const channel = this.channel;
    const realtime = this.realtime;
    this.channel = null;
    this.realtime = null;
    this.typingOn = false;
    this.presenceReady = false;
    this.knownUsers.clear();
    if (channel && realtime) void realtime.removeChannel(channel).catch(() => {});
    if (realtime) void Promise.resolve(realtime.disconnect()).catch(() => {});
  }

  private teardown(): void {
    this.clearRetryTimer();
    this.closeRealtime();
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private clearSubscribeTimer(): void {
    if (this.subscribeTimer) {
      clearTimeout(this.subscribeTimer);
      this.subscribeTimer = null;
    }
  }

  private setStatus(status: ClientStatus, detail = ""): void {
    if (this.status === status && this.statusDetail === detail) return;
    this.status = status;
    this.statusDetail = detail;
    this.emit("status", status, detail);
  }
}
