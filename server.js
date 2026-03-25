const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
const PORT = process.env.MM_PORT || 18800;
const CONNECTIONS_FILE = path.join(__dirname, 'connections.json');

// ── Logging ──────────────────────────────────────────────────────────────────

const LOGS_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.openclaw', 'logs');
const MM_LOG = path.join(LOGS_DIR, 'model-manager.log');
const MM_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

// Ensure logs directory exists
try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch {}

function mmLog(level, message, details) {
  try {
    // Rotate if over max size
    try {
      const stat = fs.statSync(MM_LOG);
      if (stat.size > MM_LOG_MAX_BYTES) {
        const rotated = MM_LOG + '.1';
        try { fs.unlinkSync(rotated); } catch {}
        fs.renameSync(MM_LOG, rotated);
      }
    } catch {} // file doesn't exist yet
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      message,
      ...(details ? { details } : {}),
    }) + '\n';
    fs.appendFileSync(MM_LOG, entry, 'utf8');
  } catch (e) {
    console.error('[mmLog] failed to write:', e.message);
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Connection Manager ───────────────────────────────────────────────────────

function loadConnections() {
  try {
    if (fs.existsSync(CONNECTIONS_FILE)) return JSON.parse(fs.readFileSync(CONNECTIONS_FILE, 'utf8'));
  } catch {}
  return {
    connections: [{
      id: 'local',
      name: 'Local Gateway',
      type: 'local',
      host: '127.0.0.1',
      port: 18789,
      token: null,
      default: true,
    }],
  };
}

function saveConnections(data) {
  fs.writeFileSync(CONNECTIONS_FILE, JSON.stringify(data, null, 2));
}

function getConnection(id) {
  const data = loadConnections();
  return data.connections.find(c => c.id === id);
}

// ── Error Handling Helpers ────────────────────────────────────────────────────

function apiError(res, status, code, message, details) {
  res.status(status).json({ ok: false, error: message, code, ...(details ? { details } : {}) });
}

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs, shell: 'powershell.exe' }, (err, stdout, stderr) => {
      if (stderr) console.error(`[run stderr] ${stderr.trim()}`);
      if (err) {
        const e = new Error(stderr?.trim() || stdout?.trim() || err.message);
        e.code = err.code;
        e.stdout = stdout;
        e.stderr = stderr;
        return reject(e);
      }
      resolve(stdout.trim());
    });
  });
}

function tryJsonParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

// ── Input Validation ─────────────────────────────────────────────────────────

const validate = {
  isNonEmptyString: s => typeof s === 'string' && s.trim().length > 0,
  isValidHostname: s => typeof s === 'string' && /^[a-zA-Z0-9]([a-zA-Z0-9\-\.]*[a-zA-Z0-9])?$/.test(s) && s.length <= 253,
  isValidPort: n => Number.isInteger(n) && n >= 1 && n <= 65535,
  isValidModelId: s => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9\-_\.:\/@]*$/.test(s) && s.length <= 256,
  isValidAlias: s => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9\-]*$/.test(s) && s.length <= 64,
  isValidApiKey: s => typeof s === 'string' && s.trim().length >= 8,
};

// Sanitize a string for safe inclusion in PowerShell shell commands.
// Rejects characters that could enable command injection via PS operators.
function sanitizeShellArg(s) {
  if (typeof s !== 'string') return '';
  // Reject strings with dangerous PowerShell metacharacters
  if (/[`$;|&<>{}()\[\]!\r\n]/.test(s)) {
    throw new Error('Input contains forbidden characters');
  }
  // Strip surrounding quotes user may have included, then wrap in single-quotes
  // (PowerShell single-quoted strings treat everything literally except '')
  return s.replace(/'/g, "''");
}

// Track consecutive RPC failures per connection
const rpcFailures = new Map();

function recordRpcFailure(connId) {
  rpcFailures.set(connId, (rpcFailures.get(connId) || 0) + 1);
}

function recordRpcSuccess(connId) {
  rpcFailures.set(connId, 0);
}

// Remote gateway RPC via WebSocket (one-shot request/response)
function gatewayRpc(conn, method, params = {}, timeoutMs) {
  const effectiveTimeout = timeoutMs || conn.timeoutMs || 15000;
  return new Promise((resolve, reject) => {
    const proto = conn.tls ? 'wss' : 'ws';
    const url = `${proto}://${conn.host}:${conn.port || 18789}`;
    const ws = new WebSocket(url, {
      headers: conn.token ? { 'Authorization': `Bearer ${conn.token}` } : {},
      handshakeTimeout: Math.min(effectiveTimeout, 30000),
    });

    let connected = false;
    const reqId = `mm-${Date.now()}`;

    const timer = setTimeout(() => {
      ws.close();
      recordRpcFailure(conn.id);
      reject(new Error(`RPC timeout (${effectiveTimeout}ms)`));
    }, effectiveTimeout);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Step 1: Handle connect.challenge → send connect request with auth
        if (msg.type === 'event' && msg.event === 'connect.challenge') {
          const connectReq = {
            type: 'req',
            id: 'mm-connect',
            method: 'connect',
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              client: { id: 'model-manager', version: '1.0.0', platform: process.platform, mode: 'operator' },
              role: 'operator',
              scopes: ['operator.read', 'operator.write'],
              caps: [],
              commands: [],
              permissions: {},
              auth: {},
              locale: 'en-US',
              userAgent: 'openclaw-model-manager/1.0.0',
            },
          };
          if (conn.token) connectReq.params.auth.token = conn.token;
          if (conn.password) connectReq.params.auth.password = conn.password;
          if (msg.payload?.nonce) {
            connectReq.params.device = { nonce: msg.payload.nonce };
          }
          ws.send(JSON.stringify(connectReq));
          return;
        }

        // Step 2: Handle connect response → send the actual RPC
        if (msg.type === 'res' && msg.id === 'mm-connect') {
          if (!msg.ok) {
            clearTimeout(timer);
            ws.close();
            recordRpcFailure(conn.id);
            reject(new Error(`Gateway auth failed: ${JSON.stringify(msg.payload || msg.error || 'unknown')}`));
            return;
          }
          connected = true;
          // Now send the actual RPC request
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params }));
          return;
        }

        // Step 3: Handle the RPC response
        if (connected && (msg.id === reqId || msg.id === 1)) {
          clearTimeout(timer);
          ws.close();
          if (msg.error) { recordRpcFailure(conn.id); reject(new Error(msg.error.message || JSON.stringify(msg.error))); }
          else { recordRpcSuccess(conn.id); resolve(msg.result); }
          return;
        }

        // Ignore other events (ticks, broadcasts, etc.)
      } catch (e) {
        clearTimeout(timer);
        ws.close();
        reject(e);
      }
    });

    ws.on('error', (e) => {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      recordRpcFailure(conn.id);
      reject(new Error(`WebSocket error: ${e.message}`));
    });

    ws.on('close', () => {
      clearTimeout(timer);
    });
  });
}

// Proxy a request through the remote Model Manager API
async function remoteMMProxy(conn, path, method = 'GET', body = null) {
  const proto = conn.tls ? 'https' : 'http';
  const mmPort = conn.mmPort || 18800;
  const timeout = conn.timeoutMs || 15000;
  const url = `${proto}://${conn.host}:${mmPort}${path}`;
  const opts = { method, signal: AbortSignal.timeout(timeout) };
  if (body) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`Remote MM returned HTTP ${r.status}`);
  return await r.json();
}

