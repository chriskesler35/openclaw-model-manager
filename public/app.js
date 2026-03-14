// ── State ────────────────────────────────────────────────────────────────────
let ws = null;
let statsInterval = null;
let wsReconnectTimer = null;

// ── Centralized App State ────────────────────────────────────────────────────
const AppState = {
  connections: [],
  activeConnId: 'local',
  wsConnected: false,
  wsReconnectAttempts: 0,
  connectionState: 'disconnected', // disconnected | connecting | connected | error
  gateway: { status: null, lastUpdate: null },
  models: { primary: null, fallbacks: [], aliases: {}, available: [], lastUpdate: null },
  system: { gpu: [], ram: null, lastUpdate: null },
  providers: { status: {}, lastUpdate: null },
  auth: { profiles: {}, lastUpdate: null },
  ui: { activeTab: 'dashboard', loading: {}, errors: {} },
  cache: {},
};

const _stateListeners = {};

function updateState(path, value) {
  const keys = path.split('.');
  let obj = AppState;
  for (let i = 0; i < keys.length - 1; i++) {
    if (obj[keys[i]] == null) obj[keys[i]] = {};
    obj = obj[keys[i]];
  }
  obj[keys[keys.length - 1]] = value;
  // Notify listeners for this path and parent paths
  for (const listenerPath of Object.keys(_stateListeners)) {
    if (path.startsWith(listenerPath) || listenerPath.startsWith(path)) {
      for (const cb of _stateListeners[listenerPath]) {
        try { cb(value, path); } catch (e) { console.error('State listener error:', e); }
      }
    }
  }
}

function setState(path, value) { return updateState(path, value); }

function getState(path) {
  const keys = path.split('.');
  let obj = AppState;
  for (const key of keys) {
    if (obj == null) return undefined;
    obj = obj[key];
  }
  return obj;
}

function onStateChange(path, callback) {
  if (!_stateListeners[path]) _stateListeners[path] = [];
  _stateListeners[path].push(callback);
  return () => {
    _stateListeners[path] = _stateListeners[path].filter(cb => cb !== callback);
  };
}

function setLoading(key, bool) {
  updateState(`ui.loading.${key}`, bool);
}

function isLoading(key) {
  return !!AppState.ui.loading[key];
}

// Backward-compat getters/setters that delegate to AppState
Object.defineProperty(window, 'connections', {
  get() { return AppState.connections; },
  set(v) { updateState('connections', v); },
});
Object.defineProperty(window, 'activeConnId', {
  get() { return AppState.activeConnId; },
  set(v) { updateState('activeConnId', v); },
});
Object.defineProperty(window, 'lastGatewayData', {
  get() { return AppState.gateway.status; },
  set(v) { updateState('gateway.status', v); updateState('gateway.lastUpdate', v ? Date.now() : AppState.gateway.lastUpdate); },
});
Object.defineProperty(window, 'lastModelsData', {
  get() { return AppState.models.primary; },
  set(v) { updateState('models.primary', v); updateState('models.lastUpdate', v ? Date.now() : AppState.models.lastUpdate); },
});
Object.defineProperty(window, 'wsReconnectAttempts', {
  get() { return AppState.wsReconnectAttempts; },
  set(v) { updateState('wsReconnectAttempts', v); },
});

window.addEventListener('unhandledrejection', e => {
  console.error('Unhandled promise rejection:', e.reason);
  const msg = e.reason?.message || String(e.reason || 'Unknown error');
  toast(`Unexpected error: ${msg}`, 'error');
});

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadConnections();
  connectWebSocket();
  refreshAll();

  // Auto-discover system on first load
  refreshLocalModels();

  // Start live system stats polling (every 3 seconds)
  refreshSystemStats();
  statsInterval = setInterval(refreshSystemStats, 3000);

  // Provider failover status
  refreshProviderStatus();

  byId('model-input').addEventListener('keydown', e => { if (e.key === 'Enter') setModel(); });
  byId('alias-model').addEventListener('keydown', e => { if (e.key === 'Enter') addAlias(); });
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function byId(id) { return document.getElementById(id); }

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  let res;
  try {
    res = await fetch(path, opts);
  } catch (e) {
    toast(`Network error: ${e.message}`, 'error');
    return { ok: false, error: e.message, code: 'NETWORK_ERROR' };
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    toast(`Bad response from server (${res.status})`, 'error');
    return { ok: false, error: 'Invalid JSON response', code: 'PARSE_ERROR' };
  }
  if (!res.ok) {
    toast(data.error || `HTTP ${res.status}`, 'error');
  }
  return data;
}

function capi(method, path, body) {
  return api(method, `/api/${activeConnId}${path}`, body);
}

async function apiWithRetry(method, path, body, maxRetries = 2, delayMs = 1000) {
  // Only retry GET requests
  if (method !== 'GET') return api(method, path, body);
  let lastResult;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastResult = await api(method, path, body);
    // Don't retry on success or 4xx client errors
    if (!lastResult.code || (lastResult.code !== 'NETWORK_ERROR' && lastResult.code !== 'PARSE_ERROR')) return lastResult;
    // Check for retryable HTTP status codes (stored in error text)
    const errText = lastResult.error || '';
    const is5xxRetryable = /\b50[234]\b/.test(errText);
    const isNetworkErr = lastResult.code === 'NETWORK_ERROR';
    if (!isNetworkErr && !is5xxRetryable) return lastResult;
    if (attempt < maxRetries) await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
  }
  return lastResult;
}

function capiRetry(path) {
  return apiWithRetry('GET', `/api/${activeConnId}${path}`);
}

function toast(msg, type = 'info') {
  // Always log to console so errors are captured in F12
  if (type === 'error') console.error('[toast]', msg);
  else if (type === 'warning') console.warn('[toast]', msg);
  else console.log('[toast]', msg);

  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  byId('toast-container').appendChild(el);
  const duration = type === 'error' ? 10000 : 5000;
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, duration);
}

