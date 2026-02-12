const state = {
  profiles: [],
  activeProfile: null,
  talkgroups: [],
  filtered: [],
  page: 1,
  pageSize: 40,
  categories: ['all'],
  previewRows: []
};

const el = {
  profileSelect: document.getElementById('profileSelect'),
  switchBtn: document.getElementById('switchBtn'),
  profileMsg: document.getElementById('profileMsg'),
  healthGrid: document.getElementById('healthGrid'),
  tgTable: document.getElementById('tgTable'),
  saveTgBtn: document.getElementById('saveTgBtn'),
  tgSearch: document.getElementById('tgSearch'),
  tgCategory: document.getElementById('tgCategory'),
  tgShowEncrypted: document.getElementById('tgShowEncrypted'),
  tgFavoritesOnly: document.getElementById('tgFavoritesOnly'),
  bulkCategory: document.getElementById('bulkCategory'),
  bulkEnableBtn: document.getElementById('bulkEnableBtn'),
  bulkDisableBtn: document.getElementById('bulkDisableBtn'),
  prevPageBtn: document.getElementById('prevPageBtn'),
  nextPageBtn: document.getElementById('nextPageBtn'),
  pageInfo: document.getElementById('pageInfo'),
  audioPlayer: document.getElementById('audioPlayer'),
  builderProfile: document.getElementById('builderProfile'),
  builderLabel: document.getElementById('builderLabel'),
  builderSystemName: document.getElementById('builderSystemName'),
  builderSysid: document.getElementById('builderSysid'),
  builderWacn: document.getElementById('builderWacn'),
  builderNac: document.getElementById('builderNac'),
  builderBandplan: document.getElementById('builderBandplan'),
  builderSiteName: document.getElementById('builderSiteName'),
  builderControlChannels: document.getElementById('builderControlChannels'),
  builderAlternateChannels: document.getElementById('builderAlternateChannels'),
  builderCsv: document.getElementById('builderCsv'),
  builderFile: document.getElementById('builderFile'),
  previewImportBtn: document.getElementById('previewImportBtn'),
  saveImportBtn: document.getElementById('saveImportBtn'),
  jsonImportBtn: document.getElementById('jsonImportBtn'),
  builderMsg: document.getElementById('builderMsg'),
  builderErrors: document.getElementById('builderErrors'),
  previewTable: document.getElementById('previewTable'),
  fields: {
    controlFreq: document.getElementById('controlFreq'),
    rssi: document.getElementById('rssi'),
    sysid: document.getElementById('sysid'),
    wacn: document.getElementById('wacn'),
    nac: document.getElementById('nac'),
    currentTg: document.getElementById('currentTg'),
    lastTg: document.getElementById('lastTg'),
    locked: document.getElementById('locked'),
    lastDecode: document.getElementById('lastDecode'),
    updated: document.getElementById('updated')
  }
};

async function fetchJson(url, init = {}) {
  const res = await fetch(url, init);
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return res.json();
}

function setText(node, value) {
  node.textContent = value == null || value === '' ? '-' : String(value);
}

function debounce(fn, delay = 220) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

function renderProfiles() {
  el.profileSelect.innerHTML = '';
  state.profiles.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.label || p.name;
    if (p.name === state.activeProfile) {
      opt.selected = true;
    }
    el.profileSelect.appendChild(opt);
  });
}

function collectCategories(entries) {
  const set = new Set(['all']);
  entries.forEach((e) => set.add((e.category || 'uncategorized').toLowerCase()));
  return Array.from(set);
}

function renderCategorySelectors() {
  const fill = (node) => {
    node.innerHTML = '';
    state.categories.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      node.appendChild(opt);
    });
  };
  fill(el.tgCategory);
  fill(el.bulkCategory);
}

function applyTalkgroupFilters() {
  const q = el.tgSearch.value.trim().toLowerCase();
  const category = el.tgCategory.value || 'all';
  const showEncrypted = el.tgShowEncrypted.checked;
  const favoritesOnly = el.tgFavoritesOnly.checked;

  state.filtered = state.talkgroups.filter((tg) => {
    if (!showEncrypted && tg.encrypted) return false;
    if (favoritesOnly && !tg.favorite) return false;
    if (category !== 'all' && (tg.category || 'uncategorized').toLowerCase() !== category) return false;
    if (!q) return true;
    const hay = `${tg.tgid} ${tg.label || ''}`.toLowerCase();
    return hay.includes(q);
  });

  state.page = 1;
  renderTalkgroupsPage();
}

