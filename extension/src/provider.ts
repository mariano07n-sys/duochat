import * as vscode from "vscode";
import { randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { PublicClient } from "./publicClient";
import { RelayClient } from "./relayClient";
import { SupabaseClient } from "./supabaseClient";
import { backendFor, type Backend, type ChatTransport, type ClientStatus } from "./transport";
import type {
  ChatMessage,
  DuoChatSettings,
  ExtensionMessage,
  HelloMessage,
  LinkStatus,
  UserIdentity,
  WebviewBootstrap,
  WebviewMessage,
} from "./protocol";
import { getWebviewHtml } from "./webviewHtml";

const ROOM_KEY_SECRET = "duochat.roomKey";
const SUPABASE_KEY_SECRET = "duochat.supabaseKey";
const INVITE_PREFIX = "duochat:";
const USER_ID_STATE = "duochat.userId";
const NOTIFICATION_THROTTLE_MS = 4000;
const FATAL_ERROR_CODES = new Set([
  "invalid_room_key",
  "room_full",
  "too_many_windows",
  "join_timeout",
]);

function systemName(): string {
  try {
    const name = os.userInfo().username.trim();
    if (name) return name.slice(0, 32);
  } catch {
    // pas de nom d'utilisateur disponible
  }
  return "Moi";
}

interface Invite {
  url: string;
  apiKey?: string;
  roomKey: string;
}

function validRoomKey(value: string): string | undefined {
  const length = value.trim().length;
  if (length < 6) return "La clé doit contenir au moins 6 caractères.";
  if (length > 128) return "La clé doit contenir moins de 128 caractères.";
  return undefined;
}

function encodeInvite(invite: Invite): string {
  const payload = invite.url
    ? { v: 1, u: invite.url, k: invite.apiKey, r: invite.roomKey }
    : { v: 1, r: invite.roomKey };
  return INVITE_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeInvite(value: string): Invite | undefined {
  const raw = value.trim();
  if (!raw.toLowerCase().startsWith(INVITE_PREFIX)) return undefined;
  try {
    const data = JSON.parse(
      Buffer.from(raw.slice(INVITE_PREFIX.length), "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (data.v !== 1 || typeof data.r !== "string") return undefined;
    if (data.u !== undefined && typeof data.u !== "string") return undefined;
    const url = (data.u ?? "").trim();
    const backend = backendFor(url);
    if (!backend || validRoomKey(data.r)) return undefined;
    if (backend === "supabase") {
      if (typeof data.k !== "string" || !data.k.trim()) return undefined;
      return { url, apiKey: data.k.trim(), roomKey: data.r.trim() };
    }
    return { url, roomKey: data.r.trim() };
  } catch {
    return undefined;
  }
}

function secretKeyProblem(key: string): string | undefined {
  if (/^sb_secret_/i.test(key)) {
    return "C'est une clé secrète : utilisez la clé publique (publishable / anon).";
  }
  const parts = key.split(".");
  if (parts.length === 3) {
    try {
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
        role?: string;
      };
      if (claims.role === "service_role") {
        return "C'est la clé service_role (secrète) : utilisez la clé anon / publishable.";
      }
    } catch {
      // pas un JWT lisible
    }
  }
  return undefined;
}

function summarize(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export class ChatProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = "duochat.chat";

  private view: vscode.WebviewView | undefined;
  private webviewReady = false;
  private client: ChatTransport;
  private readonly statusItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  private messages: ChatMessage[] = [];
  private users: UserIdentity[] = [];
  private self: UserIdentity | undefined;
  private roomKey: string | undefined;
  private supabaseKey: string | undefined;
  private settings: DuoChatSettings;
  private unread = 0;
  private lastNotificationAt = 0;
  private wantConnected = false;
  private readonly userId: string;
  private reconnectDebounce: NodeJS.Timeout | undefined;
  private suppressSettingsReconnectUntil = 0;

  constructor(private readonly context: vscode.ExtensionContext) {
    let userId = context.globalState.get<string>(USER_ID_STATE);
    if (!userId) {
      userId = randomUUID();
      void context.globalState.update(USER_ID_STATE, userId);
    }

    this.userId = userId;
    this.settings = this.readSettings();
    this.client = this.createClient(backendFor(this.settings.serverUrl) ?? "public");
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.statusItem.command = "duochat.open";
    this.statusItem.show();

    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused && this.view?.visible) this.clearUnread();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("duochat")) this.onSettingsChanged();
      }),
    );

    this.refreshStatusBar();
  }

  async initialize(): Promise<void> {
    this.roomKey = await this.context.secrets.get(ROOM_KEY_SECRET);
    this.supabaseKey = await this.context.secrets.get(SUPABASE_KEY_SECRET);
    this.settings = this.readSettings();
    this.syncContextKeys();
    this.refreshStatusBar();
    if (this.webviewReady) this.post(this.bootstrap());

    const autoConnect = vscode.workspace
      .getConfiguration("duochat")
      .get<boolean>("autoConnect", true);
    if (this.isConfigured() && autoConnect) {
      await this.connect();
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.webviewReady = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    webviewView.webview.html = getWebviewHtml(webviewView.webview, this.context.extensionUri);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.clearUnread();
    });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined;
      this.webviewReady = false;
    });

    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((raw) => {
        void this.handleWebviewMessage(raw);
      }),
    );
  }

  async connect(): Promise<void> {
    this.settings = this.readSettings();
    const backend = backendFor(this.settings.serverUrl);
    if (!backend || !this.isConfigured() || !this.roomKey) {
      await this.configure();
      return;
    }
    this.useBackend(backend);
    this.client.configure({
      url: this.settings.serverUrl,
      roomKey: this.roomKey,
      name: this.settings.displayName,
      apiKey: backend === "supabase" ? this.supabaseKey : undefined,
    });
    this.wantConnected = true;
    this.client.connect();
  }

  disconnect(): void {
    this.wantConnected = false;
    this.client.disconnect();
  }

  async configure(): Promise<void> {
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: "$(add) Créer un salon",
          description: "en un clic, rien à installer",
          id: "create",
        },
        {
          label: "$(link) Rejoindre avec une invitation",
          description: "code reçu de votre collaborateur",
          id: "join",
        },
        {
          label: "$(server) Options avancées",
          description: "votre propre projet Supabase ou relais",
          id: "advanced",
        },
      ],
      {
        title: "DuoChat",
        placeHolder: "Comment voulez-vous discuter ?",
        ignoreFocusOut: true,
      },
    );
    if (!choice) return;
    if (choice.id === "create") await this.createRoom();
    else if (choice.id === "join") await this.joinWithInvite();
    else await this.createAdvancedRoom();
  }

  async copyInvite(): Promise<void> {
    const invite = this.currentInvite();
    if (!invite) {
      const choice = await vscode.window.showWarningMessage(
        "Aucun salon DuoChat configuré.",
        "Configurer",
      );
      if (choice) await this.configure();
      return;
    }
    await vscode.env.clipboard.writeText(encodeInvite(invite));
    void vscode.window.showInformationMessage(
      "Invitation copiée. Envoyez-la en privé à votre collaborateur : elle donne accès au salon.",
    );
  }

  private async joinWithInvite(): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: "DuoChat — Rejoindre (1/2)",
      prompt: "Collez l'invitation reçue (commence par duochat:)",
      placeHolder: "duochat:…",
      password: true,
      ignoreFocusOut: true,
      validateInput: (candidate) =>
        decodeInvite(candidate) ? undefined : "Invitation invalide ou incomplète.",
    });
    if (value === undefined) return;
    const invite = decodeInvite(value);
    if (!invite) return;

    const name = await this.askDisplayName("DuoChat — Pseudo (2/2)");
    if (name === undefined) return;

    await this.saveConfiguration(invite, name);
    void vscode.window.showInformationMessage("Salon DuoChat rejoint.");
  }

  private async createRoom(): Promise<void> {
    const name = await this.askDisplayName("DuoChat — Créer un salon");
    if (name === undefined) return;
    await this.finishRoomCreation({ url: "", roomKey: randomBytes(16).toString("hex") }, name);
  }

  private async finishRoomCreation(invite: Invite, name: string): Promise<void> {
    await this.saveConfiguration(invite, name);
    await vscode.env.clipboard.writeText(encodeInvite(invite));
    void vscode.window.showInformationMessage(
      "Salon créé. L'invitation est copiée : envoyez-la en privé à votre collaborateur (« Rejoindre avec une invitation »).",
    );
  }

  private async createAdvancedRoom(): Promise<void> {
    const current = this.settings.serverUrl;
    const url = await vscode.window.showInputBox({
      title: "DuoChat — Options avancées (1/4)",
      prompt:
        "URL du projet Supabase (Project Settings › API), ou d'un relais auto-hébergé en wss://",
      value: current,
      placeHolder: "https://abcdefgh.supabase.co",
      ignoreFocusOut: true,
      validateInput: (candidate) =>
        candidate.trim() && backendFor(candidate)
          ? undefined
          : "Utilisez https://<projet>.supabase.co ou une URL de relais wss://.",
    });
    if (url === undefined) return;
    const cleanUrl = url.trim().replace(/\/+$/, "");
    const backend = backendFor(cleanUrl);
    if (!backend || backend === "public") return;

    let apiKey: string | undefined;
    if (backend === "supabase") {
      const sameProject = cleanUrl === current.replace(/\/+$/, "");
      apiKey = await vscode.window.showInputBox({
        title: "DuoChat — Options avancées (2/4)",
        prompt: "Clé publique du projet (publishable ou anon), jamais la clé secrète",
        value: sameProject ? this.supabaseKey : undefined,
        placeHolder: "sb_publishable_… ou eyJhbGciOi…",
        password: true,
        ignoreFocusOut: true,
        validateInput: (candidate) =>
          candidate.trim().length < 20
            ? "Clé trop courte."
            : secretKeyProblem(candidate.trim()),
      });
      if (apiKey === undefined) return;
      apiKey = apiKey.trim();
    }

    const name = await this.askDisplayName("DuoChat — Options avancées (3/4)");
    if (name === undefined) return;

    const roomKey = await this.askRoomKey("DuoChat — Options avancées (4/4)");
    if (!roomKey) return;

    await this.finishRoomCreation({ url: cleanUrl, apiKey, roomKey }, name);
  }

  private async askDisplayName(title: string): Promise<string | undefined> {
    const name = await vscode.window.showInputBox({
      title,
      prompt: "Nom affiché aux autres participants",
      value: this.settings.displayName,
      placeHolder: systemName(),
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length > 32 ? "32 caractères maximum." : undefined),
    });
    return name?.trim();
  }

  private async askRoomKey(title: string): Promise<string | undefined> {
    const items: (vscode.QuickPickItem & { id: string })[] = [
      {
        label: "$(sparkle) Générer une clé de salon",
        description: "recommandé",
        id: "generate",
      },
      { label: "$(key) Saisir ma propre clé", id: "enter" },
    ];
    if (this.roomKey) {
      items.unshift({
        label: "$(history) Conserver la clé actuelle",
        description: "même salon qu'avant",
        id: "keep",
      });
    }
    const choice = await vscode.window.showQuickPick(items, {
      title,
      placeHolder: "Clé secrète du salon",
      ignoreFocusOut: true,
    });
    if (!choice) return undefined;
    if (choice.id === "keep") return this.roomKey;
    if (choice.id === "generate") return randomBytes(16).toString("hex");

    const value = await vscode.window.showInputBox({
      title,
      prompt: "Clé secrète partagée avec votre collaborateur",
      password: true,
      placeHolder: "Au moins 6 caractères",
      ignoreFocusOut: true,
      validateInput: validRoomKey,
    });
    return value?.trim() || undefined;
  }

  private async saveConfiguration(invite: Invite, name: string): Promise<void> {
    const config = vscode.workspace.getConfiguration("duochat");
    this.suppressSettingsReconnectUntil = Date.now() + 2500;
    await config.update("serverUrl", invite.url || undefined, vscode.ConfigurationTarget.Global);
    await config.update("displayName", name, vscode.ConfigurationTarget.Global);
    await this.context.secrets.store(ROOM_KEY_SECRET, invite.roomKey);
    if (invite.apiKey) await this.context.secrets.store(SUPABASE_KEY_SECRET, invite.apiKey);
    else await this.context.secrets.delete(SUPABASE_KEY_SECRET);

    this.roomKey = invite.roomKey;
    this.supabaseKey = invite.apiKey;
    this.settings = this.readSettings();
    this.messages = [];
    this.syncContextKeys();
    this.refreshStatusBar();
    this.post(this.bootstrap());
    await this.connect();
  }

  private currentInvite(): Invite | undefined {
    if (!this.isConfigured() || !this.roomKey) return undefined;
    const url = this.settings.serverUrl;
    return backendFor(url) === "supabase"
      ? { url, apiKey: this.supabaseKey, roomKey: this.roomKey }
      : { url, roomKey: this.roomKey };
  }

  private isConfigured(): boolean {
    const backend = backendFor(this.settings.serverUrl);
    if (!backend || !this.roomKey) return false;
    return backend !== "supabase" || Boolean(this.supabaseKey);
  }

  private createClient(backend: Backend): ChatTransport {
    const log = (line: string) => console.warn(`[duochat] ${line}`);
    const client: ChatTransport =
      backend === "public"
        ? new PublicClient(this.userId, log)
        : backend === "supabase"
          ? new SupabaseClient(this.userId, log)
          : new RelayClient(this.userId, log);

    client.on("status", (status: ClientStatus, detail: string) =>
      this.onClientStatus(status, detail),
    );
    client.on("hello", (hello: HelloMessage) => this.onHello(hello));
    client.on("message", (message: ChatMessage) => this.onChatMessage(message));
    client.on("presence", (users: UserIdentity[]) => {
      this.users = users;
      this.post({ type: "presence", users });
    });
    client.on("typing", (payload: { userId: string; name: string; on: boolean }) => {
      this.post({ type: "typing", ...payload });
    });
    client.on("system", (payload: { text: string; ts: number }) => {
      this.post({ type: "system", ...payload });
    });
    client.on("serverError", (code: string, message: string) => {
      if (FATAL_ERROR_CODES.has(code)) return;
      const level = code === "history_unavailable" ? "info" : "error";
      this.post({ type: "notice", level, text: message });
    });
    return client;
  }

  private useBackend(backend: Backend): void {
    if (this.client.backend === backend) return;
    this.client.dispose();
    this.client = this.createClient(backend);
    this.self = undefined;
    this.users = [];
    this.messages = [];
    this.post(this.bootstrap());
  }

  async shareLocation(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage("Ouvrez un fichier pour partager sa position.");
      return;
    }
    if (editor.document.isUntitled) {
      void vscode.window.showWarningMessage(
        "Enregistrez le fichier avant de partager sa position.",
      );
      return;
    }
    if (!this.client.isConnected()) {
      const choice = await vscode.window.showWarningMessage(
        "DuoChat n'est pas connecté.",
        "Ouvrir le chat",
      );
      if (choice) await this.focusView();
      return;
    }

    const file = vscode.workspace
      .asRelativePath(editor.document.uri, false)
      .replace(/\\/g, "/");
    const line = editor.selection.active.line + 1;
    if (!this.client.sendLocation({ file, line })) {
      void vscode.window.showWarningMessage(
        "Impossible d'envoyer la référence : DuoChat est hors ligne.",
      );
    }
  }

  async focusView(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.duochat");
    this.view?.show?.(false);
    this.clearUnread();
  }

  dispose(): void {
    if (this.reconnectDebounce) {
      clearTimeout(this.reconnectDebounce);
      this.reconnectDebounce = undefined;
    }
    this.client.dispose();
    this.statusItem.dispose();
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
  }

  private readSettings(): DuoChatSettings {
    const config = vscode.workspace.getConfiguration("duochat");
    return {
      serverUrl: (config.get<string>("serverUrl", "") || "").trim(),
      displayName:
        (config.get<string>("displayName", "") || "").trim() || systemName(),
      notifications: config.get<boolean>("notifications", true),
    };
  }

  private async handleWebviewMessage(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== "object") return;
    const message = raw as WebviewMessage;

    switch (message.type) {
      case "ready":
        this.webviewReady = true;
        this.post(this.bootstrap());
        break;
      case "send": {
        const text = typeof message.text === "string" ? message.text.slice(0, 4000) : "";
        if (!text.trim()) return;
        if (!this.client.sendText(text)) {
          this.post({ type: "sendFailed", text });
          this.post({
            type: "notice",
            level: "error",
            text: "Message non envoyé : DuoChat est hors ligne.",
          });
        }
        break;
      }
      case "typing":
        if (typeof message.on === "boolean") this.client.setTyping(message.on);
        break;
      case "shareLocation":
        await this.shareLocation();
        break;
      case "configure":
        await this.configure();
        break;
      case "connect":
        await this.connect();
        break;
      case "openLocation":
        await this.openLocation(message.file, message.line);
        break;
      default:
        break;
    }
  }

  private onClientStatus(status: ClientStatus, detail: string): void {
    if (status !== "connected") {
      this.users = [];
      this.post({ type: "presence", users: [] });
    }
    this.post({ type: "status", status, error: detail || undefined });
    this.syncContextKeys();
    this.refreshStatusBar();
  }

  private onHello(hello: HelloMessage): void {
    this.self = hello.self;
    this.users = hello.users;
    this.messages = hello.history.slice(-200);
    this.post({
      type: "hello",
      self: hello.self,
      users: hello.users,
      messages: this.messages,
    });
    this.clearUnread();
    this.syncContextKeys();
    this.refreshStatusBar();
  }

  private onChatMessage(message: ChatMessage): void {
    if (this.messages.some((existing) => existing.id === message.id)) return;
    this.messages.push(message);
    if (this.messages.length > 200) this.messages.shift();
    this.post({ type: "message", message });

    const mine = message.userId === this.self?.id;
    const seen = Boolean(this.view?.visible && vscode.window.state.focused);
    if (!mine && !seen) {
      this.incrementUnread();
      this.maybeNotify(message);
    }
  }

  private onSettingsChanged(): void {
    const next = this.readSettings();
    const connectionChanged =
      next.serverUrl !== this.settings.serverUrl ||
      next.displayName !== this.settings.displayName;
    this.settings = next;

    if (
      connectionChanged &&
      this.wantConnected &&
      this.isConfigured() &&
      Date.now() > this.suppressSettingsReconnectUntil
    ) {
      if (this.reconnectDebounce) clearTimeout(this.reconnectDebounce);
      this.reconnectDebounce = setTimeout(() => {
        this.reconnectDebounce = undefined;
        void this.connect();
      }, 600);
    }
  }

  private maybeNotify(message: ChatMessage): void {
    if (!this.settings.notifications) return;
    if (message.userId === this.self?.id) return;
    if (this.view?.visible && vscode.window.state.focused) return;

    const now = Date.now();
    if (now - this.lastNotificationAt < NOTIFICATION_THROTTLE_MS) return;
    this.lastNotificationAt = now;

    const preview =
      message.kind === "location" && message.meta
        ? `partage ${message.meta.file}:${message.meta.line}`
        : summarize(message.text);

    void vscode.window
      .showInformationMessage(`${message.name} : ${preview}`, "Ouvrir le chat")
      .then((choice) => {
        if (choice) void this.focusView();
      });
  }

  private async openLocation(file: unknown, line: unknown): Promise<void> {
    if (typeof file !== "string" || !file.trim()) return;
    if (typeof line !== "number" || !Number.isFinite(line)) return;

    const uri = await this.resolveFile(file);
    if (!uri) {
      const choice = await vscode.window.showWarningMessage(
        `Fichier introuvable : ${file}`,
        "Copier le chemin",
      );
      if (choice) await vscode.env.clipboard.writeText(file);
      return;
    }

    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const zeroBased = Math.min(
        Math.max(0, Math.floor(line) - 1),
        Math.max(0, document.lineCount - 1),
      );
      const position = new vscode.Position(zeroBased, 0);
      await vscode.window.showTextDocument(document, {
        preview: true,
        selection: new vscode.Range(position, position),
      });
    } catch (error) {
      void vscode.window.showWarningMessage(
        `Impossible d'ouvrir ${file} : ${String(error)}`,
      );
    }
  }

  private async resolveFile(file: string): Promise<vscode.Uri | undefined> {
    const normalized = file.replace(/\\/g, "/");
    if (normalized.split("/").includes("..")) return undefined;

    if (path.isAbsolute(normalized)) {
      const uri = vscode.Uri.file(normalized);
      try {
        await vscode.workspace.fs.stat(uri);
        return uri;
      } catch {
        return undefined;
      }
    }

    const relativeSegments = normalized.split("/").filter(Boolean);
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const uri = vscode.Uri.joinPath(folder.uri, ...relativeSegments);
      try {
        await vscode.workspace.fs.stat(uri);
        return uri;
      } catch {
        // essayer le dossier suivant
      }
    }
    return undefined;
  }

  private bootstrap(): WebviewBootstrap {
    return {
      type: "bootstrap",
      configured: this.isConfigured(),
      status: this.currentStatus(),
      error: this.isConfigured() ? this.client.statusDetail || undefined : undefined,
      self: this.self,
      users: this.users,
      messages: this.messages,
      settings: this.settings,
    };
  }

  private currentStatus(): LinkStatus {
    return this.isConfigured() ? this.client.status : "unconfigured";
  }

  private post(message: ExtensionMessage): void {
    if (!this.view || !this.webviewReady) return;
    void this.view.webview.postMessage(message);
  }

  private incrementUnread(): void {
    this.unread++;
    if (this.view) {
      this.view.badge = {
        value: this.unread,
        tooltip: `${this.unread} nouveau(x) message(s)`,
      };
    }
    this.refreshStatusBar();
  }

  private clearUnread(): void {
    if (this.unread === 0) return;
    this.unread = 0;
    if (this.view) this.view.badge = undefined;
    this.refreshStatusBar();
  }

  private syncContextKeys(): void {
    void vscode.commands.executeCommand(
      "setContext",
      "duochat.configured",
      this.isConfigured(),
    );
    void vscode.commands.executeCommand(
      "setContext",
      "duochat.connected",
      this.client.status === "connected",
    );
  }

  private refreshStatusBar(): void {
    const unread = this.unread > 0 ? ` ${this.unread}` : "";
    this.statusItem.text = `$(comment-discussion) DuoChat${unread}`;

    let stateText: string;
    if (!this.isConfigured()) {
      stateText = "Non configuré - cliquez pour créer ou rejoindre un salon";
    } else if (this.client.status === "connected") {
      stateText = this.users.length > 1 ? `${this.users.length} participant(s)` : "Connecté";
    } else if (this.client.status === "connecting") {
      stateText = "Connexion…";
    } else if (this.client.status === "error") {
      stateText = `Erreur : ${this.client.statusDetail || "connexion"}`;
    } else {
      stateText = "Hors ligne";
    }

    const unreadText = this.unread > 0 ? ` · ${this.unread} non lu(s)` : "";
    this.statusItem.tooltip = `DuoChat — ${stateText}${unreadText}`;
    this.statusItem.backgroundColor =
      this.client.status === "error"
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
  }
}