function feedback(id, msg, type) {
  const el = byId(id);
  if (!el) return;
  el.textContent = msg;
  el.className = `feedback ${type}`;
  setTimeout(() => { el.textContent = ''; el.className = 'feedback'; }, 5000);
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function markStale(elementId) {
  const el = byId(elementId);
  if (!el) return;
  el.classList.add('data-stale');
  // Add stale indicator if not already present
  if (!el.querySelector('.stale-indicator')) {
    const badge = document.createElement('span');
    badge.className = 'stale-indicator';
    badge.textContent = '(stale)';
    el.appendChild(badge);
  }
}

function clearStale(elementId) {
  const el = byId(elementId);
  if (!el) return;
  el.classList.remove('data-stale');
  const badge = el.querySelector('.stale-indicator');
  if (badge) badge.remove();
}

function dur(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// ── Is the gateway actually running? ─────────────────────────────────────────
function isGatewayRunning(data) {
  if (!data) return false;
  // Best signal: RPC probe succeeded
  if (data.rpc?.ok === true) return true;
  // Next: port is in use by a gateway process
  if (data.port?.status === 'busy' && data.port?.listeners?.length > 0) return true;
  // Remote: explicit running flag
  if (data.running === true) return true;
  return false;
}

// ── Tab Management ───────────────────────────────────────────────────────────
function switchTab(tabId) {
  updateState('ui.activeTab', tabId);
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${tabId}`));

  // Lazy-load data for tabs
  if (tabId === 'health') { refreshHealth(); refreshProviderStatus(); }
  if (tabId === 'logs') refreshLogFiles();
  if (tabId === 'fallbacks') refreshFallbacks();
  if (tabId === 'local') refreshLocalModels();
  if (tabId === 'connections') renderConnList();
  if (tabId === 'auth') refreshCredentials();
}

// ── Connection Management ────────────────────────────────────────────────────

async function loadConnections() {
  const res = await api('GET', '/api/connections');
  if (res.ok) {
    connections = res.connections;
    const def = connections.find(c => c.default) || connections[0];
    if (def) activeConnId = def.id;
    renderConnectionSelect();
  }
}

function renderConnectionSelect() {
  const sel = byId('conn-select');
  sel.innerHTML = connections.map(c =>
    `<option value="${c.id}" ${c.id === activeConnId ? 'selected' : ''}>${esc(c.name)} ${c.type === 'remote' ? '🌐' : '🏠'}</option>`
  ).join('');
}

function switchConnection() {
  activeConnId = byId('conn-select').value;
  updateConnTypeBadge();
  refreshAll();

  // Refresh the currently visible tab's data
  const activeTab = document.querySelector('.tab.active')?.dataset?.tab;
  if (activeTab === 'health') { refreshHealth(); refreshSystemStats(); refreshProviderStatus(); }
  if (activeTab === 'local') refreshLocalModels();
  if (activeTab === 'auth') refreshCredentials();
  if (activeTab === 'connections') renderConnList();
}

function updateConnTypeBadge() {
  const conn = connections.find(c => c.id === activeConnId);
  const badge = byId('conn-type-badge');
  if (conn && badge) {
    badge.textContent = conn.type === 'local' ? 'LOCAL' : 'REMOTE';
    badge.className = `conn-type-badge ${conn.type === 'local' ? 'conn-type-local' : 'conn-type-remote'}`;
  }
}

function refreshAll() {
  updateConnTypeBadge();
  fetchGatewayStatusFull();
  refreshModels();
  refreshFallbacks();
  refreshAliases();
  refreshAuth();
}

// Full status (for health tab — can take ~6-8s)
async function fetchGatewayStatusFull() {
  setLoading('gateway', true);
  try {
    const res = await capiRetry('/gateway/status');
    if (res.ok) {
      lastGatewayData = res.status;
      AppState.cache.gateway = res.status;
      updateGatewayUI(res.status);
      refreshHealth();
    } else if (AppState.cache.gateway) {
      lastGatewayData = AppState.cache.gateway;
      updateGatewayUI(AppState.cache.gateway);
      markStale('gateway-badge');
    }
  } catch {
    if (AppState.cache.gateway) {
      lastGatewayData = AppState.cache.gateway;
      updateGatewayUI(AppState.cache.gateway);
      markStale('gateway-badge');
    }
  }
  setLoading('gateway', false);
}

// ── WebSocket ────────────────────────────────────────────────────────────────

function showWsStatus(state) {
  let el = byId('ws-status');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ws-status';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;color:#fff;text-align:center;padding:4px 8px;font-size:12px;display:none';
    document.body.prepend(el);
  }
  if (state === 'connected' || state === true) {
    el.style.display = 'none';
  } else if (state === 'connecting') {
    el.textContent = 'Connecting to server…';
    el.style.background = 'var(--warning, #d97706)';
    el.style.display = 'block';
  } else if (state === 'error') {
    el.textContent = 'Connection error — will retry…';
    el.style.background = 'var(--danger, #dc2626)';
    el.style.display = 'block';
  } else {
    el.textContent = 'Connection lost — reconnecting…';
    el.style.background = 'var(--danger, #dc2626)';
    el.style.display = 'block';
  }
}

function connectWebSocket() {
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }

  updateState('connectionState', 'connecting');
  showWsStatus('connecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    const wasReconnect = wsReconnectAttempts > 0;
    wsReconnectAttempts = 0;
    updateState('wsConnected', true);
    updateState('connectionState', 'connected');
    showWsStatus('connected');
    if (wasReconnect) refreshAll();
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'gateway-status') {
        const connId = msg.connId || 'local';
        if (connId === activeConnId) {
          lastGatewayData = msg.data;
          updateGatewayUI(msg.data);
          // Update health if it's the active tab
          if (document.querySelector('.tab[data-tab="health"]')?.classList.contains('active')) {
            refreshHealth();
          }
        }
      }
    } catch {}
  };

  ws.onclose = () => {
    updateState('wsConnected', false);
    updateState('connectionState', 'disconnected');
    showWsStatus('disconnected');
    const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts), 30000);
    wsReconnectAttempts++;
    wsReconnectTimer = setTimeout(connectWebSocket, delay);
  };

  ws.onerror = () => {
    updateState('connectionState', 'error');
    showWsStatus('error');
    try { ws.close(); } catch {}
  };
}

// ── Gateway UI ───────────────────────────────────────────────────────────────

function updateGatewayUI(data) {
  const badge = byId('gateway-badge');
  const badgeText = badge.querySelector('.badge-text');
  const statusText = byId('gw-status-text');
  const pid = byId('gw-pid');
  const host = byId('gw-host');
  const port = byId('gw-port');

  const running = isGatewayRunning(data);
  const conn = connections.find(c => c.id === activeConnId);

  if (running) {
    badge.className = 'badge badge-running';
    badgeText.textContent = 'Running';
    statusText.textContent = '🟢 Running';
    statusText.style.color = 'var(--success)';

    const listenerPid = data?.port?.listeners?.[0]?.pid;
    pid.textContent = data.pid || listenerPid || '—';

    const bindHost = data?.gateway?.bindHost || (conn?.type === 'remote' ? conn.host : '127.0.0.1');
    host.textContent = bindHost;

    const gwPort = data?.gateway?.port || conn?.port || 18789;
    port.textContent = gwPort;
  } else {
    badge.className = 'badge badge-stopped';
    badgeText.textContent = 'Stopped';
    statusText.textContent = '🔴 Stopped';
    statusText.style.color = 'var(--danger)';
    pid.textContent = '—';
    host.textContent = conn?.type === 'remote' ? conn.host : '—';
    port.textContent = conn?.port || '—';
  }

  byId('btn-start').disabled = running;
  byId('btn-stop').disabled = !running;
}

// ── Health Report (Plain English) ────────────────────────────────────────────

async function refreshHealth() {
  const container = byId('health-report');
  const cards = [];

  // 1. Gateway Status
  const data = lastGatewayData;
  const running = isGatewayRunning(data);
  const conn = connections.find(c => c.id === activeConnId);

  if (running) {
    const bindHost = data?.gateway?.bindHost || '127.0.0.1';
    const gwPort = data?.gateway?.port || 18789;
    const bindMode = data?.gateway?.bindMode || 'unknown';
    const listenerPid = data?.port?.listeners?.[0]?.pid;
    const listenerCmd = data?.port?.listeners?.[0]?.command || 'node';

    let bindDesc = 'only this machine (loopback)';
    if (bindMode === 'lan' || bindHost === '0.0.0.0') bindDesc = 'all network interfaces (LAN accessible)';
    else if (bindMode === 'tailnet') bindDesc = 'Tailscale network';

    cards.push(healthCard('🟢', 'Gateway', 'ok', 'Running',
      `Your gateway is <strong>up and running</strong> on port <strong>${gwPort}</strong>, ` +
      `listening on <strong>${bindDesc}</strong>.` +
      (listenerPid ? ` Process ID: ${listenerPid} (${esc(listenerCmd)}).` : ''),
      data?.rpc?.ok ? 'RPC connection verified ✓' : 'Status detected via port listener'
    ));
  } else {
    const hint = data?.port?.hints?.[0] || '';
    cards.push(healthCard('🔴', 'Gateway', 'err', 'Stopped',
      `Your gateway is <strong>not running</strong>. ` +
      (conn?.type === 'remote'
        ? `Could not connect to <strong>${esc(conn.host)}:${conn.port}</strong>. Check that the remote gateway is started and the network (Tailscale, SSH tunnel) is connected.`
        : 'Click the <strong>Gateway tab</strong> to start it.'),
      hint ? esc(hint) : null
    ));
  }

  // 2. Service Status (local only)
  if (data?.service && conn?.type === 'local') {
    const svc = data.service;
    const loaded = svc.loaded;
    const taskStatus = svc.runtime?.status;
    const taskState = svc.runtime?.state;

    if (loaded && taskStatus === 'running') {
      cards.push(healthCard('✅', 'Scheduled Task', 'ok', 'Active',
        'The Windows scheduled task is <strong>registered and running</strong>. ' +
        'Your gateway will restart automatically if the system reboots.'));
    } else if (loaded) {
      cards.push(healthCard('⚠️', 'Scheduled Task', 'warn', 'Registered but idle',
        `The scheduled task is <strong>registered</strong> but currently <strong>${esc(taskState || taskStatus || 'not running')}</strong>. ` +
        'This means the gateway was started manually (via CLI) rather than through the scheduled task. ' +
        'Everything works fine — the task is just a safety net for auto-restart.'));
    } else {
      cards.push(healthCard('ℹ️', 'Scheduled Task', 'warn', 'Not installed',
        'No scheduled task is registered. Your gateway won\'t auto-start on reboot. ' +
        'Run <code>openclaw gateway install</code> to set one up.'));
    }
  }

  // 3. Config Status
  if (data?.config) {
    const cfgOk = data.config.cli?.valid && data.config.cli?.exists;
    if (cfgOk) {
      const cfgPath = data.config.cli?.path || 'unknown';
      cards.push(healthCard('📄', 'Configuration', 'ok', 'Valid',
        `Config file found at <strong>${esc(cfgPath)}</strong> and validated successfully.`));
    } else {
      cards.push(healthCard('⚠️', 'Configuration', 'warn', 'Issue detected',
        data.config.cli?.exists
          ? 'Config file exists but may have validation issues. Check your <code>openclaw.json</code>.'
          : 'No config file found. Run <code>openclaw onboard</code> to create one.'));
    }

    // Config audit issues
    if (data.service?.configAudit?.issues?.length > 0) {
      const issues = data.service.configAudit.issues;
      cards.push(healthCard('⚠️', 'Config Audit', 'warn', `${issues.length} issue(s)`,
        'The config audit found: ' + issues.map(i => `<strong>${esc(i)}</strong>`).join(', ')));
    }
  }

  // 4. Primary Model
  if (lastModelsData) {
    const m = lastModelsData;
    const primary = m.resolvedDefault || m.defaultModel || 'Not set';
    const fbCount = m.fallbacks?.length || 0;
    cards.push(healthCard('🤖', 'Primary Model', 'ok', 'Configured',
      `Active model: <strong>${esc(primary)}</strong>` +
      (fbCount > 0 ? ` with <strong>${fbCount} fallback${fbCount > 1 ? 's' : ''}</strong> configured.` : '. No fallbacks configured — consider adding some for reliability.')));
  }

  // 5. Auth Providers
  if (lastModelsData?.auth?.providers) {
    const providers = lastModelsData.auth.providers;
    const missing = providers.filter(p => p.effective?.kind === 'none' || p.profiles?.count === 0);
    const authed = providers.filter(p => p.effective?.kind !== 'none' && (p.profiles?.count > 0 || p.effective?.kind === 'env'));

    if (authed.length > 0) {
      const names = authed.map(p => `<strong>${esc(p.provider)}</strong>`).join(', ');
      cards.push(healthCard('🔑', 'Auth Providers', authed.length > 0 ? 'ok' : 'warn',
        `${authed.length} connected`,
        `Authenticated providers: ${names}.` +
        (missing.length > 0 ? ` ${missing.length} provider(s) have no credentials configured.` : '')));
    }
  }

  // 6. Network / Bind
  if (data?.gateway?.bindMode === 'lan' && running) {
    cards.push(healthCard('🌐', 'Network Access', 'ok', 'LAN mode',
      'Your gateway is accessible from <strong>other devices on your network</strong> (including Tailscale). ' +
      'Make sure you have a gateway token configured for security.'));
  }

  // 7. Local Models Summary
  try {
    const lmRes = await apiWithRetry('GET', '/api/system/local-models');
    if (lmRes?.ok && lmRes.data) {
      const { models, system } = lmRes.data;
      const compatible = models.filter(m => m.status === 'compatible').length;
      const warnings = models.filter(m => m.status === 'warning').length;
      const incompatible = models.filter(m => m.status === 'incompatible').length;
      const total = models.length;

      let gpuDesc = '';
      if (system.totalVRAM > 0) {
        gpuDesc = `<strong>${(system.totalVRAM / 1024).toFixed(1)} GB</strong> total VRAM (${(system.freeVRAM / 1024).toFixed(1)} GB free)`;
      }

      const level = incompatible > 0 ? 'warn' : 'ok';
      cards.push(healthCard('💻', 'Local Models', level,
        `${total} installed`,
        `<strong>${compatible}</strong> model${compatible !== 1 ? 's' : ''} fit comfortably in GPU memory` +
        (warnings > 0 ? `, <strong>${warnings}</strong> might need other models unloaded first` : '') +
        (incompatible > 0 ? `, <strong>${incompatible}</strong> won't fit in GPU (CPU fallback only)` : '') +
        `. ${gpuDesc ? `System has ${gpuDesc}.` : ''}` +
        ` <strong>${(system.totalRAM / 1024).toFixed(0)} GB</strong> system RAM (${(system.freeRAM / 1024).toFixed(0)} GB free).`,
        'Click the Local Models tab for details'
      ));
    }
  } catch {}

  container.innerHTML = cards.length ? cards.join('') : '<div class="empty-state">No health data available yet. Check back in a moment.</div>';
}

function healthCard(icon, title, level, statusText, body, detail) {
  return `<div class="health-card">
    <div class="health-card-header">
      <span class="health-icon">${icon}</span>
      <span class="health-title">${esc(title)}</span>
      <span class="health-status health-${level}">${esc(statusText)}</span>
    </div>
    <div class="health-body">${body}</div>
    ${detail ? `<div class="health-detail">${detail}</div>` : ''}
  </div>`;
}

// ── Gateway Actions ──────────────────────────────────────────────────────────

async function gatewayAction(action) {
  const btn = byId(`btn-${action}`);
  const origText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> ${action}…`;

  try {
    const res = await capi('POST', `/gateway/${action}`);
    if (res.ok) {
      toast(`Gateway ${action} successful`, 'success');
      feedback('gateway-feedback', res.message || `${action} completed`, 'success');

      // After restart/start, poll until gateway is back online
      if (action === 'restart' || action === 'start') {
        btn.innerHTML = `<span class="spinner"></span> waiting for gateway…`;
        feedback('gateway-feedback', action === 'restart'
          ? '⏳ Restarting gateway — this can take up to 30 seconds while the process recycles...'
          : 'Waiting for gateway to come back online...', 'info');
        let online = false;
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            // Silent fetch — don't use api() which toasts on every failure
            const r = await fetch(`/api/${activeConnId}/health`);
            if (r.ok) {
              const health = await r.json();
              if (health.ok && isGatewayRunning(health.status)) {
                online = true;
                break;
              }
            }
          } catch {}
        }
        if (online) {
          toast('Gateway is back online', 'success');
          feedback('gateway-feedback', 'Gateway is back online ✓', 'success');
          refreshAll();
        } else {
          toast('Gateway may still be starting — check status in a moment', 'warning');
          feedback('gateway-feedback', 'Gateway did not respond yet. It may still be starting.', 'warning');
        }
      }
    } else {
      toast(`Gateway ${action} failed: ${res.error}`, 'error');
      feedback('gateway-feedback', res.error + (res.hint ? ` — ${res.hint}` : ''), 'error');
    }
  } catch (e) {
    toast(`Gateway ${action} error: ${e.message}`, 'error');
  }

  setTimeout(() => { btn.innerHTML = origText; btn.disabled = false; }, 2500);
}

// ── Models ───────────────────────────────────────────────────────────────────

async function refreshModels() {
  setLoading('models', true);
  try {
    const res = await capiRetry('/models/status');
    if (res.ok && res.data) {
      lastModelsData = res.data;
      AppState.cache.models = res.data;
      renderModelsDisplay(res.data);
      clearStale('primary-model-display');
    } else if (AppState.cache.models) {
      lastModelsData = AppState.cache.models;
      renderModelsDisplay(AppState.cache.models);
      markStale('primary-model-display');
    }
  } catch (e) {
    if (AppState.cache.models) {
      lastModelsData = AppState.cache.models;
      renderModelsDisplay(AppState.cache.models);
      markStale('primary-model-display');
    } else {
      byId('primary-model-display').innerHTML = `<span class="model-name" style="color:var(--danger)">Error loading</span>`;
    }
  }
  setLoading('models', false);
  refreshModelList();
}

function renderModelsDisplay(data) {
  const d = data;
  const primary = d.resolvedDefault || d.defaultModel || d.primary || '—';
  const display = byId('primary-model-display');

  let metaParts = [];
  const provider = primary.split('/')[0];
  if (provider && provider !== '—') metaParts.push(`Provider: ${provider}`);
  if (d.fallbacks?.length) metaParts.push(`${d.fallbacks.length} fallbacks`);
  if (d.imageModel) metaParts.push(`Image: ${d.imageModel}`);

  display.innerHTML = `
    <div class="model-name">${esc(primary)}</div>
    ${metaParts.length ? `<div class="model-meta">${esc(metaParts.join(' · '))}</div>` : ''}
  `;
}

async function setModel() {
  const input = byId('model-input');
  const model = input.value.trim();
  if (!model) return;
  try {
    const res = await capi('POST', '/models/set', { model });
    if (res.ok) {
      toast(`Primary model → ${model}`, 'success');
      feedback('model-feedback', res.message, 'success');
      input.value = '';
      refreshModels();
    } else {
      feedback('model-feedback', res.error, 'error');
    }
  } catch (e) { feedback('model-feedback', e.message, 'error'); }
}

async function refreshModelList() {
  const showAll = byId('show-all-models')?.checked;
  const container = byId('model-list');

  try {
    const res = await capiRetry(`/models/list?all=${showAll}`);
    let models = [];

    if (res.ok && res.data) {
      if (Array.isArray(res.data)) {
        models = res.data;
      } else if (res.data.models && Array.isArray(res.data.models)) {
        models = res.data.models;
      }
    }

    if (models.length === 0) {
      container.innerHTML = '<div class="empty-state">No models found</div>';
      return;
    }

    let html = `<table class="model-table"><thead><tr>
      <th>Model</th><th>Name</th><th>Context</th><th>Tags</th><th></th>
    </tr></thead><tbody>`;

    for (const m of models) {
      const key = m.key || m.id || m.model || (typeof m === 'string' ? m : '');
      const name = m.name || '';
      const ctx = m.contextWindow ? `${(m.contextWindow / 1000).toFixed(0)}k` : '—';
      const tags = m.tags || [];

      const tagHtml = tags.map(t => {
        let cls = 'model-tag';
        if (t === 'default') cls += ' model-tag-default';
        else if (t.startsWith('fallback')) cls += ' model-tag-fallback';
        else if (t === 'local') cls += ' model-tag-local';
        return `<span class="${cls}">${esc(t)}</span>`;
      }).join('');

      html += `<tr>
        <td>${esc(key)}</td>
        <td style="font-family:var(--font);color:var(--text-dim)">${esc(name)}</td>
        <td>${esc(ctx)}</td>
        <td class="model-tags">${tagHtml}</td>
        <td><button class="btn btn-sm btn-primary" onclick="quickSet('${esc(key)}')">Use</button></td>
      </tr>`;
    }
    html += '</tbody></table>';
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div class="empty-state">Error: ${esc(e.message)}</div>`;
  }
}

