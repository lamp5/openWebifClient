// Uruchom: node server.js   ->  http://localhost:8080
// Serwuje index.html + playlistę i przekazuje strumienie z dekodera (omija CORS).
// Dla ?program=N wycina z multipleksu MPEG-TS tylko wybrany program (to samo co VLC robi z #EXTVLCOPT:program=).
const http = require('http'), fs = require('fs'), path = require('path'), net = require('net');
const { spawn, spawnSync } = require('child_process');
const { Transform } = require('stream');
// ---- konfiguracja: config.json obok server.js (opcjonalny); flagi i zmienne środowiskowe mają pierwszeństwo ----
const DEFAULTS = { decoder: null, webPort: 80, streamPort: 8001, port: 8080, source: 'auto', bouquet: null,
  playlist: 'playlist.m3u8', openBrowser: true, transcode: false, ffmpeg: null, videoPreset: 'veryfast', audioBitrate: '128k' };
let cfg = { ...DEFAULTS };
try { cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')) }; }
catch (e) { if (e.code !== 'ENOENT') { console.error('config.json: ' + e.message); process.exit(1); } }
const PORT = +process.env.PORT || cfg.port;
const FILES = { '/': 'index.html', '/index.html': 'index.html', '/style.css': 'style.css' };
const MIME = { '.html': 'text/html; charset=utf-8', '.m3u8': 'text/plain; charset=utf-8', '.css': 'text/css; charset=utf-8' };
// ffmpeg (opcjonalnie): wycina program, kopiuje wideo i zamienia audio na AAC (rozwiązuje MP2/AC3).
// Wyłączenie: NO_FFMPEG=1 node server.js   |   własna ścieżka: FFMPEG=/ścieżka/do/ffmpeg
const FFMPEG = process.env.NO_FFMPEG ? null : (process.env.FFMPEG || cfg.ffmpeg || 'ffmpeg');
const HAS_FFMPEG = !!FFMPEG && (() => { try { return spawnSync(FFMPEG, ['-version']).status === 0; } catch { return false; } })();
// --transcode: wideo też przez ffmpeg (deinterlace + ponowne kodowanie do H.264). Wymaga ffmpeg, zużywa CPU,
// ale omija błędy dekodowania w przeglądarce (sprzętowy dekoder, przeplot 1080i, dziwne GOP-y).
const CLI_T = process.argv.includes('--no-transcode') ? false : ((process.argv.includes('--transcode') || process.env.TRANSCODE) ? true : null);
const TRANSCODE = () => CLI_T !== null ? CLI_T : cfg.transcode === true;   // flaga CLI wygrywa z config.json
const isPrivate = h => net.isIPv4(h) && (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h));

function crc32mpeg(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) { c ^= b << 24; for (let i = 0; i < 8; i++) c = (c & 0x80000000) ? ((c << 1) ^ 0x04C11DB7) : (c << 1); c >>>= 0; }
  return c >>> 0;
}
// zwraca sekcję PSI zaczynającą się w pakiecie (jeśli mieści się w jednym pakiecie)
function sectionOf(p) {
  if (!(p[1] & 0x40)) return null;
  const afc = (p[3] >> 4) & 3; if (!(afc & 1)) return null;
  let off = 4; if (afc & 2) off += 1 + p[4];
  const start = off + 1 + p[off];
  if (start + 3 > 188) return null;
  const len = ((p[start + 1] & 0xf) << 8) | p[start + 2];
  if (start + 3 + len > 188) return null;
  return p.subarray(start, start + 3 + len);
}

