const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || '/data';
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');
const RUNTIME_DIR = path.join(DATA_DIR, 'runtime');
const ACTIVE_PROFILE_FILE = path.join(RUNTIME_DIR, 'active-profile.json');
const STATUS_FILE = path.join(RUNTIME_DIR, 'op25-status.json');
const RELOAD_FILE = path.join(RUNTIME_DIR, 'reload-request.json');
const SWITCH_HOOK = process.env.SWITCH_HOOK || '';
const STREAM_URL = process.env.STREAM_URL || 'http://localhost:8000/stream';
const ICECAST_STATUS_URL = process.env.ICECAST_STATUS_URL || 'http://icecast:8000/status-json.xsl';
const OP25_SYSTEMD_SERVICE = process.env.OP25_SYSTEMD_SERVICE || 'op25-supervisor.service';

const PROFILE_OPTIONS = new Set(['AZDPS', 'MCSO']);

function ensureDirs() {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function isSafeProfileName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(name);
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
  return files
    .map((f) => f.replace(/\.profile\.json$/, ''))
    .filter((name) => isSafeProfileName(name));
}

function activeProfile() {
  const state = readJson(ACTIVE_PROFILE_FILE, null);
  if (!state || !isSafeProfileName(state.profile)) {
    return null;
  }
  return state.profile;
}

function nowIso() {
  return new Date().toISOString();
}

function runSwitchHook(profile) {
  if (!SWITCH_HOOK) {
    return;
  }

  const child = spawn(SWITCH_HOOK, [profile], {
    detached: true,
    stdio: 'ignore',
    shell: true
  });
  child.unref();
}

function triggerOp25Reload(reason, profile = activeProfile()) {
  writeJson(RELOAD_FILE, {
    requestedAt: nowIso(),
    reason,
    profile: profile || null
  });
  if (profile) {
    runSwitchHook(profile);
  }
}

function clampText(value, max = 128) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().slice(0, max);
}

function parseCsvLine(line) {
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
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

function parseCsv(text) {
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    const row = {};
    for (let i = 0; i < headers.length; i += 1) {
      row[headers[i]] = cols[i] || '';
    }
    return row;
  });

  return { headers, rows };
}

function parseBool(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(v);
}

function parseMode(value) {
  const v = String(value ?? '').trim().toUpperCase();
  if (['D', 'T', 'DE', 'TE'].includes(v)) {
    return v;
  }
  return 'D';
}

function modeToRule(mode) {
  return mode.endsWith('E') ? 'deny' : 'allow';
}

function modeEncrypted(mode, encrypted) {
  if (typeof encrypted === 'boolean') {
    return encrypted;
  }
  return mode.endsWith('E');
}

function normalizeTalkgroup(raw, idx, errors) {
  const tgid = Number(raw.tgid);
  if (!Number.isInteger(tgid) || tgid < 0 || tgid > 65535) {
    errors.push(`Row ${idx + 1}: invalid tgid '${raw.tgid}'`);
    return null;
  }

  const mode = parseMode(raw.mode);
  const encrypted = modeEncrypted(mode, raw.encrypted);
  const favorite = Boolean(raw.favorite);

  return {
    tgid,
    label: clampText(raw.label || `TG ${tgid}`),
    mode,
    encrypted,
    category: clampText(raw.category || 'uncategorized', 64) || 'uncategorized',
    favorite,
    filterAction: modeToRule(mode),
    enabled: raw.enabled !== false
  };
}

function normalizeTalkgroupsFromRows(rows) {
  const errors = [];
  const dedupe = new Map();

  rows.forEach((row, idx) => {
    const normalized = normalizeTalkgroup(
      {
        tgid: row.tgid,
        label: row.label,
        mode: row.mode,
        encrypted: row.encrypted,
        category: row.category,
        favorite: row.favorite,
        enabled: row.enabled
      },
      idx,
      errors
    );

    if (normalized) {
      dedupe.set(normalized.tgid, normalized);
    }
  });

  return { errors, entries: Array.from(dedupe.values()).sort((a, b) => a.tgid - b.tgid) };
}