// Remote HTTP health check
async function httpHealthCheck(conn) {
  const proto = conn.tls ? 'https' : 'http';
  const url = `${proto}://${conn.host}:${conn.port}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), conn.timeoutMs || 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: conn.token ? { 'Authorization': `Bearer ${conn.token}` } : {},
    });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status, body: await res.text().catch(() => '') };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: e.message };
  }
}

// Build CLI flags for remote gateway commands
function remoteFlags(conn) {
  let flags = '';
  if (conn.type !== 'local') {
    flags += ` --url 'ws://${sanitizeShellArg(conn.host)}:${conn.port}'`;
    if (conn.token) flags += ` --token '${sanitizeShellArg(conn.token)}'`;
    if (conn.password) flags += ` --password '${sanitizeShellArg(conn.password)}'`;
  }
  return flags;
}

// ── Connection CRUD ──────────────────────────────────────────────────────────

app.get('/api/connections', asyncHandler(async (req, res) => {
  const data = loadConnections();
  // Redact tokens for display
  const safe = data.connections.map(c => ({
    ...c,
    token: c.token ? '••••' + c.token.slice(-6) : null,
    password: c.password ? '••••' : null,
  }));
  res.json({ ok: true, connections: safe });
}));

app.post('/api/connections', asyncHandler(async (req, res) => {
  const { name, host, port, token, password, tls, mmPort, ollamaPort, timeoutMs } = req.body;
  if (!validate.isNonEmptyString(name)) return apiError(res, 400, 'VALIDATION_ERROR', 'name is required and must be a non-empty string');
  if (!validate.isValidHostname(host)) return apiError(res, 400, 'VALIDATION_ERROR', 'host must be a valid hostname (alphanumeric, hyphens, dots, max 253 chars)');
  if (port !== undefined && !validate.isValidPort(port)) return apiError(res, 400, 'VALIDATION_ERROR', 'port must be an integer between 1 and 65535');

  const data = loadConnections();
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/,'');
  if (data.connections.find(c => c.id === id)) {
    return apiError(res, 409, 'CONFLICT', `Connection "${id}" already exists`);
  }

  data.connections.push({
    id,
    name,
    type: 'remote',
    host,
    port: port || 18789,
    token: token || null,
    password: password || null,
    tls: !!tls,
    mmPort: mmPort || 18800,
    ollamaPort: ollamaPort || 11434,
    timeoutMs: timeoutMs ? parseInt(timeoutMs) : 15000,
    default: false,
  });
  saveConnections(data);
  res.json({ ok: true, id });
}));

app.put('/api/connections/:id', asyncHandler(async (req, res) => {
  const data = loadConnections();
  const conn = data.connections.find(c => c.id === req.params.id);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Not found');

  const { name, host, port, token, password, tls, mmPort, ollamaPort, timeoutMs } = req.body;
  if (name !== undefined && !validate.isNonEmptyString(name)) return apiError(res, 400, 'VALIDATION_ERROR', 'name must be a non-empty string');
  if (host !== undefined && !validate.isValidHostname(host)) return apiError(res, 400, 'VALIDATION_ERROR', 'host must be a valid hostname');
  if (port !== undefined && !validate.isValidPort(port)) return apiError(res, 400, 'VALIDATION_ERROR', 'port must be an integer between 1 and 65535');
  if (name) conn.name = name;
  if (host) conn.host = host;
  if (port) conn.port = port;
  if (token !== undefined) conn.token = token || null;
  if (password !== undefined) conn.password = password || null;
  if (tls !== undefined) conn.tls = !!tls;
  if (mmPort !== undefined) conn.mmPort = mmPort || 18800;
  if (ollamaPort !== undefined) conn.ollamaPort = ollamaPort || 11434;
  if (timeoutMs !== undefined) conn.timeoutMs = timeoutMs ? parseInt(timeoutMs) : 15000;

  saveConnections(data);
  res.json({ ok: true });
}));

app.delete('/api/connections/:id', asyncHandler(async (req, res) => {
  const data = loadConnections();
  if (req.params.id === 'local') return apiError(res, 400, 'VALIDATION_ERROR', 'Cannot delete local connection');
  data.connections = data.connections.filter(c => c.id !== req.params.id);
  saveConnections(data);
  res.json({ ok: true });
}));

app.post('/api/connections/:id/default', asyncHandler(async (req, res) => {
  const data = loadConnections();
  data.connections.forEach(c => c.default = (c.id === req.params.id));
  saveConnections(data);
  res.json({ ok: true });
}));

// ── Connection Health Check ──────────────────────────────────────────────────

app.get('/api/connections/:id/health', asyncHandler(async (req, res) => {
  const conn = getConnection(req.params.id);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Connection not found');

  const consecutiveFailures = rpcFailures.get(req.params.id) || 0;

  if (conn.type === 'local') {
    // Use HTTP /health instead of shelling out to `openclaw gateway status --json`
    // to avoid WS probe spam in gateway logs
    const port = conn.port || 18789;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
      clearTimeout(timer);
      const body = await r.json().catch(() => null);
      res.json({ ok: true, status: { running: r.ok, rpc: { ok: r.ok }, port: { status: 'busy' }, gateway: { bindHost: '127.0.0.1', port }, ...(body || {}) }, rpcConsecutiveFailures: consecutiveFailures });
    } catch (e) {
      clearTimeout(timer);
      res.json({ ok: true, status: { running: false, error: e.message }, rpcConsecutiveFailures: consecutiveFailures });
    }
    return;
  }

  // Remote: try remote Model Manager first, fallback to HTTP health
  try {
    const result = await remoteMMProxy(conn, '/api/local/gateway/status');
    res.json({ ok: true, status: { running: true, proxy: true, ...(result.status || result) }, rpcConsecutiveFailures: consecutiveFailures });
  } catch (proxyErr) {
    // Fallback to HTTP health check
    const httpRes = await httpHealthCheck(conn);
    if (httpRes.ok) {
      res.json({ ok: true, status: { running: true, proxy: false, http: true }, rpcConsecutiveFailures: consecutiveFailures });
    } else {
      res.json({ ok: true, status: { running: false, proxy: false, proxyError: proxyErr.message, httpError: httpRes.error }, rpcConsecutiveFailures: consecutiveFailures });
    }
  }
}));

// ── Doctor --fix (connection-aware) ─────────────────────────────────────────

app.post('/api/:connId/doctor/fix', async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });

  if (conn.type === 'local') {
    try {
      const out = await run('openclaw doctor --fix', 120000);
      res.json({ ok: true, output: out, message: 'Doctor --fix completed. Review the output below for results.' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message, stdout: e.stdout });
    }
  } else {
    // Remote: try CLI with remote flags
    try {
      const out = await run(`openclaw doctor --fix${remoteFlags(conn)}`, 120000);
      res.json({ ok: true, output: out, message: 'Doctor --fix completed on remote host.' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message, stdout: e.stdout });
    }
  }
});

app.get('/api/:connId/doctor/run', async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });

  if (conn.type === 'local') {
    try {
      const out = await run('openclaw doctor --json', 60000);
      const parsed = tryJsonParse(out);
      res.json({ ok: true, output: parsed || out });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message, stdout: e.stdout });
    }
  } else {
    try {
      const out = await run(`openclaw doctor --json${remoteFlags(conn)}`, 60000);
      const parsed = tryJsonParse(out);
      res.json({ ok: true, output: parsed || out });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message, stdout: e.stdout });
    }
  }
});

// ── Gateway Control (connection-aware) ───────────────────────────────────────

app.get('/api/:connId/gateway/status', asyncHandler(async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Connection not found');

  if (conn.type === 'local') {
    // Use HTTP /health instead of shelling out to `openclaw gateway status --json`
    // to avoid WS probe spam in gateway logs
    const port = conn.port || 18789;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
      clearTimeout(timer);
      const body = await r.json().catch(() => null);
      res.json({ ok: true, status: { running: r.ok, rpc: { ok: r.ok }, port: { status: 'busy' }, gateway: { bindHost: '127.0.0.1', port }, ...(body || {}) } });
    } catch (e) {
      clearTimeout(timer);
      res.json({ ok: true, status: { running: false, error: e.message } });
    }
  } else {
    try {
      const result = await remoteMMProxy(conn, '/api/local/gateway/status');
      res.json({ ok: true, status: result.status || result });
    } catch (e) {
      // Fallback to HTTP health check
      try {
        const health = await httpHealthCheck(conn);
        res.json({ ok: true, status: { running: health.ok, ...health } });
      } catch (e2) {
        res.json({ ok: true, status: { running: false, error: e.message } });
      }
    }
  }
}));

app.post('/api/:connId/gateway/:action', asyncHandler(async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Connection not found');
  const action = req.params.action;

  if (!['start', 'stop', 'restart'].includes(action)) {
    return apiError(res, 400, 'VALIDATION_ERROR', 'Invalid action');
  }

  if (conn.type === 'local') {
    mmLog('info', `Gateway ${action} requested`, { connId: conn.id, type: 'local' });
    try {
      let out;
      if (action === 'restart' || action === 'stop' || action === 'start') {
        // Use Windows Task Scheduler directly — openclaw CLI has file lock issues (EPERM on models.json)
        const taskName = 'OpenClaw Gateway';

        if (action === 'restart' || action === 'stop') {
          try { await run(`cmd /c schtasks /End /TN "${taskName}"`, 10000); } catch {}
          // Poll until gateway port is actually free (process fully exited, file locks released)
          const gwPort = conn.port || 18789;
          for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
              const check = await run(`cmd /c netstat -ano | findstr ":${gwPort}.*LISTENING"`, 3000);
              if (!check || !check.trim()) break;
            } catch {
              break; // findstr returns non-zero when no match = port is free
            }
          }
          // Extra buffer for file locks to fully release
          await new Promise(r => setTimeout(r, 2000));
        }

        if (action === 'restart' || action === 'start') {
          await run(`cmd /c schtasks /Run /TN "${taskName}"`, 10000);
        }

        out = `Gateway ${action} completed via Task Scheduler`;
      } else {
        out = await run(`openclaw gateway ${action}`, 20000);
      }
      mmLog('info', `Gateway ${action} succeeded`, { output: out });
      res.json({ ok: true, message: out || `Gateway ${action} completed` });
    } catch (e) {
      mmLog('error', `Gateway ${action} failed`, { error: e.message, stdout: e.stdout });
      apiError(res, 500, 'GATEWAY_ERROR', e.message, { stdout: e.stdout });
    }
  } else {
    mmLog('info', `Gateway ${action} requested (remote)`, { connId: conn.id, host: conn.host });
    // Remote: for restart, try RPC signal; start/stop need SSH or remote agent
    if (action === 'restart') {
      try {
        const result = await remoteMMProxy(conn, '/api/local/gateway/restart', 'POST');
        mmLog('info', `Remote gateway restart succeeded`, { connId: conn.id });
        res.json({ ok: true, message: 'Restart signal sent', result });
      } catch (e) {
        // Try via CLI with remote flags
        try {
          const out = await run(`openclaw gateway call restart${remoteFlags(conn)}`, 15000);
          mmLog('info', `Remote gateway restart via CLI succeeded`, { connId: conn.id });
          res.json({ ok: true, message: out || 'Restart requested via CLI' });
        } catch (e2) {
          mmLog('error', `Remote gateway restart failed`, { connId: conn.id, rpcError: e.message, cliError: e2.message });
          apiError(res, 500, 'GATEWAY_ERROR', `RPC: ${e.message}. CLI: ${e2.message}`);
        }
      }
    } else {
      // start/stop on remote — can try CLI with --url flag or inform user
      try {
        const out = await run(`openclaw gateway ${action}${remoteFlags(conn)}`, 15000);
        mmLog('info', `Remote gateway ${action} succeeded`, { connId: conn.id });
        res.json({ ok: true, message: out || `Gateway ${action} requested` });
      } catch (e) {
        mmLog('error', `Remote gateway ${action} failed`, { connId: conn.id, error: e.message });
        apiError(res, 500, 'GATEWAY_ERROR', e.message, { hint: `Remote ${action} may require SSH access or a remote agent. Configure SSH tunnel or run openclaw on the remote host.` });
      }
    }
  }
}));

// ── Doctor (fix) ─────────────────────────────────────────────────────────────

app.post('/api/:connId/gateway/doctor', asyncHandler(async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Connection not found');

  if (conn.type === 'local') {
    mmLog('info', 'Doctor --fix requested', { connId: conn.id });
    try {
      const out = await run('openclaw doctor --fix --non-interactive', 60000);
      mmLog('info', 'Doctor --fix completed', { output: out });
      res.json({ ok: true, message: 'Doctor completed', output: out });
    } catch (e) {
      mmLog('error', 'Doctor --fix failed', { error: e.message, stdout: e.stdout, stderr: e.stderr });
      // Doctor may exit non-zero but still produce useful output
      res.json({ ok: false, error: e.message, output: e.stdout || e.stderr || '' });
    }
  } else {
    // Remote: proxy to remote Model Manager
    try {
      const result = await remoteMMProxy(conn, '/api/local/gateway/doctor', 'POST');
      mmLog('info', 'Remote doctor --fix succeeded', { connId: conn.id });
      res.json({ ok: true, message: 'Doctor completed (remote)', result });
    } catch (e) {
      mmLog('error', 'Remote doctor --fix failed', { connId: conn.id, error: e.message });
      apiError(res, 500, 'DOCTOR_ERROR', e.message);
    }
  }
}));

// ── Models (connection-aware) ────────────────────────────────────────────────

app.get('/api/:connId/models/status', asyncHandler(async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Connection not found');

  if (conn.type === 'local') {
    try {
      // Read config directly instead of CLI (avoids EPERM on models.json)
      const config = readJsonFile(OPENCLAW_CONFIG);
      if (!config) return apiError(res, 500, 'CONFIG_ERROR', 'Could not read OpenClaw config');
      const agentDir = path.join(process.env.USERPROFILE || '', '.openclaw', 'agents', 'main', 'agent');
      const modelsJson = readJsonFile(path.join(agentDir, 'models.json'));
      const authProfiles = readJsonFile(AUTH_PROFILES);

      const defaults = config?.agents?.defaults || {};
      const modelConfig = defaults?.model || {};
      const aliases = {};
      // Build aliases from config
      if (config?.agents?.defaults?.models) {
        for (const [key, val] of Object.entries(config.agents.defaults.models)) {
          if (val?.alias) aliases[val.alias] = key;
        }
      }
      // Also check model.aliases in config
      if (modelConfig.aliases) {
        for (const [alias, model] of Object.entries(modelConfig.aliases)) {
          aliases[alias] = model;
        }
      }

      const data = {
        configPath: OPENCLAW_CONFIG,
        agentDir,
        defaultModel: modelConfig.primary || 'unknown',
        resolvedDefault: modelConfig.primary || 'unknown',
        fallbacks: modelConfig.fallbacks || [],
        imageModel: modelConfig.image || null,
        imageFallbacks: [],
        aliases,
        allowed: modelsJson?.models?.map(m => m.key || m) || [],
        auth: authProfiles ? { storePath: AUTH_PROFILES, providers: authProfiles.profiles ? Object.keys(authProfiles.profiles).map(k => ({ provider: k.split(':')[0], profileId: k })) : [] } : null
      };
      res.json({ ok: true, data });
    } catch (e) {
      apiError(res, 500, 'INTERNAL_ERROR', e.message);
    }
  } else {
    try {
      const result = await remoteMMProxy(conn, '/api/local/models/status');
      res.json({ ok: true, data: result.data || result });
    } catch (e) {
      apiError(res, 500, 'INTERNAL_ERROR', e.message);
    }
  }
}));

app.get('/api/:connId/models/list', asyncHandler(async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Connection not found');

  if (conn.type === 'local') {
    try {
      // Get local Ollama models directly from Ollama API (fast, no CLI needed)
      let localModels = [];
      try {
        const ollamaRes = await fetch('http://127.0.0.1:11434/api/tags');
        if (ollamaRes.ok) {
          const ollamaData = await ollamaRes.json();
          localModels = (ollamaData.models || []).map(m => ({
            key: `ollama/${m.name}`,
            name: m.name,
            local: true,
            tags: [],
            parameterSize: m.details?.parameter_size || '',
            quantization: m.details?.quantization_level || '',
            sizeHuman: m.size >= 1024 * 1024 * 1024
              ? `${(m.size / 1024 ** 3).toFixed(1)} GB`
              : `${Math.round(m.size / 1024 / 1024)} MB`,
          }));
        }
      } catch {}

      // Get API/external models from models.json (has providers structure)
      const agentDir = path.join(process.env.USERPROFILE || '', '.openclaw', 'agents', 'main', 'agent');
      const modelsJson = readJsonFile(path.join(agentDir, 'models.json')) || {};
      const apiModels = [];
      for (const [provider, provData] of Object.entries(modelsJson.providers || {})) {
        if (provider === 'ollama') continue; // already covered by Ollama API
        for (const m of (provData.models || [])) {
          apiModels.push({
            key: `${provider}/${m.id}`,
            name: m.name || m.id,
            local: false,
            tags: [],
            parameterSize: '',
            quantization: '',
            sizeHuman: '',
          });
        }
      }

      const allModels = [...localModels, ...apiModels];
      res.json({ ok: true, data: { count: allModels.length, models: allModels } });
    } catch (e) {
      apiError(res, 500, 'INTERNAL_ERROR', e.message);
    }
  } else {
    try {
      const allFlag = req.query.all === 'true' ? '?all=true' : '';
      const result = await remoteMMProxy(conn, `/api/local/models/list${allFlag}`);
      res.json({ ok: true, data: result.data || result });
    } catch (e) {
      apiError(res, 500, 'INTERNAL_ERROR', e.message);
    }
  }
}));

app.post('/api/:connId/models/set', asyncHandler(async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Connection not found');
  const { model } = req.body;
  if (!validate.isValidModelId(model)) return apiError(res, 400, 'VALIDATION_ERROR', 'model must be a valid model ID');

  if (conn.type === 'local') {
    try {
      const config = readJsonFile(OPENCLAW_CONFIG);
      if (!config) return apiError(res, 500, 'CONFIG_ERROR', 'Could not read OpenClaw config');

      // Ensure path exists
      if (!config.agents) config.agents = {};
      if (!config.agents.defaults) config.agents.defaults = {};
      if (!config.agents.defaults.model || typeof config.agents.defaults.model === 'string') {
        config.agents.defaults.model = {};
      }

      config.agents.defaults.model.primary = model;
      writeJsonFile(OPENCLAW_CONFIG, config);

      res.json({
        ok: true,
        message: `Primary model switched to ${model}`,
        note: 'Change is immediate — no gateway restart needed.',
      });
    } catch (e) {
      apiError(res, 500, 'INTERNAL_ERROR', e.message);
    }
  } else {
    try {
      const result = await remoteMMProxy(conn, '/api/local/models/set', 'POST', { model });
      res.json({ ok: true, message: result.message || `Model set to ${model}`, result });
    } catch (e) {
      apiError(res, 500, 'INTERNAL_ERROR', e.message);
    }
  }
}));

// ── Aliases (connection-aware, local only for now) ───────────────────────────

app.get('/api/:connId/models/aliases', asyncHandler(async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Connection not found');

  try {
    if (conn.type === 'local') {
      const config = readJsonFile(OPENCLAW_CONFIG);
      if (!config) return apiError(res, 500, 'CONFIG_ERROR', 'Could not read OpenClaw config');
      const models = config?.agents?.defaults?.models || {};
      const aliases = {};
      for (const [key, val] of Object.entries(models)) {
        if (val?.alias) aliases[val.alias] = key;
      }
      res.json({ ok: true, data: { aliases } });
    } else {
      const result = await remoteMMProxy(conn, '/api/local/models/aliases');
      res.json({ ok: true, data: result.data || result });
    }
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
}));

app.post('/api/:connId/models/aliases', asyncHandler(async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Connection not found');
  const { alias, model } = req.body;
  if (!validate.isValidAlias(alias)) return apiError(res, 400, 'VALIDATION_ERROR', 'alias must be alphanumeric with hyphens (max 64 chars)');
  if (!validate.isValidModelId(model)) return apiError(res, 400, 'VALIDATION_ERROR', 'model must be a valid model ID');

  if (conn.type === 'local') {
    try {
      const out = await run(`openclaw models aliases add '${sanitizeShellArg(alias)}' '${sanitizeShellArg(model)}'`);
      res.json({ ok: true, message: out || `Alias ${alias} → ${model}` });
    } catch (e) { apiError(res, 500, 'INTERNAL_ERROR', e.message); }
  } else {
    try {
      const result = await remoteMMProxy(conn, '/api/local/models/aliases', 'POST', { alias, model });
      res.json(result);
    } catch (e) { apiError(res, 500, 'INTERNAL_ERROR', e.message); }
  }
}));

app.delete('/api/:connId/models/aliases/:alias', asyncHandler(async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Connection not found');

  if (conn.type === 'local') {
    try {
      const out = await run(`openclaw models aliases remove '${sanitizeShellArg(req.params.alias)}'`);
      res.json({ ok: true, message: out || 'Alias removed' });
    } catch (e) { apiError(res, 500, 'INTERNAL_ERROR', e.message); }
  } else {
    try {
      const result = await remoteMMProxy(conn, `/api/local/models/aliases/${encodeURIComponent(req.params.alias)}`, 'DELETE');
      res.json(result);
    } catch (e) { apiError(res, 500, 'INTERNAL_ERROR', e.message); }
  }
}));

// ── Fallbacks (connection-aware, local only for now) ─────────────────────────

app.get('/api/:connId/models/fallbacks', asyncHandler(async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Connection not found');

  try {
    if (conn.type === 'local') {
      const config = readJsonFile(OPENCLAW_CONFIG);
      if (!config) return apiError(res, 500, 'CONFIG_ERROR', 'Could not read OpenClaw config');
      const fallbacks = config?.agents?.defaults?.model?.fallbacks || [];
      res.json({ ok: true, data: { fallbacks } });
    } else {
      const result = await remoteMMProxy(conn, '/api/local/models/fallbacks');
      res.json({ ok: true, data: result.data || result });
    }
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
}));

app.post('/api/:connId/models/fallbacks', asyncHandler(async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Connection not found');
  const { model } = req.body;
  if (!validate.isValidModelId(model)) return apiError(res, 400, 'VALIDATION_ERROR', 'model must be a valid model ID');

  if (conn.type === 'local') {
    try {
      const out = await run(`openclaw models fallbacks add '${sanitizeShellArg(model)}'`);
      res.json({ ok: true, message: out || `Fallback added: ${model}` });
    } catch (e) { apiError(res, 500, 'INTERNAL_ERROR', e.message); }
  } else {
    try {
      const result = await remoteMMProxy(conn, '/api/local/models/fallbacks', 'POST', { model });
      res.json(result);
    } catch (e) { apiError(res, 500, 'INTERNAL_ERROR', e.message); }
  }
}));

app.delete('/api/:connId/models/fallbacks/:model', asyncHandler(async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Connection not found');

  if (conn.type === 'local') {
    try {
      const out = await run(`openclaw models fallbacks remove '${sanitizeShellArg(req.params.model)}'`);
      res.json({ ok: true, message: out || 'Fallback removed' });
    } catch (e) { apiError(res, 500, 'INTERNAL_ERROR', e.message); }
  } else {
    try {
      const result = await remoteMMProxy(conn, `/api/local/models/fallbacks/${encodeURIComponent(req.params.model)}`, 'DELETE');
      res.json(result);
    } catch (e) { apiError(res, 500, 'INTERNAL_ERROR', e.message); }
  }
}));

app.delete('/api/:connId/models/fallbacks', asyncHandler(async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Connection not found');

  if (conn.type === 'local') {
    try {
      const out = await run('openclaw models fallbacks clear');
      res.json({ ok: true, message: out || 'Fallbacks cleared' });
    } catch (e) { apiError(res, 500, 'INTERNAL_ERROR', e.message); }
  } else {
    try {
      const result = await remoteMMProxy(conn, '/api/local/models/fallbacks', 'DELETE');
      res.json(result);
    } catch (e) { apiError(res, 500, 'INTERNAL_ERROR', e.message); }
  }
}));

// Save entire fallback list (reorder/bulk edit)
app.put('/api/:connId/models/fallbacks', asyncHandler(async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Connection not found');
  if (conn.type !== 'local') return apiError(res, 501, 'NOT_IMPLEMENTED', 'Not supported remotely');

  const { fallbacks } = req.body;
  if (!Array.isArray(fallbacks)) return apiError(res, 400, 'VALIDATION_ERROR', 'fallbacks must be an array');
  if (fallbacks.some(f => !validate.isValidModelId(f))) return apiError(res, 400, 'VALIDATION_ERROR', 'each fallback must be a valid model ID');

  try {
    const config = readJsonFile(OPENCLAW_CONFIG);
    if (!config) return apiError(res, 500, 'CONFIG_ERROR', 'Could not read config');

    if (!config.agents?.defaults?.model) {
      config.agents = config.agents || {};
      config.agents.defaults = config.agents.defaults || {};
      config.agents.defaults.model = config.agents.defaults.model || {};
    }
    config.agents.defaults.model.fallbacks = fallbacks;
    writeJsonFile(OPENCLAW_CONFIG, config);

    res.json({
      ok: true,
      message: `Fallback chain updated (${fallbacks.length} models)`,
      warning: 'The gateway needs to be restarted for changes to take effect. If a conversation is active, wait until it finishes.',
    });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
}));

// Get all available models (for fallback dropdown)
app.get('/api/:connId/models/available', asyncHandler(async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Connection not found');

  try {
    if (conn.type === 'local') {
      const agentDir = path.join(process.env.USERPROFILE || '', '.openclaw', 'agents', 'main', 'agent');
      const modelsJson = readJsonFile(path.join(agentDir, 'models.json'));

      let models = [];

      // New format: { providers: { providerName: { models: [...] } } }
      if (modelsJson?.providers) {
        for (const [providerName, providerData] of Object.entries(modelsJson.providers)) {
          const provModels = providerData.models || [];
          for (const m of provModels) {
            const modelId = m.id || m.key || '';
            if (!modelId) continue;
            const key = modelId.includes('/') ? modelId : `${providerName}/${modelId}`;
            const isLocal = providerName === 'ollama' || providerData.api === 'ollama';
            models.push({
              key,
              name: m.name || modelId,
              local: isLocal,
              tags: m.tags || [],
              provider: providerName,
            });
          }
        }
      } else {
        // Legacy flat array format: { models: [...] }
        models = (modelsJson?.models || []).map(m => ({
          key: typeof m === 'string' ? m : (m.key || m.id || ''),
          name: m.name || m.key || '',
          local: m.local || false,
          tags: m.tags || [],
        }));
      }

      res.json({ ok: true, models });
    } else {
      const result = await remoteMMProxy(conn, '/api/local/models/available');
      res.json({ ok: true, models: result.models || [] });
    }
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
}));

// ── Auth Profiles ────────────────────────────────────────────────────────────

app.get('/api/:connId/auth/profiles', asyncHandler(async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Connection not found');

  if (conn.type === 'local') {
    try {
      const agentDir = path.join(process.env.USERPROFILE || '', '.openclaw', 'agents');
      const dirs = fs.existsSync(agentDir) ? fs.readdirSync(agentDir) : [];
      let profiles = {};
      for (const d of dirs) {
        const fp = path.join(agentDir, d, 'agent', 'auth-profiles.json');
        if (fs.existsSync(fp)) {
          try {
            const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
            profiles[d] = {
              profiles: Object.keys(data.profiles || {}).map(k => {
                const p = data.profiles[k];
                return {
                  id: k, provider: p.provider, type: p.type,
                  email: p.email || null,
                  hasKey: p.type === 'api_key' ? !!p.key : undefined,
                  hasToken: p.type === 'oauth' ? !!p.access : undefined,
                  expires: p.expires || null,
                };
              }),
              usageStats: data.usageStats || {},
            };
          } catch {}
        }
      }
      res.json({ ok: true, data: profiles });
    } catch (e) {
      apiError(res, 500, 'INTERNAL_ERROR', e.message);
    }
  } else {
    // Remote: proxy through remote Model Manager
    try {
      const result = await remoteMMProxy(conn, '/api/local/auth/profiles');
      res.json({ ok: true, data: result.data || result });
    } catch (e) {
      apiError(res, 500, 'INTERNAL_ERROR', e.message);
    }
  }
}));

// ── Probe ────────────────────────────────────────────────────────────────────

app.post('/api/:connId/models/probe', asyncHandler(async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Connection not found');

  if (conn.type === 'local') {
    try {
      const raw = await run('openclaw models status --probe --json', 60000);
      res.json({ ok: true, data: tryJsonParse(raw) || raw });
    } catch (e) {
      apiError(res, 500, 'INTERNAL_ERROR', e.message);
    }
  } else {
    apiError(res, 501, 'NOT_IMPLEMENTED', 'Probe not yet supported remotely');
  }
}));

// ── Live System Stats (fast, for polling) ────────────────────────────────────

// Use cmd.exe for fast stats — PowerShell startup adds ~3-5s per call
function runCmd(cmd, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs, shell: true }, (err, stdout, stderr) => {
      if (err) return reject({ code: err.code, message: stderr || err.message, stdout });
      resolve(stdout.trim());
    });
  });
}

// Cache RAM total (doesn't change between reboots)
let cachedRamTotalMB = null;

app.get('/api/system/stats', asyncHandler(async (req, res) => {
  try {
    // Run GPU + RAM queries in parallel for speed
    const [gpuResult, ramFreeResult, ramTotalResult, ollamaPs] = await Promise.allSettled([
      runCmd('nvidia-smi --query-gpu=name,memory.total,memory.free,memory.used,utilization.gpu,temperature.gpu --format=csv,noheader,nounits', 3000),
      runCmd('wmic OS get FreePhysicalMemory /value', 3000),
      cachedRamTotalMB ? Promise.resolve(null) : runCmd('wmic ComputerSystem get TotalPhysicalMemory /value', 3000),
      fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(2000) }).then(r => r.json()).catch(() => null),
    ]);

    const results = { gpus: [], ram: null, runningModels: [] };

    // Parse GPU
    if (gpuResult.status === 'fulfilled' && gpuResult.value) {
      results.gpus = gpuResult.value.split('\n').filter(Boolean).map(line => {
        const p = line.split(',').map(s => s.trim());
        return {
          name: p[0],
          totalMiB: parseInt(p[1]),
          freeMiB: parseInt(p[2]),
          usedMiB: parseInt(p[3]),
          utilPct: parseInt(p[4]),
          tempC: parseInt(p[5]),
        };
      });
    }

    // Parse RAM (wmic is much faster than PowerShell CIM)
    if (ramTotalResult.status === 'fulfilled' && ramTotalResult.value) {
      const match = ramTotalResult.value.match(/TotalPhysicalMemory=(\d+)/);
      if (match) cachedRamTotalMB = Math.round(parseInt(match[1]) / (1024 * 1024));
    }
    if (ramFreeResult.status === 'fulfilled') {
      const match = ramFreeResult.value.match(/FreePhysicalMemory=(\d+)/);
      const freeMB = match ? Math.round(parseInt(match[1]) / 1024) : 0;
      if (cachedRamTotalMB) {
        results.ram = { totalMB: cachedRamTotalMB, freeMB };
      }
    }

    // Parse running models for offload detection
    if (ollamaPs.status === 'fulfilled' && ollamaPs.value?.models) {
      results.runningModels = ollamaPs.value.models.map(rm => {
        const total = rm.size || 0;
        const vram = rm.size_vram != null ? rm.size_vram : total;
        const gpuPct = total > 0 ? Math.round((vram / total) * 100) : 0;
        return {
          name: rm.name,
          size: total,
          sizeVram: vram,
          sizeCpu: total - vram,
          gpuPct,
          cpuPct: 100 - gpuPct,
          contextLength: rm.context_length || null,
          expiresAt: rm.expires_at || null,
        };
      });
    }

    res.json({ ok: true, data: results });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
}));

// Connection-scoped stats
app.get('/api/:connId/system/stats', asyncHandler(async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Connection not found');

  if (conn.type === 'local') {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/system/stats`);
      return res.json(await r.json());
    } catch (e) {
      return apiError(res, 500, 'INTERNAL_ERROR', e.message);
    }
  }

  // Remote: try Model Manager
  const mmPort = conn.mmPort || 18800;
  const proto = conn.tls ? 'https' : 'http';
  const timeout = conn.timeoutMs || 15000;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const r = await fetch(`${proto}://${conn.host}:${mmPort}/api/system/stats`, { signal: controller.signal });
    clearTimeout(timer);
    if (r.ok) return res.json(await r.json());
  } catch {}

  res.json({ ok: true, data: { gpus: [], ram: null }, source: 'unavailable' });
}));

