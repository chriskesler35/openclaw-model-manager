# AGENTS.md

## Cursor Cloud specific instructions

This is a single-service Node.js (Express) web application with no build step, no linter, and no test framework. See `README.md` for full docs.

### Running the app

```
npm start          # or: node server.js
```

Server listens on `http://localhost:18800` (override with `MM_PORT` env var). The `--dev` flag (`npm run dev`) currently has no special behavior distinct from `npm start`.

### Key caveats

- **No lint or test commands exist.** `package.json` only defines `start` and `dev` scripts. There is no ESLint, Prettier, or test runner configured.
- **No build step.** Frontend is vanilla HTML/CSS/JS served statically from `public/`.
- **External dependencies are optional.** The app starts and serves its UI without OpenClaw gateway, Ollama, or nvidia-smi. API calls to those services will return errors/fallback states, but the UI remains fully interactive.
- The `run()` helper in `server.js` defaults to `powershell.exe` as the shell (Windows-oriented). On Linux, some local gateway/system commands will fail — this is expected in a cloud VM and does not block UI development. The `runCmd()` helper uses the default system shell.
- `connections.json` (gitignored) stores saved remote connections. It is created on first write.
