import fs from "fs";
import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcode from "qrcode-terminal";

const ATLAS_URL = process.env.ATLAS_WHATSAPP_URL || "http://127.0.0.1:8000/whatsapp-inbound";
const SHARED_SECRET = process.env.ATLAS_WHATSAPP_SECRET || "";
const SESSION_DIR = process.env.ATLAS_WHATSAPP_SESSION_DIR || "./session";
const BLACKLIST_PATH = process.env.ATLAS_WHATSAPP_BLACKLIST_PATH || "./blacklist.csv";
const BLACKLIST_MIN_MATCH_LEN = 7; // igual que en app/tools/whatsapp_blacklist.py
// Cuanto esperar antes de mandar la auto-respuesta, para darle tiempo a
// Santiago de contestar el mismo primero. Si Santiago escribe en esa
// ventana, se cancela el auto-reply pendiente para ese contacto.
const REPLY_DELAY_MS = Number(process.env.ATLAS_SECRETARY_REPLY_DELAY_MS || 150000); // 2.5 min
const REPLY_PREFIX = "🤖 *AtlasAssistant*\n";
// Si Santiago le escribio a este contacto hace menos de esto, se asume que
// esta activo en la conversacion y el bot NO auto-responde, sin importar
// REPLY_DELAY_MS (con delay 0 no hay ventana real para "cancelar", esto es
// independiente de eso).
const ACTIVE_WINDOW_MS = Number(process.env.ATLAS_SECRETARY_ACTIVE_WINDOW_MS || 600000); // 10 min

// jid -> { timer, reply }. Un solo pendiente por contacto: si llegan varios
// mensajes seguidos, se reinicia el timer y solo se manda la respuesta al
// ultimo pedido (evita responder mensaje por mensaje en rafaga).
const pending = new Map();
// jid -> timestamp (ms) del ultimo mensaje que Santiago mando el mismo.
const lastFromMeAt = new Map();

if (!SHARED_SECRET) {
  console.error("ATLAS_WHATSAPP_SECRET no esta configurado. Abortando.");
  process.exit(1);
}

const logger = pino({ level: "warn" });

async function forwardToAtlas(payload) {
  try {
    const res = await fetch(ATLAS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Atlas-Secret": SHARED_SECRET,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      console.error(`Atlas respondio ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error("fallo reenviando a Atlas:", err.message);
    return null;
  }
}

function digitsOnly(raw) {
  return (raw || "").replace(/\D/g, "");
}

function numbersMatch(a, b) {
  const da = digitsOnly(a);
  const db = digitsOnly(b);
  if (!da || !db) return false;
  const [shorter, longer] = da.length <= db.length ? [da, db] : [db, da];
  if (shorter.length < BLACKLIST_MIN_MATCH_LEN) return false;
  return longer.endsWith(shorter);
}

function isBlacklisted(jid) {
  let content;
  try {
    content = fs.readFileSync(BLACKLIST_PATH, "utf8");
  } catch {
    return false; // no existe el archivo todavia = lista vacia
  }
  const number = jid.split("@")[0];
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => numbersMatch(number, line));
}

function classifyMessage(message) {
  if (!message) return null;
  if (message.conversation) return { kind: "text", text: message.conversation };
  if (message.extendedTextMessage?.text) return { kind: "text", text: message.extendedTextMessage.text };
  if (message.imageMessage) return { kind: "image", text: message.imageMessage.caption || null };
  if (message.videoMessage) return { kind: "video", text: message.videoMessage.caption || null };
  if (message.audioMessage) return { kind: "audio", text: null };
  return null;
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("Escanea este QR con WhatsApp (Dispositivos vinculados > Vincular dispositivo):");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log("Conexion cerrada.", loggedOut ? "Sesion cerrada, hay que re-vincular." : "Reintentando en 3s...");
      if (!loggedOut) {
        setTimeout(() => {
          start().catch((err) => console.error("fallo al reconectar:", err.message));
        }, 3000);
      }
    } else if (connection === "open") {
      console.log("atlas-whatsapp conectado.");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") continue; // ignorar grupos y estados

      if (msg.key.fromMe) {
        // Santiago respondio el mismo desde su telefono: cancelar cualquier
        // auto-respuesta pendiente para este contacto y recordar que esta
        // activo aca, para no auto-responder tampoco a sus proximos mensajes.
        lastFromMeAt.set(jid, Date.now());
        const p = pending.get(jid);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(jid);
          console.log(`Santiago respondio ${jid} manualmente, cancelo auto-respuesta pendiente.`);
        }
        continue;
      }

      if (isBlacklisted(jid)) {
        continue; // numero en lista negra: se ignora por completo, ni se registra ni se avisa
      }

      const classified = classifyMessage(msg.message);
      if (!classified) continue;

      const lastActive = lastFromMeAt.get(jid);
      if (lastActive && Date.now() - lastActive < ACTIVE_WINDOW_MS) {
        console.log(`Santiago esta activo con ${jid} (respondio hace ${Math.round((Date.now() - lastActive) / 1000)}s), no auto-respondo.`);
        continue;
      }

      const sender = msg.pushName || jid;
      let atlasPayload;

      if (classified.kind === "text") {
        console.log(`Mensaje de ${sender} (${jid}): ${classified.text}`);
        atlasPayload = { type: "message", jid, sender_name: sender, text: classified.text };
      } else if (classified.kind === "audio") {
        console.log(`Audio de ${sender} (${jid})`);
        let audioB64;
        try {
          const buffer = await downloadMediaMessage(msg, "buffer", {});
          audioB64 = buffer.toString("base64");
        } catch (err) {
          console.error("fallo descargando audio:", err.message);
          continue;
        }
        atlasPayload = { type: "audio", jid, sender_name: sender, audio_b64: audioB64 };
      } else {
        // imagen o video: no se descarga el archivo (para no gastar tokens
        // analizandolo), solo se avisa que llego + el caption si tiene.
        console.log(`${classified.kind} de ${sender} (${jid})${classified.text ? `: ${classified.text}` : ""}`);
        atlasPayload = { type: "media", media_kind: classified.kind, jid, sender_name: sender, caption: classified.text };
      }

      const result = await forwardToAtlas(atlasPayload);

      if (!result?.reply) continue;

      // Si ya habia una auto-respuesta pendiente para este contacto, se
      // reemplaza (reinicia el reloj) en vez de acumular una por mensaje.
      const existing = pending.get(jid);
      if (existing) clearTimeout(existing.timer);

      const timer = setTimeout(async () => {
        pending.delete(jid);
        try {
          await sock.sendMessage(jid, { text: REPLY_PREFIX + result.reply });
        } catch (err) {
          console.error("fallo enviando auto-respuesta:", err.message);
        }
      }, REPLY_DELAY_MS);

      pending.set(jid, { timer, reply: result.reply });
    }
  });

  sock.ev.on("call", async (calls) => {
    for (const call of calls) {
      if (call.status !== "offer") continue;
      const jid = call.from;
      console.log(`Llamada entrante de ${jid}`);
      await forwardToAtlas({ type: "call", jid, sender_name: jid });
    }
  });
}

process.on("unhandledRejection", (err) => {
  console.error("unhandled rejection (ignorado, sigue corriendo):", err?.message || err);
});

start().catch((err) => console.error("fallo al iniciar:", err.message));