// ── System Info & Local Models ────────────────────────────────────────────────

app.get('/api/system/info', asyncHandler(async (req, res) => {
  try {
    const results = {};

    // CPU
    try {
      const cpu = await run('Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors | ConvertTo-Json', 10000);
      results.cpu = tryJsonParse(cpu);
    } catch {}

    // RAM — use separate calls because PowerShell variable chaining is unreliable via Node exec
    try {
      const totalStr = await run('(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory', 10000);
      const freeStr = await run('(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory', 10000);
      results.ram = {
        totalBytes: parseInt(totalStr.trim()),
        freeBytes: parseInt(freeStr.trim()) * 1024,  // FreePhysicalMemory is in KB
      };
    } catch {}

    // GPU (nvidia-smi)
    try {
      const gpu = await run('nvidia-smi --query-gpu=name,memory.total,memory.free,memory.used,utilization.gpu --format=csv,noheader', 5000);
      results.gpus = gpu.split('\n').filter(Boolean).map(line => {
        const parts = line.split(',').map(s => s.trim());
        return {
          name: parts[0],
          totalMiB: parseInt(parts[1]),
          freeMiB: parseInt(parts[2]),
          usedMiB: parseInt(parts[3]),
          utilPct: parseInt(parts[4]),
        };
      });
    } catch {
      results.gpus = [];
    }

    res.json({ ok: true, data: results });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
}));

app.get('/api/system/local-models', asyncHandler(async (req, res) => {
  try {
    // Get Ollama models via API
    const ollamaRes = await fetch('http://127.0.0.1:11434/api/tags');
    const ollamaData = await ollamaRes.json();
    const models = ollamaData.models || [];

    // Get GPU info for compatibility assessment
    let totalVRAM = 0;
    let totalFreeVRAM = 0;
    try {
      const gpu = await run('nvidia-smi --query-gpu=memory.total,memory.free --format=csv,noheader,nounits', 5000);
      gpu.split('\n').filter(Boolean).forEach(line => {
        const [total, free] = line.split(',').map(s => parseInt(s.trim()));
        totalVRAM += total;
        totalFreeVRAM += free;
      });
    } catch {}

    // Get RAM info (separate calls — PS variable chaining breaks in Node exec)
    let totalRAM = 0;
    let freeRAM = 0;
    try {
      const totalStr = await run('(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory', 10000);
      const freeStr = await run('(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory', 10000);
      totalRAM = Math.round(parseInt(totalStr.trim()) / (1024 * 1024)); // bytes → MB
      freeRAM = Math.round(parseInt(freeStr.trim()) / 1024);  // KB → MB
    } catch {}

    // Get running models with VRAM/CPU offload info
    let runningInfo = {};  // name → { gpuPct, cpuPct, sizeVram, sizeCpu, contextLength, expiresAt }
    try {
      const psRes = await fetch('http://127.0.0.1:11434/api/ps');
      const psData = await psRes.json();
      for (const rm of (psData.models || [])) {
        const total = rm.size || 0;
        const vram = rm.size_vram != null ? rm.size_vram : total;
        const gpuPct = total > 0 ? Math.round((vram / total) * 100) : 0;
        runningInfo[rm.name] = {
          sizeVram: vram,
          sizeCpu: total - vram,
          gpuPct,
          cpuPct: 100 - gpuPct,
          contextLength: rm.context_length || null,
          expiresAt: rm.expires_at || null,
        };
      }
    } catch {}

    // Assess compatibility for each model
    const assessed = models.map(m => {
      const sizeMB = Math.round(m.size / (1024 * 1024));
      const params = m.details?.parameter_size || '';
      const paramNum = parseFloat(params); // e.g. 7.6 from "7.6B"
      const quant = m.details?.quantization_level || '';

      // Rough VRAM estimate: model size + ~20% overhead for KV cache at short context
      const estimatedVRAM = Math.round(sizeMB * 1.2);

      let canRunGPU = 'unknown';
      let canRunCPU = 'unknown';
      let recommendation = '';
      let status = 'compatible';

      if (totalVRAM > 0) {
        if (estimatedVRAM <= totalFreeVRAM) {
          canRunGPU = 'yes';
          recommendation = `Fits in GPU memory. ~${estimatedVRAM} MB needed, ${totalFreeVRAM} MB free.`;
        } else if (estimatedVRAM <= totalVRAM) {
          canRunGPU = 'partial';
          recommendation = `May fit in GPU if other models are unloaded. Needs ~${estimatedVRAM} MB, ${totalFreeVRAM} MB currently free of ${totalVRAM} MB total.`;
          status = 'warning';
        } else {
          canRunGPU = 'no';
          // Check CPU fallback
          if (sizeMB <= freeRAM) {
            recommendation = `Too large for GPU (${totalVRAM} MB). Can run on CPU using system RAM (${freeRAM} MB free) but will be much slower.`;
            status = 'warning';
          } else {
            recommendation = `Too large for both GPU (${totalVRAM} MB) and available RAM (${freeRAM} MB free). Would require offloading or a smaller quantization.`;
            status = 'incompatible';
          }
        }
      }

      if (freeRAM > 0) {
        canRunCPU = sizeMB <= freeRAM ? 'yes' : 'no';
      }

      const ri = runningInfo[m.name];
      const isRunning = !!ri;

      // If running and offloaded, override recommendation
      let offloadInfo = null;
      if (ri) {
        if (ri.gpuPct < 100 && ri.gpuPct > 0) {
          offloadInfo = {
            gpuPct: ri.gpuPct,
            cpuPct: ri.cpuPct,
            sizeVramMB: Math.round(ri.sizeVram / (1024 * 1024)),
            sizeCpuMB: Math.round(ri.sizeCpu / (1024 * 1024)),
            status: 'offloaded',
          };
          recommendation = `⚠️ PARTIALLY OFFLOADED: ${ri.gpuPct}% GPU (${Math.round(ri.sizeVram / (1024*1024))} MB) / ${ri.cpuPct}% CPU (${Math.round(ri.sizeCpu / (1024*1024))} MB). Performance will be slower than full GPU.`;
          status = 'warning';
        } else if (ri.gpuPct === 0) {
          offloadInfo = {
            gpuPct: 0,
            cpuPct: 100,
            sizeVramMB: 0,
            sizeCpuMB: Math.round(ri.sizeCpu / (1024 * 1024)),
            status: 'cpu-only',
          };
          recommendation = `🐌 RUNNING ON CPU ONLY: Entire model (${sizeMB} MB) is in system RAM. Expect significantly slower inference.`;
          status = 'warning';
        } else {
          offloadInfo = {
            gpuPct: 100,
            cpuPct: 0,
            sizeVramMB: Math.round(ri.sizeVram / (1024 * 1024)),
            sizeCpuMB: 0,
            status: 'full-gpu',
          };
        }
      }

      return {
        name: m.name,
        size: sizeMB,
        sizeHuman: sizeMB >= 1024 ? `${(sizeMB / 1024).toFixed(1)} GB` : `${sizeMB} MB`,
        parameterSize: params,
        quantization: quant,
        family: m.details?.family || '',
        format: m.details?.format || '',
        estimatedVRAM,
        canRunGPU,
        canRunCPU,
        status,
        recommendation,
        isRunning,
        offload: offloadInfo,
        contextLength: ri?.contextLength || null,
        expiresAt: ri?.expiresAt || null,
        modified: m.modified_at,
      };
    });

    res.json({
      ok: true,
      data: {
        models: assessed,
        system: {
          totalVRAM,
          freeVRAM: totalFreeVRAM,
          totalRAM,
          freeRAM,
          gpuCount: totalVRAM > 0 ? Math.max(1, Math.round(totalVRAM / 12288)) : 0,
        },
      },
    });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
}));

// ── Ollama Model Management (Pull / Delete / Copy) ────────────────────────────

// Track in-progress pull jobs (keyed by pullId)
const pullJobs = new Map();

function getOllamaBase(conn) {
  const host = conn.type === 'local' ? '127.0.0.1' : conn.host;
  const port = conn.ollamaPort || (conn.type === 'local' ? 11434 : 11434);
  return { host, port };
}

async function ollamaApi(conn, method, path, body, timeoutMs = 120000) {
  const { host, port } = getOllamaBase(conn);
  const url = `http://${host}:${port}${path}`;
  const opts = { method, signal: AbortSignal.timeout(timeoutMs) };
  if (body) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Ollama API ${r.status}: ${text || r.statusText}`);
  }
  return r;
}

// POST /api/:connId/ollama/pull — stream pull progress via SSE
app.post('/api/:connId/ollama/pull', async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });

  const { model } = req.body;
  if (!model) return res.status(400).json({ ok: false, error: 'model name is required' });

  const pullId = `pull-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Helper to send SSE event
  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Mark as started
  send('started', { pullId, model, message: `Starting pull: ${model}` });

  if (conn.type === 'local') {
    // Local: use CLI and stream stdout/stderr
    const { spawn } = require('child_process');
    const isWindows = process.platform === 'win32';
    const child = spawn(isWindows ? 'ollama' : 'ollama', ['pull', model], {
      shell: true,
      env: { ...process.env }
    });

    pullJobs.set(pullId, { connId: conn.id, model, child, done: false });
    let done = false;
    const finish = (status, message) => {
      if (done) return;
      done = true;
      pullJobs.delete(pullId);
      send('done', { pullId, model, status, message });
      res.end();
    };

    child.stdout.on('data', (data) => {
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          send('progress', { pullId, model, ...parsed });
        } catch {
          send('stdout', { pullId, model, line });
        }
      }
    });

    child.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (line) send('stderr', { pullId, model, line });
    });

    child.on('error', (e) => finish('error', `Process error: ${e.message}`));
    child.on('close', (code) => {
      finish(code === 0 ? 'complete' : 'error', code === 0 ? 'Pull complete' : `Process exited with code ${code}`);
    });

    // Keepalive + cleanup check every 30s
    const keepalive = setInterval(() => {
      if (res.writableEnded) { clearInterval(keepalive); return; }
      res.write(': keepalive\n\n');
    }, 30000);

    req.on('close', () => {
      clearInterval(keepalive);
      if (!done) {
        finish('cancelled', 'Request cancelled by client');
        child.kill();
      }
    });

  } else {
    // Remote: use Ollama API streaming endpoint
    const { host, port } = getOllamaBase(conn);
    let done = false;
    const finish = (status, message) => {
      if (done) return;
      done = true;
      pullJobs.delete(pullId);
      send('done', { pullId, model, status, message });
      res.end();
    };

    try {
      // Ollama API streaming pull
      const apiRes = await fetch(`http://${host}:${port}/api/pull`, {
        method: 'POST',
        signal: AbortSignal.timeout(300000), // 5min initial connect
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model, stream: true }),
      });

      if (!apiRes.ok) {
        const text = await apiRes.text();
        return finish('error', `Ollama API ${apiRes.status}: ${text}`);
      }

      pullJobs.set(pullId, { connId: conn.id, model, done: false });

      const reader = apiRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const readChunk = () => {
        reader.read().then(({ done: rd, value }) => {
          if (rd) {
            if (buffer) {
              try {
                const parsed = JSON.parse(buffer);
                send('progress', { pullId, model, ...parsed });
              } catch {
                send('stdout', { pullId, model, line: buffer });
              }
            }
            finish('complete', 'Pull complete');
            return;
          }
          const text = decoder.decode(value, { stream: true });
          const parts = (buffer + text).split('\n');
          buffer = parts.pop() || '';
          for (const part of parts) {
            if (!part.trim()) continue;
            try {
              const parsed = JSON.parse(part);
              send('progress', { pullId, model, ...parsed });
            } catch {
              send('stdout', { pullId, model, line: part });
            }
          }
          readChunk();
        });
      };

      readChunk();

      req.on('close', () => {
        if (!done) {
          finish('cancelled', 'Request cancelled by client');
          reader.cancel();
        }
      });

    } catch (e) {
      if (e.name === 'AbortError') {
        finish('error', 'Request timed out connecting to remote Ollama');
      } else {
        finish('error', e.message);
      }
    }

    // Keepalive
    const keepalive = setInterval(() => {
      if (res.writableEnded) { clearInterval(keepalive); return; }
      res.write(': keepalive\n\n');
    }, 30000);
    req.on('close', () => clearInterval(keepalive));
  }
});