function quickSet(model) {
  byId('model-input').value = model;
  setModel();
}

// ── Fallbacks ────────────────────────────────────────────────────────────────

let fallbackList = [];        // Current working list (may have unsaved changes)
let fallbackOriginal = [];    // Last-saved state from server
let allAvailableModels = [];  // Full model list for the dropdown
let dragSrcIndex = null;

async function refreshFallbacks() {
  const container = byId('fallback-tiles');
  setLoading('fallbacks', true);

  // Load fallbacks and available models in parallel
  const [fbRes, modRes] = await Promise.all([
    capiRetry('/models/fallbacks'),
    capiRetry('/models/available'),
  ]);

  // Parse fallbacks
  if (fbRes.ok && fbRes.data) {
    const list = Array.isArray(fbRes.data) ? fbRes.data : (fbRes.data.fallbacks || []);
    fallbackList = list.map(f => typeof f === 'string' ? f : (f.model || f.id || f));
    fallbackOriginal = [...fallbackList];
    updateState('models.fallbacks', fallbackList);
  }

  // Parse available models
  if (modRes.ok && modRes.models) {
    allAvailableModels = modRes.models;
    updateState('models.available', modRes.models);
  }

  renderFallbackTiles();
  populateFallbackDropdown();
  updateFallbackDirty();
  setLoading('fallbacks', false);
}

function renderFallbackTiles() {
  const container = byId('fallback-tiles');
  if (!container) return;

  if (fallbackList.length === 0) {
    container.innerHTML = '<div class="empty-state">No fallbacks configured. Add models from the dropdown below — they\'ll be tried in order if the primary fails.</div>';
    return;
  }

  container.innerHTML = fallbackList.map((model, i) => {
    const info = allAvailableModels.find(m => m.key === model);
    const displayName = info?.name || model;
    const isLocal = info?.local || model.startsWith('ollama/');
    const provider = model.split('/')[0];

    return `<div class="fallback-tile" draggable="true" data-index="${i}"
                 ondragstart="fbDragStart(event, ${i})"
                 ondragover="fbDragOver(event)"
                 ondragenter="fbDragEnter(event)"
                 ondragleave="fbDragLeave(event)"
                 ondrop="fbDrop(event, ${i})"
                 ondragend="fbDragEnd(event)">
      <span class="ft-grip">⠿</span>
      <span class="ft-order">${i + 1}</span>
      <div class="ft-info">
        <div class="ft-model">${esc(displayName)}</div>
        <div class="ft-meta">
          <span class="ft-badge ${isLocal ? 'ft-badge-local' : 'ft-badge-external'}">${isLocal ? '💻 Local' : '☁️ ' + esc(provider)}</span>
          <span style="margin-left:6px;color:var(--text-label)">${esc(model)}</span>
        </div>
      </div>
      <button class="ft-remove" onclick="removeFallbackTile(${i})" title="Remove from fallback chain">✕</button>
    </div>`;
  }).join('');
}

function populateFallbackDropdown() {
  const select = byId('fallback-add-select');
  if (!select) return;

  // Group models by provider, exclude ones already in fallback list
  const inFallbacks = new Set(fallbackList);
  const available = allAvailableModels.filter(m => !inFallbacks.has(m.key));

  // Group by provider
  const groups = {};
  for (const m of available) {
    const provider = m.key.split('/')[0];
    if (!groups[provider]) groups[provider] = [];
    groups[provider].push(m);
  }

  let html = '<option value="">Select a model to add…</option>';

  // Local models first
  if (groups['ollama']?.length) {
    html += '<optgroup label="💻 Local (Ollama)">';
    for (const m of groups['ollama']) {
      html += `<option value="${esc(m.key)}">${esc(m.name || m.key)}</option>`;
    }
    html += '</optgroup>';
    delete groups['ollama'];
  }

  // External providers
  for (const [provider, models] of Object.entries(groups).sort()) {
    html += `<optgroup label="☁️ ${esc(provider)}">`;
    for (const m of models) {
      html += `<option value="${esc(m.key)}">${esc(m.name || m.key)}</option>`;
    }
    html += '</optgroup>';
  }

  select.innerHTML = html;
}

function addFallbackFromDropdown() {
  const select = byId('fallback-add-select');
  const model = select?.value;
  if (!model) return feedback('fallback-feedback', 'Select a model first', 'error');

  if (fallbackList.includes(model)) {
    return feedback('fallback-feedback', 'Model already in fallback chain', 'error');
  }

  fallbackList.push(model);
  renderFallbackTiles();
  populateFallbackDropdown();
  updateFallbackDirty();
  select.value = '';
}

function removeFallbackTile(index) {
  fallbackList.splice(index, 1);
  renderFallbackTiles();
  populateFallbackDropdown();
  updateFallbackDirty();
}

// Drag & Drop handlers
function fbDragStart(e, index) {
  dragSrcIndex = index;
  e.target.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', index);
}

function fbDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

function fbDragEnter(e) {
  e.preventDefault();
  const tile = e.target.closest('.fallback-tile');
  if (tile) tile.classList.add('drag-over');
}

function fbDragLeave(e) {
  const tile = e.target.closest('.fallback-tile');
  if (tile) tile.classList.remove('drag-over');
}

function fbDrop(e, targetIndex) {
  e.preventDefault();
  const tile = e.target.closest('.fallback-tile');
  if (tile) tile.classList.remove('drag-over');

  if (dragSrcIndex === null || dragSrcIndex === targetIndex) return;

  // Reorder
  const [moved] = fallbackList.splice(dragSrcIndex, 1);
  fallbackList.splice(targetIndex, 0, moved);

  renderFallbackTiles();
  updateFallbackDirty();
}

function fbDragEnd(e) {
  dragSrcIndex = null;
  document.querySelectorAll('.fallback-tile').forEach(t => {
    t.classList.remove('dragging', 'drag-over');
  });
}

function updateFallbackDirty() {
  const isDirty = JSON.stringify(fallbackList) !== JSON.stringify(fallbackOriginal);
  const badge = byId('fallback-dirty-badge');
  const btn = byId('btn-save-fallbacks');
  if (badge) badge.style.display = isDirty ? 'inline' : 'none';
  if (btn) btn.style.display = isDirty ? 'inline-flex' : 'none';
}

async function saveFallbacks() {
  const btn = byId('btn-save-fallbacks');
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Saving…';

  try {
    const res = await capi('PUT', '/models/fallbacks', { fallbacks: fallbackList });
    if (res.ok) {
      fallbackOriginal = [...fallbackList];
      updateFallbackDirty();
      toast('✅ Fallback chain saved! Restart the gateway for changes to take effect.', 'success');
      feedback('fallback-feedback', '✅ ' + res.message + ' — ' + res.warning, 'success');
    } else {
      feedback('fallback-feedback', '❌ ' + (res.error || 'Save failed'), 'error');
    }
  } catch (e) {
    feedback('fallback-feedback', '❌ ' + e.message, 'error');
  }

  btn.innerHTML = orig;
  btn.disabled = false;
}

async function clearFallbacks() {
  if (!confirm('Clear all fallbacks? This will save immediately.')) return;
  try {
    const res = await capi('DELETE', '/models/fallbacks');
    if (res.ok) {
      fallbackList = [];
      fallbackOriginal = [];
      renderFallbackTiles();
      populateFallbackDropdown();
      updateFallbackDirty();
      toast('Fallbacks cleared', 'info');
    }
  } catch (e) { toast(e.message, 'error'); }
}

// ── Aliases ──────────────────────────────────────────────────────────────────

async function refreshAliases() {
  const container = byId('alias-list');
  setLoading('aliases', true);
  try {
    const res = await capiRetry('/models/aliases');
    if (res.ok && res.data) {
      AppState.cache.aliases = res.data;
      updateState('models.lastUpdate', Date.now());
      clearStale('alias-list');
      let entries = [];
      if (Array.isArray(res.data)) {
        entries = res.data.map(a => ({ alias: a.alias || a.name || a, model: a.model || a.target || '' }));
      } else if (typeof res.data === 'object') {
        const obj = res.data.aliases || res.data;
        entries = Object.entries(obj).map(([alias, model]) => ({
          alias, model: typeof model === 'string' ? model : (model.model || JSON.stringify(model))
        }));
      }
      updateState('models.aliases', entries.reduce((acc, e) => { acc[e.alias] = e.model; return acc; }, {}));
      if (entries.length === 0) {
        container.innerHTML = '<div class="empty-state">No aliases configured. Create short names for your favorite models.</div>';
        setLoading('aliases', false);
        return;
      }
      renderAliasEntries(container, entries);
    } else if (AppState.cache.aliases) {
      markStale('alias-list');
    } else {
      container.innerHTML = '<div class="empty-state">No aliases configured</div>';
    }
  } catch {
    if (AppState.cache.aliases) {
      markStale('alias-list');
    } else {
      container.innerHTML = '<div class="empty-state">Error loading aliases</div>';
    }
  }
  setLoading('aliases', false);
}

function renderAliasEntries(container, entries) {
  container.innerHTML = entries.map(({ alias, model }) => `
    <div class="item-row">
      <div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px">
        <span class="item-label" style="color:var(--warning)">${esc(alias)}</span>
        <span class="item-arrow">→</span>
        <span class="item-label">${esc(model)}</span>
      </div>
      <button class="btn-remove" onclick="removeAlias('${esc(alias)}')" title="Remove">✕</button>
    </div>`).join('');
}

async function addAlias() {
  const alias = byId('alias-name').value.trim();
  const model = byId('alias-model').value.trim();
  if (!alias || !model) return;
  try {
    const res = await capi('POST', '/models/aliases', { alias, model });
    if (res.ok) { toast(`Alias: ${alias} → ${model}`, 'success'); byId('alias-name').value = ''; byId('alias-model').value = ''; refreshAliases(); }
    else feedback('alias-feedback', res.error, 'error');
  } catch (e) { feedback('alias-feedback', e.message, 'error'); }
}

async function removeAlias(alias) {
  try {
    const res = await capi('DELETE', `/models/aliases/${encodeURIComponent(alias)}`);
    if (res.ok) { toast('Alias removed', 'info'); refreshAliases(); }
    else toast(res.error, 'error');
  } catch (e) { toast(e.message, 'error'); }
}

