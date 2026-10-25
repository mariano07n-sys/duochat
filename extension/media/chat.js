(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  const EMOJIS = [
    "😀", "😄", "😁", "😅", "😂", "🤣", "🙂", "😉",
    "😊", "😍", "😎", "🤔", "😇", "🙃", "😴", "🤯",
    "😱", "😭", "🥳", "🤝", "👋", "👍", "👎", "👏",
    "🙏", "💪", "🤞", "✌️", "🫡", "👀", "🔥", "✨",
    "💡", "⚡", "🚀", "🐛", "✅", "❌", "⚠️", "🎉",
    "❤️", "💜", "💙", "💚", "😈", "🤖", "☕", "🍕",
    "🎯", "🧠", "📌", "🔗", "💬", "🫶", "🤙", "🧑‍💻"
  ];

  const FILE_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"></path><path d="M14 2v6h6"></path><path d="m10 13-2 2 2 2"></path><path d="m14 17 2-2-2-2"></path></svg>';

  const app = document.getElementById("app");
  const statusText = document.getElementById("statusText");
  const presenceEl = document.getElementById("presence");
  const settingsBtn = document.getElementById("settingsBtn");
  const banner = document.getElementById("banner");
  const bannerText = document.getElementById("bannerText");
  const bannerSpinner = document.getElementById("bannerSpinner");
  const bannerAction = document.getElementById("bannerAction");
  const scroller = document.getElementById("scroller");
  const welcomeEl = document.getElementById("welcome");
  const welcomeTitle = document.getElementById("welcomeTitle");
  const welcomeText = document.getElementById("welcomeText");
  const welcomeAction = document.getElementById("welcomeAction");
  const messagesEl = document.getElementById("messages");
  const jumpBtn = document.getElementById("jumpBtn");
  const typingEl = document.getElementById("typing");
  const typingText = document.getElementById("typingText");
  const emojiBtn = document.getElementById("emojiBtn");
  const emojiPop = document.getElementById("emojiPop");
  const emojiGrid = document.getElementById("emojiGrid");
  const input = document.getElementById("input");
  const shareBtn = document.getElementById("shareBtn");
  const sendBtn = document.getElementById("sendBtn");
  const composerHint = document.getElementById("composerHint");
  const counter = document.getElementById("counter");
  const toast = document.getElementById("toast");

  const timeFormatter = new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit"
  });
  const fullTimeFormatter = new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short"
  });
  const dayFormatter = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long"
  });
  const dayYearFormatter = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  });

  const GROUP_WINDOW_MS = 5 * 60 * 1000;
  const MAX_MESSAGES = 500;
  const TYPING_TTL_MS = 6000;

  const state = {
    configured: false,
    status: "unconfigured",
    error: undefined,
    self: null,
    users: [],
    messages: [],
    settings: { serverUrl: "", displayName: "", notifications: true },
    typing: new Map(),
    typingTimers: new Map(),
    nearBottom: true,
    pendingCount: 0
  };

  const renderedIds = new Set();
  let lastRenderedMessage = null;
  let lastDayKey = null;
  let typingActive = false;
  let typingStopTimer = null;
  let toastTimer = null;
  let draftTimer = null;
  let emojiOpen = false;

  function toDate(ts) {
    const date = new Date(Number(ts));
    return Number.isNaN(date.getTime()) ? new Date() : date;
  }

  function sameDay(a, b) {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  function dayKey(ts) {
    return toDate(ts).toDateString();
  }

  function dayLabel(ts) {
    const date = toDate(ts);
    const now = new Date();
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (sameDay(date, now)) return "Aujourd'hui";
    if (sameDay(date, yesterday)) return "Hier";
    const formatter = date.getFullYear() === now.getFullYear() ? dayFormatter : dayYearFormatter;
    const label = formatter.format(date);
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  function safeColor(value) {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : "#22d3ee";
  }

  function initials(name) {
    if (typeof name !== "string") return "?";
    const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
    if (!parts.length) return "?";
    const first = Array.from(parts[0])[0] ?? "";
    const second = parts.length > 1 ? (Array.from(parts[1])[0] ?? "") : "";
    return (first + second).toUpperCase();
  }

  function appendLinkedText(container, text) {
    const pattern = /https?:\/\/[^\s<>"'`]+/gi;
    let cursor = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
      let url = match[0];
      let trailing = "";
      while (/[.,;:!?]$/.test(url)) {
        trailing = url.slice(-1) + trailing;
        url = url.slice(0, -1);
      }
      if (!url) continue;

      if (match.index > cursor) {
        container.append(document.createTextNode(text.slice(cursor, match.index)));
      }
      const link = document.createElement("a");
      link.href = url;
      link.textContent = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      container.append(link);
      if (trailing) container.append(document.createTextNode(trailing));
      cursor = match.index + match[0].length;
    }

    if (cursor < text.length) {
      container.append(document.createTextNode(text.slice(cursor)));
    }
  }

  function createAvatar(name, color) {
    const avatar = document.createElement("div");
    avatar.className = "dc-avatar";
    avatar.textContent = initials(name);
    avatar.setAttribute("aria-hidden", "true");
    avatar.style.setProperty("--avatar-color", safeColor(color));
    return avatar;
  }

  function createLocationCard(meta) {
    const file = typeof meta.file === "string" ? meta.file.replace(/\\/g, "/") : "fichier";
    const rawLine = Number(meta.line);
    const line = Number.isFinite(rawLine) && rawLine > 0 ? Math.floor(rawLine) : 1;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "dc-loc";
    button.dataset.file = file;
    button.dataset.line = String(line);
    button.title = `Ouvrir ${file}:${line}`;
    button.setAttribute("aria-label", `Ouvrir ${file}, ligne ${line}`);

    const icon = document.createElement("span");
    icon.className = "dc-loc-icon";
    icon.innerHTML = FILE_ICON;

    const body = document.createElement("span");
    body.className = "dc-loc-body";

    const pathEl = document.createElement("span");
    pathEl.className = "dc-loc-path";
    pathEl.dir = "auto";

    const slash = file.lastIndexOf("/");
    if (slash >= 0) {
      const dir = document.createElement("span");
      dir.className = "dc-loc-dir";
      dir.textContent = file.slice(0, slash + 1);
      const base = document.createElement("span");
      base.className = "dc-loc-file";
      base.textContent = file.slice(slash + 1);
      pathEl.append(dir, base);
    } else {
      const base = document.createElement("span");
      base.className = "dc-loc-file";
      base.textContent = file;
      pathEl.append(base);
    }

    const lineEl = document.createElement("span");
    lineEl.className = "dc-loc-line";
    lineEl.textContent = `:${line}`;
    body.append(pathEl, lineEl);

    const action = document.createElement("span");
    action.className = "dc-loc-open";
    action.textContent = "Ouvrir";

    button.append(icon, body, action);
    return button;
  }

  function createDaySeparator(ts) {
    const node = document.createElement("div");
    node.className = "dc-day";
    node.setAttribute("role", "separator");
    const label = document.createElement("span");
    label.textContent = dayLabel(ts);
    node.append(label);
    return node;
  }

  function appendMessageNode(message, initial) {
    if (!message || typeof message !== "object") return;
    const id = typeof message.id === "string" ? message.id : "";
    if (id && renderedIds.has(id)) return;
    if (id) renderedIds.add(id);

    const ts = Number(message.ts) || Date.now();
    const own = Boolean(state.self && message.userId === state.self.id);
    const name = typeof message.name === "string" && message.name ? message.name : "Inconnu";
    const key = dayKey(ts);
    let newDay = false;

    if (key !== lastDayKey) {
      messagesEl.append(createDaySeparator(ts));
      lastDayKey = key;
      newDay = true;
      lastRenderedMessage = null;
    }

    const group =
      !newDay &&
      lastRenderedMessage &&
      lastRenderedMessage.userId === message.userId &&
      lastRenderedMessage.kind === "text" &&
      message.kind === "text" &&
      ts >= lastRenderedMessage.ts &&
      ts - lastRenderedMessage.ts < GROUP_WINDOW_MS;

    const article = document.createElement("article");
    article.className =
      "dc-msg" +
      (own ? " dc-msg--own" : "") +
      (group ? " dc-msg--grouped" : "") +
      (initial ? "" : " dc-msg--live");
    if (id) article.dataset.id = id;
    article.style.setProperty("--avatar-color", safeColor(message.color));

    const avatar = createAvatar(name, message.color);

    const main = document.createElement("div");
    main.className = "dc-msg-main";

    const head = document.createElement("div");
    head.className = "dc-msg-head";
    const nameEl = document.createElement("span");
    nameEl.className = "dc-msg-name";
    nameEl.textContent = own ? "Vous" : name;
    const timeEl = document.createElement("time");
    timeEl.className = "dc-msg-time";
    const date = toDate(ts);
    timeEl.dateTime = date.toISOString();
    timeEl.textContent = timeFormatter.format(date);
    timeEl.title = fullTimeFormatter.format(date);
    head.append(nameEl, timeEl);

    const bubble = document.createElement("div");
    bubble.className = "dc-bubble";
    if (message.kind === "location" && message.meta && typeof message.meta.file === "string") {
      bubble.classList.add("dc-bubble--location");
      bubble.append(createLocationCard(message.meta));
    } else {
      bubble.dir = "auto";
      appendLinkedText(bubble, typeof message.text === "string" ? message.text : "");
    }

    main.append(head, bubble);
    article.append(avatar, main);
    messagesEl.append(article);

    lastRenderedMessage = { userId: message.userId, ts, kind: message.kind };
    removeTypingUser(message.userId);
    updateWelcome();

    if (initial) return;

    if (own || state.nearBottom) {
      scrollToBottom(true);
      resetPending();
    } else {
      state.pendingCount++;
      updateJump();
    }
  }

  function appendSystemMessage(text) {
    if (typeof text !== "string" || !text) return;
    const node = document.createElement("div");
    node.className = "dc-system dc-system--live";
    const bubble = document.createElement("span");
    bubble.textContent = text;
    node.append(bubble);
    messagesEl.append(node);
    lastRenderedMessage = null;
    updateWelcome();
    if (state.nearBottom) scrollToBottom(true);
  }

  function clearMessages() {
    messagesEl.replaceChildren();
    renderedIds.clear();
    lastRenderedMessage = null;
    lastDayKey = null;
  }

  function renderAll() {
    clearMessages();
    for (const message of state.messages) appendMessageNode(message, true);
    renderPresence();
    renderStatus();
    updateBanner();
    renderTyping();
    updateWelcome();
    updateComposer();

    window.requestAnimationFrame(() => {
      scroller.scrollTop = scroller.scrollHeight;
      state.nearBottom = true;
      resetPending();
    });
  }

  function renderPresence() {
    presenceEl.replaceChildren();
    const users = Array.isArray(state.users) ? state.users : [];
    if (!users.length) {
      presenceEl.hidden = true;
      presenceEl.removeAttribute("title");
      presenceEl.removeAttribute("aria-label");
      return;
    }

    const maxChips = 3;
    let shown = users;
    let more = 0;
    if (users.length > maxChips) {
      shown = users.slice(0, maxChips - 1);
      more = users.length - shown.length;
    }

    for (const user of shown) {
      const chip = document.createElement("span");
      chip.className = "dc-chip";
      chip.textContent = initials(user.name);
      chip.style.setProperty("--chip-color", safeColor(user.color));
      chip.title = user.name + (state.self && user.id === state.self.id ? " (vous)" : "");
      chip.setAttribute("aria-hidden", "true");
      presenceEl.append(chip);
    }

    if (more > 0) {
      const chip = document.createElement("span");
      chip.className = "dc-chip dc-chip--more";
      chip.textContent = `+${more}`;
      chip.title = users
        .slice(maxChips - 1)
        .map((user) => user.name)
        .join(", ");
      chip.setAttribute("aria-hidden", "true");
      presenceEl.append(chip);
    }

    const names = users.map(
      (user) => user.name + (state.self && user.id === state.self.id ? " (vous)" : "")
    );
    presenceEl.title = names.join(", ");
    presenceEl.setAttribute("aria-label", `En ligne : ${names.join(", ")}`);
    presenceEl.hidden = false;
  }

  function renderStatus() {
    app.dataset.status = state.status;
    let text = "Non configuré";

    if (state.status === "unconfigured") {
      text = "Non configuré";
    } else if (state.status === "connected") {
      const others = (state.users || []).filter(
        (user) => !state.self || user.id !== state.self.id
      );
      if (others.length === 0) text = "Vous êtes seul en ligne";
      else if (others.length === 1) text = others[0].name;
      else if (others.length === 2) text = `${others[0].name} et ${others[1].name}`;
      else text = `${others[0].name}, ${others[1].name} +${others.length - 2}`;
    } else if (state.status === "connecting") {
      text = "Connexion…";
    } else if (state.status === "error") {
      text = "Connexion impossible";
    } else {
      text = "Hors ligne";
    }

    statusText.textContent = text;
    statusText.title = text;
  }

  function updateBanner() {
    if (!state.configured || state.status === "unconfigured" || state.status === "connected") {
      banner.hidden = true;
      return;
    }

    let text = "";
    let spinner = false;
    let action = false;

    if (state.status === "connecting") {
      text = state.error || "Connexion…";
      spinner = true;
    } else if (state.status === "offline") {
      text = state.error || "Hors ligne. Reconnexion automatique…";
      action = true;
    } else if (state.status === "error") {
      text = state.error || "Connexion impossible.";
      action = true;
    }

    if (!text) {
      banner.hidden = true;
      return;
    }

    bannerText.textContent = text;
    bannerText.title = text;
    bannerSpinner.hidden = !spinner;
    bannerAction.hidden = !action;
    bannerAction.textContent = state.status === "error" ? "Réessayer" : "Reconnecter";
    banner.hidden = false;
  }

  function updateWelcome() {
    const empty = state.messages.length === 0 && messagesEl.childElementCount === 0;
    if (!empty) {
      welcomeEl.hidden = true;
      return;
    }

    if (state.status === "unconfigured") {
      welcomeTitle.textContent = "Bienvenue sur DuoChat";
      welcomeText.textContent =
        "Créez un salon en un clic et envoyez l'invitation à votre collaborateur, ou collez celle qu'il vous a envoyée. Rien d'autre à installer.";
      welcomeAction.textContent = "Créer ou rejoindre un salon";
      welcomeAction.dataset.action = "configure";
      welcomeEl.hidden = false;
      return;
    }

    if (state.status === "connected") {
      welcomeTitle.textContent = "Salon prêt";
      welcomeText.textContent =
        "Aucun message pour l'instant. Dites bonjour, ou partagez la ligne sur laquelle vous travaillez.";
      welcomeAction.textContent = "Partager le fichier courant";
      welcomeAction.dataset.action = "share";
      welcomeEl.hidden = false;
      return;
    }

    welcomeEl.hidden = true;
  }

  function updateComposer() {
    const connected = state.configured && state.status === "connected";
    input.disabled = !connected;

    if (connected) {
      input.placeholder = "Écrire un message…";
      composerHint.textContent = "Entrée pour envoyer · Maj+Entrée pour aller à la ligne";
    } else if (state.status === "unconfigured") {
      input.placeholder = "Configurer DuoChat…";
      composerHint.textContent = "DuoChat n'est pas encore configuré";
    } else if (state.status === "connecting") {
      input.placeholder = "Connexion…";
      composerHint.textContent = "Connexion en cours";
    } else {
      input.placeholder = "Hors ligne…";
      composerHint.textContent = "DuoChat est hors ligne";
    }

    emojiBtn.disabled = !connected;
    shareBtn.disabled = !connected;
    updateSendState();
    updateCounter();

    if (!connected) {
      resetTypingState();
      setEmojiOpen(false, false);
    }
  }

  function updateSendState() {
    const connected = state.configured && state.status === "connected";
    sendBtn.disabled = !connected || !input.value.trim();
  }

  function updateCounter() {
    const length = input.value.length;
    counter.hidden = length < 3600;
    counter.textContent = `${length} / 4000`;
    counter.classList.toggle("is-warning", length >= 3600 && length < 3900);
    counter.classList.toggle("is-limit", length >= 3900);
  }

  function setTypingUser(userId, name, on) {
    if (!userId) return;
    const existing = state.typingTimers.get(userId);
    if (existing) clearTimeout(existing);
    state.typingTimers.delete(userId);

    if (on) {
      state.typing.set(userId, name || "Quelqu'un");
      const timer = setTimeout(() => {
        state.typing.delete(userId);
        state.typingTimers.delete(userId);
        renderTyping();
      }, TYPING_TTL_MS);
      state.typingTimers.set(userId, timer);
    } else {
      state.typing.delete(userId);
    }
    renderTyping();
  }

  function removeTypingUser(userId) {
    if (!state.typing.has(userId) && !state.typingTimers.has(userId)) return;
    const timer = state.typingTimers.get(userId);
    if (timer) clearTimeout(timer);
    state.typingTimers.delete(userId);
    state.typing.delete(userId);
    renderTyping();
  }

  function pruneTyping() {
    for (const userId of [...state.typing.keys()]) {
      if (!state.users.some((user) => user.id === userId)) {
        removeTypingUser(userId);
      }
    }
  }

  function clearTyping() {
    for (const timer of state.typingTimers.values()) clearTimeout(timer);
    state.typingTimers.clear();
    state.typing.clear();
    renderTyping();
  }

  function renderTyping() {
    const names = [...state.typing.values()].filter(Boolean);
    if (names.length === 0) {
      typingEl.hidden = true;
      typingText.textContent = "";
      return;
    }

    let text;
    if (names.length === 1) {
      text = `${names[0]} écrit…`;
    } else if (names.length === 2) {
      text = `${names[0]} et ${names[1]} écrivent…`;
    } else {
      const remaining = names.length - 2;
      text = `${names[0]}, ${names[1]} et ${remaining} autre${
        remaining > 1 ? "s" : ""
      } écrivent…`;
    }

    typingText.textContent = text;
    typingEl.hidden = false;
  }

  function isNearBottom() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
  }

  function scrollToBottom(smooth) {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scroller.scrollTo({
      top: scroller.scrollHeight,
      behavior: smooth && !reduceMotion ? "smooth" : "auto"
    });
    state.nearBottom = true;
  }

  function resetPending() {
    state.pendingCount = 0;
    jumpBtn.hidden = true;
  }

  function updateJump() {
    if (state.pendingCount > 0 && !state.nearBottom) {
      jumpBtn.textContent = `↓ Nouveaux messages · ${state.pendingCount}`;
      jumpBtn.hidden = false;
    } else {
      jumpBtn.hidden = true;
    }
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight || 22, 132)}px`;
  }

  function persistDraft() {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      try {
        vscode.setState({ draft: input.value });
      } catch {
        // etat local indisponible
      }
    }, 250);
  }

  function restoreDraft() {
    try {
      const saved = vscode.getState && vscode.getState();
      if (saved && typeof saved.draft === "string") {
        input.value = saved.draft.slice(0, 4000);
      }
    } catch {
      // etat local indisponible
    }
    autosize();
    updateSendState();
    updateCounter();
  }

  function notifyTyping() {
    if (state.status !== "connected") return;
    if (!typingActive) {
      typingActive = true;
      vscode.postMessage({ type: "typing", on: true });
    }
    if (typingStopTimer) clearTimeout(typingStopTimer);
    typingStopTimer = setTimeout(() => {
      typingStopTimer = null;
      if (!typingActive) return;
      typingActive = false;
      vscode.postMessage({ type: "typing", on: false });
    }, 1600);
  }

  function stopTyping() {
    if (typingStopTimer) {
      clearTimeout(typingStopTimer);
      typingStopTimer = null;
    }
    if (typingActive) {
      typingActive = false;
      vscode.postMessage({ type: "typing", on: false });
    }
  }

  function resetTypingState() {
    if (typingStopTimer) {
      clearTimeout(typingStopTimer);
      typingStopTimer = null;
    }
    typingActive = false;
  }

  function onInputChanged() {
    autosize();
    updateSendState();
    updateCounter();
    persistDraft();

    if (state.status !== "connected") {
      resetTypingState();
      return;
    }
    if (input.value.trim()) {
      notifyTyping();
    } else {
      stopTyping();
    }
  }

  function sendMessage() {
    if (!state.configured || state.status !== "connected") return;
    const text = input.value.trim();
    if (!text) return;

    vscode.postMessage({ type: "send", text });
    setEmojiOpen(false, false);
    input.value = "";
    autosize();
    updateSendState();
    updateCounter();
    persistDraft();
    resetTypingState();
    input.focus();
  }

  function setEmojiOpen(open, moveFocus) {
    const next = Boolean(open) && !input.disabled;
    emojiOpen = next;
    emojiPop.hidden = !next;
    emojiBtn.setAttribute("aria-expanded", String(next));

    if (!next && moveFocus !== false) {
      if (emojiGrid.contains(document.activeElement)) emojiBtn.focus();
      return;
    }
    if (next && moveFocus !== false) {
      const first = emojiGrid.querySelector("button");
      if (first) first.focus();
    }
  }

  function insertEmoji(emoji) {
    const start = typeof input.selectionStart === "number" ? input.selectionStart : input.value.length;
    const end = typeof input.selectionEnd === "number" ? input.selectionEnd : start;
    input.focus();
    const max = input.maxLength > 0 ? input.maxLength : Infinity;
    const next = input.value.slice(0, start) + emoji + input.value.slice(end);
    if (next.length <= max) {
      input.setRangeText(emoji, start, end, "end");
    } else {
      const room = max - (input.value.length - (end - start));
      let clipped = "";
      for (const char of emoji) {
        if ((clipped + char).length > room) break;
        clipped += char;
      }
      if (clipped) input.setRangeText(clipped, start, end, "end");
    }
    setEmojiOpen(false, false);
    onInputChanged();
  }

  function buildEmojiGrid() {
    const fragment = document.createDocumentFragment();
    for (const emoji of EMOJIS) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = emoji;
      button.title = emoji;
      button.setAttribute("aria-label", `Emoji ${emoji}`);
      button.addEventListener("click", () => insertEmoji(emoji));
      fragment.append(button);
    }
    emojiGrid.append(fragment);
  }

  function showToast(text, level) {
    toast.textContent = typeof text === "string" ? text : "Une erreur est survenue.";
    toast.dataset.level = level === "error" ? "error" : "info";
    toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hidden = true;
      toastTimer = null;
    }, 3800);
  }

  function applyBootstrap(message) {
    state.configured = Boolean(message.configured);
    state.status =
      typeof message.status === "string"
        ? message.status
        : state.configured
          ? "offline"
          : "unconfigured";
    state.error = typeof message.error === "string" ? message.error : undefined;
    state.self = message.self && typeof message.self === "object" ? message.self : null;
    state.users = Array.isArray(message.users) ? message.users : [];
    state.messages = Array.isArray(message.messages)
      ? message.messages.slice(-MAX_MESSAGES)
      : [];
    if (message.settings && typeof message.settings === "object") {
      state.settings = message.settings;
    }
    clearTyping();
    renderAll();
  }

  function applyHello(message) {
    state.status = "connected";
    state.error = undefined;
    state.self = message.self && typeof message.self === "object" ? message.self : state.self;
    state.users = Array.isArray(message.users) ? message.users : [];
    state.messages = Array.isArray(message.messages)
      ? message.messages.slice(-MAX_MESSAGES)
      : [];
    clearTyping();
    renderAll();
  }

  function applyStatus(message) {
    state.status = typeof message.status === "string" ? message.status : state.status;
    state.error = typeof message.error === "string" ? message.error : undefined;

    if (state.status !== "connected") {
      state.users = [];
      clearTyping();
      renderPresence();
    }
    renderStatus();
    updateBanner();
    updateComposer();
    updateWelcome();
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;

    switch (message.type) {
      case "bootstrap":
        applyBootstrap(message);
        break;
      case "hello":
        applyHello(message);
        break;
      case "status":
        applyStatus(message);
        break;
      case "message": {
        const chatMessage = message.message;
        if (!chatMessage || typeof chatMessage !== "object") return;
        state.messages.push(chatMessage);
        if (state.messages.length > MAX_MESSAGES) {
          state.messages.splice(0, state.messages.length - MAX_MESSAGES);
        }
        appendMessageNode(chatMessage, false);
        break;
      }
      case "presence":
        state.users = Array.isArray(message.users) ? message.users : [];
        pruneTyping();
        renderPresence();
        renderStatus();
        break;
      case "typing":
        if (message.userId === (state.self && state.self.id)) return;
        setTypingUser(message.userId, message.name, Boolean(message.on));
        break;
      case "system":
        appendSystemMessage(message.text);
        break;
      case "notice":
        showToast(message.text, message.level);
        break;
      case "sendFailed":
        if (typeof message.text === "string" && !input.value.trim()) {
          input.value = message.text.slice(0, 4000);
          autosize();
          updateSendState();
          updateCounter();
          persistDraft();
          if (!input.disabled) input.focus();
        }
        break;
      default:
        break;
    }
  });

  settingsBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "configure" });
  });

  welcomeAction.addEventListener("click", () => {
    if (welcomeAction.dataset.action === "share") {
      vscode.postMessage({ type: "shareLocation" });
    } else {
      vscode.postMessage({ type: "configure" });
    }
  });

  bannerAction.addEventListener("click", () => {
    vscode.postMessage({ type: "connect" });
  });

  jumpBtn.addEventListener("click", () => {
    scrollToBottom(true);
    resetPending();
  });

  input.addEventListener("input", (event) => {
    if (event.isComposing) {
      autosize();
      return;
    }
    onInputChanged();
  });

  input.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener("click", sendMessage);

  shareBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "shareLocation" });
    input.focus();
  });

  emojiBtn.addEventListener("click", () => {
    setEmojiOpen(!emojiOpen);
  });

  document.addEventListener("click", (event) => {
    if (!emojiOpen) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (emojiPop.contains(target) || emojiBtn.contains(target)) return;
    setEmojiOpen(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && emojiOpen) {
      event.preventDefault();
      setEmojiOpen(false);
      emojiBtn.focus();
    }
  });

  messagesEl.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest(".dc-loc");
    if (!button) return;
    const file = button.dataset.file;
    const line = Number(button.dataset.line);
    if (file && Number.isFinite(line)) {
      vscode.postMessage({ type: "openLocation", file, line });
    }
  });

  scroller.addEventListener(
    "scroll",
    () => {
      state.nearBottom = isNearBottom();
      if (state.nearBottom) resetPending();
    },
    { passive: true }
  );

  window.addEventListener("resize", () => {
    autosize();
    if (state.nearBottom) scrollToBottom(false);
  });

  buildEmojiGrid();
  restoreDraft();
  renderStatus();
  renderPresence();
  renderTyping();
  updateBanner();
  updateWelcome();
  updateComposer();
  vscode.postMessage({ type: "ready" });
})();