// GET /api/:connId/ollama/pull/status — list active pull jobs
app.get('/api/:connId/ollama/pull/status', (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });

  const active = [];
  for (const [id, job] of pullJobs) {
    if (job.connId === conn.id) {
      active.push({ pullId: id, model: job.model, status: 'running' });
    }
  }
  res.json({ ok: true, activePulls: active });
});

// POST /api/:connId/ollama/pull/:pullId/cancel — cancel a running pull
app.post('/api/:connId/ollama/pull/:pullId/cancel', (req, res) => {
  const job = pullJobs.get(req.params.pullId);
  if (!job) return res.status(404).json({ ok: false, error: 'Pull job not found or already complete' });

  try { job.child?.kill(); } catch {}
  pullJobs.delete(req.params.pullId);
  res.json({ ok: true, message: `Pull ${req.params.pullId} cancelled` });
});

// DELETE /api/:connId/ollama/models/:model — delete a model
app.delete('/api/:connId/ollama/models/:model', async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });

  const modelName = decodeURIComponent(req.params.model);
  if (!modelName) return res.status(400).json({ ok: false, error: 'model name required' });

  if (conn.type === 'local') {
    const { exec } = require('child_process');
    const cmd = `ollama rm "${modelName}"`;
    return new Promise((resolve) => {
      exec(cmd, { shell: true, timeout: 30000 }, (err, stdout, stderr) => {
        if (err) {
          const errMsg = (stderr || err.message || '').toLowerCase();
          if (errMsg.includes('not found') || errMsg.includes('no such file') || errMsg.includes('failed to get file info')) {
            res.json({ ok: true, message: `Model "${modelName}" is not installed (already removed)` });
            return resolve();
          }
          res.status(500).json({ ok: false, error: stderr || err.message });
          return resolve();
        }
        res.json({ ok: true, message: `Model "${modelName}" deleted` });
        resolve();
      });
    });
  } else {
    // Remote: use Ollama API
    try {
      await ollamaApi(conn, 'DELETE', `/api/tags/${encodeURIComponent(modelName)}`);
      res.json({ ok: true, message: `Model "${modelName}" deleted` });
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('not found') || msg.includes('No such file')) {
        res.json({ ok: true, message: `Model "${modelName}" is not installed (already removed)` });
      } else {
        res.status(500).json({ ok: false, error: msg });
      }
    }
  }
});

// POST /api/:connId/ollama/copy — copy a model (duplicate with new name)
app.post('/api/:connId/ollama/copy', async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });

  const { source, target } = req.body;
  if (!source || !target) return res.status(400).json({ ok: false, error: 'source and target model names required' });

  if (conn.type === 'local') {
    const { exec } = require('child_process');
    return new Promise((resolve) => {
      exec(`ollama cp "${source}" "${target}"`, { shell: true, timeout: 30000 }, (err, stdout, stderr) => {
        if (err) {
          res.status(500).json({ ok: false, error: stderr || err.message });
          return resolve();
        }
        res.json({ ok: true, message: `Copied "${source}" → "${target}"` });
        resolve();
      });
    });
  } else {
    try {
      await ollamaApi(conn, 'POST', '/api/copy', { source, target });
      res.json({ ok: true, message: `Copied "${source}" → "${target}"` });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }
});

// ── Remote System Info & Local Models ─────────────────────────────────────────

app.get('/api/:connId/system/info', asyncHandler(async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Connection not found');

  if (conn.type === 'local') {
    // Redirect to the non-scoped endpoint
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/system/info`);
      const data = await r.json();
      return res.json(data);
    } catch (e) {
      return apiError(res, 500, 'INTERNAL_ERROR', e.message);
    }
  }

  // Remote: try Model Manager on the remote host, then fall back to basic info
  const mmPort = conn.mmPort || 18800;
  const proto = conn.tls ? 'https' : 'http';

  // Try remote Model Manager first
  const infoTimeout = conn.timeoutMs || 15000;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), infoTimeout);
    const r = await fetch(`${proto}://${conn.host}:${mmPort}/api/system/info`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (r.ok) {
      const data = await r.json();
      data.source = 'remote-model-manager';
      return res.json(data);
    }
  } catch {}

  // No remote Model Manager — return what we can
  res.json({ ok: true, data: null, source: 'unavailable',
    hint: `Could not reach Model Manager on ${conn.host}:${mmPort}. Install and run the Model Manager on the remote system for full system info.` });
}));

app.get('/api/:connId/system/local-models', asyncHandler(async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Connection not found');

  if (conn.type === 'local') {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/system/local-models`);
      const data = await r.json();
      return res.json(data);
    } catch (e) {
      return apiError(res, 500, 'INTERNAL_ERROR', e.message);
    }
  }

  // Remote: try Model Manager first (has full compatibility analysis)
  const mmPort = conn.mmPort || 18800;
  const ollamaPort = conn.ollamaPort || 11434;
  const proto = conn.tls ? 'https' : 'http';
  const connTimeout = conn.timeoutMs || 15000;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), connTimeout);
    const r = await fetch(`${proto}://${conn.host}:${mmPort}/api/system/local-models`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (r.ok) {
      const data = await r.json();
      data.source = 'remote-model-manager';
      return res.json(data);
    }
  } catch {}

  // Fallback: try Ollama API directly on the remote host
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), connTimeout);
    const r = await fetch(`http://${conn.host}:${ollamaPort}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (r.ok) {
      const ollamaData = await r.json();
      const models = (ollamaData.models || []).map(m => ({
        name: m.name,
        size: Math.round(m.size / (1024 * 1024)),
        sizeHuman: m.size >= 1024*1024*1024 ? `${(m.size / (1024**3)).toFixed(1)} GB` : `${Math.round(m.size / (1024*1024))} MB`,
        parameterSize: m.details?.parameter_size || '',
        quantization: m.details?.quantization_level || '',
        family: m.details?.family || '',
        format: m.details?.format || '',
        status: 'unknown',
        canRunGPU: 'unknown',
        canRunCPU: 'unknown',
        recommendation: 'System specs unavailable on remote host. Run the Model Manager on the remote system for full compatibility analysis.',
        estimatedVRAM: Math.round(m.size / (1024 * 1024) * 1.2),
        isRunning: false,
      }));

      // Try to get running models
      try {
        const psController = new AbortController();
        const psTimer = setTimeout(() => psController.abort(), 3000);
        const psR = await fetch(`http://${conn.host}:${ollamaPort}/api/ps`, { signal: psController.signal });
        clearTimeout(psTimer);
        if (psR.ok) {
          const psData = await psR.json();
          const running = (psData.models || []).map(m => m.name);
          models.forEach(m => { m.isRunning = running.includes(m.name); });
        }
      } catch {}

      return res.json({
        ok: true,
        source: 'remote-ollama',
        data: { models, system: { totalVRAM: 0, freeVRAM: 0, totalRAM: 0, freeRAM: 0, gpuCount: 0 } },
        hint: 'Connected directly to Ollama. Run the Model Manager on the remote system for GPU/RAM compatibility checks.',
      });
    }
  } catch {}

  res.json({
    ok: true, source: 'unavailable',
    data: { models: [], system: {} },
    hint: `Could not reach Ollama (${conn.host}:${ollamaPort}) or Model Manager (${conn.host}:${mmPort}) on the remote host.`,
  });
}));

