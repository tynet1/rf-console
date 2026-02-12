const state = {
  profiles: [],
  activeProfile: null,
  talkgroups: [],
  filteredTalkgroups: [],
  categories: ['all'],
  page: 1,
  pageSize: 40,
  templates: null
};

const el = {
  healthGrid: document.getElementById('healthGrid'),
  activeProfile: document.getElementById('activeProfile'),
  controlFreq: document.getElementById('controlFreq'),
  rssi: document.getElementById('rssi'),
  sysid: document.getElementById('sysid'),
  wacn: document.getElementById('wacn'),
  nac: document.getElementById('nac'),
  currentTg: document.getElementById('currentTg'),
  lastTg: document.getElementById('lastTg'),
  locked: document.getElementById('locked'),
  lastDecode: document.getElementById('lastDecode'),
  updated: document.getElementById('updated'),
  profileSelect: document.getElementById('profileSelect'),
  switchBtn: document.getElementById('switchBtn'),
  adminToken: document.getElementById('adminToken'),
  saveTokenBtn: document.getElementById('saveTokenBtn'),
  checkControlBtn: document.getElementById('checkControlBtn'),
  controlMsg: document.getElementById('controlMsg'),
  controlOutput: document.getElementById('controlOutput'),
  tgSearch: document.getElementById('tgSearch'),
  tgCategory: document.getElementById('tgCategory'),
  tgFavoritesOnly: document.getElementById('tgFavoritesOnly'),
  tgShowEncrypted: document.getElementById('tgShowEncrypted'),
  bulkCategory: document.getElementById('bulkCategory'),
  bulkEnableBtn: document.getElementById('bulkEnableBtn'),
  bulkDisableBtn: document.getElementById('bulkDisableBtn'),
  saveTgBtn: document.getElementById('saveTgBtn'),
  tgTable: document.getElementById('tgTable'),
  prevPageBtn: document.getElementById('prevPageBtn'),
  nextPageBtn: document.getElementById('nextPageBtn'),
  pageInfo: document.getElementById('pageInfo'),
  importProfile: document.getElementById('importProfile'),
  copySitesTemplateBtn: document.getElementById('copySitesTemplateBtn'),
  copyTgTemplateBtn: document.getElementById('copyTgTemplateBtn'),
  loadJsonBtn: document.getElementById('loadJsonBtn'),
  sitesCsv: document.getElementById('sitesCsv'),
  sitesFile: document.getElementById('sitesFile'),
  previewSitesBtn: document.getElementById('previewSitesBtn'),
  saveSitesBtn: document.getElementById('saveSitesBtn'),
  tgCsv: document.getElementById('tgCsv'),
  tgFile: document.getElementById('tgFile'),
  previewTgBtn: document.getElementById('previewTgBtn'),
  saveTgImportBtn: document.getElementById('saveTgImportBtn'),
  importMsg: document.getElementById('importMsg'),
  importErrors: document.getElementById('importErrors'),
  importPreviewTable: document.getElementById('importPreviewTable'),
  audioPlayer: document.getElementById('audioPlayer')
};

function getAdminToken() {
  return localStorage.getItem('rf_admin_token') || '';
}

function setAdminToken(token) {
  localStorage.setItem('rf_admin_token', token || '');
}

async function fetchJson(url, init = {}, withAdmin = false) {
  const headers = { ...(init.headers || {}) };
  if (withAdmin) {
    headers['x-admin-token'] = getAdminToken();
  }
  const res = await fetch(url, { ...init, headers });
  const txt = await res.text();
  let data;
  try {
    data = txt ? JSON.parse(txt) : {};
  } catch {
    data = { error: txt };
  }
  if (!res.ok) {
    throw new Error(data.error || txt || `HTTP ${res.status}`);
  }
  return data;
}

