import fs from "fs";
import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcode from "qrcode-terminal";

const ATLAS_URL = process.env.ATLAS_WHATSAPP_URL || "http://127.0.0.1:8000/whatsapp-inbound";
const SHARED_SECRET = process.env.ATLAS_WHATSAPP_SECRET || "";
const SESSION_DIR = process.env.ATLAS_WHATSAPP_SESSION_DIR || "./session";
const BLACKLIST_PATH = process.env.ATLAS_WHATSAPP_BLACKLIST_PATH || "./blacklist.csv";
const CALL_BLACKLIST_PATH = process.env.ATLAS_WHATSAPP_CALL_BLACKLIST_PATH || "./call_blacklist.csv";
const BLACKLIST_MIN_MATCH_LEN = 7; // igual que en app/tools/whatsapp_blacklist.py
const LEARNED_NAMES_PATH = process.env.ATLAS_WHATSAPP_LEARNED_NAMES_PATH || "./learned_names.json";
// Cuantas llamadas sin responder de un contacto se dejan sonar normal antes
// de que el bot empiece a rechazarlas automaticamente.
const CALL_REJECT_THRESHOLD = Number(process.env.ATLAS_CALL_REJECT_THRESHOLD || 2);
// Cuanto esperar antes de mandar la auto-respuesta, para darle tiempo a
// Santiago de contestar el mismo primero. Si Santiago escribe en esa
// ventana, se cancela el auto-reply pendiente para ese contacto.
const REPLY_DELAY_MS = Number(process.env.ATLAS_SECRETARY_REPLY_DELAY_MS || 150000); // 2.5 min
const REPLY_PREFIX = "🤖 *AtlasAssistant*\n";
// Baileys NO puede "contestar" una llamada con audio real (no implementa el
// protocolo de medios de WhatsApp) — lo unico posible es rechazarla y avisar.
// El mensaje/audio de aviso lo genera Atlas (LLM), no es texto fijo aca.
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
// id (lid o numero, sin @...) -> nombre. WhatsApp ahora usa IDs anonimos
// (@lid) para muchos contactos en vez del numero real, y ademas la sync
// completa de contactos de Baileys nunca llega en una sesion ya vinculada
// (confirmado: 0 eventos 'messaging-history.set' en meses de logs). Este
// mapa se llena APRENDIENDO el pushName la primera vez que alguien escribe
// o manda un audio (eso si siempre trae nombre) — asi, cuando esa misma
// persona LLAMA despues (las llamadas no traen pushName), ya la reconocemos.
// Se persiste en disco para sobrevivir reinicios del servicio.
const contactNames = new Map();

function loadLearnedNames() {
  try {
    const raw = fs.readFileSync(LEARNED_NAMES_PATH, "utf8");
    const obj = JSON.parse(raw);
    for (const [id, name] of Object.entries(obj)) contactNames.set(id, name);
    console.log(`Cargados ${Object.keys(obj).length} nombres aprendidos de contactos.`);
  } catch {
    // no existe todavia, arranca vacio
  }
}

function learnContactName(jid, name) {
  if (!name) return;
  const idPart = jid.split("@")[0].split(":")[0];
  if (contactNames.get(idPart) === name) return; // sin cambios, no reescribir
  contactNames.set(idPart, name);
  try {
    fs.writeFileSync(LEARNED_NAMES_PATH, JSON.stringify(Object.fromEntries(contactNames), null, 2));
  } catch (err) {
    console.error("fallo guardando nombres aprendidos:", err.message);
  }
}

loadLearnedNames();

// Avisos de llamada rechazada: texto/audio FIJO (pre-generado una sola vez
// con `python -c "from app.tts import synthesize_speech..."`, ver
// call_reject_audio/). Una llamada rechazada no tiene contenido real para
// que un LLM le responda de forma distinta cada vez, asi que no vale la
// pena el costo/latencia de generarlo dinamicamente — variedad minima via
// varias variantes fijas elegidas al azar, sin gastar nada por llamada.
const CALL_REJECT_TEXTS = [
  "Santiago no puede atender llamadas en este momento. Si es algo importante, escribime por acá y le aviso enseguida.",
  "Ahora mismo Santiago no puede contestar el teléfono. Contame qué necesitás y se lo hago llegar.",
  "Santiago está ocupado y no puede atender llamadas ahora. Si querés, escribime y le paso el mensaje.",
  "En este momento no puedo pasarte con Santiago por teléfono. Escribime acá y le aviso que necesitás hablar con él.",
];
const CALL_REJECT_AUDIO_DIR = process.env.ATLAS_CALL_REJECT_AUDIO_DIR || "./call_reject_audio";
const callRejectVariants = CALL_REJECT_TEXTS.map((text, i) => {
  const path = `${CALL_REJECT_AUDIO_DIR}/variant_${i + 1}.ogg`;
  let audio = null;
  try {
    audio = fs.readFileSync(path);
  } catch {
    console.error(`no se encontro ${path}, esa variante caera a texto plano.`);
  }
  return { text, audio };
});