function createFilter(program) {
  let rest = Buffer.alloc(0), pmtPid = -1, keep = new Set(), cc = 0, pcc = 0, passAll = false, logged = false;
  return new Transform({
    transform(chunk, _e, cb) {
      const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const out = []; let i = 0;
      while (i + 188 <= buf.length) {
        if (buf[i] !== 0x47) { i++; continue; }
        const p = buf.subarray(i, i + 188); i += 188;
        if (passAll) { out.push(p); continue; }
        const pid = ((p[1] & 0x1f) << 8) | p[2];
        if (pid === 0) {                                   // PAT -> przepisz na jeden program
          if (!(p[1] & 0x40)) continue;
          const s = sectionOf(p);
          if (!s) { passAll = true; out.push(p); continue; }
          let found = -1;
          for (let o = 8; o + 4 <= s.length - 4; o += 4) {
            const prog = (s[o] << 8) | s[o + 1], pp = ((s[o + 2] & 0x1f) << 8) | s[o + 3];
            if (prog === program && prog !== 0) found = pp;
          }
          if (found < 0) { console.log('program', program, 'nie istnieje w PAT – przekazuję całość'); passAll = true; out.push(p); continue; }
          pmtPid = found;
          const sec = Buffer.alloc(16);
          sec[1] = 0xB0; sec[2] = 13; s.copy(sec, 3, 3, 8);
          sec[8] = program >> 8; sec[9] = program & 255; sec[10] = 0xE0 | (pmtPid >> 8); sec[11] = pmtPid & 255;
          sec.writeUInt32BE(crc32mpeg(sec.subarray(0, 12)), 12);
          const pkt = Buffer.alloc(188, 0xFF);
          pkt[0] = 0x47; pkt[1] = 0x40; pkt[2] = 0; pkt[3] = 0x10 | (cc++ & 15); pkt[4] = 0; sec.copy(pkt, 5);
          out.push(pkt);
        } else if (pid === pmtPid) {                       // PMT -> zostaw wideo + jedno audio AAC
          if (!(p[1] & 0x40)) continue;
          const s = sectionOf(p);
          if (!s || s[0] !== 2) continue;
          const pcr = ((s[8] & 0x1f) << 8) | s[9], list = [];
          let o = 12 + (((s[10] & 0xf) << 8) | s[11]);
          while (o + 5 <= s.length - 4) { list.push({ type: s[o], pid: ((s[o + 1] & 0x1f) << 8) | s[o + 2] }); o += 5 + (((s[o + 3] & 0xf) << 8) | s[o + 4]); }
          const vid = list.filter(e => [0x1b, 0x24, 0x02, 0x10].includes(e.type)).slice(0, 1);
          const aud = list.filter(e => e.type === 0x0f || e.type === 0x11).slice(0, 1);
          if (!logged) {
            logged = true;
            console.log('program', program, '– strumienie:', list.map(e => '0x' + e.type.toString(16) + '@' + e.pid).join(' '));
            if (!vid.length) console.log('  ! brak wideo H.264/MPEG-2/HEVC w tym programie');
            if (!aud.length) console.log('  ! brak audio AAC (MP2/AC3?) – obraz bez dźwięku; zainstaluj ffmpeg, żeby je przekodować');
          }
          const sel = [...vid, ...aud];
          if (!sel.length) { passAll = true; continue; }
          keep = new Set([pcr, ...sel.map(e => e.pid)]);
          const n = sel.length, len = 9 + 5 * n + 4, sec = Buffer.alloc(3 + len);
          sec[0] = 2; sec[1] = 0xB0 | (len >> 8); sec[2] = len & 255; s.copy(sec, 3, 3, 8);
          sec[8] = 0xE0 | (pcr >> 8); sec[9] = pcr & 255; sec[10] = 0xF0; sec[11] = 0;
          sel.forEach((e, k) => { const b = 12 + 5 * k; sec[b] = e.type; sec[b + 1] = 0xE0 | (e.pid >> 8); sec[b + 2] = e.pid & 255; sec[b + 3] = 0xF0; sec[b + 4] = 0; });
          sec.writeUInt32BE(crc32mpeg(sec.subarray(0, sec.length - 4)), sec.length - 4);
          const pkt = Buffer.alloc(188, 0xFF);
          pkt[0] = 0x47; pkt[1] = 0x40 | (pmtPid >> 8); pkt[2] = pmtPid & 255; pkt[3] = 0x10 | (pcc++ & 15); pkt[4] = 0; sec.copy(pkt, 5);
          out.push(pkt);
        } else if (keep.has(pid)) out.push(p);
      }
      rest = buf.subarray(i);
      cb(null, out.length ? Buffer.concat(out) : undefined);
    }
  });
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
}

