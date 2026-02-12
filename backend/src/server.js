const express = require('express');
const fs = require('fs');
const path = require('path');
const { Buffer } = require('buffer');

const app = express();

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || '/data';
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');
const RUNTIME_DIR = path.join(DATA_DIR, 'runtime');
const ACTIVE_PROFILE_FILE = path.join(RUNTIME_DIR, 'active-profile.json');
const STATUS_FILE = path.join(RUNTIME_DIR, 'op25-status.json');
const RELOAD_FILE = path.join(RUNTIME_DIR, 'reload-request.json');
const STREAM_URL = process.env.STREAM_URL || 'http://localhost:8000/stream';
const ICECAST_STATUS_URL = process.env.ICECAST_STATUS_URL || 'http://icecast:8000/status-json.xsl';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const CONTROL_PRIVATE_ONLY = process.env.CONTROL_PRIVATE_ONLY !== '0';
const HOST_HELPER_URL = process.env.HOST_HELPER_URL || '';
const HOST_HELPER_TOKEN = process.env.HOST_HELPER_TOKEN || ADMIN_TOKEN;

const PROFILE_OPTIONS = new Set(['AZDPS', 'MCSO']);

function ensureDirs() {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function isSafeProfileName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(name);
}

function profileFile(profileName) {
  return path.join(PROFILES_DIR, `${profileName}.profile.json`);
}

function talkgroupsFile(profileName) {
  return path.join(PROFILES_DIR, `${profileName}.talkgroups.json`);
}

function filterFile(profileName) {
  return path.join(RUNTIME_DIR, `${profileName}.filter.json`);
}

function listProfiles() {
  const files = fs.readdirSync(PROFILES_DIR).filter((f) => f.endsWith('.profile.json'));
  return files.map((f) => f.replace(/\.profile\.json$/, '')).filter((name) => isSafeProfileName(name));
}

function activeProfile() {
  const state = readJson(ACTIVE_PROFILE_FILE, null);
  if (!state || !isSafeProfileName(state.profile)) {
    return null;
  }
  return state.profile;
}

function clampText(value, max = 128) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().slice(0, max);
}

function parseCsvLine(line, delimiter = ',') {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsv(text) {
  const lines = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }

  const delimiter = lines[0].includes(',') ? ',' : (lines[0].includes('\\t') ? '\\t' : ',');
  const headers = parseCsvLine(lines[0], delimiter);
  const rows = lines.slice(1).map((line) => {
    const cols = parseCsvLine(line, delimiter);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] || '';
    });
    return row;
  });
  return { headers, rows };
}

function parseBool(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(v);
}

function parseMode(value) {
  const m = String(value ?? '').trim().toUpperCase();
  if (['D', 'T', 'DE', 'TE'].includes(m)) {
    return m;
  }
  return 'D';
}