// ── Model & Provider Management ─────────────────────────────────────────────

const OPENCLAW_CONFIG = path.join(process.env.USERPROFILE || process.env.HOME, '.openclaw', 'openclaw.json');
const AUTH_PROFILES = path.join(process.env.USERPROFILE || process.env.HOME, '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');

function readJsonFile(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// Known external providers and their auth modes
const KNOWN_PROVIDERS = {
  anthropic: { authMode: 'token', label: 'Anthropic', keyPrefix: 'sk-ant-', placeholder: 'sk-ant-...' },
  openrouter: { authMode: 'api_key', label: 'OpenRouter', keyPrefix: 'sk-or-', placeholder: 'sk-or-v1-...' },
  openai: { authMode: 'api_key', label: 'OpenAI', keyPrefix: 'sk-', placeholder: 'sk-...' },
  google: { authMode: 'api_key', label: 'Google AI', keyPrefix: 'AI', placeholder: 'AIza...' },
  mistral: { authMode: 'api_key', label: 'Mistral', keyPrefix: '', placeholder: 'API key' },
  groq: { authMode: 'api_key', label: 'Groq', keyPrefix: 'gsk_', placeholder: 'gsk_...' },
  together: { authMode: 'api_key', label: 'Together AI', keyPrefix: '', placeholder: 'API key' },
  deepseek: { authMode: 'api_key', label: 'DeepSeek', keyPrefix: 'sk-', placeholder: 'sk-...' },
  ollama: { authMode: 'none', label: 'Ollama (Local)', keyPrefix: '', placeholder: '' },
};

// GET known providers list
app.get('/api/providers', (req, res) => {
  res.json({ ok: true, providers: KNOWN_PROVIDERS });
});

// GET current auth credentials status (no secrets exposed)
app.get('/api/credentials/status', asyncHandler(async (req, res) => {
  try {
    const config = readJsonFile(OPENCLAW_CONFIG);
    const authProfiles = readJsonFile(AUTH_PROFILES);
    if (!config || !authProfiles) {
      return apiError(res, 500, 'CONFIG_ERROR', 'Could not read config files');
    }

    const providers = {};
    // From config auth.profiles
    for (const [profileId, profile] of Object.entries(config.auth?.profiles || {})) {
      providers[profile.provider] = providers[profile.provider] || { profiles: [], hasCredentials: false };
      providers[profile.provider].profiles.push({ profileId, mode: profile.mode });
    }

    // From auth-profiles.json — check if keys exist (don't expose them)
    for (const [profileId, profile] of Object.entries(authProfiles.profiles || {})) {
      const prov = profile.provider;
      providers[prov] = providers[prov] || { profiles: [], hasCredentials: false };
      const hasKey = !!(profile.token || profile.key || profile.apiKey);
      if (hasKey) providers[prov].hasCredentials = true;
      // Mask the key for display
      const existing = providers[prov].profiles.find(p => p.profileId === profileId);
      if (existing) {
        existing.hasKey = hasKey;
        existing.keyHint = hasKey ? maskKey(profile.token || profile.key || profile.apiKey || '') : null;
      } else {
        providers[prov].profiles.push({
          profileId,
          mode: profile.type || 'api_key',
          hasKey,
          keyHint: hasKey ? maskKey(profile.token || profile.key || profile.apiKey || '') : null,
        });
      }
    }

    // Check configured model providers that don't have auth
    for (const [provKey] of Object.entries(config.models?.providers || {})) {
      if (!providers[provKey]) {
        providers[provKey] = { profiles: [], hasCredentials: provKey === 'ollama' };
      }
    }

    res.json({ ok: true, providers });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
}));

function maskKey(key) {
  if (!key || key.length < 8) return '••••••••';
  return key.substring(0, 6) + '••••••' + key.substring(key.length - 4);
}

// POST add/update credentials for a provider
app.post('/api/credentials/save', asyncHandler(async (req, res) => {
  try {
    const { provider, key, profileId: customProfileId } = req.body;
    if (!validate.isNonEmptyString(provider)) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'provider is required and must be a non-empty string');
    }
    if (!validate.isValidApiKey(key)) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'API key must be a string of at least 8 characters');
    }

    const provInfo = KNOWN_PROVIDERS[provider];
    if (!provInfo) {
      return apiError(res, 400, 'VALIDATION_ERROR', `Unknown provider: ${provider}. Supported: ${Object.keys(KNOWN_PROVIDERS).join(', ')}`);
    }
    if (provInfo.authMode === 'none') {
      return apiError(res, 400, 'VALIDATION_ERROR', `${provInfo.label} does not require credentials`);
    }

    // Use CLI paste-token for safety (handles config updates properly)
    const profileArg = customProfileId ? `--profile-id '${sanitizeShellArg(customProfileId)}'` : '';
    const cmd = `echo '${sanitizeShellArg(key)}' | openclaw models auth paste-token --provider '${sanitizeShellArg(provider)}' ${profileArg}`;
    
    try {
      await run(cmd, 15000);
    } catch (cliErr) {
      // Fallback: write directly to auth-profiles.json
      const authProfiles = readJsonFile(AUTH_PROFILES) || { version: 1, profiles: {}, usageStats: {} };
      const config = readJsonFile(OPENCLAW_CONFIG) || {};
      const profileId = customProfileId || `${provider}:default`;
      const isToken = provInfo.authMode === 'token';

      authProfiles.profiles[profileId] = {
        type: provInfo.authMode,
        provider,
        ...(isToken ? { token: key } : { key }),
      };
      writeJsonFile(AUTH_PROFILES, authProfiles);

      // Ensure config has the auth profile reference
      if (!config.auth) config.auth = { profiles: {} };
      if (!config.auth.profiles) config.auth.profiles = {};
      if (!config.auth.profiles[profileId]) {
        config.auth.profiles[profileId] = { provider, mode: provInfo.authMode };
        writeJsonFile(OPENCLAW_CONFIG, config);
      }
    }

    res.json({
      ok: true,
      message: `Credentials saved for ${provInfo.label}`,
      warning: 'The gateway may need to be restarted for changes to take effect. If a conversation is active, wait until it completes before restarting.',
      profileId: customProfileId || `${provider}:default`,
    });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
}));

// POST add a new model to the configuration
app.post('/api/models/add', asyncHandler(async (req, res) => {
  try {
    const { provider, modelId, displayName, contextWindow, alias } = req.body;
    if (!validate.isNonEmptyString(provider)) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'provider is required');
    }
    if (!validate.isValidModelId(modelId)) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'modelId must be alphanumeric with hyphens, underscores, dots, colons, slashes, or @ (max 256 chars)');
    }

    const fullModelKey = `${provider}/${modelId}`;
    const config = readJsonFile(OPENCLAW_CONFIG);
    if (!config) return apiError(res, 500, 'CONFIG_ERROR', 'Could not read config');

    // Initialize paths if needed
    if (!config.agents) config.agents = { defaults: {} };
    if (!config.agents.defaults) config.agents.defaults = {};
    if (!config.agents.defaults.models) config.agents.defaults.models = {};

    // Check if model already exists
    if (config.agents.defaults.models[fullModelKey]) {
      return apiError(res, 409, 'CONFLICT', `Model ${fullModelKey} already exists in configuration`);
    }

    // Add to agents.defaults.models (the allowed models list)
    const modelEntry = {};
    if (alias) modelEntry.alias = alias;
    config.agents.defaults.models[fullModelKey] = modelEntry;

    // For Ollama local models, also add to models.providers.ollama.models
    if (provider === 'ollama') {
      if (!config.models) config.models = {};
      if (!config.models.providers) config.models.providers = {};
      if (!config.models.providers.ollama) {
        config.models.providers.ollama = {
          baseUrl: 'http://127.0.0.1:11434',
          apiKey: 'ollama-local',
          api: 'ollama',
          models: [],
        };
      }
      if (!config.models.providers.ollama.models) config.models.providers.ollama.models = [];

      // Add model definition
      config.models.providers.ollama.models.push({
        id: modelId,
        name: displayName || modelId,
        reasoning: false,
        input: 'text',
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: contextWindow || 32768,
        maxTokens: contextWindow || 32768,
      });
    }

    writeJsonFile(OPENCLAW_CONFIG, config);

    // Check if provider has credentials
    const authProfiles = readJsonFile(AUTH_PROFILES);
    const providerProfiles = Object.values(authProfiles?.profiles || {}).filter(p => p.provider === provider);
    const hasCredentials = provider === 'ollama' || providerProfiles.some(p => p.token || p.key || p.apiKey);

    const result = {
      ok: true,
      message: `Model ${fullModelKey} added to configuration`,
      modelKey: fullModelKey,
      warning: 'The gateway may need to be restarted for the new model to be available. If a conversation is active, wait until it completes before restarting.',
    };

    if (!hasCredentials && provider !== 'ollama') {
      result.credentialWarning = `⚠️ No API credentials found for ${provider}. You'll need to add an API key before this model can be used.`;
      result.needsCredentials = true;
    }

    res.json(result);
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
}));

// DELETE remove a model from configuration
app.delete('/api/models/remove', asyncHandler(async (req, res) => {
  try {
    const { modelKey } = req.body;
    if (!modelKey) return apiError(res, 400, 'VALIDATION_ERROR', 'modelKey is required');

    const config = readJsonFile(OPENCLAW_CONFIG);
    if (!config) return apiError(res, 500, 'CONFIG_ERROR', 'Could not read config');

    // Don't allow removing the primary model
    if (config.agents?.defaults?.model?.primary === modelKey) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'Cannot remove the primary model. Change the primary model first.');
    }

    // Remove from agents.defaults.models
    if (config.agents?.defaults?.models?.[modelKey]) {
      delete config.agents.defaults.models[modelKey];
    }

    // Remove from fallbacks if present
    const fallbacks = config.agents?.defaults?.model?.fallbacks || [];
    config.agents.defaults.model.fallbacks = fallbacks.filter(f => f !== modelKey);

    // For Ollama, also remove from models.providers.ollama.models
    const parts = modelKey.split('/');
    if (parts[0] === 'ollama' && config.models?.providers?.ollama?.models) {
      const ollamaId = parts.slice(1).join('/');
      config.models.providers.ollama.models = config.models.providers.ollama.models.filter(m => m.id !== ollamaId);
    }

    writeJsonFile(OPENCLAW_CONFIG, config);

    res.json({
      ok: true,
      message: `Model ${modelKey} removed from configuration`,
      warning: 'The gateway may need to be restarted for changes to take effect.',
    });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
}));

// GET gateway running sessions (to warn before restart)
app.get('/api/gateway/sessions', asyncHandler(async (req, res) => {
  try {
    const raw = await run('openclaw sessions list --json', 10000);
    const parsed = tryJsonParse(raw);
    res.json({ ok: true, data: parsed });
  } catch (e) {
    res.json({ ok: true, data: { sessions: [], error: e.message } });
  }
}));

// ── Failover & Cooldown Management ──────────────────────────────────────────

// Get provider cooldown/error status (connection-aware)
app.get('/api/:connId/providers/status', asyncHandler(async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Connection not found');

  if (conn.type !== 'local') {
    try {
      const result = await remoteMMProxy(conn, '/api/local/providers/status');
      return res.json(result);
    } catch (e) {
      return apiError(res, 500, 'INTERNAL_ERROR', e.message);
    }
  }

  // Local — fall through to original logic
  try {
    const config = readJsonFile(OPENCLAW_CONFIG);
    const authProfiles = readJsonFile(AUTH_PROFILES);

    if (!config && !authProfiles) {
      return res.json({ ok: true, primary: 'none', fallbacks: [], providers: {},
        note: 'No local OpenClaw config found. Use a remote connection to manage models.' });
    }
    if (!config) return apiError(res, 500, 'CONFIG_ERROR', 'Could not read OpenClaw config');

    const primary = config?.agents?.defaults?.model?.primary || 'unknown';
    const fallbacks = config?.agents?.defaults?.model?.fallbacks || [];

    const now = Date.now();
    const stats = authProfiles?.usageStats || {};

    const providers = {};
    for (const [profileId, s] of Object.entries(stats)) {
      const provider = profileId.split(':')[0];
      const cooldownRemaining = s.cooldownUntil ? Math.max(0, Math.ceil((s.cooldownUntil - now) / 1000)) : 0;
      const disabledRemaining = s.disabledUntil ? Math.max(0, Math.ceil((s.disabledUntil - now) / 1000)) : 0;

      providers[provider] = {
        profileId,
        errorCount: s.errorCount || 0,
        failureCounts: s.failureCounts || {},
        lastUsed: s.lastUsed || null,
        cooldownSeconds: cooldownRemaining,
        disabledSeconds: disabledRemaining,
        inCooldown: cooldownRemaining > 0,
        isDisabled: disabledRemaining > 0,
        status: disabledRemaining > 0 ? 'disabled' : cooldownRemaining > 0 ? 'cooldown' : 'ready',
      };
    }

    res.json({ ok: true, primary, fallbacks, providers });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
}));

