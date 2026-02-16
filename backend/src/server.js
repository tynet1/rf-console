const express = require('express');
const fs = require('fs');
const path = require('path');
const { Buffer } = require('buffer');
const { execFile } = require('child_process');
const { promisify } = require('util');

const app = express();

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || '/data';
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');
const RUNTIME_DIR = path.join(DATA_DIR, 'runtime');
const ACTIVE_PROFILE_FILE = path.join(RUNTIME_DIR, 'active-profile.json');
const ACTIVE_PROFILE_LEGACY_FILE = path.join(RUNTIME_DIR, 'active_profile.json');
const STATUS_FILE = path.join(RUNTIME_DIR, 'op25-status.json');
const RELOAD_FILE = path.join(RUNTIME_DIR, 'reload-request.json');
const STREAM_URL = process.env.STREAM_URL || 'http://localhost:8000/stream';
const ICECAST_STATUS_URL = process.env.ICECAST_STATUS_URL || 'http://icecast:8000/status-json.xsl';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const CONTROL_PRIVATE_ONLY = process.env.CONTROL_PRIVATE_ONLY !== '0';
const HOST_HELPER_URL = process.env.HOST_HELPER_URL || '';
const HOST_HELPER_TOKEN = process.env.HOST_HELPER_TOKEN || ADMIN_TOKEN;
const DOCKER_BIN = process.env.DOCKER_BIN || 'docker';
const OP25_CONTAINER = process.env.OP25_CONTAINER || 'rf-console-op25';
const ICECAST_CONTAINER = process.env.ICECAST_CONTAINER || 'rf-console-icecast';
const STREAMER_CONTAINER = process.env.STREAMER_CONTAINER || 'rf-console-streamer';
const BACKEND_CONTAINER = process.env.BACKEND_CONTAINER || 'rf-console-backend';

const execFileAsync = promisify(execFile);

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

function migrateLegacyActiveProfile() {
  if (fs.existsSync(ACTIVE_PROFILE_FILE) || !fs.existsSync(ACTIVE_PROFILE_LEGACY_FILE)) {
    return;
  }
  try {
    const legacy = readJson(ACTIVE_PROFILE_LEGACY_FILE, null);
    if (legacy && isSafeProfileName(legacy.profile)) {
      writeJson(ACTIVE_PROFILE_FILE, legacy);
      fs.unlinkSync(ACTIVE_PROFILE_LEGACY_FILE);
    }
  } catch {
    // keep legacy file untouched on failure
  }
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
  writeTagsTsv(profile, doc.entries);
  return doc;
}