function normalizeFreqToken(token) {
  const v = String(token || '').trim();
  if (!v) {
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return n.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
}

function parseFreqList(value) {
  return String(value || '')
    .split(/[;|\s]+/)
    .map((v) => normalizeFreqToken(v))
    .filter(Boolean);
}

function normalizeSitesCsv(csvText) {
  const parsed = parseCsv(csvText);
  const errors = [];
  const sites = [];

  const required = ['site_name', 'control_freq'];
  for (const key of required) {
    if (!parsed.headers.includes(key)) {
      errors.push(`Missing required CSV header: ${key}`);
    }
  }
  if (errors.length > 0) {
    return { errors, sites: [] };
  }

  parsed.rows.forEach((row, idx) => {
    const rowNo = idx + 2;
    const name = clampText(row.site_name, 128);
    if (!name) {
      errors.push(`Row ${rowNo}: site_name is required`);
      return;
    }

    const controlChannels = parseFreqList(row.control_freq);
    if (controlChannels.length === 0) {
      errors.push(`Row ${rowNo}: control_freq is required and must be numeric`);
      return;
    }

    const alternateChannels = parseFreqList(row.alt_freqs);
    sites.push({
      name,
      nac: clampText(row.nac, 16) || null,
      sysid: clampText(row.sysid, 16) || null,
      wacn: clampText(row.wacn, 16) || null,
      controlChannels,
      alternateChannels,
      bandplan: clampText(row.bandplan, 64) || null
    });
  });

  return { errors, sites };
}

function normalizeTalkgroupsCsv(csvText) {
  const parsed = parseCsv(csvText);
  const errors = [];
  const dedupe = new Map();

  const required = ['tgid', 'label'];
  for (const key of required) {
    if (!parsed.headers.includes(key)) {
      errors.push(`Missing required CSV header: ${key}`);
    }
  }
  if (errors.length > 0) {
    return { errors, entries: [] };
  }

  parsed.rows.forEach((row, idx) => {
    const rowNo = idx + 2;
    const tgid = Number(row.tgid);
    if (!Number.isInteger(tgid) || tgid < 0 || tgid > 65535) {
      errors.push(`Row ${rowNo}: invalid tgid '${row.tgid}'`);
      return;
    }
    const label = clampText(row.label, 128);
    if (!label) {
      errors.push(`Row ${rowNo}: label is required`);
      return;
    }

    const mode = parseMode(row.mode);
    const encrypted = row.encrypted === '' ? mode.endsWith('E') : parseBool(row.encrypted);
    const category = clampText(row.category, 64) || 'uncategorized';
    const favorite = parseBool(row.favorite);
    const enabled = row.enabled === '' ? true : parseBool(row.enabled);

    dedupe.set(tgid, {
      tgid,
      label,
      mode,
      encrypted,
      category,
      favorite,
      filterAction: encrypted ? 'deny' : 'allow',
      enabled
    });
  });

  return {
    errors,
    entries: Array.from(dedupe.values()).sort((a, b) => a.tgid - b.tgid)
  };
}

function normalizeTalkgroupsEntries(entries) {
  const errors = [];
  const out = [];
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i] || {};
    const tgid = Number(e.tgid);
    if (!Number.isInteger(tgid) || tgid < 0 || tgid > 65535) {
      errors.push(`Row ${i + 1}: invalid tgid '${e.tgid}'`);
      continue;
    }
    const mode = parseMode(e.mode);
    const encrypted = typeof e.encrypted === 'boolean' ? e.encrypted : mode.endsWith('E');
    out.push({
      tgid,
      label: clampText(e.label || `TG ${tgid}`),
      mode,
      encrypted,
      category: clampText(e.category || 'uncategorized', 64) || 'uncategorized',
      favorite: !!e.favorite,
      filterAction: encrypted ? 'deny' : 'allow',
      enabled: e.enabled !== false
    });
  }
  return { errors, entries: out.sort((a, b) => a.tgid - b.tgid) };
}

function buildFilterPolicy(entries) {
  const allow = entries.filter((e) => e.enabled && e.filterAction === 'allow').map((e) => e.tgid);
  const deny = entries.filter((e) => e.enabled && e.filterAction === 'deny').map((e) => e.tgid);
  const policy = allow.length > 0 ? 'whitelist' : 'blacklist';
  return {
    policy,
    allow,
    deny,
    effective: policy === 'whitelist' ? allow : deny
  };
}

function persistTalkgroups(profile, entries) {
  const doc = {
    updatedAt: nowIso(),
    filter: buildFilterPolicy(entries),
    entries
  };
  writeJson(talkgroupsFile(profile), doc);
  writeJson(filterFile(profile), {
    generatedAt: nowIso(),
    profile,
    filter: doc.filter
  });
  return doc;
}

function triggerReload(reason, profile = activeProfile()) {
  writeJson(RELOAD_FILE, {
    requestedAt: nowIso(),
    reason,
    profile: profile || null
  });
}

function readProfileSummary(name) {
  const p = readJson(profileFile(name), {});
  return {
    name,
    label: p.label || name,
    description: p.description || '',
    hasTalkgroups: fs.existsSync(talkgroupsFile(name)),
    updatedAt: p.updatedAt || null,
    system: p.system || null
  };
}

function extractClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  let ip = forwarded || req.ip || req.connection?.remoteAddress || '';
  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }
  return ip;
}

function isPrivateIp(ip) {
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
  return false;
}

function extractAuthToken(req) {
  const header = String(req.headers['x-admin-token'] || '').trim();
  if (header) {
    return header;
  }

  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }

  if (auth.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const parts = decoded.split(':');
      return parts[1] || parts[0] || '';
    } catch {
      return '';
    }
  }

  return '';
}

