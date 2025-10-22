// index.js
import 'dotenv/config';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadContentFromMessage
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import fs from 'node:fs/promises';
import path from 'node:path';
import ffmpeg from 'fluent-ffmpeg';

let ffmpegPath = null;
try {
  const mod = await import('ffmpeg-static');
  ffmpegPath = mod?.default || null;
} catch {}
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

// ───────────────────────── Config ─────────────────────────
const CMD_PREFIX = process.env.CMD_PREFIX || '!';
const AUTH_DIR = process.env.AUTH_DIR || './auth';
const BOT_NAME = process.env.BOT_NAME || 'YuraBot';

// Invisible separator (mention notify tanpa tampilan @)
const INV = '\u2063'; // U+2063

// ─────────────────────── Util: ambil teks ───────────────────────
function getTextFromMessage(msg) {
  const m = msg.message || {};
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  if (m.documentMessage?.caption) return m.documentMessage.caption;
  return '';
}

// ───────── media → buffer + info (deteksi GIF playback) ─────────
async function messageToBuffer(sock, msg) {
  const m = msg.message || {};
  const quoted = m?.extendedTextMessage?.contextInfo?.quotedMessage;
  let mediaNode = null;

  if (quoted?.imageMessage) mediaNode = { type: 'imageMessage', node: quoted.imageMessage };
  else if (quoted?.videoMessage) mediaNode = { type: 'videoMessage', node: quoted.videoMessage };
  else if (quoted?.documentMessage && /image|video/.test(quoted.documentMessage.mimetype))
    mediaNode = { type: 'documentMessage', node: quoted.documentMessage };

  if (!mediaNode) {
    if (m.imageMessage) mediaNode = { type: 'imageMessage', node: m.imageMessage };
    else if (m.videoMessage) mediaNode = { type: 'videoMessage', node: m.videoMessage };
    else if (m.documentMessage && /image|video/.test(m.documentMessage.mimetype))
      mediaNode = { type: 'documentMessage', node: m.documentMessage };
  }

  if (!mediaNode) return { buffer: null, isVideo: false, isGif: false, mimetype: '' };

  const stream = await downloadContentFromMessage(
    mediaNode.node,
    mediaNode.type.replace('Message', '')
  );
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const buffer = Buffer.concat(chunks);

  const mimetype =
    mediaNode.node?.mimetype ||
    (mediaNode.type === 'imageMessage' ? 'image/jpeg' :
     mediaNode.type === 'videoMessage' ? 'video/mp4' : '');

  // WA sering mengirim GIF sebagai videoMessage dengan flag gifPlayback=true
  const gifPlaybackFlag = Boolean(mediaNode.node?.gifPlayback);
  const isGif = gifPlaybackFlag || /image\/gif/i.test(mimetype || '');
  const isVideo = (mediaNode.type === 'videoMessage' || /video/.test(mimetype || '')) && !isGif;

  return { buffer, isVideo, isGif, mimetype };
}