function normalizeTalkgroupsPayload(payload = {}) {
  if (Array.isArray(payload.entries)) {
    const rows = payload.entries.map((entry) => ({
      tgid: entry?.tgid,
      label: entry?.label,
      mode: entry?.mode,
      encrypted: entry?.encrypted,
      category: entry?.category,
      favorite: entry?.favorite,
      enabled: entry?.enabled
    }));
    return normalizeTalkgroupsFromRows(rows);
  }

  if (typeof payload.csv === 'string') {
    const parsed = parseCsv(payload.csv);
    return normalizeTalkgroupsFromRows(parsed.rows);
  }

  return { errors: ['No entries or csv payload found'], entries: [] };
}

function validateSystemSite(site, idx, errors) {
  const name = clampText(site?.name || `Site ${idx + 1}`, 128);
  const controlChannels = Array.isArray(site?.controlChannels)
    ? site.controlChannels.map((f) => String(f).trim()).filter(Boolean)
    : [];
  const alternateChannels = Array.isArray(site?.alternateChannels)
    ? site.alternateChannels.map((f) => String(f).trim()).filter(Boolean)
    : [];

  if (controlChannels.length === 0) {
    errors.push(`Site ${idx + 1}: at least one control channel is required`);
  }

  return {
    name,
    nac: clampText(site?.nac, 16) || null,
    sysid: clampText(site?.sysid, 16) || null,
    wacn: clampText(site?.wacn, 16) || null,
    controlChannels,
    alternateChannels,
    bandplan: clampText(site?.bandplan, 64) || null
  };
}

function normalizeProfileImport(profile, payload) {
  const errors = [];
  if (!PROFILE_OPTIONS.has(profile)) {
    errors.push(`Profile must be one of: ${Array.from(PROFILE_OPTIONS).join(', ')}`);
  }

  const label = clampText(payload?.label || profile, 128) || profile;
  const description = clampText(payload?.description || '', 240);
  const command = Array.isArray(payload?.command) && payload.command.every((x) => typeof x === 'string')
    ? payload.command
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
    ];

  let sites = [];
  if (Array.isArray(payload?.system?.sites)) {
    sites = payload.system.sites.map((site, idx) => validateSystemSite(site, idx, errors));
  } else {
    errors.push('system.sites array is required');
  }

  const talkgroups = normalizeTalkgroupsPayload(payload?.talkgroups || payload);
  errors.push(...talkgroups.errors);

  return {
    errors,
    profileDoc: {
      label,
      description,
      notes: clampText(payload?.notes || '', 500),
      system: {
        name: clampText(payload?.system?.name || profile, 128) || profile,
        sysid: clampText(payload?.system?.sysid, 16) || null,
        wacn: clampText(payload?.system?.wacn, 16) || null,
        nac: clampText(payload?.system?.nac, 16) || null,
        bandplan: clampText(payload?.system?.bandplan, 64) || null,
        sites
      },
      command,
      updatedAt: nowIso(),
      importSource: payload?.importSource || 'manual'
    },
    talkgroupDoc: {
      updatedAt: nowIso(),
      entries: talkgroups.entries
    }
  };
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
  const talkgroupDoc = {
    updatedAt: nowIso(),
    filter: buildFilterPolicy(entries),
    entries
  };
  writeJson(talkgroupsFile(profile), talkgroupDoc);
  writeJson(filterFile(profile), {
    generatedAt: nowIso(),
    profile,
    filter: talkgroupDoc.filter
  });
  return talkgroupDoc;
}

function readProfileSummary(name) {
  const p = readJson(profileFile(name), {});
  return {
    name,
    label: p.label || name,
    description: p.description || '',
    hasTalkgroups: fs.existsSync(talkgroupsFile(name)),
    system: p.system || null,
    updatedAt: p.updatedAt || null
  };
}

