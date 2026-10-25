import type { EventEmitter } from "node:events";
import type { ChatMessage, LinkStatus, LocationMeta } from "./protocol";

export type ClientStatus = Exclude<LinkStatus, "unconfigured">;

export type Backend = "public" | "supabase" | "relay";

export interface ClientCredentials {
  url: string;
  roomKey: string;
  name: string;
  apiKey?: string;
}

export interface ChatTransport extends EventEmitter {
  readonly backend: Backend;
  status: ClientStatus;
  statusDetail: string;
  configure(credentials: ClientCredentials): void;
  isConnected(): boolean;
  connect(): void;
  disconnect(): void;
  sendText(text: string): boolean;
  sendLocation(meta: LocationMeta): boolean;
  setTyping(on: boolean): void;
  dispose(): void;
}

export function backendFor(url: string): Backend | undefined {
  const value = url.trim();
  if (!value) return "public";
  if (/^https?:\/\/\S+$/i.test(value)) return "supabase";
  if (/^wss?:\/\/\S+$/i.test(value)) return "relay";
  return undefined;
}

export const USER_COLORS = [
  "#22d3ee",
  "#a78bfa",
  "#34d399",
  "#fbbf24",
  "#fb7185",
  "#60a5fa",
  "#f472b6",
  "#2dd4bf",
];

export function colorFor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return USER_COLORS[hash % USER_COLORS.length];
}

export const LIMITS = { name: 32, text: 4000, file: 512, history: 200 };
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function cleanLine(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL_CHARS, "").replace(/[\r\n\t]/g, " ").trim().slice(0, max);
}

export function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n?/g, "\n").replace(CONTROL_CHARS, "").trim().slice(0, LIMITS.text);
}

export function sanitizeMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const id = cleanLine(entry.id, 64);
  const userId = cleanLine(entry.userId, 64);
  const name = cleanLine(entry.name, LIMITS.name);
  if (!id || !userId || !name) return null;

  const color =
    typeof entry.color === "string" && /^#[0-9a-f]{6}$/i.test(entry.color)
      ? entry.color
      : colorFor(userId);
  const ts = typeof entry.ts === "number" && Number.isFinite(entry.ts) ? entry.ts : Date.now();

  if (entry.kind === "location") {
    const meta = (entry.meta ?? {}) as Record<string, unknown>;
    const file = cleanLine(meta.file, LIMITS.file);
    const line = Number(meta.line);
    if (!file || !Number.isInteger(line) || line < 1 || line > 1_000_000) return null;
    return {
      t: "msg",
      id,
      userId,
      name,
      color,
      kind: "location",
      text: `${file}:${line}`,
      meta: { file, line },
      ts,
    };
  }

  const text = cleanText(entry.text);
  if (!text) return null;
  return { t: "msg", id, userId, name, color, kind: "text", text, ts };
}
