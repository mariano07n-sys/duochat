import os from "node:os";
import { fileURLToPath } from "node:url";
import { createChatServer } from "./server.js";

const port = Number.parseInt(process.env.PORT ?? "8787", 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`[duochat] PORT invalide: ${process.env.PORT}`);
  process.exit(1);
}

const host = process.env.HOST || "0.0.0.0";
const defaultDataDir = fileURLToPath(new URL("../data", import.meta.url));
const dataDir = process.env.DATA_DIR === "" ? null : process.env.DATA_DIR || defaultDataDir;

const chat = createChatServer({ port, host, dataDir });
const address = await chat.listen();

const urls = new Set([`ws://localhost:${address.port}`]);
if (host === "0.0.0.0" || host === "::") {
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const entry of interfaces ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        urls.add(`ws://${entry.address}:${address.port}`);
      }
    }
  }
}

console.log(`[duochat] relais demarre sur le port ${address.port}`);
for (const url of urls) console.log(`[duochat]   ${url}`);
console.log(`[duochat] historique: ${dataDir ?? "desactive"}`);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[duochat] arret (${signal})...`);
  try {
    await chat.close();
  } catch (error) {
    console.error("[duochat] erreur a l'arret:", error);
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
