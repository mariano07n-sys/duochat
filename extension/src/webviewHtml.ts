import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const mediaRoot = vscode.Uri.joinPath(extensionUri, "media");
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "chat.css"));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "chat.js"));
  const nonce = randomBytes(16).toString("base64");
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${styleUri}">
  <title>DuoChat</title>
</head>
<body>
  <div class="dc-app" id="app" data-status="unconfigured">
    <header class="dc-header">
      <div class="dc-heading">
        <div class="dc-title">
          <span class="dc-logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="21" height="21">
              <defs>
                <linearGradient id="dc-logo-gradient" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="#22d3ee"/>
                  <stop offset="1" stop-color="#a78bfa"/>
                </linearGradient>
                <linearGradient id="dc-welcome-gradient" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="#67e8f9"/>
                  <stop offset="1" stop-color="#c4b5fd"/>
                </linearGradient>
              </defs>
              <path fill="url(#dc-logo-gradient)" fill-rule="evenodd" d="M4.8 3h14.4A3.8 3.8 0 0 1 23 6.8v7.4a3.8 3.8 0 0 1-3.8 3.8h-5.2l-4.5 4.2a.9.9 0 0 1-1.5-.67V18H4.8A3.8 3.8 0 0 1 1 14.2V6.8A3.8 3.8 0 0 1 4.8 3Zm1.9 5.1a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Zm5.3 0a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Zm5.3 0a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z"/>
            </svg>
          </span>
          <h1>DuoChat</h1>
        </div>
        <div class="dc-status-line" aria-live="polite">
          <span class="dc-dot" id="statusDot" aria-hidden="true"></span>
          <span id="statusText">Non configuré</span>
        </div>
      </div>
      <div class="dc-heading-right">
        <div class="dc-presence" id="presence" aria-label="Participants" hidden></div>
        <button class="dc-icon-btn" id="settingsBtn" type="button" title="Configurer DuoChat" aria-label="Configurer DuoChat">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"></path>
          </svg>
        </button>
      </div>
    </header>

    <div class="dc-banner" id="banner" hidden>
      <span class="dc-banner-spinner" id="bannerSpinner" aria-hidden="true"></span>
      <span class="dc-banner-text" id="bannerText"></span>
      <button class="dc-banner-action" id="bannerAction" type="button" hidden>Reconnecter</button>
    </div>

    <div class="dc-main">
      <main class="dc-scroll" id="scroller" tabindex="0" aria-label="Conversation">
        <section class="dc-welcome" id="welcome" hidden>
          <div class="dc-welcome-card">
            <div class="dc-welcome-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="27" height="27">
                <path fill="url(#dc-welcome-gradient)" fill-rule="evenodd" d="M4.8 3h14.4A3.8 3.8 0 0 1 23 6.8v7.4a3.8 3.8 0 0 1-3.8 3.8h-5.2l-4.5 4.2a.9.9 0 0 1-1.5-.67V18H4.8A3.8 3.8 0 0 1 1 14.2V6.8A3.8 3.8 0 0 1 4.8 3Zm1.9 5.1a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Zm5.3 0a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Zm5.3 0a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z"/>
              </svg>
            </div>
            <h2 id="welcomeTitle">Bienvenue</h2>
            <p id="welcomeText">Configurez DuoChat pour discuter avec votre collaborateur sans quitter l'éditeur.</p>
            <button class="dc-primary" id="welcomeAction" type="button">Configurer DuoChat</button>
          </div>
        </section>
        <div class="dc-messages" id="messages" role="log" aria-live="polite" aria-relevant="additions" aria-label="Messages"></div>
      </main>
      <button class="dc-jump" id="jumpBtn" type="button" hidden>↓ Nouveaux messages</button>
    </div>

    <div class="dc-typing" id="typing" hidden aria-live="polite">
      <span class="dc-typing-dots" aria-hidden="true"><span></span><span></span><span></span></span>
      <span id="typingText"></span>
    </div>

    <footer class="dc-composer" id="composer">
      <div class="dc-emoji-pop" id="emojiPop" hidden role="dialog" aria-label="Emojis">
        <div class="dc-emoji-grid" id="emojiGrid"></div>
      </div>
      <div class="dc-input-shell">
        <button class="dc-tool" id="emojiBtn" type="button" title="Choisir un emoji" aria-label="Choisir un emoji" aria-haspopup="dialog" aria-expanded="false">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9"></circle>
            <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"></path>
            <line x1="9" y1="9.5" x2="9.01" y2="9.5"></line>
            <line x1="15" y1="9.5" x2="15.01" y2="9.5"></line>
          </svg>
        </button>
        <textarea id="input" rows="1" maxlength="4000" placeholder="Écrire un message…" aria-label="Votre message"></textarea>
        <button class="dc-tool" id="shareBtn" type="button" title="Partager le fichier et la ligne courants" aria-label="Partager le fichier et la ligne courants">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="16 18 22 12 16 6"></polyline>
            <polyline points="8 6 2 12 8 18"></polyline>
          </svg>
        </button>
        <button class="dc-send" id="sendBtn" type="button" title="Envoyer (Entrée)" aria-label="Envoyer le message" disabled>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M22 2 11 13"></path>
            <path d="M22 2 15 22l-4-9-9-4Z"></path>
          </svg>
        </button>
      </div>
      <div class="dc-input-meta">
        <span id="composerHint">Entrée pour envoyer · Maj+Entrée pour aller à la ligne</span>
        <span class="dc-counter" id="counter" hidden></span>
      </div>
    </footer>

    <div class="dc-toast" id="toast" role="status" hidden></div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
