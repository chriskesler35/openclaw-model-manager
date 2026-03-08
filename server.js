const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
const PORT = process.env.MM_PORT || 18800;
const CONNECTIONS_FILE = path.join(__dirname, 'connections.json');

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

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs, shell: 'powershell.exe' }, (err, stdout, stderr) => {
      if (err) return reject({ code: err.code, message: stderr || err.message, stdout });
      resolve(stdout.trim());
    });
  });
}

function tryJsonParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

// Remote gateway RPC via WebSocket (one-shot request/response)
function gatewayRpc(conn, method, params = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const proto = conn.tls ? 'wss' : 'ws';
    const url = `${proto}://${conn.host}:${conn.port}`;
    const ws = new WebSocket(url, {
      headers: conn.token ? { 'Authorization': `Bearer ${conn.token}` } : {},
      handshakeTimeout: 5000,
    });

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`RPC timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
    });

    ws.on('message', (data) => {
      clearTimeout(timer);
      try {
        const msg = JSON.parse(data.toString());
        ws.close();
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      } catch (e) {
        ws.close();
        reject(e);
      }
    });

    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${e.message}`));
    });
  });
}

// Remote HTTP health check
async function httpHealthCheck(conn) {
  const proto = conn.tls ? 'https' : 'http';
  const url = `${proto}://${conn.host}:${conn.port}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
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
    flags += ` --url ws://${conn.host}:${conn.port}`;
    if (conn.token) flags += ` --token "${conn.token}"`;
    if (conn.password) flags += ` --password "${conn.password}"`;
  }
  return flags;
}

// ── Connection CRUD ──────────────────────────────────────────────────────────

app.get('/api/connections', (req, res) => {
  const data = loadConnections();
  // Redact tokens for display
  const safe = data.connections.map(c => ({
    ...c,
    token: c.token ? '••••' + c.token.slice(-6) : null,
    password: c.password ? '••••' : null,
  }));
  res.json({ ok: true, connections: safe });
});

app.post('/api/connections', (req, res) => {
  const { name, host, port, token, password, tls, mmPort, ollamaPort } = req.body;
  if (!name || !host) return res.status(400).json({ ok: false, error: 'name and host required' });

  const data = loadConnections();
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/,'');
  if (data.connections.find(c => c.id === id)) {
    return res.status(409).json({ ok: false, error: `Connection "${id}" already exists` });
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
    default: false,
  });
  saveConnections(data);
  res.json({ ok: true, id });
});

app.put('/api/connections/:id', (req, res) => {
  const data = loadConnections();
  const conn = data.connections.find(c => c.id === req.params.id);
  if (!conn) return res.status(404).json({ ok: false, error: 'Not found' });

  const { name, host, port, token, password, tls, mmPort, ollamaPort } = req.body;
  if (name) conn.name = name;
  if (host) conn.host = host;
  if (port) conn.port = port;
  if (token !== undefined) conn.token = token || null;
  if (password !== undefined) conn.password = password || null;
  if (tls !== undefined) conn.tls = !!tls;
  if (mmPort !== undefined) conn.mmPort = mmPort || 18800;
  if (ollamaPort !== undefined) conn.ollamaPort = ollamaPort || 11434;

  saveConnections(data);
  res.json({ ok: true });
});

app.delete('/api/connections/:id', (req, res) => {
  const data = loadConnections();
  if (req.params.id === 'local') return res.status(400).json({ ok: false, error: 'Cannot delete local connection' });
  data.connections = data.connections.filter(c => c.id !== req.params.id);
  saveConnections(data);
  res.json({ ok: true });
});

app.post('/api/connections/:id/default', (req, res) => {
  const data = loadConnections();
  data.connections.forEach(c => c.default = (c.id === req.params.id));
  saveConnections(data);
  res.json({ ok: true });
});

// ── Connection Health Check ──────────────────────────────────────────────────

app.get('/api/connections/:id/health', async (req, res) => {
  const conn = getConnection(req.params.id);
  if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });

  if (conn.type === 'local') {
    try {
      const raw = await run('openclaw gateway status --json');
      const parsed = tryJsonParse(raw);
      res.json({ ok: true, status: parsed || raw });
    } catch (e) {
      res.json({ ok: true, status: { running: false, error: e.message, stdout: e.stdout } });
    }
    return;
  }

  // Remote: try WS RPC first, fallback to HTTP health
  try {
    const result = await gatewayRpc(conn, 'status', {}, 8000);
    res.json({ ok: true, status: { running: true, rpc: true, ...result } });
  } catch (rpcErr) {
    // Fallback to HTTP
    const httpRes = await httpHealthCheck(conn);
    if (httpRes.ok) {
      res.json({ ok: true, status: { running: true, rpc: false, http: true } });
    } else {
      res.json({ ok: true, status: { running: false, rpc: false, rpcError: rpcErr.message, httpError: httpRes.error } });
    }
  }
});