// WEBP statis (gambar) — square canvas 512x512, AR konten tetap
async function toStaticWebp(inputBuffer) {
  const tmp = path.join(process.cwd(), 'tmp');
  await fs.mkdir(tmp, { recursive: true });
  const inPath = path.join(tmp, `in_${Date.now()}`);
  const outPath = path.join(tmp, `out_${Date.now()}.webp`);
  await fs.writeFile(inPath, inputBuffer);

  // 1) scale sisi terpanjang ke 512 tanpa mengubah AR
  // 2) ubah ke RGBA agar bisa transparan
  // 3) pad ke 512x512, center (tanpa warna, full transparan)
  const vf =
    "scale='if(gt(iw,ih),512,-2)':'if(gt(ih,iw),512,-2)':flags=lanczos:force_original_aspect_ratio=decrease," +
    "format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000";

  await new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .outputOptions([
        '-vcodec', 'libwebp',
        '-vf', vf,
        '-q:v', '60',   // naikkan (70-80) kalau mau lebih kecil
        '-an',
        '-vsync', '0'
      ])
      .output(outPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  const out = await fs.readFile(outPath).finally(async () => {
    await fs.unlink(inPath).catch(()=>{});
    await fs.unlink(outPath).catch(()=>{});
  });
  return out;
}

// WEBP animasi (GIF / video) — square canvas 512x512, AR konten tetap
async function toAnimatedWebp(inputBuffer, { fps = 15, maxSec = 6 } = {}) {
  const tmp = path.join(process.cwd(), 'tmp');
  await fs.mkdir(tmp, { recursive: true });
  const inPath = path.join(tmp, `in_${Date.now()}`);
  const outPath = path.join(tmp, `out_${Date.now()}.webp`);
  await fs.writeFile(inPath, inputBuffer);

  const vf =
    "scale='if(gt(iw,ih),512,-2)':'if(gt(ih,iw),512,-2)':flags=lanczos:force_original_aspect_ratio=decrease," +
    "format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000," +
    `fps=${fps}`;

  await new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .outputOptions([
        '-vcodec', 'libwebp',
        '-filter:v', vf,
        '-loop', '0',
        '-an',
        '-vsync', '0',
        '-q:v', '65',
        '-t', String(maxSec)   // batasi durasi biar ukuran kecil & kompatibel
      ])
      .output(outPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  const out = await fs.readFile(outPath).finally(async () => {
    await fs.unlink(inPath).catch(()=>{});
    await fs.unlink(outPath).catch(()=>{});
  });
  return out;
}


// ─────────────── TagAll admin-only (tanpa baris baru) ───────────────
async function cmdTagAll(sock, msg, textArg) {
  const from = msg.key.remoteJid;
  const sender = msg.key.participant || msg.key.remoteJid;

  if (!from?.endsWith('@g.us')) {
    await sock.sendMessage(from, { text: 'Perintah ini hanya bisa digunakan di grup, kak 💬' }, { quoted: msg });
    return;
  }

  const meta = await sock.groupMetadata(from);
  const adminList = meta.participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin').map(p => p.id);

  const isAdmin = adminList.includes(sender);
  if (!isAdmin) {
    await sock.sendMessage(from, { text: 'Maaf kak, cuma admin yang bisa pakai perintah ini 😅' }, { quoted: msg });
    return;
  }

  const participants = (meta.participants || []).map(p => p.id);
  if (!participants.length) {
    await sock.sendMessage(from, { text: 'Tidak ada anggota ditemukan 😕' }, { quoted: msg });
    return;
  }

  // TANPA baris baru:
  const filler = participants.map(() => INV).join('');
  const teks = (textArg?.trim() || 'Penting nih kak!') + filler;

  await sock.sendMessage(from, {
    text: teks,
    mentions: participants
  }, { quoted: msg });
}

// ─────────────── Sticker command ───────────────
async function cmdSticker(sock, msg) {
  const { buffer, isVideo, isGif } = await messageToBuffer(sock, msg);
  const from = msg.key.remoteJid;

  if (!buffer) {
    await sock.sendMessage(from, { text: 'Reply/kirim gambar atau video/GIF dengan caption !sticker.' }, { quoted: msg });
    return;
  }

  const MAX = 15 * 1024 * 1024;
  if (buffer.length > MAX) {
    await sock.sendMessage(from, { text: 'File terlalu besar. Maksimal ~15MB.' }, { quoted: msg });
    return;
  }

  // GIF/video -> sticker animasi WEBP
  if (isGif || isVideo) {
    const webpAnim = await toAnimatedWebp(buffer, { fps: 15, maxSec: 6 });
    await sock.sendMessage(from, { sticker: webpAnim }, { quoted: msg });
    return;
  }

  // Gambar -> sticker statis WEBP
  const webp = await toStaticWebp(buffer);
  await sock.sendMessage(from, { sticker: webp }, { quoted: msg });
}

// ─────────────── Router Command ───────────────
function parseCommand(txt) {
  if (!txt || !txt.startsWith(CMD_PREFIX)) return null;
  const cut = txt.slice(CMD_PREFIX.length).trim();
  const [cmd] = cut.split(/\s+/);
  const argText = cut.slice(cmd.length).trim();
  return { cmd: cmd.toLowerCase(), argText };
}

// ─────────────── Bootstrap WhatsApp ───────────────
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: state,
    browser: [BOT_NAME, 'Chrome', '1.0'],
    syncFullHistory: false
  });

  sock.ev.on('connection.update', (u) => {
    const { qr, connection, lastDisconnect } = u;
    if (qr) {
      console.clear();
      console.log(`[${BOT_NAME}] Scan QR berikut untuk login:`);
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Koneksi terputus:', lastDisconnect?.error, 'reconnect:', shouldReconnect);
      if (shouldReconnect) start();
    } else if (connection === 'open') {
      console.log(`[${BOT_NAME}] Tersambung ✅`);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (up) => {
    try {
      const msg = up.messages?.[0];
      if (!msg || msg.key.fromMe) return;

      const txt = getTextFromMessage(msg);
      const parsed = parseCommand(txt);
      if (!parsed) return;

      const { cmd, argText } = parsed;
      if (cmd === 'tagall') {
        await cmdTagAll(sock, msg, argText);
        return;
      }
      if (cmd === 'sticker' || cmd === 's' || cmd === 'stiker') {
        await cmdSticker(sock, msg);
        return;
      }

      if (cmd === 'help' || cmd === 'menu') {
        const help = [
          `*${BOT_NAME}*`,
          `Prefix: ${CMD_PREFIX}`,
          '',
          `• ${CMD_PREFIX}tagall [pesan]  → Mention semua (admin only, tanpa baris baru)`,
          `• ${CMD_PREFIX}sticker (reply gambar/video/GIF) →`,
          `   - Gambar → stiker statis WEBP (AR fleksibel)`,
          `   - GIF/Video → stiker animasi WEBP (≤ ~6s, fps 15, AR fleksibel)`,
        ].join('\n');
        await sock.sendMessage(msg.key.remoteJid, { text: help }, { quoted: msg });
      }

    } catch (err) {
      console.error('messages.upsert error:', err);
    }
  });
}

start().catch((e) => console.error('Fatal start error:', e));