function execCommand(command, args = [], timeoutMs = 2000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false });
    let stdout = '';
    let stderr = '';
    let done = false;

    const finish = (result) => {
      if (done) {
        return;
      }
      done = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // no-op
      }
      finish({ ok: false, code: null, stdout, stderr: `${stderr} (timeout)` });
    }, timeoutMs);

    child.stdout.on('data', (buf) => {
      stdout += String(buf);
    });
    child.stderr.on('data', (buf) => {
      stderr += String(buf);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, code: null, stdout, stderr: err.message });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function checkIcecast() {
  const checkedAt = nowIso();
  try {
    const res = await fetch(ICECAST_STATUS_URL, { method: 'GET' });
    if (!res.ok) {
      return {
        status: 'red',
        message: `Icecast status endpoint returned ${res.status}`,
        last_checked: checkedAt,
        details: {}
      };
    }
    const payload = await res.json();
    const src = payload?.icestats?.source;
    const sources = Array.isArray(src) ? src : src ? [src] : [];
    const streamSource = sources.find((s) => s.listenurl && String(s.listenurl).includes('/stream')) || null;

    return {
      status: streamSource ? 'green' : 'yellow',
      message: streamSource ? 'Icecast reachable; /stream mount visible' : 'Icecast reachable; /stream mount not visible',
      last_checked: checkedAt,
      details: {
        streamMounted: !!streamSource,
        listenerCount: streamSource?.listeners ?? 0,
        sourceConnected: !!streamSource,
        sourceIp: streamSource?.server_name || null
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
  if (!isoString) {
    return false;
  }
  const t = Date.parse(isoString);
  if (!Number.isFinite(t)) {
    return false;
  }
  return Date.now() - t <= seconds * 1000;
}

async function buildHealth() {
  const status = readJson(STATUS_FILE, {});
  const checkedAt = nowIso();
  const icecast = await checkIcecast();
  const active = activeProfile();

  const systemd = await execCommand('systemctl', ['is-active', OP25_SYSTEMD_SERVICE], 1500);
  const hasAloop = await execCommand('sh', ['-c', "grep -q '^snd_aloop ' /proc/modules"], 1000);
  const loopCard = await execCommand('sh', ['-c', "test -r /proc/asound/cards && grep -qi loopback /proc/asound/cards"], 1000);
  const rtlSdr = await execCommand('sh', ['-c', 'command -v rtl_sdr >/dev/null 2>&1'], 1000);

  const op25Locked = Boolean(status.locked);
  const op25Fresh = isRecent(status.lastUpdated, 15);

  return {
    activeProfile: active,
    checks: {
      backend: {
        status: 'green',
        message: 'Backend API reachable',
        last_checked: checkedAt
      },
      icecast: icecast,
      streamer: {
        status: icecast.details?.sourceConnected ? 'green' : 'yellow',
        message: icecast.details?.sourceConnected ? 'Streamer source connected to /stream' : 'No source connected to /stream',
        last_checked: checkedAt
      },
      op25Supervisor: {
        status: systemd.ok ? 'green' : 'yellow',
        message: systemd.ok ? 'op25-supervisor.service is active' : `systemctl check unavailable/inactive (${systemd.stderr || systemd.stdout || 'unknown'})`,
        last_checked: checkedAt
      },
      op25Process: {
        status: status.running ? (op25Locked ? 'green' : 'yellow') : 'red',
        message: status.running
          ? op25Locked
            ? 'OP25 running and locked'
            : 'OP25 running but not locked yet'
          : 'OP25 process not running',
        last_checked: checkedAt,
        details: {
          locked: op25Locked,
          last_status_update: status.lastUpdated || null,
          last_decode_time: status.lastDecodeTime || null,
          fresh: op25Fresh
        }
      },
      alsaLoopback: {
        status: hasAloop.ok && loopCard.ok ? 'green' : hasAloop.ok || loopCard.ok ? 'yellow' : 'red',
        message: hasAloop.ok && loopCard.ok
          ? 'snd-aloop loaded and loopback device present'
          : 'Loopback not fully detected (check snd-aloop and /proc/asound/cards)',
        last_checked: checkedAt
      },
      sdr: {
        status: rtlSdr.ok ? 'green' : 'yellow',
        message: rtlSdr.ok ? 'rtl_sdr binary found' : 'rtl_sdr not found in PATH (warning)',
        last_checked: checkedAt
      }
    }
  };
}

app.use(express.json({ limit: '5mb' }));
app.use(express.static('/app/public'));

app.get('/api/profiles', (_req, res) => {
  const current = activeProfile();
  const profiles = listProfiles().map(readProfileSummary);
  res.json({ profiles, activeProfile: current });
});

app.post('/api/profiles/switch', (req, res) => {
  const { profile } = req.body || {};
  if (!isSafeProfileName(profile)) {
    return res.status(400).json({ error: 'Invalid profile name' });
  }

  const pf = profileFile(profile);
  if (!fs.existsSync(pf)) {
    return res.status(404).json({ error: `Profile '${profile}' not found` });
  }

  const changedAt = nowIso();
  writeJson(ACTIVE_PROFILE_FILE, {
    profile,
    changedAt,
    changedBy: 'api'
  });

  triggerOp25Reload('profile-switch', profile);
  return res.json({ ok: true, profile, changedAt });
});

app.get('/api/talkgroups/:profile', (req, res) => {
  const { profile } = req.params;
  if (!isSafeProfileName(profile)) {
    return res.status(400).json({ error: 'Invalid profile name' });
  }

  const payload = readJson(talkgroupsFile(profile), { entries: [], filter: { policy: 'blacklist', allow: [], deny: [] } });
  return res.json(payload);
});

app.put('/api/talkgroups/:profile', (req, res) => {
  const { profile } = req.params;
  if (!isSafeProfileName(profile)) {
    return res.status(400).json({ error: 'Invalid profile name' });
  }

  const normalized = normalizeTalkgroupsPayload({ entries: req.body?.entries || [] });
  if (normalized.errors.length > 0) {
    return res.status(400).json({ error: normalized.errors.join('; ') });
  }

  const saved = persistTalkgroups(profile, normalized.entries);
  triggerOp25Reload('talkgroup-update', profile);
  return res.json({ ok: true, count: saved.entries.length, filter: saved.filter });
});

app.post('/api/talkgroups/import/:profile/preview', (req, res) => {
  const { profile } = req.params;
  if (!isSafeProfileName(profile)) {
    return res.status(400).json({ error: 'Invalid profile name' });
  }

  const normalized = normalizeTalkgroupsPayload(req.body || {});
  return res.json({ ok: normalized.errors.length === 0, errors: normalized.errors, entries: normalized.entries.slice(0, 200), total: normalized.entries.length });
});

app.post('/api/talkgroups/import/:profile/save', (req, res) => {
  const { profile } = req.params;
  if (!isSafeProfileName(profile)) {
    return res.status(400).json({ error: 'Invalid profile name' });
  }

  const normalized = normalizeTalkgroupsPayload(req.body || {});
  if (normalized.errors.length > 0) {
    return res.status(400).json({ error: normalized.errors.join('; '), errors: normalized.errors });
  }

  const saved = persistTalkgroups(profile, normalized.entries);
  triggerOp25Reload('talkgroup-import', profile);
  return res.json({ ok: true, count: saved.entries.length, filter: saved.filter });
});

app.post('/api/import/profile/:profile/preview', (req, res) => {
  const { profile } = req.params;
  const payload = req.body || {};

  let transformed = payload;
  if (typeof payload.csv === 'string') {
    const parsed = parseCsv(payload.csv);
    transformed = {
      importSource: 'csv',
      label: payload.label || profile,
      description: payload.description || '',
      system: {
        name: payload.systemName || profile,
        sysid: payload.sysid || '',
        wacn: payload.wacn || '',
        nac: payload.nac || '',
        bandplan: payload.bandplan || '',
        sites: [
          {
            name: payload.siteName || 'Default Site',
            controlChannels: String(payload.controlChannels || '').split(/[;\s]+/).filter(Boolean),
            alternateChannels: String(payload.alternateChannels || '').split(/[;\s]+/).filter(Boolean),
            nac: payload.siteNac || payload.nac || ''
          }
        ]
      },
      talkgroups: {
        csv: payload.csv
      }
    };
  }

  const result = normalizeProfileImport(profile, transformed);
  return res.json({
    ok: result.errors.length === 0,
    errors: result.errors,
    preview: {
      profile: result.profileDoc,
      talkgroups: result.talkgroupDoc.entries.slice(0, 200),
      totalTalkgroups: result.talkgroupDoc.entries.length
    }
  });
});

app.post('/api/import/profile/:profile/save', (req, res) => {
  const { profile } = req.params;
  const payload = req.body || {};

  let transformed = payload;
  if (typeof payload.csv === 'string') {
    const parsed = parseCsv(payload.csv);
    transformed = {
      importSource: 'csv',
      label: payload.label || profile,
      description: payload.description || '',
      system: {
        name: payload.systemName || profile,
        sysid: payload.sysid || '',
        wacn: payload.wacn || '',
        nac: payload.nac || '',
        bandplan: payload.bandplan || '',
        sites: [
          {
            name: payload.siteName || 'Default Site',
            controlChannels: String(payload.controlChannels || '').split(/[;\s]+/).filter(Boolean),
            alternateChannels: String(payload.alternateChannels || '').split(/[;\s]+/).filter(Boolean),
            nac: payload.siteNac || payload.nac || ''
          }
        ]
      },
      talkgroups: {
        csv: payload.csv
      }
    };
    if (parsed.rows.length === 0) {
      return res.status(400).json({ error: 'CSV payload had no rows' });
    }
  }

  const result = normalizeProfileImport(profile, transformed);
  if (result.errors.length > 0) {
    return res.status(400).json({ error: result.errors.join('; '), errors: result.errors });
  }

  writeJson(profileFile(profile), result.profileDoc);
  const talkgroupDoc = persistTalkgroups(profile, result.talkgroupDoc.entries);

  const tsvPath = path.join(PROFILES_DIR, `${profile}.tsv`);
  if (!fs.existsSync(tsvPath)) {
    fs.writeFileSync(tsvPath, '# generated placeholder - update with full OP25 trunk config\n', 'utf8');
  }

  triggerOp25Reload('profile-import', profile);
  return res.json({ ok: true, profile, talkgroups: talkgroupDoc.entries.length, filter: talkgroupDoc.filter });
});

app.post('/api/import/profile/:profile/from-json-file', (req, res) => {
  const { profile } = req.params;
  if (!isSafeProfileName(profile)) {
    return res.status(400).json({ error: 'Invalid profile name' });
  }

  const fileName = req.body?.fileName || `${profile}.import.json`;
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(fileName)) {
    return res.status(400).json({ error: 'Invalid file name' });
  }

  const filePath = path.join(PROFILES_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `Import file not found: ${fileName}` });
  }

  const raw = readJson(filePath, null);
  if (!raw) {
    return res.status(400).json({ error: `Unable to parse JSON from ${fileName}` });
  }

  const result = normalizeProfileImport(profile, { ...raw, importSource: `json-file:${fileName}` });
  if (result.errors.length > 0) {
    return res.status(400).json({ error: result.errors.join('; '), errors: result.errors });
  }

  writeJson(profileFile(profile), result.profileDoc);
  const talkgroupDoc = persistTalkgroups(profile, result.talkgroupDoc.entries);
  triggerOp25Reload('profile-json-import', profile);

  return res.json({ ok: true, profile, fileName, talkgroups: talkgroupDoc.entries.length, filter: talkgroupDoc.filter });
});