// Legacy non-connection-aware route
app.get('/api/providers/status', (req, res) => {
  try {
    const config = readJsonFile(OPENCLAW_CONFIG);
    const authProfiles = readJsonFile(AUTH_PROFILES);

    if (!config && !authProfiles) {
      return res.json({ ok: true, primary: 'none', fallbacks: [], providers: {},
        note: 'No local OpenClaw config found.' });
    }
    if (!config) return apiError(res, 500, 'CONFIG_ERROR', 'Could not read OpenClaw config');

    const primary = config?.agents?.defaults?.model?.primary || 'unknown';
    const fallbacks = config?.agents?.defaults?.model?.fallbacks || [];

    const now = Date.now();
    const stats = authProfiles?.usageStats || {};

    const providers = {};
    for (const [profileId, s] of Object.entries(stats)) {
      const provider = profileId.split(':')[0];
      const cooldownRemaining = s.cooldownUntil ? Math.max(0, Math.ceil((s.cooldownUntil - now) / 1000)) : 0;
      const disabledRemaining = s.disabledUntil ? Math.max(0, Math.ceil((s.disabledUntil - now) / 1000)) : 0;

      providers[provider] = {
        profileId,
        errorCount: s.errorCount || 0,
        failureCounts: s.failureCounts || {},
        lastUsed: s.lastUsed || null,
        cooldownSeconds: cooldownRemaining,
        disabledSeconds: disabledRemaining,
        inCooldown: cooldownRemaining > 0,
        isDisabled: disabledRemaining > 0,
        status: disabledRemaining > 0 ? 'disabled' : cooldownRemaining > 0 ? 'cooldown' : 'ready',
      };
    }

    res.json({ ok: true, primary, fallbacks, providers });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
});

// Clear cooldown (connection-aware)
app.post('/api/:connId/providers/clear-cooldown', asyncHandler(async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Connection not found');

  if (conn.type !== 'local') {
    try {
      const result = await remoteMMProxy(conn, '/api/local/providers/clear-cooldown', 'POST', req.body);
      return res.json(result);
    } catch (e) {
      return apiError(res, 500, 'INTERNAL_ERROR', e.message);
    }
  }

  // Local — fall through
  try {
    const { provider } = req.body;
    if (!provider) return apiError(res, 400, 'VALIDATION_ERROR', 'provider is required');

    const authProfiles = readJsonFile(AUTH_PROFILES);
    if (!authProfiles) return apiError(res, 500, 'CONFIG_ERROR', 'Could not read auth profiles');

    const profileId = `${provider}:default`;
    if (authProfiles.usageStats?.[profileId]) {
      authProfiles.usageStats[profileId].cooldownUntil = 0;
      authProfiles.usageStats[profileId].disabledUntil = 0;
      authProfiles.usageStats[profileId].errorCount = 0;
      authProfiles.usageStats[profileId].failureCounts = {};
      writeJsonFile(AUTH_PROFILES, authProfiles);
    }

    res.json({ ok: true, message: `Cooldown cleared for ${provider}. The provider is ready to use again.` });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
}));

// Legacy non-connection-aware route
app.post('/api/providers/clear-cooldown', (req, res) => {
  try {
    const { provider } = req.body;
    if (!provider) return apiError(res, 400, 'VALIDATION_ERROR', 'provider is required');

    const authProfiles = readJsonFile(AUTH_PROFILES);
    if (!authProfiles) return apiError(res, 500, 'CONFIG_ERROR', 'Could not read auth profiles');

    const profileId = `${provider}:default`;
    if (authProfiles.usageStats?.[profileId]) {
      authProfiles.usageStats[profileId].cooldownUntil = 0;
      authProfiles.usageStats[profileId].disabledUntil = 0;
      authProfiles.usageStats[profileId].errorCount = 0;
      authProfiles.usageStats[profileId].failureCounts = {};
      writeJsonFile(AUTH_PROFILES, authProfiles);
    }

    res.json({ ok: true, message: `Cooldown cleared for ${provider}. The provider is ready to use again.` });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
});

// Hot-swap primary model (connection-aware)
app.post('/api/:connId/failover', asyncHandler(async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Connection not found');

  if (conn.type !== 'local') {
    try {
      const result = await remoteMMProxy(conn, '/api/local/failover', 'POST', req.body);
      return res.json(result);
    } catch (e) {
      return apiError(res, 500, 'INTERNAL_ERROR', e.message);
    }
  }

  // Local — fall through
  try {
    const { model } = req.body;
    if (!validate.isValidModelId(model)) return apiError(res, 400, 'VALIDATION_ERROR', 'model must be a valid model ID');

    const out = await run(`openclaw models set '${sanitizeShellArg(model)}'`, 10000);
    res.json({
      ok: true,
      message: `Primary model switched to ${model}`,
      note: 'Change is immediate — no gateway restart needed.',
      output: out,
    });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
}));

// Legacy non-connection-aware route
app.post('/api/failover', asyncHandler(async (req, res) => {
  try {
    const { model } = req.body;
    if (!validate.isValidModelId(model)) return apiError(res, 400, 'VALIDATION_ERROR', 'model must be a valid model ID');

    // Use CLI to hot-swap — takes effect immediately without restart
    const out = await run(`openclaw models set '${sanitizeShellArg(model)}'`, 10000);
    res.json({
      ok: true,
      message: `Primary model switched to ${model}`,
      note: 'Change is immediate — no gateway restart needed.',
      output: out,
    });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
}));

// ── Remote Connectivity Test ─────────────────────────────────────────────────

async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

app.get('/api/:connId/remote-test', asyncHandler(async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return apiError(res, 404, 'NOT_FOUND', 'Connection not found');

  if (conn.type === 'local') {
    // For local, just confirm everything is reachable locally
    const start = Date.now();
    const results = { gateway: null, mm: null, ollama: null };

    // Gateway
    try {
      const r = await fetchWithTimeout(`http://127.0.0.1:${conn.port || 18789}/health`, {}, 3000);
      results.gateway = { ok: r.ok, status: r.status, hint: r.ok ? 'Gateway is running' : 'Gateway returned non-OK status' };
    } catch (e) {
      results.gateway = { ok: false, error: e.message, hint: 'Gateway is not running or not reachable on port ' + (conn.port || 18789) };
    }

    // Model Manager (self)
    results.mm = { ok: true, hint: 'You are using the local Model Manager right now' };

    // Ollama
    try {
      const r = await fetchWithTimeout('http://127.0.0.1:11434/api/tags', {}, 3000);
      if (r.ok) {
        const data = await r.json();
        results.ollama = { ok: true, modelsCount: data.models?.length || 0, hint: `Ollama is running with ${data.models?.length || 0} models installed` };
      } else {
        results.ollama = { ok: false, status: r.status, hint: 'Ollama returned non-OK status' };
      }
    } catch (e) {
      results.ollama = { ok: false, error: e.message, hint: 'Ollama is not running on port 11434' };
    }

    return res.json({ ok: true, data: results, timeMs: Date.now() - start });
  }

  // Remote connection
  const proto = conn.tls ? 'https' : 'http';
  const headers = conn.token ? { 'Authorization': `Bearer ${conn.token}` } : {};
  const gwPort = conn.port || 18789;
  const mmPort = conn.mmPort || 18800;
  const ollamaPort = conn.ollamaPort || 11434;
  const connTimeout = conn.timeoutMs || 15000;
  const start = Date.now();

  // Run all three tests in parallel
  const [gwResult, mmResult, ollamaResult] = await Promise.allSettled([
    // Gateway health
    (async () => {
      try {
        const r = await fetchWithTimeout(`${proto}://${conn.host}:${gwPort}/health`, { headers }, connTimeout);
        let body = null;
        try { body = await r.json(); } catch { try { body = await r.text(); } catch {} }
        if (r.ok) return { ok: true, url: `${proto}://${conn.host}:${gwPort}`, status: r.status, body, hint: 'Gateway is running and responding' };
        return { ok: false, url: `${proto}://${conn.host}:${gwPort}`, status: r.status, body, hint: `Gateway returned HTTP ${r.status}. Check auth token or gateway config.` };
      } catch (e) {
        const isTimeout = e.name === 'AbortError';
        return {
          ok: false, url: `${proto}://${conn.host}:${gwPort}`,
          error: e.message,
          hint: isTimeout
            ? `Gateway at ${conn.host}:${gwPort} timed out (${connTimeout}ms). Checklist:\n• Is OpenClaw gateway running on the remote machine? (openclaw gateway status)\n• Is port ${gwPort} open in the remote firewall?\n• Try increasing the Connection Timeout in connection settings\n• For Tailscale relay connections, 30000ms+ is recommended`
            : `Cannot connect to gateway at ${conn.host}:${gwPort}. Checklist:\n• Is the host reachable? (ping ${conn.host})\n• Is OpenClaw gateway running? (openclaw gateway start)\n• Is port ${gwPort} open in the remote firewall?`
        };
      }
    })(),

    // Model Manager
    (async () => {
      try {
        const r = await fetchWithTimeout(`${proto}://${conn.host}:${mmPort}/api/system/info`, {}, connTimeout);
        if (r.ok) {
          const data = await r.json();
          return { ok: true, url: `${proto}://${conn.host}:${mmPort}`, info: data, hint: 'Remote Model Manager is running — full system stats available' };
        }
        return { ok: false, url: `${proto}://${conn.host}:${mmPort}`, status: r.status, hint: `Model Manager returned HTTP ${r.status}. It may be running but returning errors.` };
      } catch (e) {
        const isTimeout = e.name === 'AbortError';
        return {
          ok: false, url: `${proto}://${conn.host}:${mmPort}`,
          error: e.message,
          hint: isTimeout
            ? `Model Manager at ${conn.host}:${mmPort} timed out (${connTimeout}ms). Checklist:\n• Is Model Manager running on the remote machine? (node server.js)\n• Is port ${mmPort} open in the remote firewall?\n• Try increasing the Connection Timeout in connection settings\n• For Tailscale relay connections, 30000ms+ is recommended`
            : `Model Manager not reachable at ${conn.host}:${mmPort}. Setup on the remote machine:\n1. git clone https://github.com/chriskesler35/openclaw-model-manager\n2. cd openclaw-model-manager && npm install\n3. node server.js\n4. Open port ${mmPort} in the firewall`
        };
      }
    })(),

    // Ollama
    (async () => {
      try {
        const r = await fetchWithTimeout(`http://${conn.host}:${ollamaPort}/api/tags`, {}, connTimeout);
        if (r.ok) {
          const data = await r.json();
          return { ok: true, url: `http://${conn.host}:${ollamaPort}`, modelsCount: data.models?.length || 0, hint: `Ollama is running with ${data.models?.length || 0} models installed` };
        }
        return { ok: false, url: `http://${conn.host}:${ollamaPort}`, status: r.status, hint: `Ollama returned HTTP ${r.status}` };
      } catch (e) {
        const isTimeout = e.name === 'AbortError';
        return {
          ok: false, url: `http://${conn.host}:${ollamaPort}`,
          error: e.message,
          hint: isTimeout
            ? `Ollama at ${conn.host}:${ollamaPort} timed out (${connTimeout}ms). Checklist:\n• Is Ollama running on the remote machine?\n• Is Ollama bound to 0.0.0.0? (set OLLAMA_HOST=0.0.0.0 and restart Ollama)\n• Is port ${ollamaPort} open in the remote firewall?\n• Try increasing the Connection Timeout in connection settings`
            : `Ollama not reachable at ${conn.host}:${ollamaPort}. Checklist:\n• Install Ollama: https://ollama.com/download\n• Set OLLAMA_HOST=0.0.0.0 so it accepts remote connections\n• Open port ${ollamaPort} in the remote firewall\n• Restart Ollama after changes`
        };
      }
    })(),
  ]);

  const results = {
    gateway: gwResult.status === 'fulfilled' ? gwResult.value : { ok: false, error: gwResult.reason?.message, hint: 'Gateway test failed unexpectedly' },
    mm: mmResult.status === 'fulfilled' ? mmResult.value : { ok: false, error: mmResult.reason?.message, hint: 'Model Manager test failed unexpectedly' },
    ollama: ollamaResult.status === 'fulfilled' ? ollamaResult.value : { ok: false, error: ollamaResult.reason?.message, hint: 'Ollama test failed unexpectedly' },
  };

  res.json({ ok: true, data: results, timeMs: Date.now() - start });
}));

// ── Gateway Discover (Bonjour/mDNS) ─────────────────────────────────────────

app.get('/api/discover', asyncHandler(async (req, res) => {
  try {
    const raw = await run('openclaw gateway discover --json --timeout 4000', 10000);
    const parsed = tryJsonParse(raw);
    res.json({ ok: true, data: parsed || raw });
  } catch (e) {
    res.json({ ok: true, data: { beacons: [], error: e.message } });
  }
}));

// ── Log Viewer API ───────────────────────────────────────────────────────────

// Validate log filename (prevent path traversal)
function isValidLogName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9._-]+\.(log|jsonl|log\.1)$/.test(name) && !name.includes('..');
}

// Read last N lines of a file efficiently (tail)
function tailFile(filePath, lines = 50, offset = 0) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const allLines = content.split('\n').filter(l => l.trim());
    const start = Math.max(0, allLines.length - lines - offset);
    const end = allLines.length - offset;
    return {
      lines: allLines.slice(Math.max(0, start), Math.max(0, end)),
      total: allLines.length,
    };
  } catch (e) {
    return { lines: [], total: 0, error: e.message };
  }
}

app.get('/api/logs/list', asyncHandler(async (req, res) => {
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      return res.json({ ok: true, files: [] });
    }
    const files = fs.readdirSync(LOGS_DIR)
      .filter(f => /\.(log|jsonl|log\.1)$/.test(f))
      .map(name => {
        const fp = path.join(LOGS_DIR, name);
        const stat = fs.statSync(fp);
        return { name, size: stat.size, modified: stat.mtime.toISOString() };
      })
      .sort((a, b) => new Date(b.modified) - new Date(a.modified));
    res.json({ ok: true, files });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
}));

app.get('/api/logs/:name', asyncHandler(async (req, res) => {
  const name = req.params.name;
  if (!isValidLogName(name)) return apiError(res, 400, 'VALIDATION_ERROR', 'Invalid log file name');
  const filePath = path.join(LOGS_DIR, name);
  if (!fs.existsSync(filePath)) return apiError(res, 404, 'NOT_FOUND', 'Log file not found');

  const lines = parseInt(req.query.lines) || 100;
  const offset = parseInt(req.query.offset) || 0;
  const result = tailFile(filePath, lines, offset);
  res.json({ ok: true, name, ...result });
}));

app.get('/api/logs/:name/tail', asyncHandler(async (req, res) => {
  const name = req.params.name;
  if (!isValidLogName(name)) return apiError(res, 400, 'VALIDATION_ERROR', 'Invalid log file name');
  const filePath = path.join(LOGS_DIR, name);
  if (!fs.existsSync(filePath)) return apiError(res, 404, 'NOT_FOUND', 'Log file not found');

  const result = tailFile(filePath, 50);
  res.json({ ok: true, name, ...result });
}));

app.get('/api/logs/:name/download', asyncHandler(async (req, res) => {
  const name = req.params.name;
  if (!isValidLogName(name)) return apiError(res, 400, 'VALIDATION_ERROR', 'Invalid log file name');
  const filePath = path.join(LOGS_DIR, name);
  if (!fs.existsSync(filePath)) return apiError(res, 404, 'NOT_FOUND', 'Log file not found');

  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  fs.createReadStream(filePath).pipe(res);
}));

