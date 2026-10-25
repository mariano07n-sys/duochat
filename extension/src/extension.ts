import * as vscode from "vscode";
import { ChatProvider } from "./provider";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const provider = new ChatProvider(context);

  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(ChatProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("duochat.open", () => provider.focusView()),
    vscode.commands.registerCommand("duochat.configure", () => provider.configure()),
    vscode.commands.registerCommand("duochat.connect", () => provider.connect()),
    vscode.commands.registerCommand("duochat.disconnect", () => provider.disconnect()),
    vscode.commands.registerCommand("duochat.shareLocation", () => provider.shareLocation()),
    vscode.commands.registerCommand("duochat.copyInvite", () => provider.copyInvite()),
  );

  await provider.initialize();
}

export function deactivate(): void {
  // les ressources sont liberees via context.subscriptions
}