// ── Gateway Control (connection-aware) ───────────────────────────────────────

app.get('/api/:connId/gateway/status', async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });

  if (conn.type === 'local') {
    try {
      const raw = await run('openclaw gateway status --json');
      const parsed = tryJsonParse(raw);
      res.json({ ok: true, status: parsed || raw });
    } catch (e) {
      res.json({ ok: true, status: { running: false, error: e.message, stdout: e.stdout } });
    }
  } else {
    try {
      const result = await gatewayRpc(conn, 'status', {}, 8000);
      res.json({ ok: true, status: { running: true, ...result } });
    } catch (e) {
      res.json({ ok: true, status: { running: false, error: e.message } });
    }
  }
});

app.post('/api/:connId/gateway/:action', async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });
  const action = req.params.action;

  if (!['start', 'stop', 'restart'].includes(action)) {
    return res.status(400).json({ ok: false, error: 'Invalid action' });
  }

  if (conn.type === 'local') {
    try {
      const out = await run(`openclaw gateway ${action}`, 20000);
      res.json({ ok: true, message: out || `Gateway ${action} requested` });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message, stdout: e.stdout });
    }
  } else {
    // Remote: for restart, try RPC signal; start/stop need SSH or remote agent
    if (action === 'restart') {
      try {
        const result = await gatewayRpc(conn, 'restart', {}, 15000);
        res.json({ ok: true, message: 'Restart signal sent', result });
      } catch (e) {
        // Try via CLI with remote flags
        try {
          const out = await run(`openclaw gateway call restart${remoteFlags(conn)}`, 15000);
          res.json({ ok: true, message: out || 'Restart requested via CLI' });
        } catch (e2) {
          res.status(500).json({ ok: false, error: `RPC: ${e.message}. CLI: ${e2.message}` });
        }
      }
    } else {
      // start/stop on remote — can try CLI with --url flag or inform user
      try {
        const out = await run(`openclaw gateway ${action}${remoteFlags(conn)}`, 15000);
        res.json({ ok: true, message: out || `Gateway ${action} requested` });
      } catch (e) {
        res.status(500).json({
          ok: false,
          error: e.message,
          hint: `Remote ${action} may require SSH access or a remote agent. Configure SSH tunnel or run openclaw on the remote host.`,
        });
      }
    }
  }
});

// ── Models (connection-aware) ────────────────────────────────────────────────