function setText(node, value) {
  node.textContent = value == null || value === '' ? '-' : String(value);
}

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tabPanel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`));
}

function appendOutput(text) {
  const stamp = new Date().toISOString();
  el.controlOutput.textContent = `[${stamp}] ${text}\n\n${el.controlOutput.textContent}`;
}

function renderHealth(health) {
  const checks = health.checks || {};
  el.healthGrid.innerHTML = '';
  Object.entries(checks).forEach(([name, info]) => {
    const row = document.createElement('div');
    row.className = 'healthItem';
    row.innerHTML = `
      <span class="light ${info.status || 'yellow'}"></span>
      <div>
        <strong>${name}</strong>
        <div class="muted">${info.message || '-'}</div>
        <div class="muted">checked: ${info.last_checked || '-'}</div>
      </div>
    `;
    el.healthGrid.appendChild(row);
  });
}

async function refreshHealth() {
  try {
    const health = await fetchJson('/api/health');
    renderHealth(health);
  } catch (err) {
    el.healthGrid.innerHTML = `<div class="healthItem"><span class="light red"></span><div><strong>health</strong><div class="muted">${err.message}</div></div></div>`;
  }
}

async function refreshStatus() {
  try {
    const data = await fetchJson('/api/status');
    state.activeProfile = data.activeProfile;
    setText(el.activeProfile, data.activeProfile);
    setText(el.controlFreq, data.status.currentControlFrequency);
    setText(el.rssi, data.status.rssi);
    setText(el.sysid, data.status.system.sysid);
    setText(el.wacn, data.status.system.wacn);
    setText(el.nac, data.status.system.nac);
    setText(el.currentTg, data.status.talkgroup.current);
    setText(el.lastTg, data.status.talkgroup.last);
    setText(el.locked, data.status.locked ? 'Yes' : 'No');
    setText(el.lastDecode, data.status.lastDecodeTime);
    setText(el.updated, data.status.lastUpdated);
    el.audioPlayer.src = data.streamUrl;
  } catch (err) {
    appendOutput(`Status error: ${err.message}`);
  }
}

function renderProfiles() {
  el.profileSelect.innerHTML = '';
  state.profiles.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.label || p.name;
    if (p.name === state.activeProfile) opt.selected = true;
    el.profileSelect.appendChild(opt);
  });
}

async function loadProfiles() {
  const data = await fetchJson('/api/profiles');
  state.profiles = data.profiles || [];
  state.activeProfile = data.activeProfile || (state.profiles[0] ? state.profiles[0].name : null);
  renderProfiles();
  if (state.activeProfile) {
    await loadTalkgroups(state.activeProfile);
  }
}

function collectCategories() {
  const set = new Set(['all']);
  state.talkgroups.forEach((tg) => set.add((tg.category || 'uncategorized').toLowerCase()));
  state.categories = Array.from(set);
  [el.tgCategory, el.bulkCategory].forEach((node) => {
    node.innerHTML = '';
    state.categories.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      node.appendChild(opt);
    });
  });
}

async function loadTalkgroups(profile) {
  const data = await fetchJson(`/api/talkgroups/${encodeURIComponent(profile)}`);
  state.talkgroups = (data.entries || []).map((tg) => ({
    ...tg,
    category: tg.category || 'uncategorized',
    encrypted: !!tg.encrypted,
    favorite: !!tg.favorite,
    mode: tg.mode || (tg.encrypted ? 'DE' : 'D'),
    enabled: tg.enabled !== false
  }));
  collectCategories();
  applyTalkgroupFilters();
}

function updateCurrentPageModel() {
  const rows = Array.from(el.tgTable.querySelectorAll('tr'));
  rows.forEach((row) => {
    const tgid = Number(row.dataset.tgid);
    const idx = state.talkgroups.findIndex((x) => x.tgid === tgid);
    if (idx < 0) return;
    const mode = row.querySelector('.mode').value;
    const encrypted = mode.endsWith('E');
    state.talkgroups[idx] = {
      ...state.talkgroups[idx],
      label: row.querySelector('.label').value.trim(),
      category: row.querySelector('.category').value.trim() || 'uncategorized',
      mode,
      encrypted,
      filterAction: encrypted ? 'deny' : 'allow',
      favorite: row.querySelector('.favorite').checked,
      enabled: row.querySelector('.enabled').checked
    };
  });
}

function renderTalkgroupPage() {
  el.tgTable.innerHTML = '';
  const total = state.filteredTalkgroups.length;
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  if (state.page > pages) state.page = pages;
  const start = (state.page - 1) * state.pageSize;
  const pageRows = state.filteredTalkgroups.slice(start, start + state.pageSize);

  pageRows.forEach((tg) => {
    const tr = document.createElement('tr');
    tr.dataset.tgid = String(tg.tgid);
    tr.innerHTML = `
      <td>${tg.tgid}</td>
      <td><input class="label" type="text" value="${(tg.label || '').replace(/"/g, '&quot;')}" /></td>
      <td><input class="category" type="text" value="${(tg.category || '').replace(/"/g, '&quot;')}" /></td>
      <td>
        <select class="mode">
          <option value="D">D</option>
          <option value="T">T</option>
          <option value="DE">DE</option>
          <option value="TE">TE</option>
        </select>
      </td>
      <td>${tg.encrypted ? '<span class="encTag">ENC</span>' : '-'}</td>
      <td><input class="favorite" type="checkbox" ${tg.favorite ? 'checked' : ''} /></td>
      <td><input class="enabled" type="checkbox" ${tg.enabled ? 'checked' : ''} /></td>
    `;
    tr.querySelector('.mode').value = tg.mode || (tg.encrypted ? 'DE' : 'D');
    el.tgTable.appendChild(tr);
  });

  el.pageInfo.textContent = `Page ${state.page}/${pages} (${total} rows)`;
}

function applyTalkgroupFilters() {
  const q = el.tgSearch.value.trim().toLowerCase();
  const cat = el.tgCategory.value || 'all';
  const onlyFav = el.tgFavoritesOnly.checked;
  const showEnc = el.tgShowEncrypted.checked;

  state.filteredTalkgroups = state.talkgroups.filter((tg) => {
    if (!showEnc && tg.encrypted) return false;
    if (onlyFav && !tg.favorite) return false;
    if (cat !== 'all' && (tg.category || 'uncategorized').toLowerCase() !== cat) return false;
    if (!q) return true;
    return `${tg.tgid} ${tg.label || ''}`.toLowerCase().includes(q);
  });

  state.page = 1;
  renderTalkgroupPage();
}

async function saveTalkgroups() {
  updateCurrentPageModel();
  const profile = state.activeProfile || el.profileSelect.value;
  const entries = state.talkgroups.map((tg) => ({
    tgid: tg.tgid,
    label: tg.label,
    mode: tg.mode,
    encrypted: !!tg.encrypted,
    category: tg.category,
    favorite: !!tg.favorite,
    enabled: tg.enabled !== false
  }));
  const resp = await fetchJson(`/api/talkgroups/${encodeURIComponent(profile)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries })
  });
  appendOutput(`Saved ${entries.length} talkgroups (${resp.filter.policy})`);
}