// ── Auth Profiles ────────────────────────────────────────────────────────────

async function refreshAuth() {
  const container = byId('auth-profiles');
  setLoading('auth', true);
  try {
    const res = await capiRetry('/auth/profiles');
    if (res.ok && res.data) {
      AppState.cache.auth = res.data;
      updateState('auth.profiles', res.data);
      updateState('auth.lastUpdate', Date.now());
      clearStale('auth-profiles');
      const allCards = [];
      for (const [agentId, agentData] of Object.entries(res.data)) {
        const profiles = agentData.profiles || [];
        const stats = agentData.usageStats || {};

        if (profiles.length > 0) {
          for (const p of profiles) {
            const pStats = stats[p.id] || {};
            const now = Date.now();
            let statusHtml = '';
            if (pStats.disabledUntil && pStats.disabledUntil > now) {
              statusHtml = `<span class="auth-stat stat-error">⛔ Disabled (${Math.ceil((pStats.disabledUntil - now) / 60000)}m)</span>`;
            } else if (pStats.cooldownUntil && pStats.cooldownUntil > now) {
              statusHtml = `<span class="auth-stat stat-warn">⏳ Cooldown (${Math.ceil((pStats.cooldownUntil - now) / 1000)}s)</span>`;
            } else {
              statusHtml = `<span class="auth-stat stat-ok">✓ Ready</span>`;
            }
            if (pStats.errorCount) statusHtml += `<span class="auth-stat stat-warn">⚠ ${pStats.errorCount} errors</span>`;
            if (pStats.lastUsed) statusHtml += `<span class="auth-stat stat-dim">Last: ${dur(now - pStats.lastUsed)} ago</span>`;

            let expiryHtml = '';
            if (p.expires) {
              const remaining = new Date(p.expires).getTime() - now;
              if (remaining < 0) expiryHtml = `<div class="auth-detail"><span class="stat-error">⚠ Expired</span></div>`;
              else if (remaining < 86400000) expiryHtml = `<div class="auth-detail"><span class="stat-warn">⏰ Expires in ${dur(remaining)}</span></div>`;
            }

            const typeClass = p.type === 'oauth' ? 'auth-type-oauth' : p.type === 'token' ? 'auth-type-token' : 'auth-type-api';

            allCards.push(`<div class="auth-card">
              <div class="auth-card-header">
                <span class="auth-provider">${esc(p.provider || p.id)}</span>
                <span class="auth-type ${typeClass}">${esc(p.type || '?')}</span>
              </div>
              <div class="auth-detail mono">${esc(p.id)}</div>
              ${p.email ? `<div class="auth-detail">${esc(p.email)}</div>` : ''}
              ${expiryHtml}
              <div style="margin-top:8px">${statusHtml}</div>
            </div>`);
          }
        } else if (agentData.auth) {
          const providers = agentData.auth.providers || agentData.auth.oauth?.providers || [];
          for (const prov of providers) {
            allCards.push(`<div class="auth-card">
              <div class="auth-card-header">
                <span class="auth-provider">${esc(prov.provider)}</span>
                <span class="auth-type auth-type-api">${esc(prov.status || '?')}</span>
              </div>
              <div class="auth-detail">Remote instance</div>
            </div>`);
          }
        }
      }
      container.innerHTML = allCards.length ? allCards.join('') : '<div class="empty-state">No auth profiles found</div>';
    } else if (AppState.cache.auth) {
      markStale('auth-profiles');
    } else {
      container.innerHTML = '<div class="empty-state">Could not load auth profiles</div>';
    }
  } catch (e) {
    if (AppState.cache.auth) {
      markStale('auth-profiles');
    } else {
      container.innerHTML = `<div class="empty-state">Error: ${esc(e.message)}</div>`;
    }
  }
  setLoading('auth', false);
}

// ── Credential Management ────────────────────────────────────────────────────

async function refreshCredentials() {
  const container = byId('credential-cards');
  if (!container) return;
  
  try {
    const res = await apiWithRetry('GET', '/api/credentials/status');
    if (!res.ok) {
      container.innerHTML = `<div class="empty-state">${esc(res.error || 'Could not load credentials')}</div>`;
      return;
    }

    const providers = res.providers || {};
    let cards = [];

    for (const [provider, info] of Object.entries(providers)) {
      const hasKey = info.hasCredentials;
      const isLocal = provider === 'ollama';
      const cardClass = isLocal ? 'cred-card-noauth' : hasKey ? 'cred-card-ok' : 'cred-card-missing';
      const icon = isLocal ? '💻' : hasKey ? '✅' : '❌';
      
      let detail = '';
      let hint = '';
      if (isLocal) {
        detail = 'No credentials needed — runs locally';
      } else if (hasKey) {
        detail = `${info.profiles?.length || 0} profile(s) configured`;
        // Show masked key hints
        const withKeys = (info.profiles || []).filter(p => p.keyHint);
        if (withKeys.length > 0) {
          hint = withKeys.map(p => `${p.profileId}: ${p.keyHint}`).join(', ');
        }
      } else {
        detail = 'No API key configured — click below to add one';
      }

      const actionHtml = !isLocal && !hasKey
        ? `<button class="btn btn-sm btn-warning" onclick="focusCredForm('${provider}')">Add Key</button>`
        : !isLocal
        ? `<button class="btn btn-sm" onclick="focusCredForm('${provider}')">Update</button>`
        : '';

      cards.push(`<div class="cred-card ${cardClass}">
        <span class="cred-card-icon">${icon}</span>
        <div class="cred-card-info">
          <div class="cred-card-name">${esc(provider)}</div>
          <div class="cred-card-detail">${esc(detail)}</div>
          ${hint ? `<div class="cred-card-hint">${esc(hint)}</div>` : ''}
        </div>
        <div class="cred-card-action">${actionHtml}</div>
      </div>`);
    }

    container.innerHTML = cards.length ? cards.join('') : '<div class="empty-state">No providers configured</div>';
  } catch (e) {
    container.innerHTML = `<div class="empty-state">Error: ${esc(e.message)}</div>`;
  }
}

function focusCredForm(provider) {
  const select = byId('cred-provider');
  if (select) {
    select.value = provider;
    onCredProviderChange();
    select.scrollIntoView({ behavior: 'smooth', block: 'center' });
    select.focus();
  }
}

function onCredProviderChange() {
  const provider = byId('cred-provider')?.value;
  const label = byId('cred-key-label');
  const hint = byId('cred-key-hint');
  const input = byId('cred-key');
  
  const PROVIDERS = {
    anthropic: { label: 'Setup Token', hint: 'Starts with sk-ant-...', placeholder: 'sk-ant-...' },
    openrouter: { label: 'API Key', hint: 'Starts with sk-or-v1-...', placeholder: 'sk-or-v1-...' },
    openai: { label: 'API Key', hint: 'Starts with sk-...', placeholder: 'sk-...' },
    google: { label: 'API Key', hint: 'Starts with AIza...', placeholder: 'AIza...' },
    mistral: { label: 'API Key', hint: '', placeholder: 'Paste API key' },
    groq: { label: 'API Key', hint: 'Starts with gsk_...', placeholder: 'gsk_...' },
    together: { label: 'API Key', hint: '', placeholder: 'Paste API key' },
    deepseek: { label: 'API Key', hint: 'Starts with sk-...', placeholder: 'sk-...' },
  };

  const info = PROVIDERS[provider];
  if (info) {
    if (label) label.textContent = info.label;
    if (input) input.placeholder = info.placeholder;
    if (hint) {
      hint.textContent = info.hint;
      hint.style.display = info.hint ? 'block' : 'none';
    }
  } else {
    if (label) label.textContent = 'API Key / Token';
    if (input) input.placeholder = 'Paste your API key or token here';
    if (hint) hint.style.display = 'none';
  }
}

async function saveCredential() {
  const provider = byId('cred-provider')?.value;
  const key = byId('cred-key')?.value?.trim();
  const profileId = byId('cred-profile-id')?.value?.trim();

  if (!provider) return feedback('cred-feedback', 'Please select a provider', 'error');
  if (!key) return feedback('cred-feedback', 'Please enter an API key or token', 'error');

  feedback('cred-feedback', 'Saving credential…', 'info');

  try {
    const body = { provider, key };
    if (profileId) body.profileId = profileId;

    const res = await api('POST', '/api/credentials/save', body);
    if (res.ok) {
      feedback('cred-feedback', `✅ ${res.message}`, 'success');
      byId('cred-key').value = '';
      byId('cred-profile-id').value = '';
      
      // Show restart warning toast
      toast('⚠️ Gateway may need restart for new credentials to take effect. Wait for active tasks to finish first.', 'warning');
      
      // Refresh credential status
      refreshCredentials();
      refreshAuth();
    } else {
      feedback('cred-feedback', `❌ ${res.error}`, 'error');
    }
  } catch (e) {
    feedback('cred-feedback', `❌ Error: ${e.message}`, 'error');
  }
}

// ── Add New Model ────────────────────────────────────────────────────────────

function switchModelType(type) {
  document.querySelectorAll('.model-type-tab').forEach(t => t.classList.remove('active'));
  event.target.classList.add('active');
  byId('add-model-external').style.display = type === 'external' ? 'block' : 'none';
  byId('add-model-local').style.display = type === 'local' ? 'block' : 'none';
}

// Check credential status when provider is selected in the Add Model form
function checkProviderCredentials() {
  const provider = byId('add-model-provider')?.value;
  const statusEl = byId('add-model-cred-status');
  if (!provider || !statusEl) {
    if (statusEl) statusEl.style.display = 'none';
    return;
  }

  // Quick async check
  api('GET', '/api/credentials/status').then(res => {
    if (!res.ok) return;
    const provInfo = res.providers?.[provider];
    if (!provInfo || (!provInfo.hasCredentials && provider !== 'ollama')) {
      statusEl.style.display = 'block';
      statusEl.className = 'cred-status-inline';
      statusEl.style.background = 'rgba(248,113,113,0.06)';
      statusEl.style.border = '1px solid rgba(248,113,113,0.2)';
      statusEl.style.color = 'var(--danger)';
      statusEl.innerHTML = `❌ <strong>No credentials found for ${esc(provider)}.</strong> You'll need to add an API key in the <a href="#" onclick="switchTab('auth'); return false;" style="color:var(--danger);text-decoration:underline">Auth tab</a> before this model can be used.`;
    } else {
      statusEl.style.display = 'block';
      statusEl.className = 'cred-status-inline';
      statusEl.style.background = 'rgba(52,211,153,0.06)';
      statusEl.style.border = '1px solid rgba(52,211,153,0.2)';
      statusEl.style.color = 'var(--success)';
      statusEl.innerHTML = `✅ Credentials configured for ${esc(provider)}. Ready to add model.`;
    }
  });
}

// Wire up the provider dropdown
document.addEventListener('DOMContentLoaded', () => {
  const sel = byId('add-model-provider');
  if (sel) sel.addEventListener('change', checkProviderCredentials);
});

async function addNewModel() {
  const provider = byId('add-model-provider')?.value;
  const modelId = byId('add-model-id')?.value?.trim();
  const displayName = byId('add-model-name')?.value?.trim();
  const contextWindow = parseInt(byId('add-model-ctx')?.value) || undefined;
  const alias = byId('add-model-alias')?.value?.trim();

  if (!provider) return feedback('add-model-feedback', 'Please select a provider', 'error');
  if (!modelId) return feedback('add-model-feedback', 'Please enter a model ID', 'error');

  feedback('add-model-feedback', 'Adding model…', 'info');

  try {
    const res = await api('POST', '/api/models/add', { provider, modelId, displayName, contextWindow, alias });
    if (res.ok) {
      let msg = `✅ ${res.message}`;
      feedback('add-model-feedback', msg, 'success');

      // Clear form
      byId('add-model-id').value = '';
      byId('add-model-name').value = '';
      byId('add-model-ctx').value = '';
      byId('add-model-alias').value = '';
      byId('add-model-cred-status').style.display = 'none';

      // Show warnings
      toast('⚠️ Gateway may need restart for the new model to be available. Wait for active tasks to finish first.', 'warning');
      if (res.needsCredentials) {
        toast(`🔑 ${res.credentialWarning}`, 'warning');
      }

      // Refresh model list
      refreshModels();
    } else {
      feedback('add-model-feedback', `❌ ${res.error}`, 'error');
    }
  } catch (e) {
    feedback('add-model-feedback', `❌ Error: ${e.message}`, 'error');
  }
}