// ---- ustawienia z poziomu aplikacji (zapis do config.json), tylko z komputera, na którym działa serwer ----
const port = x => Number.isInteger(x) && x > 0 && x < 65536 ? x : undefined;
const bool = x => typeof x === 'boolean' ? x : undefined;
const optStr = (x, n) => x === null || x === '' ? null : (typeof x === 'string' && x.length < n ? x : undefined);
const SCHEMA = {
  decoder: x => x === null || x === '' ? null : (typeof x === 'string' && /^[A-Za-z0-9.-]{1,253}$/.test(x) ? x : undefined),
  webPort: port, streamPort: port, port, openBrowser: bool, transcode: bool,
  source: x => ['auto', 'decoder', 'playlist'].includes(x) ? x : undefined,
  bouquet: x => optStr(x, 100), ffmpeg: x => optStr(x, 260),
  playlist: x => typeof x === 'string' && x && x.length < 260 ? x : undefined,
  videoPreset: x => ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'].includes(x) ? x : undefined,
  audioBitrate: x => typeof x === 'string' && /^\d{2,3}k$/.test(x) ? x : undefined,
};
const RESTART_KEYS = ['port', 'ffmpeg', 'openBrowser'];
const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
function readBody(req, cb) {
  let b = ''; req.on('data', d => { b += d; if (b.length > 10000) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(b || '{}')); } catch { cb(null); } });
}
function sendJSON(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(obj)); }
function saveSettings(req, res) {
  if (!isLocal(req)) return sendJSON(res, 403, { error: 'Ustawienia można zmieniać tylko z komputera, na którym działa serwer.' });
  readBody(req, body => {
    if (!body || typeof body !== 'object') return sendJSON(res, 400, { error: 'Niepoprawne dane.' });
    const upd = {}, bad = [];
    for (const k of Object.keys(body)) { if (!(k in SCHEMA)) continue; const val = SCHEMA[k](body[k]); val === undefined ? bad.push(k) : upd[k] = val; }
    if (bad.length) return sendJSON(res, 400, { error: 'Niepoprawne pola: ' + bad.join(', '), fields: bad });
    const file = path.join(__dirname, 'config.json'); let cur = {};
    try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') return sendJSON(res, 500, { error: 'config.json jest uszkodzony: ' + e.message }); }
    const restart = Object.keys(upd).filter(k => RESTART_KEYS.includes(k) && upd[k] !== cfg[k]);
    try { fs.writeFileSync(file, JSON.stringify({ ...cur, ...upd }, null, 2) + '\n'); } catch (e) { return sendJSON(res, 500, { error: 'Nie można zapisać config.json: ' + e.message }); }
    Object.assign(cfg, upd);
    sendJSON(res, 200, { ok: true, restart });
  });
}
async function testDecoder(req, res, u) {
  if (!isLocal(req)) return sendJSON(res, 403, { ok: false, error: 'tylko z komputera z serwerem' });
  const host = u.searchParams.get('host') || '', p = parseInt(u.searchParams.get('port') || '80', 10);
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host) || !port(p)) return sendJSON(res, 400, { ok: false, error: 'niepoprawny adres lub port' });
  try {
    const j = await getJSON('http://' + host + ':' + p + '/api/about'), i = j.info || {};
    sendJSON(res, 200, { ok: true, model: [i.brand, i.model].filter(Boolean).join(' ') || 'OpenWebif odpowiada' });
  } catch (e) { sendJSON(res, 200, { ok: false, error: e.message }); }
}

