export type LinkStatus = "unconfigured" | "connecting" | "connected" | "offline" | "error";

export type MessageKind = "text" | "location";

export interface UserIdentity {
  id: string;
  name: string;
  color: string;
}

export interface LocationMeta {
  file: string;
  line: number;
}

export interface ChatMessage {
  t: "msg";
  id: string;
  userId: string;
  name: string;
  color: string;
  text: string;
  kind: MessageKind;
  meta?: LocationMeta;
  ts: number;
}

export interface HelloMessage {
  t: "hello";
  self: UserIdentity;
  users: UserIdentity[];
  history: ChatMessage[];
  serverTime: number;
}

export type ServerMessage =
  | HelloMessage
  | ChatMessage
  | { t: "presence"; users: UserIdentity[] }
  | { t: "typing"; userId: string; name: string; on: boolean }
  | { t: "system"; text: string; ts: number }
  | { t: "error"; code: string; message: string };

export type ClientMessage =
  | { t: "join"; roomKey: string; name: string; userId: string }
  | { t: "msg"; kind: MessageKind; text?: string; meta?: LocationMeta }
  | { t: "typing"; on: boolean };

export interface DuoChatSettings {
  serverUrl: string;
  displayName: string;
  notifications: boolean;
}

export interface WebviewBootstrap {
  type: "bootstrap";
  configured: boolean;
  status: LinkStatus;
  error?: string;
  self?: UserIdentity;
  users: UserIdentity[];
  messages: ChatMessage[];
  settings: DuoChatSettings;
}

export type ExtensionMessage =
  | WebviewBootstrap
  | { type: "status"; status: LinkStatus; error?: string }
  | { type: "hello"; self: UserIdentity; users: UserIdentity[]; messages: ChatMessage[] }
  | { type: "message"; message: ChatMessage }
  | { type: "presence"; users: UserIdentity[] }
  | { type: "typing"; userId: string; name: string; on: boolean }
  | { type: "system"; text: string; ts: number }
  | { type: "notice"; level: "info" | "error"; text: string }
  | { type: "sendFailed"; text: string };

export type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "shareLocation" }
  | { type: "typing"; on: boolean }
  | { type: "configure" }
  | { type: "connect" }
  | { type: "openLocation"; file: string; line: number };