async function addNewLocalModel() {
  const modelId = byId('add-local-model-id')?.value?.trim();
  const displayName = byId('add-local-model-name')?.value?.trim();
  const contextWindow = parseInt(byId('add-local-model-ctx')?.value) || 32768;
  const alias = byId('add-local-model-alias')?.value?.trim();

  if (!modelId) return feedback('add-model-feedback', 'Please enter a model tag (e.g. llama3:8b)', 'error');

  feedback('add-model-feedback', 'Adding local model…', 'info');

  try {
    const res = await api('POST', '/api/models/add', { provider: 'ollama', modelId, displayName, contextWindow, alias });
    if (res.ok) {
      feedback('add-model-feedback', `✅ ${res.message}`, 'success');
      byId('add-local-model-id').value = '';
      byId('add-local-model-name').value = '';
      byId('add-local-model-ctx').value = '32768';
      byId('add-local-model-alias').value = '';

      toast('⚠️ Gateway may need restart for the new model to be available.', 'warning');
      refreshModels();
      refreshLocalModels();
    } else {
      feedback('add-model-feedback', `❌ ${res.error}`, 'error');
    }
  } catch (e) {
    feedback('add-model-feedback', `❌ Error: ${e.message}`, 'error');
  }
}

// ── Provider Probe ───────────────────────────────────────────────────────────