function renderImportPreview(type, rows) {
  el.importPreviewTable.innerHTML = '';
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    if (type === 'sites') {
      tr.innerHTML = `<td>site</td><td>${row.name || ''}</td><td>${(row.controlChannels || []).join(';')}</td><td>${(row.alternateChannels || []).join(';')}</td><td>${row.nac || ''}</td>`;
    } else {
      tr.innerHTML = `<td>tg</td><td>${row.tgid || ''}</td><td>${row.label || ''}</td><td>${row.mode || ''}</td><td>${row.category || ''}</td>`;
    }
    el.importPreviewTable.appendChild(tr);
  });
}

function setImportResult(message, errors = []) {
  el.importMsg.textContent = message;
  el.importErrors.textContent = errors.join('\n');
}

async function loadTemplates() {
  state.templates = await fetchJson('/api/import/templates');
}

async function doControlAction(action) {
  if (!confirm(`Run action: ${action}?`)) return;
  try {
    const resp = await fetchJson('/api/control/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    }, true);
    appendOutput(`${resp.action} (exit ${resp.exitCode})\nSTDOUT:\n${resp.stdout || ''}\nSTDERR:\n${resp.stderr || ''}`);
  } catch (err) {
    appendOutput(`Action ${action} failed: ${err.message}`);
  }
}

async function showLogs(target) {
  try {
    const resp = await fetchJson(`/api/control/logs/${encodeURIComponent(target)}?lines=200`, {}, true);
    appendOutput(`${resp.action} (exit ${resp.exitCode})\n${resp.stdout || ''}\n${resp.stderr || ''}`);
  } catch (err) {
    appendOutput(`Log fetch ${target} failed: ${err.message}`);
  }
}

function bindFiles() {
  el.sitesFile.addEventListener('change', async (ev) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    el.sitesCsv.value = await f.text();
  });
  el.tgFile.addEventListener('change', async (ev) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    el.tgCsv.value = await f.text();
  });
}