app.post('/api/logs/:name/clear', asyncHandler(async (req, res) => {
  const name = req.params.name;
  if (!isValidLogName(name)) return apiError(res, 400, 'VALIDATION_ERROR', 'Invalid log file name');
  const filePath = path.join(LOGS_DIR, name);
  if (!fs.existsSync(filePath)) return apiError(res, 404, 'NOT_FOUND', 'Log file not found');

  // Rotate instead of delete: rename to .1
  const rotated = filePath + '.1';
  try { fs.unlinkSync(rotated); } catch {}
  fs.renameSync(filePath, rotated);
  mmLog('info', `Log file rotated: ${name}`);
  res.json({ ok: true, message: `${name} rotated to ${name}.1` });
}));

// ── Routing Profiles ─────────────────────────────────────────────────────────

const ROUTING_CONFIG = path.join(__dirname, 'routing.json');
const COSTS_FILE = path.join(__dirname, 'costs.json');

const DEFAULT_PROFILES = [
  {
    id: 'cloud-first',
    name: 'Cloud First',
    description: 'Maximum capability — use the most powerful cloud model as primary',
    rules: [
      { condition: 'default', model: 'anthropic/claude-opus-4-6' },
    ],
    primary: 'anthropic/claude-opus-4-6',
    fallbacks: ['google/gemini-2.5-pro', 'anthropic/claude-sonnet-4-6', 'openrouter/auto'],
  },
  {
    id: 'local-first',
    name: 'Local First',
    description: 'Cost saving — route to local GPU models, fall back to cloud only when needed',
    rules: [
      { condition: 'cost-saving', model: 'ollama/qwen2.5-coder:32b', description: 'Route to local when possible' },
    ],
    primary: 'ollama/qwen2.5-coder:32b',
    fallbacks: ['ollama/qwen2.5-coder:14b', 'anthropic/claude-opus-4-6', 'openrouter/auto'],
  },
  {
    id: 'balanced',
    name: 'Balanced',
    description: 'Best of both worlds — mid-tier cloud primary with local fallback',
    rules: [
      { condition: 'default', model: 'anthropic/claude-sonnet-4-6' },
      { condition: 'cost-saving', model: 'ollama/qwen2.5-coder:32b', description: 'Route to local when possible' },
    ],
    primary: 'anthropic/claude-sonnet-4-6',
    fallbacks: ['ollama/qwen2.5-coder:32b', 'anthropic/claude-opus-4-6', 'openrouter/auto'],
  },
];

function loadRoutingConfig() {
  if (fs.existsSync(ROUTING_CONFIG)) {
    try { return JSON.parse(fs.readFileSync(ROUTING_CONFIG, 'utf8')); } catch {}
  }
  // Auto-create with defaults
  const data = { activeProfileId: null, profiles: DEFAULT_PROFILES };
  fs.writeFileSync(ROUTING_CONFIG, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

function saveRoutingConfig(data) {
  fs.writeFileSync(ROUTING_CONFIG, JSON.stringify(data, null, 2), 'utf8');
}

// List all profiles + active
app.get('/api/routing/profiles', asyncHandler(async (req, res) => {
  const data = loadRoutingConfig();
  res.json({ ok: true, profiles: data.profiles, activeProfileId: data.activeProfileId });
}));

// Create profile
app.post('/api/routing/profiles', asyncHandler(async (req, res) => {
  const { name, description, rules, primary, fallbacks } = req.body;
  if (!validate.isNonEmptyString(name)) return apiError(res, 400, 'VALIDATION_ERROR', 'name is required');
  if (!validate.isValidModelId(primary)) return apiError(res, 400, 'VALIDATION_ERROR', 'primary must be a valid model ID');
  if (!Array.isArray(fallbacks)) return apiError(res, 400, 'VALIDATION_ERROR', 'fallbacks must be an array');

  const data = loadRoutingConfig();
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
  if (data.profiles.find(p => p.id === id)) {
    return apiError(res, 409, 'CONFLICT', `Profile "${id}" already exists`);
  }

  data.profiles.push({ id, name, description: description || '', rules: rules || [], primary, fallbacks });
  saveRoutingConfig(data);
  mmLog('info', `Routing profile created: ${name}`, { id, primary });
  res.json({ ok: true, id });
}));

// Update profile
app.put('/api/routing/profiles/:id', asyncHandler(async (req, res) => {
  const data = loadRoutingConfig();
  const profile = data.profiles.find(p => p.id === req.params.id);
  if (!profile) return apiError(res, 404, 'NOT_FOUND', 'Profile not found');

  const { name, description, rules, primary, fallbacks } = req.body;
  if (name !== undefined) profile.name = name;
  if (description !== undefined) profile.description = description;
  if (rules !== undefined) profile.rules = rules;
  if (primary !== undefined) profile.primary = primary;
  if (fallbacks !== undefined) profile.fallbacks = fallbacks;

  saveRoutingConfig(data);
  mmLog('info', `Routing profile updated: ${profile.name}`, { id: profile.id });
  res.json({ ok: true });
}));

// Delete profile
app.delete('/api/routing/profiles/:id', asyncHandler(async (req, res) => {
  const data = loadRoutingConfig();
  const idx = data.profiles.findIndex(p => p.id === req.params.id);
  if (idx === -1) return apiError(res, 404, 'NOT_FOUND', 'Profile not found');

  const removed = data.profiles.splice(idx, 1)[0];
  if (data.activeProfileId === req.params.id) data.activeProfileId = null;
  saveRoutingConfig(data);
  mmLog('info', `Routing profile deleted: ${removed.name}`, { id: removed.id });
  res.json({ ok: true });
}));

// Activate profile — writes primary + fallbacks to openclaw.json
app.post('/api/routing/profiles/:id/activate', asyncHandler(async (req, res) => {
  const data = loadRoutingConfig();
  const profile = data.profiles.find(p => p.id === req.params.id);
  if (!profile) return apiError(res, 404, 'NOT_FOUND', 'Profile not found');

  // Write to openclaw.json
  const config = readJsonFile(OPENCLAW_CONFIG);
  if (!config) return apiError(res, 500, 'CONFIG_ERROR', 'Could not read OpenClaw config');

  config.agents = config.agents || {};
  config.agents.defaults = config.agents.defaults || {};
  config.agents.defaults.model = config.agents.defaults.model || {};
  config.agents.defaults.model.id = profile.primary;
  config.agents.defaults.model.fallbacks = profile.fallbacks;
  writeJsonFile(OPENCLAW_CONFIG, config);

  data.activeProfileId = profile.id;
  saveRoutingConfig(data);

  mmLog('info', `Routing profile activated: ${profile.name}`, { id: profile.id, primary: profile.primary, fallbacks: profile.fallbacks });
  res.json({
    ok: true,
    message: `Profile "${profile.name}" activated — primary: ${profile.primary}`,
    warning: 'Changes take effect on next session, or restart the gateway now.',
  });
}));

// ── Cost Dashboard ───────────────────────────────────────────────────────────

const MODEL_PRICING = {
  'anthropic/claude-opus-4-6': { input: 15, output: 75, cacheRead: 1.50 },
  'claude-opus-4-6': { input: 15, output: 75, cacheRead: 1.50 },
  'anthropic/claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.30 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.30 },
  'anthropic/claude-sonnet-4-5-20250929': { input: 3, output: 15, cacheRead: 0.30 },
  'google/gemini-2.5-pro': { input: 1.25, output: 10, cacheRead: 0 },
  'google/gemini-2.5-flash': { input: 0.15, output: 0.60, cacheRead: 0 },
  'openrouter/auto': { input: 2, output: 8, cacheRead: 0 },
};

function getModelPricing(modelId) {
  // Try exact match first
  if (MODEL_PRICING[modelId]) return MODEL_PRICING[modelId];
  // Try without provider prefix
  const short = modelId.includes('/') ? modelId.split('/').pop() : modelId;
  if (MODEL_PRICING[short]) return MODEL_PRICING[short];
  // Local models are free
  if (modelId.startsWith('ollama/')) return { input: 0, output: 0, cacheRead: 0 };
  // Unknown cloud model — estimate
  return { input: 3, output: 15, cacheRead: 0.30 };
}

function isLocalModel(modelId) {
  return modelId && (modelId.startsWith('ollama/') || modelId.startsWith('ollama:'));
}

function loadCosts() {
  try {
    if (fs.existsSync(COSTS_FILE)) return JSON.parse(fs.readFileSync(COSTS_FILE, 'utf8'));
  } catch {}
  return { days: {} };
}

function saveCosts(data) {
  fs.writeFileSync(COSTS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// GET /api/routing/costs — compute cost estimate from gateway status
app.get('/api/routing/costs', asyncHandler(async (req, res) => {
  try {
    // Try to get session token data from gateway
    let sessions = [];
    try {
      const raw = await run('openclaw gateway call status --json', 10000);
      const parsed = tryJsonParse(raw);
      // sessions can be an object { recent: [...], byAgent: {...} } or already an array
      if (parsed?.sessions) {
        sessions = parsed.sessions.recent
          || (Array.isArray(parsed.sessions) ? parsed.sessions : Object.values(parsed.sessions.byAgent || {}).flatMap(a => a.recent || []));
      } else if (parsed?.status?.sessions) {
        sessions = parsed.status.sessions.recent
          || (Array.isArray(parsed.status.sessions) ? parsed.status.sessions : Object.values(parsed.status.sessions.byAgent || {}).flatMap(a => a.recent || []));
      } else if (Array.isArray(parsed)) {
        sessions = parsed;
      }
    } catch {}

    // Calculate costs per model
    const modelCosts = {};
    let totalCost = 0;
    let totalLocalTokens = 0;
    let totalCloudTokens = 0;

    for (const session of sessions) {
      const model = session.model || session.modelId || 'unknown';
      const input = session.inputTokens || session.input_tokens || 0;
      const output = session.outputTokens || session.output_tokens || 0;
      const cacheRead = session.cacheRead || session.cache_read_tokens || 0;
      const pricing = getModelPricing(model);
      const cost = (input * pricing.input + output * pricing.output + cacheRead * pricing.cacheRead) / 1_000_000;

      if (!modelCosts[model]) modelCosts[model] = { input: 0, output: 0, cacheRead: 0, cost: 0, local: isLocalModel(model) };
      modelCosts[model].input += input;
      modelCosts[model].output += output;
      modelCosts[model].cacheRead += cacheRead;
      modelCosts[model].cost += cost;

      totalCost += cost;
      if (isLocalModel(model)) totalLocalTokens += input + output;
      else totalCloudTokens += input + output;
    }

    // What would it cost if all local tokens went to cloud (opus pricing)?
    const opusPricing = MODEL_PRICING['anthropic/claude-opus-4-6'];
    const savedByCost = (totalLocalTokens * ((opusPricing.input + opusPricing.output) / 2)) / 1_000_000;

    // Store daily summary
    const costs = loadCosts();
    const today = new Date().toISOString().slice(0, 10);
    costs.days[today] = { totalCost, modelCosts, totalLocalTokens, totalCloudTokens, savedByCost, updatedAt: new Date().toISOString() };
    saveCosts(costs);

    res.json({
      ok: true,
      today: {
        totalCost,
        modelCosts,
        totalLocalTokens,
        totalCloudTokens,
        savedByCost,
        localRatio: (totalLocalTokens + totalCloudTokens) > 0
          ? Math.round((totalLocalTokens / (totalLocalTokens + totalCloudTokens)) * 100)
          : 0,
      },
    });
  } catch (e) {
    apiError(res, 500, 'INTERNAL_ERROR', e.message);
  }
}));

// GET /api/routing/costs/history — daily cost history
app.get('/api/routing/costs/history', asyncHandler(async (req, res) => {
  const costs = loadCosts();
  // Return last 7 days
  const days = Object.entries(costs.days || {})
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 7)
    .reverse()
    .map(([date, data]) => ({ date, ...data }));
  res.json({ ok: true, days });
}));

// ── Semantic Cache ──────────────────────────────────────────────────────────

const CACHE_FILE = path.join(__dirname, 'prompt-cache.json');
const CACHE_CONFIG_FILE = path.join(__dirname, 'cache-config.json');
const OLLAMA_URL = 'http://127.0.0.1:11434';

let _cacheData = null; // lazy loaded

function loadCache() {
  if (_cacheData) return _cacheData;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      _cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      return _cacheData;
    }
  } catch {}
  _cacheData = { entries: [] };
  return _cacheData;
}

function saveCache(data) {
  _cacheData = data;
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function loadCacheConfig() {
  try {
    if (fs.existsSync(CACHE_CONFIG_FILE)) return JSON.parse(fs.readFileSync(CACHE_CONFIG_FILE, 'utf8'));
  } catch {}
  return { enabled: true, threshold: 0.92, maxEntries: 500 };
}

function saveCacheConfig(cfg) {
  fs.writeFileSync(CACHE_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

async function getEmbeddingModel() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) return null;
    const data = await res.json();
    const models = (data.models || []).map(m => m.name || m.model);
    // Prefer small embedding-friendly models
    const preferred = ['llama3.1:8b', 'qwen2.5-coder:7b', 'llama3.2:3b', 'llama3:8b', 'qwen2.5:7b', 'nomic-embed-text'];
    for (const p of preferred) {
      if (models.some(m => m.startsWith(p))) return p;
    }
    // Fall back to first available model
    return models[0] || null;
  } catch {
    return null;
  }
}

async function getEmbedding(text) {
  const model = await getEmbeddingModel();
  if (!model) {
    mmLog('warn', 'Cache: no Ollama model available for embeddings');
    return null;
  }
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
    });
    if (!res.ok) {
      mmLog('warn', 'Cache: Ollama embedding request failed', { status: res.status });
      return null;
    }
    const data = await res.json();
    return data.embedding || null;
  } catch (e) {
    mmLog('warn', 'Cache: Ollama offline or error', { error: e.message });
    return null;
  }
}

async function cacheLookup(prompt, threshold) {
  if (threshold == null) threshold = loadCacheConfig().threshold || 0.92;
  const embedding = await getEmbedding(prompt);
  if (!embedding) return { hit: false, similarity: 0 };

  const cache = loadCache();
  let bestMatch = null;
  let bestSim = 0;

  for (const entry of cache.entries) {
    if (!entry.embedding) continue;
    const sim = cosineSimilarity(embedding, entry.embedding);
    if (sim > bestSim) {
      bestSim = sim;
      bestMatch = entry;
    }
  }

  if (bestMatch && bestSim >= threshold) {
    return { hit: true, similarity: bestSim, entry: bestMatch, embedding };
  }
  return { hit: false, similarity: bestSim, embedding };
}

function evictLRU(cache, maxEntries) {
  if (cache.entries.length <= maxEntries) return;
  // Sort by lastHit (oldest first), then by hits (fewest first)
  cache.entries.sort((a, b) => {
    const aTime = a.lastHit || a.createdAt || '';
    const bTime = b.lastHit || b.createdAt || '';
    return aTime.localeCompare(bTime);
  });
  cache.entries = cache.entries.slice(cache.entries.length - maxEntries);
}