async function runProbe() {
  const btn = byId('btn-probe');
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Probing…';
  const container = byId('probe-results');
  container.innerHTML = '<div class="empty-state"><span class="spinner"></span> Running live probes against all providers… this may take up to 60 seconds</div>';

  try {
    const res = await capi('POST', '/models/probe');
    if (!res.ok || !res.data) {
      container.innerHTML = `<div class="empty-state" style="color:var(--danger)">${esc(res.error || 'Probe failed')}</div>`;
      btn.innerHTML = orig;
      btn.disabled = false;
      return;
    }

    const data = res.data;
    const probeData = data.auth?.probes;
    const providers = data.auth?.providers || [];
    const oauthProviders = data.auth?.oauth?.providers || [];

    let html = '';

    // Summary banner
    if (probeData) {
      const results = probeData.results || [];
      const okCount = results.filter(r => r.status === 'ok').length;
      const failCount = results.filter(r => r.status !== 'ok').length;
      const durationSec = ((probeData.durationMs || 0) / 1000).toFixed(1);

      const summaryClass = failCount === 0 ? 'health-ok' : okCount === 0 ? 'health-err' : 'health-warn';
      html += `<div class="probe-summary ${summaryClass}">
        Probed <strong>${results.length} provider${results.length !== 1 ? 's' : ''}</strong> in ${durationSec}s —
        <strong>${okCount} healthy</strong>${failCount > 0 ? `, <strong>${failCount} with issues</strong>` : ''}
      </div>`;
    }

    // Provider cards with plain English
    html += '<div class="probe-cards">';

    if (probeData?.results) {
      for (const r of probeData.results) {
        const isOk = r.status === 'ok';
        const statusIcon = isOk ? '✅' : r.status === 'unknown' ? '⚠️' : '❌';
        const cardClass = isOk ? 'probe-card-ok' : r.error ? 'probe-card-fail' : 'probe-card-warn';

        // Plain English description
        let description = '';
        if (isOk) {
          description = `<strong>${esc(r.provider)}</strong> is responding normally. `;
          description += `Authenticated via <strong>${esc(r.mode === 'api_key' ? 'API key' : r.mode === 'token' ? 'setup token' : r.mode)}</strong>`;
          if (r.profileId) description += ` (profile: ${esc(r.profileId)})`;
          description += `. Response time: <strong>${(r.latencyMs / 1000).toFixed(1)}s</strong>.`;
        } else if (r.error) {
          description = `<strong>${esc(r.provider)}</strong> did not respond successfully. `;
          if (r.error.includes('timed out')) {
            description += `The request <strong>timed out</strong> after ${(r.latencyMs / 1000).toFixed(1)}s. `;
            description += 'This could mean the provider is slow, the model is loading, or there\'s a network issue.';
          } else if (r.error.includes('401') || r.error.includes('auth')) {
            description += `<strong>Authentication failed.</strong> Check your API key or token for this provider.`;
          } else if (r.error.includes('429') || r.error.includes('rate')) {
            description += `<strong>Rate limited.</strong> You've hit the provider's request limit. Try again later.`;
          } else {
            description += `Error: <strong>${esc(r.error)}</strong>`;
          }
        } else {
          description = `<strong>${esc(r.provider)}</strong> returned status: <strong>${esc(r.status)}</strong>.`;
        }

        // Model tested
        const modelNote = r.model ? `Tested model: <span class="mono" style="font-size:11px">${esc(r.model)}</span>` : '';

        // Latency indicator
        let latencyBadge = '';
        if (r.latencyMs) {
          const secs = r.latencyMs / 1000;
          const latClass = secs < 3 ? 'temp-cool' : secs < 10 ? 'temp-warm' : 'temp-hot';
          const latLabel = secs < 3 ? 'Fast' : secs < 10 ? 'Moderate' : 'Slow';
          latencyBadge = `<span class="live-stat-temp ${latClass}">${latLabel} — ${secs.toFixed(1)}s</span>`;
        }

        // Unique ID for expandable JSON
        const detailId = `probe-detail-${r.provider}-${r.profileId || 'default'}`.replace(/[^a-zA-Z0-9-]/g, '-');

        html += `<div class="probe-result-card ${cardClass}">
          <div class="probe-result-header">
            <span style="font-size:18px">${statusIcon}</span>
            <div class="probe-result-title">
              <div style="font-weight:600;font-size:14px">${esc(r.provider)}</div>
              <div style="font-size:11px;color:var(--text-dim)">${modelNote}</div>
            </div>
            ${latencyBadge}
          </div>
          <div class="probe-result-body">${description}</div>
          <div class="probe-result-expand">
            <button class="btn btn-sm" onclick="toggleProbeDetail('${detailId}')">📋 View Raw Data</button>
            <div id="${detailId}" class="probe-detail-json" style="display:none">
              <pre>${esc(JSON.stringify(r, null, 2))}</pre>
            </div>
          </div>
        </div>`;
      }
    }

    // Also show providers that weren't probed (from the providers list)
    const probedProviders = (probeData?.results || []).map(r => r.provider);
    for (const p of providers) {
      if (probedProviders.includes(p.provider)) continue;
      const effective = p.effective?.kind || 'none';
      const hasAuth = effective !== 'none' && p.profiles?.count > 0;

      html += `<div class="probe-result-card ${hasAuth ? 'probe-card-skip' : 'probe-card-noauth'}">
        <div class="probe-result-header">
          <span style="font-size:18px">${hasAuth ? 'ℹ️' : '🔒'}</span>
          <div class="probe-result-title">
            <div style="font-weight:600;font-size:14px">${esc(p.provider)}</div>
            <div style="font-size:11px;color:var(--text-dim)">Not probed</div>
          </div>
        </div>
        <div class="probe-result-body">
          ${hasAuth
            ? `<strong>${esc(p.provider)}</strong> has credentials configured (${esc(effective)}) but was not included in this probe run.`
            : `<strong>${esc(p.provider)}</strong> has <strong>no credentials configured</strong>. Add an API key or log in to use this provider.`
          }
        </div>
      </div>`;
    }

    html += '</div>';

    // Full raw JSON expandable at the bottom
    const fullDetailId = 'probe-full-json';
    html += `<div style="margin-top:16px;text-align:center">
      <button class="btn btn-sm" onclick="toggleProbeDetail('${fullDetailId}')">🔍 View Complete Raw Response</button>
      <div id="${fullDetailId}" class="probe-detail-json" style="display:none;margin-top:8px">
        <pre>${esc(JSON.stringify(data, null, 2))}</pre>
      </div>
    </div>`;

    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div class="empty-state" style="color:var(--danger)">Error: ${esc(e.message)}</div>`;
  }
  btn.innerHTML = orig;
  btn.disabled = false;
}

function toggleProbeDetail(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

// ── Connection Management UI ─────────────────────────────────────────────────

function openConnModal() {
  byId('conn-modal').style.display = 'flex';
  renderModalConnList();
}

function closeConnModal() {
  byId('conn-modal').style.display = 'none';
}

async function renderModalConnList() {
  const container = byId('modal-conn-list');
  container.innerHTML = connections.map(c => {
    const isActive = c.id === activeConnId;
    return `<div class="conn-item ${isActive ? 'conn-active' : ''}" onclick="byId('conn-select').value='${c.id}'; switchConnection(); closeConnModal();" style="cursor:pointer">
      <div class="conn-item-info">
        <div class="conn-item-name">${esc(c.name)} ${c.default ? '⭐' : ''}</div>
        <div class="conn-item-host">${c.type === 'local' ? 'localhost' : `${esc(c.host || '')}:${c.port || 18789}`}</div>
      </div>
    </div>`;
  }).join('');
}

async function renderConnList() {
  const container = byId('conn-list');
  if (!container) return;

  const healthChecks = connections.map(async (c) => {
    try {
      const res = await api('GET', `/api/connections/${c.id}/health`);
      return { id: c.id, running: isGatewayRunning(res.status) };
    } catch { return { id: c.id, running: false }; }
  });
  const healths = await Promise.all(healthChecks);
  const healthMap = {};
  healths.forEach(h => healthMap[h.id] = h.running);

  container.innerHTML = connections.map(c => {
    const isActive = c.id === activeConnId;
    const healthy = healthMap[c.id];
    const statusCls = healthy === true ? 'conn-status-ok' : healthy === false ? 'conn-status-err' : 'conn-status-unknown';

    return `<div class="conn-item ${isActive ? 'conn-active' : ''}">
      <div class="conn-item-status ${statusCls}"></div>
      <div class="conn-item-info">
        <div class="conn-item-name">${esc(c.name)} ${c.default ? '⭐' : ''}</div>
        <div class="conn-item-host">${c.type === 'local' ? 'localhost (CLI)' : `${esc(c.host || '')}:${c.port || 18789}`}${c.token ? ' 🔒' : ''}${c.type !== 'local' ? ` · MM:${c.mmPort||18800} · Ollama:${c.ollamaPort||11434} · Timeout:${((c.timeoutMs||15000)/1000)}s` : ''}</div>
      </div>
      <div class="conn-item-actions">
        ${!c.default ? `<button class="btn btn-sm" onclick="setDefaultConn('${c.id}')" title="Set default">⭐</button>` : ''}
        <button class="btn btn-sm" onclick="byId('conn-select').value='${c.id}'; switchConnection();" title="Switch to">→</button>
        ${c.type !== 'local' ? `<button class="btn btn-sm" onclick="editConn('${c.id}')" title="Edit connection settings">✏️</button>` : ''}
        ${c.type !== 'local' ? `<button class="btn btn-sm btn-danger" onclick="deleteConn('${c.id}')" title="Remove">✕</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

async function addConnection() {
  const name = byId('conn-name').value.trim();
  const host = byId('conn-host').value.trim();
  const port = parseInt(byId('conn-port').value) || 18789;
  const token = byId('conn-token').value.trim();
  const password = byId('conn-password').value.trim();
  const mmPort = parseInt(byId('conn-mm-port')?.value) || 18800;
  const ollamaPort = parseInt(byId('conn-ollama-port')?.value) || 11434;
  const timeoutMs = parseInt(byId('conn-timeout')?.value) || 15000;
  const tls = byId('conn-tls').checked;

  if (!name || !host) {
    feedback('conn-feedback', 'Name and host are required', 'error');
    return;
  }

  try {
    const res = await api('POST', '/api/connections', { name, host, port, token: token || null, password: password || null, tls, mmPort, ollamaPort, timeoutMs });
    if (res.ok) {
      toast(`Connection "${name}" added`, 'success');
      byId('conn-name').value = '';
      byId('conn-host').value = '';
      byId('conn-port').value = '18789';
      byId('conn-token').value = '';
      byId('conn-password').value = '';
      if (byId('conn-mm-port')) byId('conn-mm-port').value = '18800';
      if (byId('conn-ollama-port')) byId('conn-ollama-port').value = '11434';
      if (byId('conn-timeout')) byId('conn-timeout').value = '15000';
      byId('conn-tls').checked = false;
      await loadConnections();
      renderConnList();
    } else {
      feedback('conn-feedback', res.error, 'error');
    }
  } catch (e) { feedback('conn-feedback', e.message, 'error'); }
}

function editConn(id) {
  const c = connections.find(x => x.id === id);
  if (!c) return;
  const container = byId('conn-list');
  // Insert edit form after the connection item
  const existingForm = document.getElementById('edit-conn-form');
  if (existingForm) existingForm.remove();

  const form = document.createElement('div');
  form.id = 'edit-conn-form';
  form.style.cssText = 'background:var(--bg-card);border:1px solid var(--accent);border-radius:8px;padding:16px;margin:8px 0';
  form.innerHTML = `
    <h4 style="margin:0 0 12px 0">Edit: ${esc(c.name)}</h4>
    <div class="form-grid">
      <div class="form-field">
        <label>Host / IP</label>
        <input type="text" id="edit-host" value="${esc(c.host || '')}">
      </div>
      <div class="form-field">
        <label>Gateway Port</label>
        <input type="text" id="edit-port" value="${c.port || 18789}">
      </div>
      <div class="form-field">
        <label>Token</label>
        <input type="password" id="edit-token" value="${esc(c.token || '')}" placeholder="Leave empty to keep current">
      </div>
      <div class="form-field">
        <label>Model Manager Port</label>
        <input type="text" id="edit-mm-port" value="${c.mmPort || 18800}">
      </div>
      <div class="form-field">
        <label>Ollama Port</label>
        <input type="text" id="edit-ollama-port" value="${c.ollamaPort || 11434}">
      </div>
      <div class="form-field">
        <label>Connection Timeout (ms)</label>
        <input type="number" id="edit-timeout" value="${c.timeoutMs || 15000}" min="1000" max="60000" step="1000">
        <small style="color:var(--text-muted);font-size:11px">Increase to 30000+ for Tailscale relay connections</small>
      </div>
      <div class="form-field">
        <label class="toggle-label">
          <input type="checkbox" id="edit-tls" ${c.tls ? 'checked' : ''}> Use TLS
        </label>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn btn-primary" onclick="saveEditConn('${c.id}')">Save Changes</button>
      <button class="btn" onclick="document.getElementById('edit-conn-form').remove()">Cancel</button>
    </div>
    <div id="edit-conn-feedback" class="feedback"></div>
  `;
  container.appendChild(form);
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function saveEditConn(id) {
  const data = {
    host: byId('edit-host').value.trim(),
    port: parseInt(byId('edit-port').value) || 18789,
    token: byId('edit-token').value.trim() || undefined,
    mmPort: parseInt(byId('edit-mm-port').value) || 18800,
    ollamaPort: parseInt(byId('edit-ollama-port').value) || 11434,
    timeoutMs: parseInt(byId('edit-timeout').value) || 15000,
    tls: byId('edit-tls').checked,
  };
  try {
    const res = await api('PUT', `/api/connections/${id}`, data);
    if (res.ok) {
      toast('Connection updated', 'success');
      document.getElementById('edit-conn-form')?.remove();
      await loadConnections();
      renderConnList();
    } else {
      feedback('edit-conn-feedback', res.error, 'error');
    }
  } catch (e) {
    feedback('edit-conn-feedback', e.message, 'error');
  }
}

async function deleteConn(id) {
  if (!confirm('Remove this connection?')) return;
  await api('DELETE', `/api/connections/${id}`);
  await loadConnections();
  renderConnList();
  toast('Connection removed', 'info');
}

async function setDefaultConn(id) {
  await api('POST', `/api/connections/${id}/default`);
  await loadConnections();
  renderConnList();
  toast('Default updated', 'success');
}

// ── Remote Connectivity Test ─────────────────────────────────────────────────

async function testRemoteConnectivity() {
  const btn = byId('btn-remote-test');
  const container = byId('remote-test-results');
  if (!container) return;

  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Testing…';
  container.innerHTML = '<div class="empty-state"><span class="spinner"></span> Testing remote connectivity… this may take a few seconds</div>';

  try {
    const res = await capi('GET', '/remote-test');
    if (!res.ok) {
      container.innerHTML = `<div class="empty-state" style="color:var(--danger)">${esc(res.error || 'Test failed')}</div>`;
      btn.innerHTML = orig;
      btn.disabled = false;
      return;
    }

    const { gateway, mm, ollama } = res.data;
    const timeMs = res.timeMs;
    const okCount = [gateway, mm, ollama].filter(t => t?.ok).length;
    const totalCount = 3;

    // Summary banner
    let summaryClass, summaryText;
    if (okCount === totalCount) {
      summaryClass = 'rt-summary-ok';
      summaryText = `✅ All ${totalCount} services reachable — full remote management available`;
    } else if (okCount > 0) {
      summaryClass = 'rt-summary-partial';
      summaryText = `⚠️ ${okCount} of ${totalCount} services reachable — some features will be limited`;
    } else {
      summaryClass = 'rt-summary-fail';
      summaryText = `❌ No remote services reachable — check network, firewall, and service status`;
    }

    let html = `<div class="rt-summary ${summaryClass}">${summaryText} <span style="margin-left:auto;font-size:11px;opacity:0.7">${timeMs}ms</span></div>`;
    html += '<div class="remote-test-grid">';

    // Render each test result
    const tests = [
      { key: 'gateway', label: 'OpenClaw Gateway', icon: '🔌', data: gateway },
      { key: 'mm', label: 'Model Manager', icon: '⚡', data: mm },
      { key: 'ollama', label: 'Ollama', icon: '🦙', data: ollama },
    ];

    for (const t of tests) {
      const d = t.data || {};
      const ok = d.ok;
      const cardClass = ok ? 'rt-card-ok' : 'rt-card-fail';
      const statusIcon = ok ? '✅' : '❌';
      const statusText = ok ? 'Reachable' : 'Unreachable';

      // Extra info for successful tests
      let extraHtml = '';
      if (ok && t.key === 'ollama' && d.modelsCount != null) {
        extraHtml = `<div style="font-size:12px;margin-top:4px;color:var(--success)">${d.modelsCount} model${d.modelsCount !== 1 ? 's' : ''} installed</div>`;
      }
      if (ok && t.key === 'mm' && d.info?.data) {
        const info = d.info.data;
        const gpuText = info.gpus?.length ? `${info.gpus.length} GPU${info.gpus.length > 1 ? 's' : ''}` : 'No GPU';
        const ramText = info.ram ? `${Math.round(info.ram.totalMB / 1024)} GB RAM` : '';
        extraHtml = `<div style="font-size:12px;margin-top:4px;color:var(--success)">${gpuText}${ramText ? ' • ' + ramText : ''}</div>`;
      }

      const rawId = `rt-raw-${t.key}`;

      html += `<div class="rt-card ${cardClass}">
        <span class="rt-icon">${t.icon}</span>
        <div class="rt-body">
          <div class="rt-title">${statusIcon} ${esc(t.label)} — ${statusText}</div>
          ${d.url ? `<div class="rt-url">${esc(d.url)}</div>` : ''}
          <div class="rt-hint" style="white-space:pre-line">${esc(d.hint || '')}</div>
          ${extraHtml}
          <button class="rt-expand-btn" onclick="toggleRtRaw('${rawId}')">📋 Raw Data</button>
          <div id="${rawId}" class="rt-raw" style="display:none">
            <pre>${esc(JSON.stringify(d, null, 2))}</pre>
          </div>
        </div>
        <div class="rt-actions">
          <button class="btn btn-sm" onclick="retrySingleTest('${t.key}')" title="Retry this test">↻</button>
        </div>
      </div>`;
    }

    html += '</div>';
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div class="empty-state" style="color:var(--danger)">Error: ${esc(e.message)}</div>`;
  }

  btn.innerHTML = orig;
  btn.disabled = false;
}

function toggleRtRaw(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

async function retrySingleTest(key) {
  // Re-run the full test (individual retry would need a separate endpoint)
  toast(`Retrying ${key} test…`, 'info');
  await testRemoteConnectivity();
}

async function refreshRemoteData() {
  toast('Refreshing all data for current connection…', 'info');
  refreshAll();
  const activeTab = document.querySelector('.tab.active')?.dataset?.tab;
  if (activeTab === 'health') { refreshHealth(); refreshSystemStats(); refreshProviderStatus(); }
  if (activeTab === 'local') refreshLocalModels();
  if (activeTab === 'auth') refreshCredentials();
  if (activeTab === 'connections') renderConnList();
}

// ── Gateway Discovery ────────────────────────────────────────────────────────

async function discoverGateways() {
  const discoverSection = byId('discover-results');
  const discoverList = byId('discover-list');
  if (!discoverSection || !discoverList) return;
  discoverSection.style.display = 'block';
  discoverList.innerHTML = '<div class="empty-state"><span class="spinner"></span> Scanning network…</div>';

  try {
    const res = await api('GET', '/api/discover');
    if (res.ok && res.data) {
      const beacons = res.data.beacons || [];
      if (beacons.length === 0) {
        discoverList.innerHTML = '<div class="empty-state">No gateways found. Make sure Bonjour discovery is enabled on your remote instances.</div>';
        return;
      }
      discoverList.innerHTML = beacons.map(b => {
        const host = b.tailnetDns || b.host || b.address || '';
        const port = b.gatewayPort || b.port || 18789;
        const name = b.name || b.hostname || host;
        return `<div class="conn-item">
          <div class="conn-item-status conn-status-ok"></div>
          <div class="conn-item-info">
            <div class="conn-item-name">📡 ${esc(name)}</div>
            <div class="conn-item-host">${esc(host)}:${port}</div>
          </div>
          <div class="conn-item-actions">
            <button class="btn btn-sm btn-primary" onclick="autoAddDiscovered('${esc(name)}','${esc(host)}',${port})">+ Add</button>
          </div>
        </div>`;
      }).join('');
    } else {
      discoverList.innerHTML = `<div class="empty-state">${esc(res.data?.error || 'Discovery failed')}</div>`;
    }
  } catch (e) {
    discoverList.innerHTML = `<div class="empty-state">Error: ${esc(e.message)}</div>`;
  }
}

// ── Provider Failover ────────────────────────────────────────────────────────

let failoverInterval = null;

async function refreshProviderStatus() {
  const container = byId('provider-failover');
  if (!container) return;

  setLoading('providers', true);
  try {
    const res = await capiRetry('/providers/status');
    if (!res.ok) {
      if (AppState.cache.providers) markStale('provider-failover');
      setLoading('providers', false);
      return;
    }
    AppState.cache.providers = res;
    updateState('providers.status', res.providers || {});
    updateState('providers.lastUpdate', Date.now());
    clearStale('provider-failover');

    const { primary, fallbacks, providers } = res;
    const anyInCooldown = Object.values(providers).some(p => p.inCooldown || p.isDisabled);

    // Build the full model list with provider info
    const allModels = [primary, ...fallbacks];
    const modelsByProvider = {};
    for (const m of allModels) {
      const prov = m.split('/')[0];
      if (!modelsByProvider[prov]) modelsByProvider[prov] = [];
      if (!modelsByProvider[prov].includes(m)) modelsByProvider[prov].push(m);
    }

    let html = `<div class="failover-panel ${anyInCooldown ? 'has-cooldown' : ''}">`;
    html += `<div class="failover-header">
      <span class="failover-title">${anyInCooldown ? '🚨 Provider Cooldown Active' : '✅ All Providers Ready'}</span>
      <button class="btn btn-sm" onclick="refreshProviderStatus()">↻ Refresh</button>
    </div>`;

    if (anyInCooldown) {
      html += `<div style="font-size:12px;color:var(--text-dim);margin-bottom:12px">
        A provider is rate-limited. Use <strong>Switch To</strong> to instantly failover to a working provider, or <strong>Clear Cooldown</strong> to reset the timer.
      </div>`;
    }

    // Primary model row
    const primaryProv = primary.split('/')[0];
    const primaryStatus = providers[primaryProv];
    const primaryInCooldown = primaryStatus?.inCooldown || primaryStatus?.isDisabled;

    html += `<div class="provider-row is-primary ${primaryInCooldown ? 'in-cooldown' : ''}">
      <span class="pr-status-dot ${primaryInCooldown ? 'pr-dot-cooldown' : 'pr-dot-ready'}"></span>
      <div class="pr-info">
        <div class="pr-name">⭐ ${esc(primary)} <span style="font-size:11px;color:var(--text-label);font-weight:400">(primary)</span></div>
        <div class="pr-detail">${primaryInCooldown
          ? `<span class="cooldown-timer">⏳ Cooldown: ${formatCooldown(primaryStatus.cooldownSeconds || primaryStatus.disabledSeconds)} remaining</span> • ${primaryStatus.errorCount} error${primaryStatus.errorCount !== 1 ? 's' : ''}`
          : 'Ready'
        }</div>
      </div>
      <div class="pr-actions">
        ${primaryInCooldown ? `<button class="btn-clear-cd" onclick="clearCooldown('${esc(primaryProv)}')">Clear Cooldown</button>` : ''}
      </div>
    </div>`;

    // Fallback rows — show unique providers with their best available model
    const shownProviders = new Set([primaryProv]);
    for (const fb of fallbacks) {
      const prov = fb.split('/')[0];
      const status = providers[prov];
      const inCooldown = status?.inCooldown || status?.isDisabled;
      const isReady = !inCooldown;

      // Show provider status indicator
      const dotClass = status?.isDisabled ? 'pr-dot-disabled' : inCooldown ? 'pr-dot-cooldown' : 'pr-dot-ready';

      let detailText = '';
      if (inCooldown) {
        detailText = `<span class="cooldown-timer">⏳ ${formatCooldown(status.cooldownSeconds || status.disabledSeconds)}</span> • ${status.errorCount} error${status.errorCount !== 1 ? 's' : ''}`;
      } else {
        detailText = 'Ready — available as fallback';
      }

      html += `<div class="provider-row ${inCooldown ? 'in-cooldown' : ''}">
        <span class="pr-status-dot ${dotClass}"></span>
        <div class="pr-info">
          <div class="pr-name">${esc(fb)}</div>
          <div class="pr-detail">${detailText}</div>
        </div>
        <div class="pr-actions">
          ${inCooldown ? `<button class="btn-clear-cd" onclick="clearCooldown('${esc(prov)}')">Clear</button>` : ''}
          ${isReady && fb !== primary ? `<button class="btn-failover" onclick="failoverTo('${esc(fb)}')">Switch To ⚡</button>` : ''}
        </div>
      </div>`;
    }

    html += '</div>';
    container.innerHTML = html;

    // Start/stop auto-refresh based on cooldown state
    if (anyInCooldown && !failoverInterval) {
      failoverInterval = setInterval(refreshProviderStatus, 5000);
    } else if (!anyInCooldown && failoverInterval) {
      clearInterval(failoverInterval);
      failoverInterval = null;
    }

  } catch (e) {
    // Preserve stale data on transient errors, show error panel if no cached data
    if (AppState.cache.providers) {
      markStale('provider-failover');
    } else {
      container.innerHTML = `<div class="failover-panel" style="border-color:var(--danger)">
        <div class="failover-header">
          <span class="failover-title">⚠️ Provider Status Unavailable</span>
          <button class="btn btn-sm" onclick="refreshProviderStatus()">↻ Retry</button>
        </div>
        <div style="font-size:12px;color:var(--text-dim);margin-top:8px">
          Could not load provider status: ${esc(e.message)}<br>
          <small>This may happen if the remote Model Manager is unreachable or still starting up.</small>
        </div>
      </div>`;
    }
  }
  setLoading('providers', false);
}

function formatCooldown(seconds) {
  if (seconds <= 0) return 'expired';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

async function failoverTo(model) {
  if (!confirm(`Switch primary model to ${model}?\n\nThis takes effect immediately — no gateway restart needed.`)) return;

  try {
    const res = await capi('POST', '/failover', { model });
    if (res.ok) {
      toast(`⚡ Switched to ${model} — ${res.note}`, 'success');
      refreshProviderStatus();
      refreshModels();
    } else {
      toast(`❌ ${res.error}`, 'error');
    }
  } catch (e) {
    toast(`❌ ${e.message}`, 'error');
  }
}

async function clearCooldown(provider) {
  try {
    const res = await capi('POST', '/providers/clear-cooldown', { provider });
    if (res.ok) {
      toast(`✅ ${res.message}`, 'success');
      refreshProviderStatus();
    } else {
      toast(`❌ ${res.error}`, 'error');
    }
  } catch (e) {
    toast(`❌ ${e.message}`, 'error');
  }
}

// ── Live System Stats ────────────────────────────────────────────────────────

async function refreshSystemStats() {
  const container = byId('live-system-stats');
  if (!container) return;

  setLoading('system', true);
  try {
    const res = await capiRetry('/system/stats');
    if (!res?.ok || !res.data) {
      if (AppState.cache.system) markStale('live-system-stats');
      setLoading('system', false);
      return;
    }
    AppState.cache.system = res.data;
    updateState('system.gpu', res.data.gpus || []);
    updateState('system.ram', res.data.ram || null);
    updateState('system.lastUpdate', Date.now());
    clearStale('live-system-stats');

    const { gpus, ram } = res.data;
    let cards = [];

    // GPU cards
    if (gpus && gpus.length > 0) {
      gpus.forEach((g, i) => {
        const usedPct = g.totalMiB > 0 ? Math.round((g.usedMiB / g.totalMiB) * 100) : 0;
        const barColor = usedPct > 90 ? 'var(--danger)' : usedPct > 70 ? 'var(--warning)' : 'var(--success)';

        // Temperature badge
        let tempHtml = '';
        if (g.tempC != null && !isNaN(g.tempC)) {
          const tempCls = g.tempC > 80 ? 'temp-hot' : g.tempC > 60 ? 'temp-warm' : 'temp-cool';
          tempHtml = `<span class="live-stat-temp ${tempCls}">${g.tempC}°C</span>`;
        }

        // GPU utilization
        const utilPct = g.utilPct != null ? g.utilPct : 0;
        const utilColor = utilPct > 80 ? 'var(--danger)' : utilPct > 50 ? 'var(--warning)' : 'var(--success)';

        const label = gpus.length > 1 ? `GPU ${i + 1}` : 'GPU';

        cards.push(`<div class="live-stat-card">
          <div class="live-stat-header">
            <span class="live-stat-title">🎮 ${label} <span style="font-weight:400;color:var(--text-dim);font-size:11px">${esc(g.name)}</span></span>
            ${tempHtml}
          </div>
          <div style="margin-bottom:8px">
            <div style="font-size:11px;color:var(--text-label);margin-bottom:3px">VRAM</div>
            <div class="live-bar-container">
              <div class="live-bar-fill" style="width:${usedPct}%;background:${barColor}"></div>
              <div class="live-bar-text">${g.usedMiB} / ${g.totalMiB} MiB (${usedPct}%)</div>
            </div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-label);margin-bottom:3px">Utilization</div>
            <div class="live-bar-container">
              <div class="live-bar-fill" style="width:${utilPct}%;background:${utilColor}"></div>
              <div class="live-bar-text">${utilPct}%</div>
            </div>
          </div>
        </div>`);
      });
    }

    // RAM card
    if (ram && ram.totalMB > 0) {
      const usedMB = ram.totalMB - ram.freeMB;
      const usedPct = Math.round((usedMB / ram.totalMB) * 100);
      const barColor = usedPct > 90 ? 'var(--danger)' : usedPct > 75 ? 'var(--warning)' : 'var(--success)';
      const totalGB = (ram.totalMB / 1024).toFixed(1);
      const usedGB = (usedMB / 1024).toFixed(1);
      const freeGB = (ram.freeMB / 1024).toFixed(1);

      cards.push(`<div class="live-stat-card">
        <div class="live-stat-header">
          <span class="live-stat-title">🧠 System RAM</span>
          <span class="live-stat-value">${totalGB} GB</span>
        </div>
        <div class="live-bar-container">
          <div class="live-bar-fill" style="width:${usedPct}%;background:${barColor}"></div>
          <div class="live-bar-text">${usedGB} / ${totalGB} GB (${usedPct}%)</div>
        </div>
        <div class="live-stat-meta">
          <span>${freeGB} GB free</span>
          <span>${usedGB} GB used</span>
        </div>
      </div>`);
    }

    // Running models cards (with offload detection)
    const running = res.data.runningModels || [];
    if (running.length > 0) {
      for (const rm of running) {
        const sizeMB = Math.round(rm.size / (1024 * 1024));
        const vramMB = Math.round(rm.sizeVram / (1024 * 1024));
        const cpuMB = Math.round(rm.sizeCpu / (1024 * 1024));
        const isOffloaded = rm.gpuPct < 100 && rm.gpuPct > 0;
        const isCpuOnly = rm.gpuPct === 0 && rm.size > 0;
        const isFullGpu = rm.gpuPct === 100;

        let statusIcon, statusText, statusClass, barHtml;

        if (isCpuOnly) {
          statusIcon = '🐌';
          statusText = 'CPU Only — No GPU acceleration';
          statusClass = 'temp-hot';
          barHtml = `
            <div class="live-bar-container">
              <div class="live-bar-fill" style="width:100%;background:var(--danger)"></div>
              <div class="live-bar-text">100% CPU (${cpuMB} MB in RAM)</div>
            </div>`;
        } else if (isOffloaded) {
          statusIcon = '⚠️';
          statusText = `Offloaded — ${rm.gpuPct}% GPU / ${rm.cpuPct}% CPU`;
          statusClass = 'temp-warm';
          barHtml = `
            <div class="live-bar-container" style="display:flex">
              <div style="width:${rm.gpuPct}%;background:var(--success);height:100%;border-radius:5px 0 0 5px"></div>
              <div style="width:${rm.cpuPct}%;background:var(--warning);height:100%;border-radius:0 5px 5px 0"></div>
            </div>
            <div class="live-stat-meta">
              <span>🟢 GPU: ${vramMB} MB (${rm.gpuPct}%)</span>
              <span>🟡 CPU: ${cpuMB} MB (${rm.cpuPct}%)</span>
            </div>`;
        } else {
          statusIcon = '✅';
          statusText = '100% GPU';
          statusClass = 'temp-cool';
          barHtml = `
            <div class="live-bar-container">
              <div class="live-bar-fill" style="width:100%;background:var(--success)"></div>
              <div class="live-bar-text">100% GPU (${vramMB} MB VRAM)</div>
            </div>`;
        }

        // Time until unload
        let expiryText = '';
        if (rm.expiresAt) {
          const remaining = new Date(rm.expiresAt).getTime() - Date.now();
          if (remaining > 0) {
            expiryText = `Unloads in ${dur(remaining)}`;
          }
        }

        cards.push(`<div class="live-stat-card" style="border-color:${isOffloaded ? 'var(--warning)' : isCpuOnly ? 'var(--danger)' : 'var(--border)'}">
          <div class="live-stat-header">
            <span class="live-stat-title">${statusIcon} ${esc(rm.name)}</span>
            <span class="live-stat-temp ${statusClass}">${esc(statusText)}</span>
          </div>
          ${barHtml}
          <div class="live-stat-meta" style="margin-top:6px">
            <span>${esc(rm.contextLength ? `Context: ${rm.contextLength.toLocaleString()}` : '')}</span>
            <span>${esc(expiryText)}</span>
          </div>
        </div>`);
      }
    }

    if (cards.length > 0) {
      container.innerHTML = cards.join('');
    } else if (res.source === 'unavailable') {
      container.innerHTML = '<div class="empty-state">System stats unavailable for remote connection</div>';
    }
  } catch (e) {
    // Don't overwrite on transient errors — keep last good state
    if (AppState.cache.system) markStale('live-system-stats');
  }
  setLoading('system', false);
}

// ── Local Models & System Info ────────────────────────────────────────────────

async function refreshLocalModels() {
  const specsContainer = byId('system-specs');
  const listContainer = byId('local-model-list');

  specsContainer.innerHTML = '<div class="empty-state"><span class="spinner"></span> Discovering system…</div>';
  listContainer.innerHTML = '<div class="empty-state"><span class="spinner"></span> Analyzing models…</div>';

  // Fetch system info and local models in parallel (connection-aware)
  const [sysRes, modelsRes] = await Promise.all([
    capiRetry('/system/info').catch(() => null),
    capiRetry('/system/local-models').catch(() => null),
  ]);

  // Show remote source info if applicable
  const isRemote = connections.find(c => c.id === activeConnId)?.type === 'remote';
  const sysSource = sysRes?.source;
  const modelsSource = modelsRes?.source;

  // Render system specs
  if (sysRes?.ok && sysRes.data) {
    const s = sysRes.data;
    const cpu = s.cpu;
    const ramTotal = s.ram?.totalBytes ? Math.round(s.ram.totalBytes / (1024**3)) : 0;
    const ramFree = s.ram?.freeBytes ? Math.round(s.ram.freeBytes / (1024**3)) : 0;
    const ramUsedPct = ramTotal > 0 ? Math.round(((ramTotal - ramFree) / ramTotal) * 100) : 0;

    let gpuHtml = '';
    if (s.gpus?.length > 0) {
      gpuHtml = s.gpus.map((g, i) => {
        const usedPct = g.totalMiB > 0 ? Math.round((g.usedMiB / g.totalMiB) * 100) : 0;
        const barColor = usedPct > 85 ? 'var(--danger)' : usedPct > 60 ? 'var(--warning)' : 'var(--success)';
        return `<div class="stat-card">
          <span class="stat-label">GPU ${s.gpus.length > 1 ? i + 1 : ''}</span>
          <span class="stat-value" style="font-size:13px">${esc(g.name)}</span>
          <div class="spec-bar-wrap">
            <div class="spec-bar"><div class="spec-bar-fill" style="width:${usedPct}%;background:${barColor}"></div></div>
            <div class="spec-bar-label">
              <span>${g.usedMiB} MB used</span>
              <span>${g.freeMiB} MB free / ${g.totalMiB} MB</span>
            </div>
          </div>
        </div>`;
      }).join('');
    } else {
      gpuHtml = `<div class="stat-card"><span class="stat-label">GPU</span><span class="stat-value" style="color:var(--text-dim)">No GPU detected</span></div>`;
    }

    const ramBarColor = ramUsedPct > 85 ? 'var(--danger)' : ramUsedPct > 70 ? 'var(--warning)' : 'var(--success)';

    let sourceLabel = '';
    if (sysSource === 'remote-model-manager') sourceLabel = `<div class="stat-card" style="grid-column:1/-1;padding:8px 16px"><span style="font-size:11px;color:var(--text-label)">📡 System info from remote Model Manager</span></div>`;

    specsContainer.innerHTML = `
      ${sourceLabel}
      <div class="stat-card">
        <span class="stat-label">CPU</span>
        <span class="stat-value" style="font-size:13px">${esc(cpu?.Name || 'Unknown')}</span>
        <div style="font-size:11px;color:var(--text-dim);margin-top:4px">${cpu?.NumberOfCores || '?'} cores / ${cpu?.NumberOfLogicalProcessors || '?'} threads</div>
      </div>
      <div class="stat-card">
        <span class="stat-label">System RAM</span>
        <span class="stat-value">${ramTotal} GB</span>
        <div class="spec-bar-wrap">
          <div class="spec-bar"><div class="spec-bar-fill" style="width:${ramUsedPct}%;background:${ramBarColor}"></div></div>
          <div class="spec-bar-label">
            <span>${ramTotal - ramFree} GB used</span>
            <span>${ramFree} GB free</span>
          </div>
        </div>
      </div>
      ${gpuHtml}
    `;
  } else if (sysRes?.hint) {
    specsContainer.innerHTML = `<div class="empty-state" style="grid-column:1/-1">${esc(sysRes.hint)}</div>`;
  } else {
    specsContainer.innerHTML = `<div class="empty-state" style="grid-column:1/-1">Could not load system info</div>`;
  }

  // Render local models with compatibility
  if (modelsRes?.ok && modelsRes.data) {
    const { models, system } = modelsRes.data;

    if (models.length === 0) {
      listContainer.innerHTML = `<div class="empty-state">${modelsRes.hint ? esc(modelsRes.hint) : 'No local models found. Install Ollama and pull some models to get started.'}</div>`;
      return;
    }

    // Sort: running first, then by size descending
    models.sort((a, b) => {
      if (a.isRunning !== b.isRunning) return b.isRunning ? 1 : -1;
      return b.size - a.size;
    });

    const totalVRAM = system.totalVRAM || 0;

    let hintHtml = '';
    if (modelsRes.source === 'remote-ollama') {
      hintHtml = `<div class="remote-hint">📡 Models retrieved from remote Ollama. System specs unavailable — run the Model Manager on the remote host for full compatibility analysis.</div>`;
    } else if (modelsRes.source === 'remote-model-manager') {
      hintHtml = `<div class="remote-hint">📡 Full compatibility analysis from remote Model Manager</div>`;
    }

    listContainer.innerHTML = hintHtml + models.map(m => {
      const barCls = m.status === 'compatible' ? 'lm-compat-ok' : m.status === 'warning' ? 'lm-compat-warn' : 'lm-compat-err';

      // VRAM usage bar
      let vramBarHtml = '';
      if (totalVRAM > 0) {
        const pct = Math.min(100, Math.round((m.estimatedVRAM / totalVRAM) * 100));
        const barColor = pct > 100 ? 'var(--danger)' : pct > 75 ? 'var(--warning)' : 'var(--success)';
        vramBarHtml = `
          <div class="lm-vram-bar">
            <div class="lm-vram-fill" style="width:${Math.min(100, pct)}%;background:${barColor}"></div>
          </div>
          <div style="font-size:10px;color:var(--text-label);margin-top:2px">
            ~${m.estimatedVRAM} MB needed / ${totalVRAM} MB total VRAM (${pct}%)
          </div>
        `;
      }

      // Offload badge
      let offloadHtml = '';
      if (m.offload) {
        if (m.offload.status === 'offloaded') {
          offloadHtml = `<span class="lm-running" style="background:var(--warning-bg);color:var(--warning)">⚠️ ${m.offload.gpuPct}% GPU / ${m.offload.cpuPct}% CPU</span>`;
        } else if (m.offload.status === 'cpu-only') {
          offloadHtml = `<span class="lm-running" style="background:var(--danger-bg);color:var(--danger)">🐌 CPU Only</span>`;
        } else if (m.offload.status === 'full-gpu') {
          offloadHtml = `<span class="lm-running" style="background:var(--success-bg);color:var(--success)">✅ 100% GPU</span>`;
        }
      }

      // Expiry info
      let expiryHtml = '';
      if (m.expiresAt) {
        const remaining = new Date(m.expiresAt).getTime() - Date.now();
        if (remaining > 0) {
          expiryHtml = `<span class="lm-meta-item" style="color:var(--text-label)">⏳ Unloads in ${dur(remaining)}</span>`;
        }
      }

      return `<div class="local-model-card" style="${m.offload?.status === 'offloaded' ? 'border-color:var(--warning)' : m.offload?.status === 'cpu-only' ? 'border-color:var(--danger)' : ''}">
        <div class="lm-compat-bar ${barCls}"></div>
        <div class="lm-body">
          <div class="lm-info">
            <div class="lm-name">
              ${esc(m.name)}
              ${m.isRunning ? '<span class="lm-running">Running</span>' : ''}
              ${offloadHtml}
            </div>
            <div class="lm-meta">
              <span class="lm-meta-item"><strong>${esc(m.sizeHuman)}</strong> on disk</span>
              <span class="lm-meta-item"><strong>${esc(m.parameterSize)}</strong> params</span>
              <span class="lm-meta-item">${esc(m.quantization)}</span>
              <span class="lm-meta-item">${esc(m.family)}</span>
              ${expiryHtml}
            </div>
          </div>
          <div class="lm-compat">
            ${esc(m.recommendation)}
            ${vramBarHtml}
          </div>
        </div>
      </div>`;
    }).join('');
  } else {
    const hint = modelsRes?.hint || modelsRes?.error || 'Could not load local models. Is Ollama running?';
    listContainer.innerHTML = `<div class="empty-state">${esc(hint)}</div>`;
  }
}

function autoAddDiscovered(name, host, port) {
  byId('conn-name').value = name;
  byId('conn-host').value = host;
  byId('conn-port').value = port;
  byId('conn-name').scrollIntoView({ behavior: 'smooth' });
  toast('Prefilled — add a token if needed, then click Add Connection', 'info');
}

// ── Logs Tab ──────────────────────────────────────────────────────────────────

let logAutoRefreshInterval = null;

async function refreshLogFiles() {
  const select = byId('log-file-select');
  const prev = select.value;
  const res = await api('GET', '/api/logs/list');
  if (!res.ok) return;

  select.innerHTML = '<option value="">Select log file…</option>' +
    (res.files || []).map(f => {
      const sizeStr = f.size < 1024 ? `${f.size} B` : f.size < 1024 * 1024 ? `${(f.size / 1024).toFixed(1)} KB` : `${(f.size / (1024 * 1024)).toFixed(1)} MB`;
      return `<option value="${esc(f.name)}">${esc(f.name)} (${sizeStr})</option>`;
    }).join('');

  // Re-select previous or auto-select model-manager.log
  if (prev && res.files.some(f => f.name === prev)) {
    select.value = prev;
  } else if (res.files.some(f => f.name === 'model-manager.log')) {
    select.value = 'model-manager.log';
  }

  if (select.value) loadLogFile();
}

async function loadLogFile() {
  const name = byId('log-file-select').value;
  const viewer = byId('log-viewer');
  const status = byId('log-status');
  if (!name) {
    viewer.innerHTML = '<div class="empty-state">Select a log file to view its contents.</div>';
    status.textContent = '';
    return;
  }

  const res = await api('GET', `/api/logs/${encodeURIComponent(name)}?lines=200`);
  if (!res.ok) {
    viewer.innerHTML = `<div class="empty-state">Error loading log: ${esc(res.error || 'unknown')}</div>`;
    return;
  }

  renderLogLines(res.lines || [], name);
  status.textContent = `Showing ${res.lines?.length || 0} of ${res.total || 0} lines — ${new Date().toLocaleTimeString()}`;
}

function renderLogLines(lines, name) {
  const viewer = byId('log-viewer');
  if (!lines.length) {
    viewer.innerHTML = '<div class="empty-state">Log file is empty.</div>';
    return;
  }

  const isJsonl = name.endsWith('.jsonl') || name.endsWith('.log');
  const html = lines.map(line => {
    // Try to parse as JSONL
    let parsed = null;
    if (isJsonl) {
      try { parsed = JSON.parse(line); } catch {}
    }

    if (parsed && parsed.ts && parsed.level) {
      const levelClass = parsed.level === 'error' ? 'log-line-error' : parsed.level === 'warn' ? 'log-line-warn' : 'log-line-info';
      const ts = parsed.ts.replace('T', ' ').replace(/\.\d+Z$/, '');
      let msg = esc(parsed.message || '');
      if (parsed.details) {
        msg += ' <span style="color:var(--text-dim)">' + esc(typeof parsed.details === 'string' ? parsed.details : JSON.stringify(parsed.details)) + '</span>';
      }
      return `<div class="log-line ${levelClass}"><span class="log-line-ts">${esc(ts)}</span><span class="log-line-level">${esc(parsed.level)}</span><span class="log-line-msg">${msg}</span></div>`;
    }

    // Plain text fallback — highlight errors/warnings
    const lower = line.toLowerCase();
    const cls = lower.includes('error') || lower.includes('fail') ? 'log-line-error' :
                lower.includes('warn') ? 'log-line-warn' : 'log-line-info';
    return `<div class="log-line ${cls}">${esc(line)}</div>`;
  }).join('');

  viewer.innerHTML = html;
  // Auto-scroll to bottom
  viewer.scrollTop = viewer.scrollHeight;
}

function toggleLogAutoRefresh() {
  const on = byId('log-auto-refresh').checked;
  if (logAutoRefreshInterval) {
    clearInterval(logAutoRefreshInterval);
    logAutoRefreshInterval = null;
  }
  if (on) {
    logAutoRefreshInterval = setInterval(() => {
      if (byId('log-file-select').value) loadLogFile();
    }, 5000);
  }
}

function downloadLogFile() {
  const name = byId('log-file-select').value;
  if (!name) { toast('Select a log file first', 'warning'); return; }
  window.open(`/api/logs/${encodeURIComponent(name)}/download`, '_blank');
}

async function clearLogFile() {
  const name = byId('log-file-select').value;
  if (!name) { toast('Select a log file first', 'warning'); return; }
  if (!confirm(`Rotate ${name}? Current content will be saved as ${name}.1`)) return;

  const res = await api('POST', `/api/logs/${encodeURIComponent(name)}/clear`);
  if (res.ok) {
    toast(res.message || 'Log rotated', 'success');
    refreshLogFiles();
  }
}