function getJSON(url) {
  return new Promise((ok, fail) => {
    const r = http.get(url, { timeout: 8000 }, res => {
      let b = ''; res.setEncoding('utf8'); res.on('data', d => b += d);
      res.on('end', () => { try { ok(JSON.parse(b)); } catch { fail(new Error('niepoprawna odpowiedź JSON z ' + url)); } });
    });
    r.on('timeout', () => r.destroy(new Error('timeout (' + url + ')')));
    r.on('error', fail);
  });
}

// Lista kanałów prosto z dekodera (OpenWebif /api/getallservices): bukiety -> kanały
async function sendChannels(res) {
  const send = (code, obj) => res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(obj));
  if (cfg.source === 'playlist' || !cfg.decoder) return send(503, { error: 'źródło kanałów: playlista', fallback: true });
  try {
    const web = 'http://' + cfg.decoder + ':' + cfg.webPort;
    const j = await getJSON(web + '/api/getallservices');
    const clean = s => String(s || '').replace(/[\u0080-\u009f]/g, '').trim();   // znaczniki DVB w nazwach
    const piconName = n => String(n).normalize('NFKD').replace(/[^\x00-\x7f]/g, '').replace(/&/g, 'and').replace(/\+/g, 'plus').replace(/\*/g, 'star').toLowerCase().replace(/[^a-z0-9]/g, '');   // jak picony "po nazwie" w Enigma2
    // Adresy piconów podaje sam dekoder (uwzględnia własną ścieżkę i nazewnictwo); starsze OpenWebif tego nie ma -> zapas niżej
    const piconOf = new Map();
    await Promise.all((j.services || []).map(async b => {
      try {
        const g = await getJSON(web + '/api/getservices?picon=1&sRef=' + encodeURIComponent(b.servicereference));
        for (const s of g.services || []) if (s.picon && !piconOf.has(s.servicereference)) piconOf.set(s.servicereference, s.picon);
      } catch {}
    }));
    const channels = [], bouquets = [];
    for (const b of j.services || []) {
      const bn = clean(b.servicename); let n = 0;
      for (const s of b.subservices || []) {
        const ref = s.servicereference || '';
        if (!/^1:0:/.test(ref)) continue;                                        // pomija markery i podbukiety
        const program = parseInt(ref.split(':')[3], 16);                         // SID = numer programu w multipleksie
        const name = clean(s.servicename), logos = new Set(), pic = piconOf.get(ref);
        if (pic) logos.add(/^https?:/.test(pic) ? pic : web + (pic[0] === '/' ? '' : '/') + pic);
        logos.add(web + '/picon/' + piconName(name) + '.png');                              // zapas 1: po nazwie
        logos.add(web + '/picon/' + ref.replace(/:/g, '_').replace(/_$/, '') + '.png');      // zapas 2: po referencji
        channels.push({ name, bouquet: bn, program: program > 0 ? program : '',
          url: 'http://' + cfg.decoder + ':' + cfg.streamPort + '/' + ref, logos: [...logos], web });
        n++;
      }
      if (n) bouquets.push(bn);
    }
    if (!channels.length) throw new Error('dekoder nie zwrócił żadnych kanałów');
    console.log('/channels: ' + channels.length + ' kanałów, picony podane przez dekoder: ' + piconOf.size);
    send(200, { source: 'decoder', channels, bouquets, defaultBouquet: cfg.bouquet });
  } catch (e) {
    console.log('/channels:', e.message);
    send(503, { error: e.message, fallback: cfg.source !== 'decoder' });
  }
}