function pickCallRejectVariant() {
  return callRejectVariants[Math.floor(Math.random() * callRejectVariants.length)];
}

// jid -> cantidad de llamadas sin responder consecutivas. Se resetea por
// completo (para todos los contactos) apenas Santiago tiene actividad.
const missedCallCount = new Map();
// IDs de mensajes que mando el propio bot: como Baileys esta vinculado a la
// cuenta real de Santiago, todo lo que el bot envia llega de vuelta como un
// evento fromMe=true identico a si Santiago lo hubiera escrito el mismo. Sin
// esto, cada auto-respuesta se auto-detectaba como "actividad de Santiago" y
// reseteaba el rechazo automatico de llamadas apenas se activaba.
const ownSentMessageIds = new Set();

function markOwnMessage(sent) {
  const id = sent?.key?.id;
  if (!id) return;
  ownSentMessageIds.add(id);
  setTimeout(() => ownSentMessageIds.delete(id), 60000);
}

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

function rememberContact(c) {
  if (!c) return;
  const name = c.name || c.notify || null;
  if (!name) return;
  const lidId = c.lid ? String(c.lid).split("@")[0].split(":")[0] : null;
  const jidId = (c.jid || c.id) ? String(c.jid || c.id).split("@")[0].split(":")[0] : null;
  if (lidId) contactNames.set(lidId, name);
  if (jidId) contactNames.set(jidId, name);
}

function displayNameFor(jid, fallback) {
  const key = jid.split("@")[0].split(":")[0];
  return contactNames.get(key) || fallback || jid;
}

// WhatsApp ahora usa @lid (id anonimo) para muchos contactos en vez del
// numero real en el jid, asi que comparar por numero solo no alcanza:
// resolvemos activamente los numeros de cada blacklist a su LID actual.
// makeBlacklist() crea una lista independiente (con su propio cache) para
// un archivo CSV dado, asi mensajes y llamadas quedan totalmente separados.
function makeBlacklist(path) {
  let lidSet = new Set();
  let rawContent = null;

  async function refreshLids(sock) {
    let content;
    try {
      content = fs.readFileSync(path, "utf8");
    } catch {
      lidSet = new Set();
      rawContent = null;
      return;
    }
    if (content === rawContent) return; // sin cambios, no re-resolver
    rawContent = content;

    const numbers = content.split("\n").map((l) => l.trim()).filter(Boolean);
    const resolved = new Set();
    for (const num of numbers) {
      const digits = digitsOnly(num);
      if (digits.length < BLACKLIST_MIN_MATCH_LEN) continue;
      try {
        const results = await sock.onWhatsApp(digits);
        for (const r of results || []) {
          if (r?.lid) resolved.add(String(r.lid).split("@")[0].split(":")[0]);
        }
      } catch (err) {
        console.error(`no se pudo resolver LID para ${num} (${path}):`, err.message);
      }
    }
    lidSet = resolved;
  }

  async function isBlocked(sock, jid) {
    await refreshLids(sock);

    const idPart = jid.split("@")[0].split(":")[0];
    if (jid.endsWith("@lid")) {
      return lidSet.has(idPart);
    }

    let content;
    try {
      content = fs.readFileSync(path, "utf8");
    } catch {
      return false; // no existe el archivo todavia = lista vacia
    }
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .some((line) => numbersMatch(idPart, line));
  }

  return { isBlocked };
}