function quoteTsv(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function writeTagsTsv(profile, entries) {
  const out = [];
  out.push([quoteTsv('tgid'), quoteTsv('tag'), quoteTsv('mode')].join('\t'));
  entries.forEach((entry) => {
    out.push([
      quoteTsv(entry.tgid),
      quoteTsv(entry.label || ''),
      quoteTsv(entry.mode || 'D')
    ].join('\t'));
  });
  fs.writeFileSync(path.join(PROFILES_DIR, `${profile}.tags.tsv`), out.join('\n') + '\n', 'utf8');
}

function ensureNamedTagsFile(tagFileName) {
  const safe = String(tagFileName || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(safe) || !safe.toLowerCase().endsWith('.tags.tsv')) {
    throw new Error(`Invalid tags file name: ${tagFileName}`);
  }
  const full = path.join(PROFILES_DIR, safe);
  if (!fs.existsSync(full)) {
    fs.writeFileSync(full, '"tgid"\t"tag"\t"mode"\n', 'utf8');
  }
  return full;
}

function findCaseInsensitiveProfileFile(fileName) {
  if (!fs.existsSync(PROFILES_DIR)) {
    return null;
  }
  const target = String(fileName || '').toLowerCase();
  if (!target) {
    return null;
  }
  const match = fs.readdirSync(PROFILES_DIR).find((name) => name.toLowerCase() === target);
  return match || null;
}

function ensureTagsFile(profile) {
  const tagsPath = path.join(PROFILES_DIR, `${profile}.tags.tsv`);
  if (fs.existsSync(tagsPath)) {
    return;
  }
  const existingTalkgroups = readJson(talkgroupsFile(profile), { entries: [] });
  writeTagsTsv(profile, Array.isArray(existingTalkgroups.entries) ? existingTalkgroups.entries : []);
}

function writeTrunkTsv(profile, sites, profileDoc = {}) {
  const tagFile = `${profile}.tags.tsv`;
  const out = [];
  out.push([
    quoteTsv('sysname'),
    quoteTsv('site_name'),
    quoteTsv('control_channel_list'),
    quoteTsv('alt_channel_list'),
    quoteTsv('nac'),
    quoteTsv('sysid'),
    quoteTsv('wacn'),
    quoteTsv('bandplan'),
    quoteTsv('tags_file')
  ].join('\t'));

  sites.forEach((site) => {
    out.push([
      quoteTsv(profileDoc.system?.name || profile),
      quoteTsv(site.name || ''),
      quoteTsv((site.controlChannels || []).join(',')),
      quoteTsv((site.alternateChannels || []).join(',')),
      quoteTsv(site.nac || profileDoc.system?.nac || ''),
      quoteTsv(site.sysid || profileDoc.system?.sysid || ''),
      quoteTsv(site.wacn || profileDoc.system?.wacn || ''),
      quoteTsv(site.bandplan || profileDoc.system?.bandplan || 'P25 Auto'),
      quoteTsv(tagFile)
    ].join('\t'));
  });
  fs.writeFileSync(path.join(PROFILES_DIR, `${profile}.trunk.tsv`), out.join('\n') + '\n', 'utf8');
}

function normalizeCommandForTrunk(profile, command) {
  if (!Array.isArray(command)) {
    return command;
  }
  return command.map((token) => {
    if (typeof token !== 'string') {
      return token;
    }
    const oldTemplate = `{PROFILES_DIR}/${profile}.tsv`;
    if (token === oldTemplate) {
      return `{PROFILES_DIR}/${profile}.trunk.tsv`;
    }
    return token.replace(new RegExp(`${profile}\\.tsv`, 'g'), `${profile}.trunk.tsv`);
  });
}

function triggerReload(reason, profile = activeProfile()) {
  writeJson(RELOAD_FILE, {
    requestedAt: nowIso(),
    reason,
    profile: profile || null
  });
}

function parseQuotedTsvLine(line) {
  const fields = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '"') {
      return { ok: false, error: 'field must start with double quote' };
    }
    i += 1;
    let value = '';
    while (i < line.length) {
      const ch = line[i];
      if (ch === '"') {
        if (line[i + 1] === '"') {
          value += '"';
          i += 2;
          continue;
        }
        i += 1;
        break;
      }
      value += ch;
      i += 1;
    }

    fields.push(value);
    if (i === line.length) {
      break;
    }
    if (line[i] !== '\t') {
      return { ok: false, error: 'fields must be tab-separated quoted values' };
    }
    i += 1;
  }
  return { ok: true, fields };
}

function findTagFilesInFields(fields) {
  return fields
    .filter((f) => typeof f === 'string' && f.toLowerCase().endsWith('.tags.tsv'))
    .map((f) => f.trim())
    .filter(Boolean);
}

function migrateLegacyTrunkFile(profile) {
  const trunkPath = path.join(PROFILES_DIR, `${profile}.trunk.tsv`);
  if (fs.existsSync(trunkPath)) {
    return;
  }
  const legacyPath = path.join(PROFILES_DIR, `${profile}.tsv`);
  if (!fs.existsSync(legacyPath)) {
    return;
  }
  try {
    fs.copyFileSync(legacyPath, trunkPath);
  } catch {
    // leave as-is on migration failure
  }
}

