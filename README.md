# ⚡ OpenClaw Model Manager

A standalone GUI for managing [OpenClaw](https://github.com/openclaw/openclaw) gateway instances — with live GPU monitoring, model management, credential handling, and multi-machine support.

![Node.js](https://img.shields.io/badge/Node.js-22+-green) ![Express](https://img.shields.io/badge/Express-4.x-blue) ![No Build Step](https://img.shields.io/badge/Build-None_Required-brightgreen)

## Quick Start

```bash
git clone https://github.com/chriskesler35/openclaw-model-manager.git
cd openclaw-model-manager
npm install
node server.js
```

Open **http://localhost:18800** — that's it.

## What It Does

### 🖥️ Live System Monitoring
- **GPU VRAM usage bars** — real-time, updates every 3 seconds
- **GPU utilization & temperature** — color-coded (green/yellow/red)
- **System RAM** — live free/used with percentage bars
- **Model offload detection** — shows when a model spills from GPU to CPU (and how much)

### 🤖 Model Management
- Set primary model with one click
- **Drag-and-drop fallback chain** — reorder, add from dropdown, remove, save
- Model aliases (short names for long model IDs)
- Add new models (external API or local Ollama) from the UI
- Browse all available models with compatibility assessment

### 🔑 Credential Management
- View credential status for all providers (masked keys)
- Add/update API keys directly from the UI
- Provider health probes with plain English results
- Expandable raw JSON for technical users

### 🔌 Gateway Control
- Start / Stop / Restart the OpenClaw gateway
- Live status indicator (green dot = running)
- Health report in plain English

### 💻 Local Model Assessment
- Scans Ollama for installed models
- Cross-references with your GPU VRAM and system RAM
- Plain English verdict: "Fits in GPU", "Tight fit", "Too large"
- Shows running models with GPU/CPU split percentage

### 🌐 Multi-Machine Support
- Connect to remote OpenClaw gateways via Tailscale, LAN, or WAN
- Gateway discovery via Bonjour/mDNS
- Connection manager with saved configs
- See [Remote Setup](#remote-setup) below

## Requirements

- **Node.js 18+** (tested on 22)
- **OpenClaw** installed and configured on the local machine
- **nvidia-smi** (optional, for GPU monitoring — comes with NVIDIA drivers)
- **Ollama** (optional, for local model management)

## Configuration

The server runs on port **18800** by default and binds to **0.0.0.0** (accessible from your network).

| Environment Variable | Default | Description |
|---|---|---|
| `MM_PORT` | `18800` | Server port |

```bash
# Run on a different port
MM_PORT=9000 node server.js
```

## Remote Setup

You can manage multiple machines from a single Model Manager instance. The remote machine determines what's available:

| Remote Has | What You Get |
|---|---|
| **OpenClaw Gateway only** | Gateway status, start/stop, model config, auth profiles |
| **Gateway + Ollama** | Above + installed model list, running model status |
| **Gateway + Model Manager** | Full experience: live GPU bars, compatibility, credentials |

### Setting Up a Remote Machine

On the remote machine (Pi, VPS, second PC, etc.):

```bash
# One-liner: clone, install, and run
git clone https://github.com/chriskesler35/openclaw-model-manager.git && cd openclaw-model-manager && npm install && node server.js
```

Or to keep it running in the background:

```bash
# With nohup
nohup node server.js > mm.log 2>&1 &

# Or with pm2 (if installed)
pm2 start server.js --name model-manager

# Or with systemd (Linux)
# See systemd section below
```

Then on your main machine, go to the **Connections** tab and add the remote:
- **Host:** IP address or hostname (e.g., `100.64.0.5` for Tailscale, or `192.168.1.50` for LAN)
- **Port:** `18789` (gateway port)
- **Token:** Your gateway auth token (from `openclaw.json` → `gateway.auth.token`)
- **Model Manager Port:** `18800` (for full system stats)
- **Ollama Port:** `11434` (for local model info)

### Tailscale (Recommended for Remote)

If both machines are on [Tailscale](https://tailscale.com/), use the Tailscale IP — it works across networks with zero port forwarding:

```bash
# Find your Tailscale IP
tailscale ip -4
```

### systemd Service (Linux)

```ini
# /etc/systemd/system/openclaw-mm.service
[Unit]
Description=OpenClaw Model Manager
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/openclaw-model-manager
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable openclaw-mm
sudo systemctl start openclaw-mm
```

## Architecture

```
server.js                    Express server (port 18800, binds 0.0.0.0)
├── /api/:connId/gateway/*   Gateway control (status, start, stop, restart)
├── /api/:connId/models/*    Model management (list, set, fallbacks, aliases)
├── /api/:connId/auth/*      Auth profile viewing
├── /api/:connId/system/*    System info & local model compatibility
├── /api/system/stats        Fast GPU/RAM polling endpoint (3s refresh)
├── /api/credentials/*       Credential management (add/update API keys)
├── /api/models/add|remove   Config file editing
├── /api/providers           Known provider registry
├── /api/discover            Bonjour/mDNS gateway discovery
├── /ws                      WebSocket live status push
│
public/
├── index.html               Tabbed UI layout
├── app.js                   Frontend logic (~1,600 lines)
└── styles.css               Dark theme (~800 lines)
│
connections.json              Saved remote gateway configs (gitignored)
```

- **No build step** — static HTML/CSS/JS served by Express
- **Independent of the OpenClaw gateway** — survives gateway stop/restart
- **Local connections** use the `openclaw` CLI for full feature access
- **Remote connections** use HTTP health checks + WebSocket RPC

## Tech Stack

- [Express](https://expressjs.com/) — HTTP server
- [ws](https://github.com/websockets/ws) — WebSocket for live status
- Vanilla JS — no framework, no build tools
- `nvidia-smi` — GPU stats (via shell)
- `wmic` / system commands — RAM stats
- Ollama API — local model management

## License

MIT