function handler(req, res) {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/proxy') {
    let t;
    try { t = new URL(u.searchParams.get('u')); } catch { res.writeHead(400).end('bad url'); return; }
    if (t.protocol !== 'http:' || !isPrivate(t.hostname)) { res.writeHead(403).end('only private LAN http hosts'); return; }
    const program = parseInt(u.searchParams.get('program') || '', 10);
    if (program > 0 && HAS_FFMPEG) {
      const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-fflags', '+genpts+nobuffer',
        '-analyzeduration', '2000000', '-probesize', '4000000', '-i', t.href,
        '-map', `0:p:${program}:v:0`, '-map', `0:p:${program}:a:0?`,
        ...(TRANSCODE() ? ['-vf', 'yadif=deint=interlaced', '-c:v', 'libx264', '-preset', cfg.videoPreset, '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '50', '-bf', '0'] : ['-c:v', 'copy']), '-c:a', 'aac', '-b:a', cfg.audioBitrate, '-ac', '2', '-af', 'aresample=async=1',
        '-f', 'mpegts', '-mpegts_flags', '+resend_headers', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
      console.log('ffmpeg: program', program);
      ff.stderr.on('data', d => process.stdout.write('[ffmpeg] ' + d));
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
      ff.stdout.pipe(res);
      ff.on('error', e => { console.log('ffmpeg error', e.message); res.end(); });
      ff.on('close', () => res.end());
      res.on('close', () => ff.kill('SIGKILL'));
      return;
    }
    const up = http.get(t, r => {
      res.writeHead(r.statusCode, { 'Content-Type': r.headers['content-type'] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      if (program > 0 && r.statusCode === 200) { const f = createFilter(program); r.pipe(f).pipe(res); res.on('close', () => f.destroy()); }
      else r.pipe(res);
    });
    up.on('error', e => { if (!res.headersSent) res.writeHead(502); res.end('upstream error: ' + e.message); });
    res.on('close', () => up.destroy());
    return;
  }
  if (u.pathname === '/settings' && req.method === 'GET') { sendJSON(res, 200, { canEdit: isLocal(req), cfg, cliTranscode: CLI_T !== null }); return; }
  if (u.pathname === '/settings' && req.method === 'POST') { saveSettings(req, res); return; }
  if (u.pathname === '/settings/test') { testDecoder(req, res, u); return; }
  if (u.pathname === '/channels') { sendChannels(res); return; }
  if (u.pathname === '/playlist') {
    fs.readFile(path.resolve(__dirname, cfg.playlist), (e, d) => {
      if (e) { res.writeHead(404).end('brak pliku playlisty: ' + cfg.playlist); return; }
      res.writeHead(200, { 'Content-Type': MIME['.m3u8'], 'Cache-Control': 'no-store' }).end(d);
    });
    return;
  }
  const f = FILES[u.pathname];
  if (!f) { res.writeHead(404).end('not found'); return; }
  fs.readFile(path.join(__dirname, f), (e, d) => {
    if (e) { res.writeHead(404).end('missing ' + f); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)], 'Cache-Control': 'no-store' }).end(d);
  });
}

if (require.main === module) console.log('Kanały: ' + (cfg.decoder && cfg.source !== 'playlist' ? 'z dekodera ' + cfg.decoder + ' (bukiety)' + (cfg.source === 'auto' ? ', zapas: ' + cfg.playlist : '') : 'z pliku ' + cfg.playlist));
if (require.main === module) {
  const url = 'http://localhost:' + PORT;
  const openIt = () => { if (cfg.openBrowser !== false && !process.argv.includes('--no-open')) openBrowser(url); };
  const srv = http.createServer(handler);
  srv.on('error', e => {
    if (e.code !== 'EADDRINUSE') { console.error('Serwer: ' + e.message); process.exit(1); }
    console.log('Port ' + PORT + ' jest zajęty - prawdopodobnie aplikacja już działa. Otwieram ją w przeglądarce.');
    openIt(); setTimeout(() => process.exit(0), 500);
  });
  srv.listen(PORT, () => { console.log('TV: http://localhost:' + PORT + (HAS_FFMPEG ? '  (ffmpeg: audio -> AAC' + (TRANSCODE() ? ', wideo -> przekodowane)' : ', wideo bez zmian)') : '  (bez ffmpeg: tylko kanały z audio AAC będą miały dźwięk)')); openIt(); });
}
module.exports = { createFilter };