app.get('/api/:connId/models/status', async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });

  if (conn.type === 'local') {
    try {
      const raw = await run('openclaw models status --json');
      res.json({ ok: true, data: tryJsonParse(raw) || raw });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  } else {
    try {
      const result = await gatewayRpc(conn, 'models.status', {}, 10000);
      res.json({ ok: true, data: result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }
});

app.get('/api/:connId/models/list', async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });

  if (conn.type === 'local') {
    try {
      const flag = req.query.all === 'true' ? ' --all' : '';
      const raw = await run(`openclaw models list --json${flag}`);
      res.json({ ok: true, data: tryJsonParse(raw) || raw });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  } else {
    try {
      const result = await gatewayRpc(conn, 'models.list', { all: req.query.all === 'true' }, 10000);
      res.json({ ok: true, data: result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }
});

app.post('/api/:connId/models/set', async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });
  const { model } = req.body;
  if (!model) return res.status(400).json({ ok: false, error: 'model is required' });

  if (conn.type === 'local') {
    try {
      const out = await run(`openclaw models set "${model}"`);
      res.json({ ok: true, message: out || `Model set to ${model}` });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  } else {
    try {
      const result = await gatewayRpc(conn, 'models.set', { model }, 10000);
      res.json({ ok: true, message: `Model set to ${model}`, result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }
});

// ── Aliases (connection-aware, local only for now) ───────────────────────────

app.get('/api/:connId/models/aliases', async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });

  try {
    if (conn.type === 'local') {
      const raw = await run('openclaw models aliases list --json');
      res.json({ ok: true, data: tryJsonParse(raw) || raw });
    } else {
      // Try from models.status RPC
      const result = await gatewayRpc(conn, 'models.status', {}, 10000);
      res.json({ ok: true, data: result?.aliases || {} });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/:connId/models/aliases', async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });
  const { alias, model } = req.body;
  if (!alias || !model) return res.status(400).json({ ok: false, error: 'alias and model required' });

  if (conn.type === 'local') {
    try {
      const out = await run(`openclaw models aliases add "${alias}" "${model}"`);
      res.json({ ok: true, message: out || `Alias ${alias} → ${model}` });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  } else {
    res.status(501).json({ ok: false, error: 'Alias management not yet supported remotely' });
  }
});

app.delete('/api/:connId/models/aliases/:alias', async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });

  if (conn.type === 'local') {
    try {
      const out = await run(`openclaw models aliases remove "${req.params.alias}"`);
      res.json({ ok: true, message: out || 'Alias removed' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  } else {
    res.status(501).json({ ok: false, error: 'Alias management not yet supported remotely' });
  }
});

// ── Fallbacks (connection-aware, local only for now) ─────────────────────────

app.get('/api/:connId/models/fallbacks', async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });

  try {
    if (conn.type === 'local') {
      const raw = await run('openclaw models fallbacks list --json');
      res.json({ ok: true, data: tryJsonParse(raw) || raw });
    } else {
      const result = await gatewayRpc(conn, 'models.status', {}, 10000);
      res.json({ ok: true, data: result?.fallbacks || [] });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/:connId/models/fallbacks', async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });
  const { model } = req.body;
  if (!model) return res.status(400).json({ ok: false, error: 'model is required' });

  if (conn.type === 'local') {
    try {
      const out = await run(`openclaw models fallbacks add "${model}"`);
      res.json({ ok: true, message: out || `Fallback added: ${model}` });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  } else {
    res.status(501).json({ ok: false, error: 'Fallback management not yet supported remotely' });
  }
});

app.delete('/api/:connId/models/fallbacks/:model', async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });

  if (conn.type === 'local') {
    try {
      const out = await run(`openclaw models fallbacks remove "${req.params.model}"`);
      res.json({ ok: true, message: out || 'Fallback removed' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  } else {
    res.status(501).json({ ok: false, error: 'Fallback management not yet supported remotely' });
  }
});

app.delete('/api/:connId/models/fallbacks', async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });

  if (conn.type === 'local') {
    try {
      const out = await run('openclaw models fallbacks clear');
      res.json({ ok: true, message: out || 'Fallbacks cleared' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  } else {
    res.status(501).json({ ok: false, error: 'Fallback management not yet supported remotely' });
  }
});

// ── Auth Profiles ────────────────────────────────────────────────────────────

app.get('/api/:connId/auth/profiles', async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });

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
      res.status(500).json({ ok: false, error: e.message });
    }
  } else {
    // Remote: try to get auth info from models.status
    try {
      const result = await gatewayRpc(conn, 'models.status', {}, 10000);
      res.json({ ok: true, data: { remote: { auth: result?.auth || {} } } });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }
});

// ── Probe ────────────────────────────────────────────────────────────────────

app.post('/api/:connId/models/probe', async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });

  if (conn.type === 'local') {
    try {
      const raw = await run('openclaw models status --probe --json', 60000);
      res.json({ ok: true, data: tryJsonParse(raw) || raw });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  } else {
    res.status(501).json({ ok: false, error: 'Probe not yet supported remotely' });
  }
});

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

app.get('/api/system/stats', async (req, res) => {
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
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Connection-scoped stats
app.get('/api/:connId/system/stats', async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });

  if (conn.type === 'local') {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/system/stats`);
      return res.json(await r.json());
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // Remote: try Model Manager
  const mmPort = conn.mmPort || 18800;
  const proto = conn.tls ? 'https' : 'http';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const r = await fetch(`${proto}://${conn.host}:${mmPort}/api/system/stats`, { signal: controller.signal });
    clearTimeout(timer);
    if (r.ok) return res.json(await r.json());
  } catch {}

  res.json({ ok: true, data: { gpus: [], ram: null }, source: 'unavailable' });
});

// ── System Info & Local Models ────────────────────────────────────────────────