function rowForTalkgroup(tg) {
  const tr = document.createElement('tr');
  tr.dataset.tgid = String(tg.tgid);
  tr.innerHTML = `
    <td>${tg.tgid}</td>
    <td><input class="tg-label" type="text" value="${(tg.label || '').replace(/"/g, '&quot;')}" /></td>
    <td><input class="tg-category" type="text" value="${(tg.category || 'uncategorized').replace(/"/g, '&quot;')}" /></td>
    <td>
      <select class="tg-mode">
        <option value="D">D</option>
        <option value="T">T</option>
        <option value="DE">DE</option>
        <option value="TE">TE</option>
      </select>
    </td>
    <td>${tg.encrypted ? '<span class="encTag">ENC</span>' : '-'}</td>
    <td><input class="tg-favorite" type="checkbox" ${tg.favorite ? 'checked' : ''} /></td>
    <td><input class="tg-enabled" type="checkbox" ${tg.enabled !== false ? 'checked' : ''} /></td>
  `;
  tr.querySelector('.tg-mode').value = tg.mode || (tg.filterAction === 'deny' ? 'DE' : 'D');
  return tr;
}

function renderTalkgroupsPage() {
  el.tgTable.innerHTML = '';
  const total = state.filtered.length;
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  if (state.page > pages) {
    state.page = pages;
  }
  const start = (state.page - 1) * state.pageSize;
  const current = state.filtered.slice(start, start + state.pageSize);
  current.forEach((tg) => el.tgTable.appendChild(rowForTalkgroup(tg)));
  el.pageInfo.textContent = `Page ${state.page}/${pages} (${total} rows)`;
}

function updateBackingModelFromPage() {
  const rows = Array.from(el.tgTable.querySelectorAll('tr'));
  rows.forEach((tr) => {
    const tgid = Number(tr.dataset.tgid);
    const idx = state.talkgroups.findIndex((x) => x.tgid === tgid);
    if (idx < 0) return;
    const mode = tr.querySelector('.tg-mode').value;
    state.talkgroups[idx] = {
      ...state.talkgroups[idx],
      label: tr.querySelector('.tg-label').value.trim(),
      category: tr.querySelector('.tg-category').value.trim() || 'uncategorized',
      mode,
      encrypted: mode.endsWith('E'),
      filterAction: mode.endsWith('E') ? 'deny' : 'allow',
      favorite: tr.querySelector('.tg-favorite').checked,
      enabled: tr.querySelector('.tg-enabled').checked
    };
  });
}

function toSaveEntries() {
  return state.talkgroups.map((tg) => ({
    tgid: tg.tgid,
    label: tg.label,
    mode: tg.mode || 'D',
    encrypted: !!tg.encrypted,
    category: tg.category || 'uncategorized',
    favorite: !!tg.favorite,
    enabled: tg.enabled !== false
  }));
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

async function loadTalkgroups(profile) {
  const data = await fetchJson(`/api/talkgroups/${encodeURIComponent(profile)}`);
  state.talkgroups = (data.entries || []).map((tg) => ({
    ...tg,
    mode: tg.mode || (tg.filterAction === 'deny' ? 'DE' : 'D'),
    encrypted: tg.encrypted || String(tg.mode || '').endsWith('E'),
    category: tg.category || 'uncategorized',
    favorite: !!tg.favorite,
    enabled: tg.enabled !== false
  }));
  state.categories = collectCategories(state.talkgroups);
  renderCategorySelectors();
  applyTalkgroupFilters();
}

function renderHealth(data) {
  const checks = data.checks || {};
  el.healthGrid.innerHTML = '';
  Object.entries(checks).forEach(([key, value]) => {
    const item = document.createElement('div');
    item.className = 'healthItem';
    item.innerHTML = `
      <span class="light ${value.status || 'yellow'}"></span>
      <div>
        <strong>${key}</strong>
        <div class="muted">${value.message || '-'}</div>
        <div class="muted">Checked: ${value.last_checked || '-'}</div>
      </div>
    `;
    el.healthGrid.appendChild(item);
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
    setText(el.fields.controlFreq, data.status.currentControlFrequency);
    setText(el.fields.rssi, data.status.rssi);
    setText(el.fields.sysid, data.status.system.sysid);
    setText(el.fields.wacn, data.status.system.wacn);
    setText(el.fields.nac, data.status.system.nac);
    setText(el.fields.currentTg, data.status.talkgroup.current);
    setText(el.fields.lastTg, data.status.talkgroup.last);
    setText(el.fields.locked, data.status.locked ? 'Yes' : 'No');
    setText(el.fields.lastDecode, data.status.lastDecodeTime);
    setText(el.fields.updated, data.status.lastUpdated);
    el.audioPlayer.src = data.streamUrl;
    el.profileMsg.textContent = `Active profile: ${state.activeProfile || 'n/a'}`;
  } catch (err) {
    el.profileMsg.textContent = `Status error: ${err.message}`;
  }
}

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tabPanel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });
}