function guardControl(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ ok: false, error: 'ADMIN_TOKEN is not configured; control endpoints disabled' });
  }

  const token = extractAuthToken(req);
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const ip = extractClientIp(req);
  if (CONTROL_PRIVATE_ONLY && !isPrivateIp(ip)) {
    return res.status(403).json({ ok: false, error: `Forbidden from non-private address: ${ip || 'unknown'}` });
  }

  return next();
}

async function callHostHelper(method, endpoint, body) {
  if (!HOST_HELPER_URL) {
    return { ok: false, status: 503, error: 'Host helper not configured' };
  }

  const url = `${HOST_HELPER_URL.replace(/\/$/, '')}${endpoint}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': HOST_HELPER_TOKEN
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const txt = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(txt);
    } catch {
      parsed = { ok: false, stdout: '', stderr: txt, exitCode: res.status };
    }
    return { ok: res.ok, status: res.status, data: parsed };
  } catch (err) {
    return { ok: false, status: 502, error: err.message };
  }
}

function controlFallback(action, command) {
  return {
    ok: false,
    action,
    stdout: '',
    stderr: `Host helper unavailable. Run on host: ${command}`,
    exitCode: 127,
    ts: nowIso()
  };
}

async function checkIcecast() {
  const checkedAt = nowIso();
  try {
    const res = await fetch(ICECAST_STATUS_URL);
    if (!res.ok) {
      return {
        status: 'red',
        message: `Icecast endpoint returned ${res.status}`,
        last_checked: checkedAt,
        details: {}
      };
    }
    const data = await res.json();
    const src = data?.icestats?.source;
    const sources = Array.isArray(src) ? src : src ? [src] : [];
    const stream = sources.find((s) => String(s.listenurl || '').includes('/stream')) || null;
    return {
      status: stream ? 'green' : 'yellow',
      message: stream ? 'Icecast reachable; /stream mount visible' : 'Icecast reachable; /stream mount missing',
      last_checked: checkedAt,
      details: {
        streamMounted: !!stream,
        sourceConnected: !!stream,
        listeners: stream?.listeners || 0
      }
    };
  } catch (err) {
    return {
      status: 'red',
      message: `Icecast check failed: ${err.message}`,
      last_checked: checkedAt,
      details: {}
    };
  }
}

function isRecent(isoString, seconds = 15) {
  if (!isoString) return false;
  const t = Date.parse(isoString);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= seconds * 1000;
}

async function buildHealth() {
  const checkedAt = nowIso();
  const status = readJson(STATUS_FILE, {});
  const icecast = await checkIcecast();
  const helperHealth = await callHostHelper('GET', '/health');

  const helperReady = helperHealth.ok && helperHealth.data?.ok;
  const op25SupervisorMessage = helperReady
    ? helperHealth.data?.details?.op25Supervisor || 'helper connected'
    : 'requires host helper for systemctl checks';

  let alsaStatus = 'yellow';
  let alsaMessage = 'requires host helper to verify Loopback on host';
  if (helperReady) {
    const found = !!helperHealth.data?.details?.alsaLoopback;
    alsaStatus = found ? 'green' : 'red';
    alsaMessage = found ? 'Loopback detected in /proc/asound/cards' : 'Loopback missing. Run: sudo modprobe snd-aloop';
  }

  let sdrStatus = 'yellow';
  let sdrMessage = 'requires host helper for USB/RTL checks';
  if (helperReady) {
    const rtlFound = !!helperHealth.data?.details?.rtlSdrInPath;
    const usbFound = !!helperHealth.data?.details?.rtlUsbPresent;
    if (rtlFound && usbFound) {
      sdrStatus = 'green';
      sdrMessage = 'RTL utility and USB dongle detected';
    } else {
      sdrStatus = 'yellow';
      sdrMessage = 'Install rtl-sdr, add udev rules, and confirm dongle is connected';
    }
  }

  const locked = !!status.locked;

  return {
    activeProfile: activeProfile(),
    checks: {
      backend: {
        status: 'green',
        message: 'Backend API reachable',
        last_checked: checkedAt
      },
      hostHelper: {
        status: helperReady ? 'green' : 'yellow',
        message: helperReady ? 'Host helper reachable' : (helperHealth.error || helperHealth.data?.error || 'Host helper not configured/reachable'),
        last_checked: checkedAt
      },
      icecast,
      streamer: {
        status: icecast.details?.sourceConnected ? 'green' : 'yellow',
        message: icecast.details?.sourceConnected ? 'Streamer source connected' : 'Streamer source not connected to /stream',
        last_checked: checkedAt
      },
      op25Supervisor: {
        status: helperReady ? (helperHealth.data?.details?.op25SupervisorActive ? 'green' : 'yellow') : 'yellow',
        message: op25SupervisorMessage,
        last_checked: checkedAt
      },
      op25Process: {
        status: status.running ? (locked ? 'green' : 'yellow') : 'red',
        message: status.running ? (locked ? 'OP25 running and locked' : 'OP25 running but not locked') : 'OP25 not running',
        last_checked: checkedAt,
        details: {
          locked,
          last_status_update: status.lastUpdated || null,
          last_decode_time: status.lastDecodeTime || null,
          fresh: isRecent(status.lastUpdated, 20)
        }
      },
      alsaLoopback: {
        status: alsaStatus,
        message: alsaMessage,
        last_checked: checkedAt
      },
      sdr: {
        status: sdrStatus,
        message: sdrMessage,
        last_checked: checkedAt
      }
    }
  };
}

app.use(express.json({ limit: '6mb' }));
app.use(express.static('/app/public'));

app.get('/api/profiles', (_req, res) => {
  const profiles = listProfiles().map(readProfileSummary);
  res.json({ profiles, activeProfile: activeProfile() });
});

app.post('/api/profiles/switch', (req, res) => {
  const profile = req.body?.profile;
  if (!isSafeProfileName(profile)) {
    return res.status(400).json({ error: 'Invalid profile name' });
  }
  if (!fs.existsSync(profileFile(profile))) {
    return res.status(404).json({ error: `Profile '${profile}' not found` });
  }

  const changedAt = nowIso();
  writeJson(ACTIVE_PROFILE_FILE, { profile, changedAt, changedBy: 'api' });
  triggerReload('profile-switch', profile);
  return res.json({ ok: true, profile, changedAt });
});

app.get('/api/talkgroups/:profile', (req, res) => {
  const profile = req.params.profile;
  if (!isSafeProfileName(profile)) {
    return res.status(400).json({ error: 'Invalid profile name' });
  }
  const payload = readJson(talkgroupsFile(profile), { entries: [], filter: { policy: 'blacklist', allow: [], deny: [] } });
  return res.json(payload);
});

app.put('/api/talkgroups/:profile', (req, res) => {
  const profile = req.params.profile;
  if (!isSafeProfileName(profile)) {
    return res.status(400).json({ error: 'Invalid profile name' });
  }
  const normalized = normalizeTalkgroupsEntries(Array.isArray(req.body?.entries) ? req.body.entries : []);
  if (normalized.errors.length > 0) {
    return res.status(400).json({ error: normalized.errors.join('; '), errors: normalized.errors });
  }
  const saved = persistTalkgroups(profile, normalized.entries);
  triggerReload('talkgroup-update', profile);
  return res.json({ ok: true, count: saved.entries.length, filter: saved.filter });
});

app.post('/api/import/sites/:profile/preview', (req, res) => {
  const profile = req.params.profile;
  if (!isSafeProfileName(profile)) {
    return res.status(400).json({ error: 'Invalid profile name' });
  }
  const csv = req.body?.csv;
  const parsed = normalizeSitesCsv(csv);
  return res.json({ ok: parsed.errors.length === 0, errors: parsed.errors, preview: parsed.sites, total: parsed.sites.length });
});

app.post('/api/import/sites/:profile/save', (req, res) => {
  const profile = req.params.profile;
  if (!isSafeProfileName(profile)) {
    return res.status(400).json({ error: 'Invalid profile name' });
  }

  const csv = req.body?.csv;
  const parsed = normalizeSitesCsv(csv);
  if (parsed.errors.length > 0) {
    return res.status(400).json({ error: parsed.errors.join('; '), errors: parsed.errors });
  }

  const existing = readJson(profileFile(profile), {});
  const updated = {
    label: existing.label || profile,
    description: existing.description || `${profile} imported profile`,
    notes: existing.notes || 'Imported from user-supplied CSV',
    system: {
      name: existing.system?.name || profile,
      sysid: existing.system?.sysid || null,
      wacn: existing.system?.wacn || null,
      nac: existing.system?.nac || null,
      bandplan: existing.system?.bandplan || 'P25 Auto',
      sites: parsed.sites
    },
    command: Array.isArray(existing.command) && existing.command.length > 0
      ? existing.command
      : [
        'python3',
        '/opt/op25/op25/gr-op25_repeater/apps/rx.py',
        '--args',
        'rtl',
        '-S',
        '2400000',
        '-T',
        `{PROFILES_DIR}/${profile}.tsv`,
        '-2',
        '-V',
        '-O',
        'plughw:Loopback,0,0',
        '-U'
      ],
    updatedAt: nowIso(),
    importSource: 'sites-csv'
  };

  writeJson(profileFile(profile), updated);
  triggerReload('sites-import', profile);
  return res.json({ ok: true, profile, sites: parsed.sites.length });
});

app.post('/api/import/talkgroups/:profile/preview', (req, res) => {
  const profile = req.params.profile;
  if (!isSafeProfileName(profile)) {
    return res.status(400).json({ error: 'Invalid profile name' });
  }
  const csv = req.body?.csv;
  const parsed = normalizeTalkgroupsCsv(csv);
  return res.json({ ok: parsed.errors.length === 0, errors: parsed.errors, preview: parsed.entries.slice(0, 250), total: parsed.entries.length });
});

app.post('/api/import/talkgroups/:profile/save', (req, res) => {
  const profile = req.params.profile;
  if (!isSafeProfileName(profile)) {
    return res.status(400).json({ error: 'Invalid profile name' });
  }
  const csv = req.body?.csv;
  const parsed = normalizeTalkgroupsCsv(csv);
  if (parsed.errors.length > 0) {
    return res.status(400).json({ error: parsed.errors.join('; '), errors: parsed.errors });
  }
  const saved = persistTalkgroups(profile, parsed.entries);
  triggerReload('talkgroup-import', profile);
  return res.json({ ok: true, profile, talkgroups: saved.entries.length, filter: saved.filter });
});

app.post('/api/import/profile/:profile/from-json-file', (req, res) => {
  const profile = req.params.profile;
  if (!isSafeProfileName(profile)) {
    return res.status(400).json({ error: 'Invalid profile name' });
  }
  const fileName = req.body?.fileName || `${profile}.import.json`;
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(fileName)) {
    return res.status(400).json({ error: 'Invalid fileName' });
  }
  const fullPath = path.join(PROFILES_DIR, fileName);
  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: `Not found: ${fileName}` });
  }

  const raw = readJson(fullPath, null);
  if (!raw) {
    return res.status(400).json({ error: `Invalid JSON: ${fileName}` });
  }

  if (!Array.isArray(raw.system?.sites) || !Array.isArray(raw.talkgroups?.entries)) {
    return res.status(400).json({ error: 'JSON file must include system.sites[] and talkgroups.entries[]' });
  }

  writeJson(profileFile(profile), {
    label: raw.label || profile,
    description: raw.description || `${profile} imported profile`,
    notes: raw.notes || 'Imported from user JSON',
    system: raw.system,
    command: Array.isArray(raw.command) && raw.command.length > 0 ? raw.command : [
      'python3', '/opt/op25/op25/gr-op25_repeater/apps/rx.py', '--args', 'rtl', '-S', '2400000', '-T', `{PROFILES_DIR}/${profile}.tsv`, '-2', '-V', '-O', 'plughw:Loopback,0,0', '-U'
    ],
    updatedAt: nowIso(),
    importSource: `json-file:${fileName}`
  });

  const normalized = normalizeTalkgroupsEntries(raw.talkgroups.entries);
  if (normalized.errors.length > 0) {
    return res.status(400).json({ error: normalized.errors.join('; '), errors: normalized.errors });
  }

  const saved = persistTalkgroups(profile, normalized.entries);
  triggerReload('profile-json-import', profile);
  return res.json({ ok: true, profile, fileName, talkgroups: saved.entries.length, filter: saved.filter });
});

app.get('/api/import/templates', (_req, res) => {
  res.json({
    sitesCsvHeaders: ['site_name', 'control_freq', 'alt_freqs', 'nac', 'sysid', 'wacn', 'bandplan'],
    sitesCsvTemplate: [
      'site_name,control_freq,alt_freqs,nac,sysid,wacn,bandplan',
      'Phoenix Simulcast,771.10625,771.35625;770.85625,293,123,BEE00,P25 Auto'
    ].join('\n'),
    talkgroupsCsvHeaders: ['tgid', 'label', 'mode', 'encrypted', 'category', 'favorite', 'enabled'],
    talkgroupsCsvTemplate: [
      'tgid,label,mode,encrypted,category,favorite,enabled',
      '1201,Dispatch A,D,false,dispatch,true,true',
      '1202,TAC 2,T,false,tac,false,true',
      '1299,Encrypted Ops,DE,true,ops,false,true'
    ].join('\n')
  });
});

app.get('/api/control/capabilities', guardControl, async (_req, res) => {
  const helper = await callHostHelper('GET', '/health');
  res.json({
    ok: true,
    helperConfigured: Boolean(HOST_HELPER_URL),
    helperReachable: helper.ok,
    helperError: helper.error || helper.data?.error || null
  });
});

app.post('/api/control/action', guardControl, async (req, res) => {
  const action = String(req.body?.action || '').trim();
  const fallbackCmd = {
    'start-op25': 'sudo systemctl start op25-supervisor.service',
    'restart-op25': 'sudo systemctl restart op25-supervisor.service',
    'stop-op25': 'sudo systemctl stop op25-supervisor.service',
    'load-alsa-loopback': 'sudo modprobe snd-aloop && grep -i Loopback /proc/asound/cards',
    'usb-sdr-check': 'lsusb | grep -Ei "rtl|realtek"; command -v rtl_sdr',
    'restart-streamer': 'docker restart rf-console-streamer',
    'restart-icecast': 'docker restart rf-console-icecast',
    'restart-backend': 'docker compose restart backend'
  };

  if (!fallbackCmd[action]) {
    return res.status(400).json({ ok: false, error: `Unsupported action: ${action}` });
  }

  const helper = await callHostHelper('POST', `/action/${encodeURIComponent(action)}`);
  if (helper.ok) {
    return res.json(helper.data);
  }

  return res.status(503).json(controlFallback(action, fallbackCmd[action]));
});

app.get('/api/control/logs/:target', guardControl, async (req, res) => {
  const target = String(req.params.target || '').trim();
  const lines = Math.max(10, Math.min(1000, Number(req.query.lines || 200)));
  const fallbackCmd = {
    op25: 'journalctl -u op25-supervisor.service -n 200 --no-pager',
    streamer: 'docker logs --tail=200 rf-console-streamer',
    icecast: 'docker logs --tail=200 rf-console-icecast'
  };

  if (!fallbackCmd[target]) {
    return res.status(400).json({ ok: false, error: `Unsupported log target: ${target}` });
  }

  const helper = await callHostHelper('GET', `/logs/${encodeURIComponent(target)}?lines=${lines}`);
  if (helper.ok) {
    return res.json(helper.data);
  }

  return res.status(503).json(controlFallback(`logs-${target}`, fallbackCmd[target]));
});

app.get('/api/health', async (_req, res) => {
  const data = await buildHealth();
  res.json(data);
});

app.get('/api/status', (_req, res) => {
  const status = readJson(STATUS_FILE, {});
  res.json({
    activeProfile: activeProfile(),
    streamUrl: STREAM_URL,
    status: {
      running: !!status.running,
      locked: !!status.locked,
      lastDecodeTime: status.lastDecodeTime || null,
      startedAt: status.startedAt || null,
      lastUpdated: status.lastUpdated || null,
      currentControlFrequency: status.currentControlFrequency || null,
      rssi: status.rssi ?? null,
      system: {
        sysid: status.system?.sysid || null,
        wacn: status.system?.wacn || null,
        nac: status.system?.nac || null
      },
      talkgroup: {
        current: status.talkgroup?.current || null,
        last: status.talkgroup?.last || null
      },
      note: status.note || null
    }
  });
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.use((_req, res) => {
  res.sendFile('/app/public/index.html');
});

ensureDirs();
if (!fs.existsSync(ACTIVE_PROFILE_FILE)) {
  const names = listProfiles();
  if (names.length > 0) {
    writeJson(ACTIVE_PROFILE_FILE, {
      profile: names[0],
      changedAt: nowIso(),
      changedBy: 'bootstrap'
    });
  }
}

app.listen(PORT, () => {
  console.log(`rf-console backend listening on :${PORT}`);
});