function validateProfileFiles(profile, options = {}) {
  const createMissingTags = !!options.createMissingTags;
  migrateLegacyTrunkFile(profile);
  ensureTagsFile(profile);
  const trunkFileName = `${profile}.trunk.tsv`;
  const trunkPath = path.join(PROFILES_DIR, trunkFileName);
  const createdTagFiles = [];

  if (!fs.existsSync(trunkPath)) {
    return {
      ok: false,
      error: `Missing required trunk file: ${trunkFileName}`,
      firstError: `Missing required trunk file: ${trunkFileName}`
    };
  }

  const lines = fs.readFileSync(trunkPath, 'utf8')
    .replace(/\r/g, '')
    .split('\n');

  let expectedCols = null;
  let firstError = null;
  const referencedTags = new Set();
  let parsedRows = 0;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const raw = lines[idx].trim();
    if (!raw || raw.startsWith('#')) {
      continue;
    }

    const parsed = parseQuotedTsvLine(raw);
    if (!parsed.ok) {
      firstError = `Line ${idx + 1}: ${parsed.error}`;
      break;
    }

    if (expectedCols == null) {
      expectedCols = parsed.fields.length;
      if (expectedCols < 2) {
        firstError = `Line ${idx + 1}: trunk.tsv has invalid column count (${expectedCols})`;
        break;
      }
    } else if (parsed.fields.length !== expectedCols) {
      firstError = `Line ${idx + 1}: expected ${expectedCols} columns but found ${parsed.fields.length}`;
      break;
    }

    parsedRows += 1;
    findTagFilesInFields(parsed.fields).forEach((tag) => referencedTags.add(tag));
  }

  if (!firstError && parsedRows === 0) {
    firstError = 'No usable rows found in trunk.tsv';
  }

  if (!firstError && referencedTags.size === 0) {
    referencedTags.add(`${profile}.tags.tsv`);
  }

  if (!firstError) {
    for (const tag of referencedTags) {
      const full = path.isAbsolute(tag) ? tag : path.join(PROFILES_DIR, tag);
      if (!fs.existsSync(full)) {
        if (!path.isAbsolute(tag) && createMissingTags) {
          try {
            ensureNamedTagsFile(tag);
            createdTagFiles.push(tag);
            continue;
          } catch (err) {
            firstError = `Unable to create missing tag file '${tag}': ${err.message}`;
            break;
          }
        }
        const caseVariant = path.isAbsolute(tag) ? null : findCaseInsensitiveProfileFile(tag);
        if (caseVariant) {
          firstError = `Referenced tag file case mismatch: '${tag}' not found, but '${caseVariant}' exists`;
        } else {
          firstError = createMissingTags
            ? `Referenced tag file is missing: ${tag}`
            : `Referenced tag file is missing: ${tag} (re-run with ?createMissingTags=1 to create an empty file)`;
        }
        break;
      }
    }
  }

  return {
    ok: !firstError,
    error: firstError,
    firstError,
    details: {
      profile,
      trunkFile: trunkFileName,
      parsedRows,
      expectedColumns: expectedCols,
      referencedTagFiles: Array.from(referencedTags),
      createdTagFiles
    }
  };
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

async function runCommand(bin, args, timeoutMs = 8000) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 2
    });
    return { ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), exitCode: 0 };
  } catch (err) {
    return {
      ok: false,
      stdout: (err.stdout || '').trim(),
      stderr: (err.stderr || err.message || '').trim(),
      exitCode: typeof err.code === 'number' ? err.code : 1
    };
  }
}

async function dockerAvailable() {
  return runCommand(DOCKER_BIN, ['version', '--format', '{{.Server.Version}}'], 4000);
}

async function dockerInspect(name) {
  const result = await runCommand(DOCKER_BIN, ['inspect', name], 6000);
  if (!result.ok) {
    return {
      ok: false,
      name,
      status: 'missing',
      message: result.stderr || result.stdout || 'container missing',
      uptime: null,
      lastExitCode: null,
      running: false
    };
  }

  try {
    const payload = JSON.parse(result.stdout);
    const state = payload[0]?.State || {};
    const status = state.Status || 'unknown';
    const startedAt = state.StartedAt ? Date.parse(state.StartedAt) : null;
    const uptime = startedAt && Number.isFinite(startedAt)
      ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
      : null;
    return {
      ok: true,
      name,
      status,
      message: status,
      uptime,
      running: Boolean(state.Running),
      lastExitCode: Number.isInteger(state.ExitCode) ? state.ExitCode : null
    };
  } catch (err) {
    return {
      ok: false,
      name,
      status: 'unknown',
      message: `inspect parse error: ${err.message}`,
      uptime: null,
      lastExitCode: null,
      running: false
    };
  }
}