function builderPayloadFromForm() {
  return {
    label: el.builderLabel.value.trim() || el.builderProfile.value,
    description: `Imported ${el.builderProfile.value} profile data`,
    systemName: el.builderSystemName.value.trim(),
    sysid: el.builderSysid.value.trim(),
    wacn: el.builderWacn.value.trim(),
    nac: el.builderNac.value.trim(),
    bandplan: el.builderBandplan.value.trim(),
    siteName: el.builderSiteName.value.trim(),
    controlChannels: el.builderControlChannels.value.trim(),
    alternateChannels: el.builderAlternateChannels.value.trim(),
    csv: el.builderCsv.value
  };
}

function renderPreviewRows(rows) {
  el.previewTable.innerHTML = '';
  rows.forEach((tg) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${tg.tgid}</td>
      <td>${tg.label || ''}</td>
      <td>${tg.mode || ''}</td>
      <td>${tg.encrypted ? 'yes' : 'no'}</td>
      <td>${tg.category || ''}</td>
    `;
    el.previewTable.appendChild(tr);
  });
}

async function previewImport() {
  const profile = el.builderProfile.value;
  const payload = builderPayloadFromForm();
  const resp = await fetchJson(`/api/import/profile/${encodeURIComponent(profile)}/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  state.previewRows = resp.preview?.talkgroups || [];
  renderPreviewRows(state.previewRows);
  el.builderErrors.textContent = (resp.errors || []).join('\n');
  el.builderMsg.textContent = `Preview: ${resp.preview?.totalTalkgroups || 0} talkgroups`;
}

async function saveImport() {
  const profile = el.builderProfile.value;
  const payload = builderPayloadFromForm();
  const resp = await fetchJson(`/api/import/profile/${encodeURIComponent(profile)}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  el.builderMsg.textContent = `Saved ${resp.talkgroups} talkgroups to ${profile}`;
  el.builderErrors.textContent = '';
  await loadProfiles();
  await refreshStatus();
}

async function importFromJsonFile() {
  const profile = el.builderProfile.value;
  const fileName = prompt(`JSON file in /data/profiles (default: ${profile}.import.json)`);
  const resp = await fetchJson(`/api/import/profile/${encodeURIComponent(profile)}/from-json-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: fileName || `${profile}.import.json` })
  });
  el.builderMsg.textContent = `Imported ${resp.fileName}: ${resp.talkgroups} talkgroups`;
  await loadProfiles();
}