function promptHash(text) {
  // Simple hash for deduplication
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return hash.toString(36);
}

// GET /api/cache/stats
app.get('/api/cache/stats', asyncHandler(async (req, res) => {
  const cache = loadCache();
  const entries = cache.entries || [];
  const totalHits = entries.reduce((sum, e) => sum + (e.hits || 0), 0);
  const totalEntries = entries.length;

  // Estimate savings: tokens that were cache-hit * average cloud cost per token
  const avgCostPerToken = 15 / 1_000_000; // rough opus input pricing
  const totalCachedTokens = entries.reduce((sum, e) => sum + ((e.tokens || 0) * (e.hits || 0)), 0);
  const estimatedSavings = totalCachedTokens * avgCostPerToken;

  // Hit rate: total hits / (total hits + total entries) as a proxy
  const hitRate = totalEntries > 0 ? Math.round((totalHits / Math.max(totalHits + totalEntries, 1)) * 100) : 0;

  const topEntries = [...entries]
    .sort((a, b) => (b.hits || 0) - (a.hits || 0))
    .slice(0, 10)
    .map(e => ({
      id: e.id,
      promptPreview: e.promptPreview,
      model: e.model,
      tokens: e.tokens,
      hits: e.hits || 0,
      lastHit: e.lastHit,
      createdAt: e.createdAt,
    }));

  res.json({ ok: true, totalEntries, totalHits, hitRate, estimatedSavings, topEntries });
}));

// GET /api/cache/entries
app.get('/api/cache/entries', asyncHandler(async (req, res) => {
  const cache = loadCache();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const entries = (cache.entries || [])
    .map(e => ({
      id: e.id,
      promptHash: e.promptHash,
      promptPreview: e.promptPreview,
      model: e.model,
      tokens: e.tokens,
      hits: e.hits || 0,
      lastHit: e.lastHit,
      createdAt: e.createdAt,
      // omit embedding — too large
    }))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const total = entries.length;
  const totalPages = Math.ceil(total / limit);
  const start = (page - 1) * limit;
  const paged = entries.slice(start, start + limit);

  res.json({ ok: true, entries: paged, page, limit, total, totalPages });
}));

// DELETE /api/cache/entries/:id
app.delete('/api/cache/entries/:id', asyncHandler(async (req, res) => {
  const cache = loadCache();
  const idx = cache.entries.findIndex(e => e.id === req.params.id);
  if (idx === -1) return apiError(res, 404, 'NOT_FOUND', 'Cache entry not found');
  cache.entries.splice(idx, 1);
  saveCache(cache);
  mmLog('info', 'Cache entry deleted', { id: req.params.id });
  res.json({ ok: true });
}));

// POST /api/cache/clear
app.post('/api/cache/clear', asyncHandler(async (req, res) => {
  const cache = loadCache();
  const count = cache.entries.length;
  cache.entries = [];
  saveCache(cache);
  mmLog('info', 'Cache cleared', { entriesRemoved: count });
  res.json({ ok: true, entriesRemoved: count });
}));

// GET /api/cache/config
app.get('/api/cache/config', asyncHandler(async (req, res) => {
  res.json({ ok: true, config: loadCacheConfig() });
}));

// PUT /api/cache/config
app.put('/api/cache/config', asyncHandler(async (req, res) => {
  const current = loadCacheConfig();
  const { enabled, threshold, maxEntries } = req.body;
  if (typeof enabled === 'boolean') current.enabled = enabled;
  if (typeof threshold === 'number' && threshold >= 0.5 && threshold <= 1.0) current.threshold = threshold;
  if (typeof maxEntries === 'number' && maxEntries >= 10 && maxEntries <= 10000) current.maxEntries = maxEntries;
  saveCacheConfig(current);
  mmLog('info', 'Cache config updated', current);
  res.json({ ok: true, config: current });
}));

// POST /api/cache/test
app.post('/api/cache/test', asyncHandler(async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== 'string') return apiError(res, 400, 'BAD_REQUEST', 'prompt is required');

  const config = loadCacheConfig();
  const result = await cacheLookup(prompt, config.threshold);

  if (result.hit) {
    // Update hit counter
    result.entry.hits = (result.entry.hits || 0) + 1;
    result.entry.lastHit = new Date().toISOString();
    saveCache(loadCache());

    res.json({
      ok: true,
      hit: true,
      similarity: Math.round(result.similarity * 10000) / 10000,
      cachedResponse: result.entry.response,
      model: result.entry.model,
      promptPreview: result.entry.promptPreview,
      tokens: result.entry.tokens,
    });
  } else {
    res.json({
      ok: true,
      hit: false,
      similarity: Math.round(result.similarity * 10000) / 10000,
    });
  }
}));

// POST /api/cache/add — manually seed a prompt+response pair
app.post('/api/cache/add', asyncHandler(async (req, res) => {
  const { prompt, response, model, tokens } = req.body;
  if (!prompt || !response) return apiError(res, 400, 'BAD_REQUEST', 'prompt and response are required');

  const config = loadCacheConfig();
  const embedding = await getEmbedding(prompt);
  if (!embedding) return apiError(res, 503, 'EMBEDDING_FAILED', 'Could not generate embedding — is Ollama running?');

  const cache = loadCache();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  cache.entries.push({
    id,
    promptHash: promptHash(prompt),
    promptPreview: prompt.slice(0, 100),
    embedding,
    response,
    model: model || 'unknown',
    tokens: tokens || 0,
    createdAt: new Date().toISOString(),
    hits: 0,
    lastHit: null,
  });

  evictLRU(cache, config.maxEntries);
  saveCache(cache);
  mmLog('info', 'Cache entry added', { id, model, promptPreview: prompt.slice(0, 60) });
  res.json({ ok: true, id });
}));

// ── Logs ────────────────────────────────────────────────────────────────────

const MM_LOG_DIR = path.join(__dirname, 'logs');

app.get('/api/logs', async (req, res) => {
  const source = req.query.source || 'gateway';
  const level = req.query.level || 'all';
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);

  const logDir = source === 'model-manager'
    ? MM_LOG_DIR
    : path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'logs');

  const entries = [];

  try {
    if (!fs.existsSync(logDir)) {
      return res.json({ ok: true, entries: [], source, logDir, hint: 'Log directory does not exist yet.' });
    }

    const files = fs.readdirSync(logDir)
      .filter(f => f.endsWith('.log'))
      .sort((a, b) => b.localeCompare(a)); // newest first

    // Read from newest file(s) until we have enough entries
    for (const file of files) {
      if (entries.length >= limit) break;
      const filePath = path.join(logDir, file);
      const stat = fs.statSync(filePath);
      // Skip very large files that take too long
      if (stat.size > 5 * 1024 * 1024) {
        // Read only last 200KB
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(200 * 1024);
        const fdStat = fs.fstatSync(fd);
        const start = Math.max(0, fdStat.size - 200 * 1024);
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        const chunk = buf.toString('utf8').split('\n').filter(Boolean);
        entries.push(...chunk.slice(-limit));
      } else {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        entries.push(...lines);
      }
    }

    // Sort all entries by timestamp descending, take limit
    const parsed = entries
      .map(line => {
        try {
          return { raw: line, obj: JSON.parse(line) };
        } catch {
          return { raw: line, obj: null };
        }
      })
      .filter(e => {
        if (!e.obj) return level === 'all';
        if (level === 'error') return e.obj.level === 'error';
        if (level === 'warn') return e.obj.level === 'warn' || e.obj.level === 'error';
        if (level === 'info') return e.obj.level !== 'debug';
        return true;
      })
      .sort((a, b) => {
        const ta = a.obj?.ts || '';
        const tb = b.obj?.ts || '';
        return tb.localeCompare(ta); // newest first
      })
      .slice(0, limit);

    const hasEntries = parsed.length > 0;
    const latestLevel = parsed[0]?.obj?.level || null;

    res.json({
      ok: true,
      entries: parsed,
      source,
      logDir,
      total: parsed.length,
      hasEntries,
      latestLevel,
      level,
      limit,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, source });
  }
});

app.get('/api/logs/files', async (req, res) => {
  const source = req.query.source || 'gateway';

  const logDir = source === 'model-manager'
    ? MM_LOG_DIR
    : path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'logs');

  try {
    if (!fs.existsSync(logDir)) {
      return res.json({ ok: true, files: [], logDir });
    }

    const files = fs.readdirSync(logDir)
      .filter(f => f.endsWith('.log'))
      .sort((a, b) => b.localeCompare(a))
      .map(f => {
        const fp = path.join(logDir, f);
        const stat = fs.statSync(fp);
        return { name: f, size: stat.size, modified: stat.mtime };
      });

    res.json({ ok: true, files, logDir });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Backward-compat: old routes without connId → use default ─────────────────

function getDefaultConnId() {
  const data = loadConnections();
  const def = data.connections.find(c => c.default) || data.connections[0];
  return def?.id || 'local';
}

// Redirect old /api/gateway/* to /api/<default>/gateway/*
for (const oldPath of ['/api/gateway/status', '/api/models/status', '/api/models/list',
  '/api/models/aliases', '/api/models/fallbacks', '/api/auth/profiles']) {
  app.all(oldPath, (req, res) => {
    const newPath = oldPath.replace('/api/', `/api/${getDefaultConnId()}/`);
    res.redirect(307, `${newPath}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
  });
}

// ── Catch-all Error Middleware ────────────────────────────────────────────────

app.use((err, req, res, _next) => {
  console.error(`[unhandled] ${req.method} ${req.originalUrl}:`, err);
  mmLog('error', `Unhandled API error: ${req.method} ${req.originalUrl}`, { error: err.message, stack: err.stack?.split('\n').slice(0, 3).join(' | ') });
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    ok: false,
    error: err.message || 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
});

// ── WebSocket for live status push ───────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

let statusInterval = null;

const _remoteBroadcastInFlight = new Set();

function broadcastStatus() {
  try {
    if (wss.clients.size === 0) return;
    const data = loadConnections();

    for (const conn of data.connections) {
      if (conn.type === 'local') {
        // Use HTTP /health endpoint instead of raw WS connect/disconnect
        // (WS probe causes "closed before connect" spam in gateway logs)
        const port = conn.port || 18789;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);

        fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal })
          .then(r => {
            clearTimeout(timer);
            const payload = JSON.stringify({
              type: 'gateway-status', connId: conn.id,
              data: { running: r.ok, rpc: { ok: r.ok }, port: { status: 'busy' }, gateway: { bindHost: '0.0.0.0', port } }
            });
            for (const client of wss.clients) {
              if (client.readyState === 1) client.send(payload);
            }
          })
          .catch(() => {
            clearTimeout(timer);
            const payload = JSON.stringify({
              type: 'gateway-status', connId: conn.id,
              data: { running: false }
            });
            for (const client of wss.clients) {
              if (client.readyState === 1) client.send(payload);
            }
          });
      } else {
        // Remote: probe via remote Model Manager (gateway binds loopback, not reachable directly)
        if (_remoteBroadcastInFlight.has(conn.id)) continue; // skip if previous probe still pending
        _remoteBroadcastInFlight.add(conn.id);

        const proto = conn.tls ? 'https' : 'http';
        const mmPort = conn.mmPort || 18800;
        const timeout = conn.timeoutMs || 15000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        fetch(`${proto}://${conn.host}:${mmPort}/api/local/gateway/status`, {
          signal: controller.signal,
        })
          .then(r => {
            clearTimeout(timer);
            return r.json().then(body => {
              const status = body?.status || {};
              const payload = JSON.stringify({
                type: 'gateway-status', connId: conn.id,
                data: { running: status.running !== false && (status.rpc?.ok || status.running === true), host: conn.host, port: conn.port, ...status }
              });
              for (const client of wss.clients) {
                if (client.readyState === 1) client.send(payload);
              }
            });
          })
          .catch(() => {
            clearTimeout(timer);
            const payload = JSON.stringify({
              type: 'gateway-status', connId: conn.id,
              data: { running: false, host: conn.host, port: conn.port }
            });
            for (const client of wss.clients) {
              if (client.readyState === 1) client.send(payload);
            }
          })
          .finally(() => {
            _remoteBroadcastInFlight.delete(conn.id);
          });
      }
    }
  } catch (e) {
    // Broadcast degraded status so clients know something is wrong
    console.error('[broadcastStatus] error:', e.message);
    try {
      const payload = JSON.stringify({
        type: 'gateway-status', connId: 'local',
        data: { running: false, degraded: true, error: e.message }
      });
      for (const client of wss.clients) {
        if (client.readyState === 1) client.send(payload);
      }
    } catch {}
  }
}

wss.on('connection', (ws) => {
  broadcastStatus();
  if (!statusInterval) {
    statusInterval = setInterval(broadcastStatus, 5000);
  }
});

wss.on('close', () => {
  if (wss.clients.size === 0 && statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
  }
});

// ── Manager Health ───────────────────────────────────────────────────────────

// Build version from git at startup
let MM_VERSION = 'unknown';
try {
  const { execSync } = require('child_process');
  MM_VERSION = execSync('git log -1 --format=%h', { cwd: __dirname, timeout: 3000 }).toString().trim();
} catch {}

app.get('/api/manager/health', (req, res) => {
  res.json({ ok: true, pid: process.pid, uptime: process.uptime(), version: MM_VERSION, serverDir: __dirname });
});

// ── Self-Restart ─────────────────────────────────────────────────────────────

app.post('/api/manager/restart', (req, res) => {
  mmLog('info', 'Model Manager self-restart requested', { pid: process.pid });
  res.json({ ok: true, message: 'Model Manager is restarting…' });

  // Write a temp restart script that waits for us to exit, then starts fresh.
  // This avoids Windows spawning visible console windows and restart loops.
  const restartScript = path.join(__dirname, '_restart.bat');
  const nodeExe = process.execPath.replace(/\//g, '\\');
  const serverJs = path.join(__dirname, 'server.js').replace(/\//g, '\\');
  fs.writeFileSync(restartScript, [
    '@echo off',
    `timeout /t 2 /nobreak >nul`,
    `start "" /b "${nodeExe}" "${serverJs}"`,
    `del "%~f0"`,
  ].join('\r\n'));

  exec(`cmd /c start /min "" "${restartScript}"`, { shell: true, windowsHide: true });

  // Give the response time to flush, then exit
  setTimeout(() => {
    mmLog('info', 'Model Manager shutting down for restart');
    process.exit(0);
  }, 500);
});

// ── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ⚡ OpenClaw Model Manager running at http://localhost:${PORT}`);
  console.log(`  🌐 Also listening on 0.0.0.0:${PORT} (accessible via Tailscale/LAN)\n`);
  mmLog('info', 'Model Manager started', { port: PORT, pid: process.pid });
});