function bindEvents() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  el.adminToken.value = getAdminToken();
  el.saveTokenBtn.addEventListener('click', () => {
    setAdminToken(el.adminToken.value.trim());
    el.controlMsg.textContent = 'Admin token saved locally in browser storage.';
  });

  el.checkControlBtn.addEventListener('click', async () => {
    try {
      const caps = await fetchJson('/api/control/capabilities', {}, true);
      el.controlMsg.textContent = `helperConfigured=${caps.helperConfigured}, helperReachable=${caps.helperReachable}`;
    } catch (err) {
      el.controlMsg.textContent = `Control access check failed: ${err.message}`;
    }
  });

  el.switchBtn.addEventListener('click', async () => {
    const profile = el.profileSelect.value;
    try {
      await fetchJson('/api/profiles/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile })
      });
      state.activeProfile = profile;
      el.controlMsg.textContent = `Profile switched to ${profile}`;
      await loadTalkgroups(profile);
      await refreshStatus();
      await refreshHealth();
    } catch (err) {
      el.controlMsg.textContent = `Profile switch failed: ${err.message}`;
    }
  });

  document.querySelectorAll('.actionBtn').forEach((btn) => {
    btn.addEventListener('click', () => doControlAction(btn.dataset.action));
  });

  document.querySelectorAll('.logBtn').forEach((btn) => {
    btn.addEventListener('click', () => showLogs(btn.dataset.log));
  });

  [el.tgSearch, el.tgCategory, el.tgFavoritesOnly, el.tgShowEncrypted].forEach((node) => {
    node.addEventListener('input', () => {
      updateCurrentPageModel();
      applyTalkgroupFilters();
    });
    node.addEventListener('change', () => {
      updateCurrentPageModel();
      applyTalkgroupFilters();
    });
  });

  el.prevPageBtn.addEventListener('click', () => {
    updateCurrentPageModel();
    if (state.page > 1) state.page -= 1;
    renderTalkgroupPage();
  });

  el.nextPageBtn.addEventListener('click', () => {
    updateCurrentPageModel();
    const pages = Math.max(1, Math.ceil(state.filteredTalkgroups.length / state.pageSize));
    if (state.page < pages) state.page += 1;
    renderTalkgroupPage();
  });

  el.bulkEnableBtn.addEventListener('click', () => {
    updateCurrentPageModel();
    const cat = el.bulkCategory.value;
    state.talkgroups = state.talkgroups.map((tg) => (
      cat === 'all' || (tg.category || 'uncategorized').toLowerCase() === cat ? { ...tg, enabled: true } : tg
    ));
    applyTalkgroupFilters();
  });

  el.bulkDisableBtn.addEventListener('click', () => {
    updateCurrentPageModel();
    const cat = el.bulkCategory.value;
    state.talkgroups = state.talkgroups.map((tg) => (
      cat === 'all' || (tg.category || 'uncategorized').toLowerCase() === cat ? { ...tg, enabled: false } : tg
    ));
    applyTalkgroupFilters();
  });

  el.saveTgBtn.addEventListener('click', async () => {
    try {
      await saveTalkgroups();
      await refreshHealth();
    } catch (err) {
      appendOutput(`Save talkgroups failed: ${err.message}`);
    }
  });

  el.copySitesTemplateBtn.addEventListener('click', async () => {
    if (!state.templates) await loadTemplates();
    await navigator.clipboard.writeText(state.templates.sitesCsvTemplate);
    setImportResult('Copied sites CSV template');
  });

  el.copyTgTemplateBtn.addEventListener('click', async () => {
    if (!state.templates) await loadTemplates();
    await navigator.clipboard.writeText(state.templates.talkgroupsCsvTemplate);
    setImportResult('Copied talkgroups CSV template');
  });

  el.previewSitesBtn.addEventListener('click', async () => {
    try {
      const profile = el.importProfile.value;
      const resp = await fetchJson(`/api/import/sites/${encodeURIComponent(profile)}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: el.sitesCsv.value })
      });
      renderImportPreview('sites', resp.preview || []);
      setImportResult(`Sites preview: ${resp.total} rows`, resp.errors || []);
    } catch (err) {
      setImportResult('', [err.message]);
    }
  });

  el.saveSitesBtn.addEventListener('click', async () => {
    try {
      const profile = el.importProfile.value;
      const resp = await fetchJson(`/api/import/sites/${encodeURIComponent(profile)}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: el.sitesCsv.value })
      });
      setImportResult(`Saved ${resp.sites} site rows for ${profile}`);
      await loadProfiles();
      await refreshHealth();
    } catch (err) {
      setImportResult('', [err.message]);
    }
  });

  el.previewTgBtn.addEventListener('click', async () => {
    try {
      const profile = el.importProfile.value;
      const resp = await fetchJson(`/api/import/talkgroups/${encodeURIComponent(profile)}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: el.tgCsv.value })
      });
      renderImportPreview('tg', resp.preview || []);
      setImportResult(`Talkgroup preview: ${resp.total} rows`, resp.errors || []);
    } catch (err) {
      setImportResult('', [err.message]);
    }
  });

  el.saveTgImportBtn.addEventListener('click', async () => {
    try {
      const profile = el.importProfile.value;
      const resp = await fetchJson(`/api/import/talkgroups/${encodeURIComponent(profile)}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: el.tgCsv.value })
      });
      setImportResult(`Saved ${resp.talkgroups} talkgroups for ${profile}`);
      if (profile === state.activeProfile) {
        await loadTalkgroups(profile);
      }
    } catch (err) {
      setImportResult('', [err.message]);
    }
  });

  el.loadJsonBtn.addEventListener('click', async () => {
    const profile = el.importProfile.value;
    const fileName = prompt(`JSON filename in /data/profiles (default ${profile}.import.json):`) || `${profile}.import.json`;
    try {
      const resp = await fetchJson(`/api/import/profile/${encodeURIComponent(profile)}/from-json-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName })
      });
      setImportResult(`Imported ${resp.fileName} with ${resp.talkgroups} talkgroups`);
      await loadProfiles();
      if (profile === state.activeProfile) await loadTalkgroups(profile);
    } catch (err) {
      setImportResult('', [err.message]);
    }
  });

  bindFiles();
}

(async () => {
  bindEvents();
  await loadTemplates();
  await loadProfiles();
  await refreshStatus();
  await refreshHealth();
  setInterval(refreshStatus, 3000);
  setInterval(refreshHealth, 4000);
})();