app.get('/api/import/templates', (_req, res) => {
  res.json({
    csvHeaders: ['tgid', 'label', 'mode', 'encrypted', 'category', 'favorite', 'enabled'],
    csvExample: [
      'tgid,label,mode,encrypted,category,favorite,enabled',
      '1201,Dispatch A,D,false,dispatch,true,true',
      '1202,TAC 2,T,false,tac,false,true',
      '1299,Encrypted Ops,DE,true,ops,false,true'
    ].join('\n'),
    jsonExample: {
      label: 'AZDPS',
      description: 'User supplied import',
      system: {
        name: 'Arizona DPS',
        sysid: '123',
        wacn: 'BEE00',
        nac: '293',
        bandplan: 'P25 Auto',
        sites: [
          {
            name: 'Phoenix Simulcast',
            controlChannels: ['771.10625', '771.35625'],
            alternateChannels: ['770.85625'],
            nac: '293'
          }
        ]
      },
      talkgroups: {
        entries: [
          { tgid: 1201, label: 'Dispatch A', mode: 'D', encrypted: false, category: 'dispatch', favorite: true, enabled: true }
        ]
      }
    }
  });
});

app.get('/api/health', async (_req, res) => {
  const health = await buildHealth();
  res.json(health);
});

app.get('/api/status', (_req, res) => {
  const status = readJson(STATUS_FILE, {});
  const profile = activeProfile();
  return res.json({
    activeProfile: profile,
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