app.get('/api/system/info', async (req, res) => {
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
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/system/local-models', async (req, res) => {
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
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Remote System Info & Local Models ─────────────────────────────────────────

app.get('/api/:connId/system/info', async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });

  if (conn.type === 'local') {
    // Redirect to the non-scoped endpoint
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/system/info`);
      const data = await r.json();
      return res.json(data);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // Remote: try Model Manager on the remote host, then fall back to basic info
  const mmPort = conn.mmPort || 18800;
  const proto = conn.tls ? 'https' : 'http';

  // Try remote Model Manager first
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
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
});

app.get('/api/:connId/system/local-models', async (req, res) => {
  const conn = getConnection(req.params.connId);
  if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });

  if (conn.type === 'local') {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/system/local-models`);
      const data = await r.json();
      return res.json(data);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // Remote: try Model Manager first (has full compatibility analysis)
  const mmPort = conn.mmPort || 18800;
  const ollamaPort = conn.ollamaPort || 11434;
  const proto = conn.tls ? 'https' : 'http';

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
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
    const timer = setTimeout(() => controller.abort(), 5000);
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
});

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
app.get('/api/credentials/status', (req, res) => {
  try {
    const config = readJsonFile(OPENCLAW_CONFIG);
    const authProfiles = readJsonFile(AUTH_PROFILES);
    if (!config || !authProfiles) {
      return res.json({ ok: false, error: 'Could not read config files' });
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
    res.status(500).json({ ok: false, error: e.message });
  }
});

function maskKey(key) {
  if (!key || key.length < 8) return '••••••••';
  return key.substring(0, 6) + '••••••' + key.substring(key.length - 4);
}

// POST add/update credentials for a provider
app.post('/api/credentials/save', async (req, res) => {
  try {
    const { provider, key, profileId: customProfileId } = req.body;
    if (!provider || !key) {
      return res.status(400).json({ ok: false, error: 'Provider and key are required' });
    }

    const provInfo = KNOWN_PROVIDERS[provider];
    if (!provInfo) {
      return res.status(400).json({ ok: false, error: `Unknown provider: ${provider}. Supported: ${Object.keys(KNOWN_PROVIDERS).join(', ')}` });
    }
    if (provInfo.authMode === 'none') {
      return res.status(400).json({ ok: false, error: `${provInfo.label} does not require credentials` });
    }

    // Use CLI paste-token for safety (handles config updates properly)
    const profileArg = customProfileId ? `--profile-id "${customProfileId}"` : '';
    const cmd = `echo "${key.replace(/"/g, '')}" | openclaw models auth paste-token --provider ${provider} ${profileArg}`;
    
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
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST add a new model to the configuration
app.post('/api/models/add', async (req, res) => {
  try {
    const { provider, modelId, displayName, contextWindow, alias } = req.body;
    if (!provider || !modelId) {
      return res.status(400).json({ ok: false, error: 'Provider and model ID are required' });
    }

    const fullModelKey = `${provider}/${modelId}`;
    const config = readJsonFile(OPENCLAW_CONFIG);
    if (!config) return res.status(500).json({ ok: false, error: 'Could not read config' });

    // Initialize paths if needed
    if (!config.agents) config.agents = { defaults: {} };
    if (!config.agents.defaults) config.agents.defaults = {};
    if (!config.agents.defaults.models) config.agents.defaults.models = {};

    // Check if model already exists
    if (config.agents.defaults.models[fullModelKey]) {
      return res.status(409).json({ ok: false, error: `Model ${fullModelKey} already exists in configuration` });
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
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE remove a model from configuration
app.delete('/api/models/remove', async (req, res) => {
  try {
    const { modelKey } = req.body;
    if (!modelKey) return res.status(400).json({ ok: false, error: 'modelKey is required' });

    const config = readJsonFile(OPENCLAW_CONFIG);
    if (!config) return res.status(500).json({ ok: false, error: 'Could not read config' });

    // Don't allow removing the primary model
    if (config.agents?.defaults?.model?.primary === modelKey) {
      return res.status(400).json({ ok: false, error: 'Cannot remove the primary model. Change the primary model first.' });
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
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET gateway running sessions (to warn before restart)
app.get('/api/gateway/sessions', async (req, res) => {
  try {
    const raw = await run('openclaw sessions list --json', 10000);
    const parsed = tryJsonParse(raw);
    res.json({ ok: true, data: parsed });
  } catch (e) {
    res.json({ ok: true, data: { sessions: [], error: e.message } });
  }
});

// ── Gateway Discover (Bonjour/mDNS) ─────────────────────────────────────────

app.get('/api/discover', async (req, res) => {
  try {
    const raw = await run('openclaw gateway discover --json --timeout 4000', 10000);
    const parsed = tryJsonParse(raw);
    res.json({ ok: true, data: parsed || raw });
  } catch (e) {
    res.json({ ok: true, data: { beacons: [], error: e.message } });
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

// ── WebSocket for live status push ───────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

let statusInterval = null;

function broadcastStatus() {
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
      // Remote: use HTTP /health to avoid WS log spam on remote gateway too
      const proto = conn.tls ? 'https' : 'http';
      const url = `${proto}://${conn.host}:${conn.port}/health`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);

      fetch(url, {
        signal: controller.signal,
        headers: conn.token ? { 'Authorization': `Bearer ${conn.token}` } : {},
      })
        .then(r => {
          clearTimeout(timer);
          const payload = JSON.stringify({
            type: 'gateway-status', connId: conn.id,
            data: { running: r.ok, host: conn.host, port: conn.port }
          });
          for (const client of wss.clients) {
            if (client.readyState === 1) client.send(payload);
          }
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
      });
    }
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

// ── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ⚡ OpenClaw Model Manager running at http://localhost:${PORT}`);
  console.log(`  🌐 Also listening on 0.0.0.0:${PORT} (accessible via Tailscale/LAN)\n`);
});