function setupFileInput() {
  el.builderFile.addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const text = await file.text();
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
      el.builderCsv.value = text;
      el.builderMsg.textContent = `Loaded CSV file ${file.name}`;
      return;
    }
    if (lower.endsWith('.json')) {
      try {
        const obj = JSON.parse(text);
        el.builderCsv.value = '';
        el.builderLabel.value = obj.label || el.builderLabel.value;
        el.builderSystemName.value = obj.system?.name || el.builderSystemName.value;
        el.builderSysid.value = obj.system?.sysid || '';
        el.builderWacn.value = obj.system?.wacn || '';
        el.builderNac.value = obj.system?.nac || '';
        el.builderBandplan.value = obj.system?.bandplan || '';
        if (Array.isArray(obj.system?.sites) && obj.system.sites[0]) {
          const site = obj.system.sites[0];
          el.builderSiteName.value = site.name || '';
          el.builderControlChannels.value = (site.controlChannels || []).join(';');
          el.builderAlternateChannels.value = (site.alternateChannels || []).join(';');
        }
        if (Array.isArray(obj.talkgroups?.entries)) {
          const csv = ['tgid,label,mode,encrypted,category,favorite,enabled'];
          obj.talkgroups.entries.forEach((tg) => {
            csv.push([
              tg.tgid,
              tg.label || '',
              tg.mode || 'D',
              tg.encrypted ? 'true' : 'false',
              tg.category || 'uncategorized',
              tg.favorite ? 'true' : 'false',
              tg.enabled === false ? 'false' : 'true'
            ].join(','));
          });
          el.builderCsv.value = csv.join('\n');
        }
        el.builderMsg.textContent = `Loaded JSON file ${file.name}`;
      } catch (err) {
        el.builderErrors.textContent = `JSON parse error: ${err.message}`;
      }
    }
  });
}

function bindEvents() {
  document.querySelectorAll('.tab').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  el.switchBtn.addEventListener('click', async () => {
    const profile = el.profileSelect.value;
    await fetchJson('/api/profiles/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile })
    });
    state.activeProfile = profile;
    el.profileMsg.textContent = `Profile switched to ${profile}`;
    await loadTalkgroups(profile);
    await refreshStatus();
    await refreshHealth();
  });

  const applyFiltersDebounced = debounce(() => {
    updateBackingModelFromPage();
    applyTalkgroupFilters();
  }, 200);

  [el.tgSearch, el.tgCategory, el.tgShowEncrypted, el.tgFavoritesOnly].forEach((node) => {
    node.addEventListener('input', applyFiltersDebounced);
    node.addEventListener('change', applyFiltersDebounced);
  });

  el.prevPageBtn.addEventListener('click', () => {
    updateBackingModelFromPage();
    if (state.page > 1) state.page -= 1;
    renderTalkgroupsPage();
  });
  el.nextPageBtn.addEventListener('click', () => {
    updateBackingModelFromPage();
    const pages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
    if (state.page < pages) state.page += 1;
    renderTalkgroupsPage();
  });

  el.bulkEnableBtn.addEventListener('click', () => {
    updateBackingModelFromPage();
    const category = el.bulkCategory.value;
    state.talkgroups = state.talkgroups.map((tg) => {
      if (category === 'all' || (tg.category || 'uncategorized').toLowerCase() === category) {
        return { ...tg, enabled: true };
      }
      return tg;
    });
    applyTalkgroupFilters();
  });

  el.bulkDisableBtn.addEventListener('click', () => {
    updateBackingModelFromPage();
    const category = el.bulkCategory.value;
    state.talkgroups = state.talkgroups.map((tg) => {
      if (category === 'all' || (tg.category || 'uncategorized').toLowerCase() === category) {
        return { ...tg, enabled: false };
      }
      return tg;
    });
    applyTalkgroupFilters();
  });

  el.saveTgBtn.addEventListener('click', async () => {
    updateBackingModelFromPage();
    const entries = toSaveEntries();
    const profile = state.activeProfile || el.profileSelect.value;
    const resp = await fetchJson(`/api/talkgroups/${encodeURIComponent(profile)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries })
    });
    el.profileMsg.textContent = `Saved ${entries.length} talkgroups (${resp.filter.policy})`;
    await refreshHealth();
  });

  el.previewImportBtn.addEventListener('click', async () => {
    try {
      await previewImport();
    } catch (err) {
      el.builderErrors.textContent = err.message;
    }
  });

  el.saveImportBtn.addEventListener('click', async () => {
    try {
      await saveImport();
    } catch (err) {
      el.builderErrors.textContent = err.message;
    }
  });

  el.jsonImportBtn.addEventListener('click', async () => {
    try {
      await importFromJsonFile();
    } catch (err) {
      el.builderErrors.textContent = err.message;
    }
  });

  setupFileInput();
}

(async () => {
  bindEvents();
  await loadProfiles();
  await refreshStatus();
  await refreshHealth();
  setInterval(refreshStatus, 3000);
  setInterval(refreshHealth, 4000);
})();