const messageBlacklist = makeBlacklist(BLACKLIST_PATH);
const callBlacklist = makeBlacklist(CALL_BLACKLIST_PATH);

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
    syncFullHistory: true,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("contacts.upsert", (contacts) => contacts.forEach(rememberContact));
  sock.ev.on("contacts.update", (contacts) => contacts.forEach(rememberContact));
  sock.ev.on("messaging-history.set", ({ contacts }) => {
    console.log(`messaging-history.set: ${(contacts || []).length} contactos recibidos.`);
    (contacts || []).forEach(rememberContact);
  });

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
      if (!jid || jid.endsWith("@g.us") || jid.endsWith("@newsletter") || jid === "status@broadcast") continue; // ignorar grupos, canales/newsletters y estados

      if (msg.key.fromMe) {
        if (ownSentMessageIds.has(msg.key.id)) {
          continue; // eco de un mensaje que mando el propio bot, no es actividad real
        }
        // Santiago respondio el mismo desde su telefono: cancelar cualquier
        // auto-respuesta pendiente para este contacto, recordar que esta
        // activo aca, y contar como actividad global (resetea el rechazo
        // automatico de llamadas para todos los contactos).
        lastFromMeAt.set(jid, Date.now());
        if (missedCallCount.size > 0) {
          missedCallCount.clear();
          console.log("Actividad de Santiago detectada, reseteo el contador de llamadas sin responder.");
        }
        const p = pending.get(jid);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(jid);
          console.log(`Santiago respondio ${jid} manualmente, cancelo auto-respuesta pendiente.`);
        }
        continue;
      }

      if (await messageBlacklist.isBlocked(sock, jid)) {
        continue; // numero en lista negra de mensajes: se ignora por completo, ni se registra ni se avisa
      }

      const classified = classifyMessage(msg.message);
      if (!classified) continue;

      const lastActive = lastFromMeAt.get(jid);
      if (lastActive && Date.now() - lastActive < ACTIVE_WINDOW_MS) {
        console.log(`Santiago esta activo con ${jid} (respondio hace ${Math.round((Date.now() - lastActive) / 1000)}s), no auto-respondo.`);
        continue;
      }

      learnContactName(jid, msg.pushName);
      const sender = displayNameFor(jid, msg.pushName);
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
          if (result.audio_b64) {
            // Aviso corto de que es el asistente, seguido de la nota de voz
            // real (WhatsApp no permite "caption" en notas de voz).
            markOwnMessage(await sock.sendMessage(jid, { text: REPLY_PREFIX.trim() }));
            markOwnMessage(await sock.sendMessage(jid, {
              audio: Buffer.from(result.audio_b64, "base64"),
              mimetype: "audio/ogg; codecs=opus",
              ptt: true,
            }));
          } else {
            markOwnMessage(await sock.sendMessage(jid, { text: REPLY_PREFIX + result.reply }));
          }
        } catch (err) {
          console.error("fallo enviando auto-respuesta:", err.message);
        }
      }, REPLY_DELAY_MS);

      pending.set(jid, { timer, reply: result.reply });
    }
  });

  sock.ev.on("call", async (calls) => {
    for (const call of calls) {
      const jid = call.from;

      if (call.status === "accept") {
        // Santiago (o algun otro de sus dispositivos) contesto de verdad:
        // eso es actividad real, resetea el rechazo automatico para todos.
        if (missedCallCount.size > 0) {
          missedCallCount.clear();
          console.log("Llamada contestada manualmente, reseteo el contador de llamadas sin responder.");
        }
        continue;
      }

      if (call.status === "offer" || call.status === "ringing") {
        if (call.status === "ringing") continue; // solo informativo
      } else {
        // Cualquier otro estado final (reject, terminate, timeout, o el que
        // sea que use WhatsApp cuando cuelgan rapido) significa que la
        // llamada termino sin ser contestada: cuenta como intento perdido.
        // No listamos los strings exactos a proposito, para no depender de
        // adivinar cual usa WhatsApp en cada caso.
        const misses = (missedCallCount.get(jid) || 0) + 1;
        missedCallCount.set(jid, misses);
        console.log(`Llamada de ${displayNameFor(jid, null) || jid} termino sin responder (${misses}/${CALL_REJECT_THRESHOLD}), status=${call.status}.`);
        continue;
      }

      if (await callBlacklist.isBlocked(sock, jid)) {
        console.log(`Llamada de numero en lista negra de llamadas (${jid}), se rechaza siempre.`);
        try {
          await sock.rejectCall(call.id, call.from);
        } catch (err) {
          console.error("fallo rechazando llamada de lista negra:", err.message);
        }
        continue;
      }

      const misses = missedCallCount.get(jid) || 0;
      const name = displayNameFor(jid, null);

      if (misses < CALL_REJECT_THRESHOLD) {
        // Todavia no supero el umbral: se deja sonar normal, para que
        // Santiago tenga la oportunidad real de contestar el mismo.
        console.log(`Llamada entrante de ${name || jid} (intento ${misses + 1}/${CALL_REJECT_THRESHOLD}, dejo sonar).`);
        continue;
      }

      // Ya fallaron 3+ intentos sin que Santiago tuviera actividad: rechazar
      // automatico y avisar con un texto/audio fijo (ver CALL_REJECT_TEXTS).
      console.log(`Llamada entrante de ${name || jid} (umbral superado, rechazo automatico).`);
      try {
        await sock.rejectCall(call.id, call.from);
      } catch (err) {
        console.error("fallo rechazando llamada:", err.message);
      }

      // Se manda igual a Atlas para que quede registrada, se notifique por
      // Telegram y (cada 5 intentos) por Pushover — pero ya no se usa su
      // respuesta, el aviso al que llama es siempre el texto/audio fijo.
      forwardToAtlas({ type: "call", jid, sender_name: name || jid }).catch(() => {});

      try {
        const variant = pickCallRejectVariant();
        if (variant.audio) {
          markOwnMessage(await sock.sendMessage(jid, { text: REPLY_PREFIX.trim() }));
          markOwnMessage(await sock.sendMessage(jid, {
            audio: variant.audio,
            mimetype: "audio/ogg; codecs=opus",
            ptt: true,
          }));
        } else {
          markOwnMessage(await sock.sendMessage(jid, { text: REPLY_PREFIX + variant.text }));
        }
      } catch (err) {
        console.error("fallo avisando tras la llamada:", err.message);
      }
    }
  });
}

process.on("unhandledRejection", (err) => {
  console.error("unhandled rejection (ignorado, sigue corriendo):", err?.message || err);
});

start().catch((err) => console.error("fallo al iniciar:", err.message));