async function dockerAction(action, containerName) {
  const cmd = action === 'start'
    ? ['start', containerName]
    : action === 'stop'
      ? ['stop', containerName]
      : ['restart', containerName];
  return runCommand(DOCKER_BIN, cmd, 15000);
}

async function dockerLogsTail(containerName, lines = 200) {
  return runCommand(DOCKER_BIN, ['logs', '--tail', String(lines), containerName], 12000);
}

function serviceStatusColor(status) {
  const s = String(status || '').toLowerCase();
  if (['running', 'active', 'up', 'healthy'].includes(s)) return 'green';
  if (['missing', 'unknown'].includes(s)) return 'yellow';
  return 'red';
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

async function buildServices() {
  const checkedAt = nowIso();
  const docker = await dockerAvailable();
  if (!docker.ok) {
    return {
      ts: checkedAt,
      source: 'backend',
      error: 'Docker CLI unavailable in backend container',
      services: {
        backend: { name: 'backend', status: 'green', message: 'running', uptime: null, lastExitCode: null },
        op25: { name: 'op25', status: 'yellow', message: docker.stderr || docker.stdout || 'docker unavailable', uptime: null, lastExitCode: null },
        icecast: { name: 'icecast', status: 'yellow', message: 'docker unavailable', uptime: null, lastExitCode: null },
        streamer: { name: 'streamer', status: 'yellow', message: 'docker unavailable', uptime: null, lastExitCode: null }
      }
    };
  }

  const [op25, icecast, streamer, backend] = await Promise.all([
    dockerInspect(OP25_CONTAINER),
    dockerInspect(ICECAST_CONTAINER),
    dockerInspect(STREAMER_CONTAINER),
    dockerInspect(BACKEND_CONTAINER)
  ]);

  const normalize = (svc) => ({
    name: svc.name,
    status: serviceStatusColor(svc.status),
    state: svc.status,
    message: svc.message,
    uptime: svc.uptime,
    lastExitCode: svc.lastExitCode
  });

  return {
    ts: checkedAt,
    source: 'backend',
    services: {
      backend: normalize(backend),
      op25: normalize(op25),
      icecast: normalize(icecast),
      streamer: normalize(streamer)
    }
  };
}

app.use(express.json({ limit: '6mb' }));
app.use(express.static('/app/public'));

app.get('/api/profiles', (_req, res) => {
  const profiles = listProfiles().map(readProfileSummary);
  res.json({ profiles, activeProfile: activeProfile() });
});

app.get('/api/validate-profile/:profile', (req, res) => {
  const profile = req.params.profile;
  if (!isSafeProfileName(profile)) {
    return res.status(400).json({ ok: false, error: 'Invalid profile name' });
  }
  const result = validateProfileFiles(profile, { createMissingTags: parseBool(req.query.createMissingTags) });
  if (!result.ok) {
    return res.status(400).json(result);
  }
  return res.json(result);
});

app.post('/api/profiles/:profile/tags/init', guardControl, (req, res) => {
  const profile = req.params.profile;
  if (!isSafeProfileName(profile)) {
    return res.status(400).json({ ok: false, error: 'Invalid profile name' });
  }
  const requestedName = String(req.body?.tagFile || `${profile}.tags.tsv`).trim();
  try {
    const target = ensureNamedTagsFile(requestedName);
    return res.json({
      ok: true,
      profile,
      tagFile: path.basename(target),
      path: target,
      ts: nowIso()
    });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/profiles/switch', async (req, res) => {
  const profile = req.body?.profile;
  if (!isSafeProfileName(profile)) {
    return res.status(400).json({ error: 'Invalid profile name' });
  }
  if (!fs.existsSync(profileFile(profile))) {
    return res.status(404).json({ error: `Profile '${profile}' not found` });
  }
  const validation = validateProfileFiles(profile);
  if (!validation.ok) {
    return res.status(400).json({ ok: false, error: validation.firstError, validation });
  }

  const changedAt = nowIso();
  writeJson(ACTIVE_PROFILE_FILE, { profile, changedAt, changedBy: 'api' });
  triggerReload('profile-switch', profile);

  const restart = await dockerAction('restart', OP25_CONTAINER);
  const logs = await dockerLogsTail(OP25_CONTAINER, 200);
  return res.json({
    ok: restart.ok,
    profile,
    changedAt,
    validation,
    restart: {
      ok: restart.ok,
      exitCode: restart.exitCode,
      stdout: restart.stdout,
      stderr: restart.stderr
    },
    logsTail: logs.stdout || logs.stderr || ''
  });
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
      ? normalizeCommandForTrunk(profile, existing.command)
      : [
        'python3',
        '/opt/op25/op25/gr-op25_repeater/apps/rx.py',
        '--args',
        'rtl',
        '-S',
        '2400000',
        '-T',
        `{PROFILES_DIR}/${profile}.trunk.tsv`,
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
  ensureTagsFile(profile);
  writeTrunkTsv(profile, parsed.sites, updated);
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
    command: Array.isArray(raw.command) && raw.command.length > 0 ? normalizeCommandForTrunk(profile, raw.command) : [
      'python3', '/opt/op25/op25/gr-op25_repeater/apps/rx.py', '--args', 'rtl', '-S', '2400000', '-T', `{PROFILES_DIR}/${profile}.trunk.tsv`, '-2', '-V', '-O', 'plughw:Loopback,0,0', '-U'
    ],
    updatedAt: nowIso(),
    importSource: `json-file:${fileName}`
  });

  const normalized = normalizeTalkgroupsEntries(raw.talkgroups.entries);
  if (normalized.errors.length > 0) {
    return res.status(400).json({ error: normalized.errors.join('; '), errors: normalized.errors });
  }

  const saved = persistTalkgroups(profile, normalized.entries);
  writeTrunkTsv(profile, raw.system.sites, raw);
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
  const docker = await dockerAvailable();
  const helper = await callHostHelper('GET', '/health');
  res.json({
    ok: true,
    dockerAvailable: docker.ok,
    dockerMessage: docker.ok ? docker.stdout : (docker.stderr || docker.stdout || 'docker unavailable'),
    helperConfigured: Boolean(HOST_HELPER_URL),
    helperReachable: helper.ok,
    helperError: helper.error || helper.data?.error || null
  });
});

app.get('/api/debug/helper', guardControl, async (_req, res) => {
  const helper = await callHostHelper('GET', '/health');
  const payload = {
    ok: helper.ok,
    ts: nowIso(),
    helperConfigured: Boolean(HOST_HELPER_URL),
    helperUrl: HOST_HELPER_URL || null,
    helperTokenConfigured: Boolean(HOST_HELPER_TOKEN),
    status: helper.status || null,
    error: helper.error || helper.data?.error || null,
    response: helper.data || null
  };
  return res.status(helper.ok ? 200 : 503).json(payload);
});

app.post('/api/control/action', guardControl, async (req, res) => {
  const action = String(req.body?.action || '').trim();
  const fallbackCmd = {
    'start-op25': `docker start ${OP25_CONTAINER}`,
    'restart-op25': `docker restart ${OP25_CONTAINER}`,
    'stop-op25': `docker stop ${OP25_CONTAINER}`,
    'load-alsa-loopback': 'sudo modprobe snd-aloop && grep -i Loopback /proc/asound/cards',
    'usb-sdr-check': 'lsusb | grep -Ei "rtl|realtek"; command -v rtl_sdr',
    'restart-streamer': 'docker restart rf-console-streamer',
    'restart-icecast': 'docker restart rf-console-icecast',
    'restart-backend': 'docker compose restart backend'
  };

  if (!fallbackCmd[action]) {
    return res.status(400).json({ ok: false, error: `Unsupported action: ${action}` });
  }

  if (action === 'start-op25' || action === 'restart-op25') {
    const profile = activeProfile();
    if (!profile) {
      return res.status(400).json({ ok: false, action, error: 'No active profile selected' });
    }
    const validation = validateProfileFiles(profile);
    if (!validation.ok) {
      return res.status(400).json({
        ok: false,
        action,
        error: `Profile validation failed: ${validation.firstError}`,
        validation
      });
    }
  }

  if (action === 'start-op25' || action === 'restart-op25' || action === 'stop-op25') {
    const dockerActionName = action === 'start-op25' ? 'start' : action === 'stop-op25' ? 'stop' : 'restart';
    const op = await dockerAction(dockerActionName, OP25_CONTAINER);
    const logs = await dockerLogsTail(OP25_CONTAINER, 200);
    return res.status(op.ok ? 200 : 500).json({
      ok: op.ok,
      action,
      stdout: op.stdout,
      stderr: op.stderr,
      exitCode: op.exitCode,
      logsTail: logs.stdout || logs.stderr || '',
      ts: nowIso()
    });
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
    op25: `docker logs --tail=200 ${OP25_CONTAINER}`,
    streamer: 'docker logs --tail=200 rf-console-streamer',
    icecast: 'docker logs --tail=200 rf-console-icecast'
  };

  if (!fallbackCmd[target]) {
    return res.status(400).json({ ok: false, error: `Unsupported log target: ${target}` });
  }

  if (target === 'op25') {
    const logs = await dockerLogsTail(OP25_CONTAINER, lines);
    return res.status(logs.ok ? 200 : 500).json({
      ok: logs.ok,
      action: 'logs-op25',
      stdout: logs.stdout,
      stderr: logs.stderr,
      exitCode: logs.exitCode,
      ts: nowIso()
    });
  }

  const helper = await callHostHelper('GET', `/logs/${encodeURIComponent(target)}?lines=${lines}`);
  if (helper.ok) {
    return res.json(helper.data);
  }

  return res.status(503).json(controlFallback(`logs-${target}`, fallbackCmd[target]));
});

app.post('/api/op25/restart', guardControl, async (_req, res) => {
  const profile = activeProfile();
  if (!profile) {
    return res.status(400).json({ ok: false, error: 'No active profile selected' });
  }
  const validation = validateProfileFiles(profile);
  if (!validation.ok) {
    return res.status(400).json({ ok: false, error: validation.firstError, validation });
  }
  const restart = await dockerAction('restart', OP25_CONTAINER);
  const logs = await dockerLogsTail(OP25_CONTAINER, 200);
  return res.json({
    ok: restart.ok,
    profile,
    validation,
    action: 'restart-op25',
    exitCode: restart.exitCode,
    stdout: restart.stdout,
    stderr: restart.stderr,
    logsTail: logs.stdout || logs.stderr || '',
    ts: nowIso()
  });
});

app.get('/api/op25/logs-tail', async (req, res) => {
  const lines = Math.max(10, Math.min(500, Number(req.query.lines || 200)));
  const logs = await dockerLogsTail(OP25_CONTAINER, lines);
  if (!logs.ok) {
    return res.status(503).json({
      ok: false,
      lines,
      error: logs.stderr || logs.stdout || 'Unable to read OP25 container logs',
      ts: nowIso(),
      tail: ''
    });
  }
  return res.json({
    ok: true,
    lines,
    ts: nowIso(),
    tail: logs.stdout || ''
  });
});

app.get('/api/health', async (_req, res) => {
  const data = await buildHealth();
  res.json(data);
});

app.get('/services', async (_req, res) => {
  const data = await buildServices();
  res.json(data);
});

app.get('/api/status', async (_req, res) => {
  const status = readJson(STATUS_FILE, {});
  const op25 = await dockerInspect(OP25_CONTAINER);
  const logs = await dockerLogsTail(OP25_CONTAINER, 120);
  const lastTail = logs.stdout || logs.stderr || status.lastErrorTail || '';
  res.json({
    activeProfile: activeProfile(),
    streamUrl: STREAM_URL,
    status: {
      running: op25.running ?? !!status.running,
      locked: !!status.locked,
      lastDecodeTime: status.lastDecodeTime || null,
      lastExitCode: op25.lastExitCode ?? status.lastExitCode ?? null,
      lastStartCommand: status.lastStartCommand || null,
      lastErrorTail: lastTail,
      timestamp: status.timestamp || null,
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
migrateLegacyActiveProfile();
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
