import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type {
  ChatMessage,
  ClientMessage,
  HelloMessage,
  LocationMeta,
  ServerMessage,
  UserIdentity,
} from "./protocol";
import type { ChatTransport, ClientCredentials, ClientStatus } from "./transport";

const FATAL_ERROR_CODES = new Set([
  "invalid_room_key",
  "room_full",
  "too_many_windows",
  "join_timeout",
]);

const HEARTBEAT_INTERVAL_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;
const JOIN_TIMEOUT_MS = 12_000;

function normalizeUrl(value: string): string {
  let url = value.trim();
  if (!url) return "";
  if (!/^wss?:\/\//i.test(url)) url = `ws://${url}`;
  return url.replace(/\/+$/, "");
}

export class RelayClient extends EventEmitter implements ChatTransport {
  readonly backend = "relay" as const;
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private joinTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private stopped = true;
  private credentials: ClientCredentials | null = null;
  private fatalError: string | null = null;
  private lastPongAt = 0;

  status: ClientStatus = "offline";
  statusDetail = "";

  constructor(
    private readonly userId: string,
    private readonly log: (line: string) => void = () => {},
  ) {
    super();
  }

  configure(credentials: ClientCredentials): void {
    this.credentials = {
      url: normalizeUrl(credentials.url),
      roomKey: credentials.roomKey.trim(),
      name: credentials.name.trim() || "Moi",
    };
  }

  isConfigured(): boolean {
    return Boolean(this.credentials?.url && this.credentials?.roomKey);
  }

  isConnected(): boolean {
    return this.status === "connected" && this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (!this.isConfigured()) {
      this.setStatus("error", "Configuration incomplète.");
      return;
    }
    this.stopped = false;
    this.fatalError = null;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    this.destroySocket();
    this.openSocket();
  }

  disconnect(): void {
    this.stopped = true;
    this.fatalError = null;
    this.clearReconnectTimer();
    this.destroySocket();
    this.setStatus("offline", "Déconnecté.");
  }

  sendText(text: string): boolean {
    const clean = text.replace(/\r\n?/g, "\n").trim();
    if (!clean) return false;
    return this.transmit({ t: "msg", kind: "text", text: clean });
  }

  sendLocation(meta: LocationMeta): boolean {
    return this.transmit({ t: "msg", kind: "location", meta });
  }

  setTyping(on: boolean): void {
    this.transmit({ t: "typing", on });
  }

  dispose(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.destroySocket();
    this.removeAllListeners();
  }

  private transmit(message: ClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    if (this.status !== "connected") return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      this.log(`envoi impossible: ${String(error)}`);
      return false;
    }
  }

  private openSocket(): void {
    if (this.stopped || !this.credentials) return;
    const { url, roomKey, name } = this.credentials;

    this.setStatus(
      this.reconnectAttempt === 0 ? "connecting" : "offline",
      this.reconnectAttempt === 0
        ? "Connexion au relais…"
        : "Connexion perdue, reconnexion automatique…",
    );

    let socket: WebSocket;
    try {
      socket = new WebSocket(url, {
        handshakeTimeout: 10_000,
        maxPayload: 256 * 1024,
      });
    } catch (error) {
      this.log(`WebSocket invalide: ${String(error)}`);
      this.setStatus("error", "URL du relais invalide.");
      return;
    }
    this.socket = socket;

    socket.on("open", () => {
      if (this.socket !== socket) return;
      this.lastPongAt = Date.now();
      const join: ClientMessage = { t: "join", roomKey, name, userId: this.userId };
      socket.send(JSON.stringify(join));
      this.startHeartbeat();
      this.joinTimer = setTimeout(() => {
        if (this.socket !== socket || this.status === "connected") return;
        this.fatalError = "Le relais ne répond pas (délai dépassé).";
        this.stopped = true;
        this.setStatus("error", this.fatalError);
        this.destroySocket();
      }, JOIN_TIMEOUT_MS);
    });

    socket.on("message", (data) => {
      if (this.socket !== socket) return;
      this.handleServerMessage(data.toString());
    });

    socket.on("pong", () => {
      this.lastPongAt = Date.now();
    });

    socket.on("error", (error) => {
      if (this.socket !== socket) return;
      this.log(`erreur websocket: ${error.message}`);
    });

    socket.on("close", (code, reason) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearJoinTimer();
      this.stopHeartbeat();

      if (this.stopped || this.fatalError) {
        if (this.fatalError) this.setStatus("error", this.fatalError);
        return;
      }

      const detail = reason.toString() || `Connexion interrompue (${code}).`;
      this.scheduleReconnect(detail);
    });
  }

  private handleServerMessage(raw: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      this.log("message serveur illisible");
      return;
    }
    if (!message || typeof message !== "object" || typeof message.t !== "string") return;

    switch (message.t) {
      case "hello": {
        const hello = message as HelloMessage;
        this.fatalError = null;
        this.reconnectAttempt = 0;
        this.clearJoinTimer();
        this.setStatus("connected");
        this.emit("hello", hello);
        break;
      }
      case "msg":
        this.emit("message", message as ChatMessage);
        break;
      case "presence":
        this.emit("presence", (message as { users: UserIdentity[] }).users);
        break;
      case "typing":
        this.emit("typing", message as { userId: string; name: string; on: boolean });
        break;
      case "system":
        this.emit("system", message as { text: string; ts: number });
        break;
      case "error": {
        const error = message as { code: string; message: string };
        if (FATAL_ERROR_CODES.has(error.code)) {
          this.fatalError = error.message;
          this.stopped = true;
          this.setStatus("error", error.message);
        }
        this.emit("serverError", error.code, error.message);
        break;
      }
      default:
        break;
    }
  }

  private scheduleReconnect(detail: string): void {
    const delay =
      Math.min(15_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 4)) +
      Math.round(Math.random() * 400);
    this.reconnectAttempt++;
    this.setStatus("offline", `${detail} Nouvelle tentative dans ${Math.ceil(delay / 1000)} s.`);
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        this.log("heartbeat expire, coupure de la connexion");
        socket.terminate();
        return;
      }
      try {
        socket.ping();
      } catch {
        // la fermeture sera traitee par l'evenement close
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearJoinTimer(): void {
    if (this.joinTimer) {
      clearTimeout(this.joinTimer);
      this.joinTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private destroySocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.clearJoinTimer();
    this.stopHeartbeat();
    if (!socket) return;
    socket.removeAllListeners();
    socket.on("error", () => {});
    try {
      socket.terminate();
    } catch {
      // deja ferme
    }
  }

  private setStatus(status: ClientStatus, detail = ""): void {
    if (this.status === status && this.statusDetail === detail) return;
    this.status = status;
    this.statusDetail = detail;
    this.emit("status", status, detail);
  }
}
