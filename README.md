# Codex Taskboard

A local-first issue board that runs in a browser and can be embedded in Codex through the standalone CDP launcher or its injection script. The same HTTP API powers the React UI and the `taskctl` CLI used by the bundled Codex Skill.

## Requirements

- Node.js 22.5 or newer

## Run locally

```bash
npm install
npm run build
npm start
```

Open <http://127.0.0.1:47823>. The SQLite database is stored at `.data/taskboard.sqlite`.

For development with live frontend reload:

```bash
npm run dev
```

The Vite UI runs at <http://127.0.0.1:5173> and proxies API requests to the local service.

## Run inside a WeCom application

The standalone UI can be mounted under a dedicated WeCom application path. For local development with application `1000003`:

```bash
export CODEX_TASKBOARD_HOST=127.0.0.1
export CODEX_TASKBOARD_WECOM_ENABLED=true
export CODEX_TASKBOARD_WECOM_AGENT_ID=1000003
export CODEX_TASKBOARD_WECOM_CORP_ID=ww-your-corp-id
export CODEX_TASKBOARD_WECOM_DEV_MODE=true
export CODEX_TASKBOARD_WECOM_DEV_USER_ID=your-wecom-user-id
export CODEX_TASKBOARD_WECOM_DEV_USER_NAME='Your name'
npm start
```

Open <http://127.0.0.1:47823/wecom/app/1000003/taskboard>. Development login is accepted only over loopback. In a real WeCom callback deployment, disable development mode and configure `CODEX_TASKBOARD_WECOM_SECRET` plus an exact HTTPS `CODEX_TASKBOARD_WECOM_PUBLIC_URL`. The application then uses WeCom OAuth and rejects unauthenticated API requests; the HTTPS route is an authenticated application entry, not an anonymous board.

The configured development identity, `TianJiYuan`, is an active member returned by the corporate API. The installed macOS service reads the selected application's Secret from the login Keychain service `dashi-taskboard` and account `CODEX_TASKBOARD_WECOM_SECRET_<AgentId>`; changing `CODEX_TASKBOARD_WECOM_AGENT_ID` therefore selects the matching Secret without editing the startup script. Never put a Secret in this repository or a LaunchAgent plist.

Set the application's visible range in the WeCom administration UI. The ordinary `agent/set` API can update fields such as `home_url`, but it does not change the application's visible members or departments; an `errcode: 0` response is therefore not proof that access was narrowed. After saving the visible range, verify it with `agent/get`: a Tian-only installation must list `TianJiYuan` in `allow_userinfos.user` and must not list a root or other department in `allow_partys.partyid`.

Multiple Codex installations can feed their project inventory into the same board. A source without `sshHost` is read locally; a source with `sshHost` uses an existing non-interactive SSH host alias:

```bash
export CODEX_TASKBOARD_DEVICE_SOURCES='[
  {"id":"mini","name":"Mac Mini","statePath":"/Users/me/.codex/.codex-global-state.json","local":true},
  {"id":"macbook","name":"MacBook Pro","sshHost":"macbook","statePath":"/Users/me/.codex/.codex-global-state.json"}
]'
export CODEX_TASKBOARD_DEVICE_SYNC_INTERVAL_MS=300000
```

The board caches the latest inventory in SQLite, shows device health and project counts, merges the same project name across devices, and retains the last known inventory when a device cannot be reached. A local source marked with `local: true` also supplies the executable workspace path for Git and Codex actions.

### Use the same board from a second Mac

Keep one Taskboard server and one SQLite database on the primary Mac. A second Mac can expose that same service only on its own loopback interface with an SSH local forward:

```bash
ssh -N -T \
  -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -o StrictHostKeyChecking=yes \
  -o GatewayPorts=no \
  -L 127.0.0.1:47823:127.0.0.1:47823 \
  primary-mac
```

The secondary Mac can then open <http://127.0.0.1:47823/wecom/app/1000003/taskboard?device=macbook>. The device query selects MacBook workspace mappings while the primary Mac keeps using the URL without that query. `taskctl` continues to use its default loopback URL. Do not start another Taskboard server or create another database on the secondary Mac. Keep both ends bound to `127.0.0.1`; the tunnel should fail closed when SSH is unavailable.

`deploy/macos/com.haitian.dashi-taskboard-mini-tunnel.plist` is the installed user LaunchAgent for the current Mini/MacBook setup. It maintains the forward with strict host verification and reconnects after interruption without publishing port 47823 to the LAN or internet.

The primary Mac service template is `deploy/macos/com.tianmac.dashi-taskboard.plist`. It binds the board to loopback, runs the WeCom `1000003` development entry, synchronizes both Codex inventories, and sends local AI requests through the existing authenticated proxy tunnel at `127.0.0.1:11090`.

Before loading that LaunchAgent, install its ASCII-path startup wrapper with `install -m 700 scripts/start-local-service.sh ~/.local/bin/dashi-taskboard-start`. The ASCII path avoids `launchd` argument corruption for repositories stored under a directory with Chinese characters; the wrapper requires `CODEX_TASKBOARD_WECOM_AGENT_ID` and loads `CODEX_TASKBOARD_WECOM_SECRET_<AgentId>` from Keychain before starting Node. Set `CODEX_TASKBOARD_WECOM_SECRET_KEYCHAIN_ACCOUNT` only when an installation deliberately uses a different Keychain account name.

`deploy/macos/com.tianmac.dashi-taskboard-backup.plist` runs `scripts/backup-local-data.mjs` at login and every day at 03:10. Each atomically published `.backup` directory contains a consistent `taskboard.sqlite`, the complete set of attachment files referenced by that snapshot, and `manifest.json` with table counts plus database and attachment sizes/SHA-256 hashes. Database integrity, foreign keys, attachment presence, and attachment sizes are checked before publication. Backup directories use mode `0700`, files use mode `0600`, and the latest 14 backup units are retained in `/Users/tianmac/Applications/dashi-taskboard/backups` (legacy SQLite-only snapshots count toward the same retention limit). Restore `taskboard.sqlite` and the matching `attachments` directory together while the Taskboard service is stopped; never mix files from different backup units.

## Use the CLI

Run it from the project:

```bash
npm run taskctl -- project create \
  --id my-project \
  --name "My project" \
  --workspace-path /absolute/path/to/repository

npm run taskctl -- issue create \
  --project my-project \
  --title "Implement the next slice" \
  --status todo \
  --priority high \
  --labels product,mvp
```

Use `npm link` if you want `taskctl` on your shell path. Set `CODEX_TASKBOARD_URL` to point the CLI at another local or LAN service. Cloud deployments are configured through the loopback companion with `taskctl cloud login`.

## Install the Codex Skill

Copy or symlink `skills/manage-taskboard` into the Codex skills directory, then start a new Codex task:

```bash
ln -s /absolute/path/to/codex-taskboard/skills/manage-taskboard \
  ~/.codex/skills/manage-taskboard
```

The Skill teaches Codex to inspect an issue, move it to `in_progress`, use optimistic versions, verify the work, and then move it to `in_review`; it moves the issue to `done` only after the user explicitly confirms acceptance or asks to mark it complete.

## Embed in Codex

### Recommended: keep your current window and open a separate Taskboard window

Keep the existing Codex window open. From the Taskboard repository, start a second Codex instance with a dedicated CDP port:

```bash
open -n -a /Applications/ChatGPT.app --args \
  --remote-debugging-port=9231 \
  --remote-allow-origins=http://127.0.0.1:9231
```

After the new Codex window appears, run the injector in another terminal:

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 \
npm run codex:inject -- --port 9231 --open
```

Keep the injector terminal running while using the embedded panel. The original Codex window remains unchanged, and the new window receives the Taskboard sidebar entry. If port `9231` is occupied, use another port in both commands.

### Alternative: restart Codex with the standalone launcher

Quit every running Codex window, then run:

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 npm run codex
```

This starts the local Taskboard service when needed, launches the official macOS Codex app with a loopback-only CDP port, injects a native-looking Taskboard entry after Plugins, and keeps watching both the service and replacement renderers. Opening Taskboard asks this launcher to health-check the fixed local service, restart it when needed, and rebuild a failed iframe. Keep this command running while using the embedded panel. The launcher does not modify `ChatGPT.app` or its `app.asar`.

Codex 26.715.52143 ships a renderer CSP that blocks arbitrary HTTP iframes. The launcher therefore enables CDP CSP bypass, reloads that renderer once, installs the document-start script, and waits until the Taskboard OOPIF is actually loaded. CDP is unauthenticated to other processes on the same machine, so only run trusted local code while the launcher is active.

To inject into a Codex instance that was already launched with CDP by another method, run:

```bash
npm run codex:inject -- --port 9229 --open
```

This command also stays resident so the injected tab can restart Taskboard after a service exit. Stop it with `Ctrl-C`.

The script adds a Taskboard entry to the Codex sidebar and renders the iframe across Codex's complete main workspace, including the contextual titlebar area so Taskboard's own header does not leave an empty strip. That full rectangular header is placed above Electron's draggable layer and marked `no-drag`; because the native contextual actions are suppressed while Taskboard is active, its own actions use their normal edge padding without an artificial right-side gap. The native sidebar stays mounted, while the previous page selection and contextual header are temporarily suppressed; choosing another Codex page restores them.

“在对话中打开” selects the corresponding native Codex project when one is available and opens an unsent native composer with `$manage-taskboard ISSUE-ID`. A conversation is attributed only after it actually processes the issue: `taskctl` reads Codex's `CODEX_THREAD_ID` and records that ID on the issue or comment mutation. Recorded IDs are clickable through Codex's native route bridge. Each issue can bind either one Git branch or one worktree; the options are scanned from the selected Codex project's repository instead of being typed by hand. The integration uses Codex's existing project, composer, and route markers; it does not patch React, replace `fetch`, load private chunks, or edit Codex data files.

To use a different UI origin, set `window.__CODEX_TASKBOARD_URL__` before the user script runs.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_TASKBOARD_HOST` | `0.0.0.0` | HTTP bind address; use `127.0.0.1` to disable LAN access |
| `CODEX_TASKBOARD_PORT` | `47823` | Local HTTP port |
| `CODEX_TASKBOARD_DATA_DIR` | `.data` | SQLite data directory |
| `CODEX_TASKBOARD_URL` | `http://127.0.0.1:47823` | CLI API origin |
| `CODEX_EXECUTABLE` | `codex` | Codex CLI executable used by local AI chat and capability discovery |
| `CODEX_TASKBOARD_WECOM_ENABLED` | `false` | Enable the WeCom application entry and identity session |
| `CODEX_TASKBOARD_WECOM_AGENT_ID` | empty | Dedicated WeCom application AgentId; required when WeCom is enabled |
| `CODEX_TASKBOARD_WECOM_SECRET_KEYCHAIN_ACCOUNT` | `CODEX_TASKBOARD_WECOM_SECRET_<AgentId>` | Optional Keychain account override used by the macOS startup wrapper |
| `CODEX_TASKBOARD_SERVICE_SECRET_KEYCHAIN_ACCOUNT` | `CODEX_TASKBOARD_SERVICE_SECRET_<AgentId>` | Optional Keychain account containing the WorkBuddy bridge/remote taskctl service secret |
| `CODEX_TASKBOARD_WECOM_PUBLIC_URL` | empty | Exact HTTPS application URL used for OAuth callbacks |
| `CODEX_TASKBOARD_WECOM_ALLOWED_USER_IDS` | empty | Optional comma-separated WeCom UserIds allowed to complete OAuth |
| `CODEX_TASKBOARD_SERVICE_SECRET` | empty | Legacy shared service secret; keep only during migration |
| `CODEX_TASKBOARD_AGENT_CREDENTIALS` | `[]` | JSON array binding each Agent secret to one `agentId`, device, project allowlist, and capability list |
| `CODEX_TASKBOARD_COMPANION_SECRET` | empty | Dedicated secret for the local/cloud companion acting-user channel |
| `CODEX_TASKBOARD_BRIDGE_SECRET` | empty | Dedicated secret for the WorkBuddy bridge; never reuse an Agent or companion secret |
| `CODEX_TASKBOARD_DEVICE_SOURCES` | `[]` | JSON list of local or SSH Codex project inventories |
| `CODEX_TASKBOARD_DEVICE_SYNC_INTERVAL_MS` | `300000` | Device inventory refresh interval in milliseconds |

`npm start` prints both the local URL and the available LAN URLs. Teammates on the same trusted network can open one of those LAN URLs and use the same taskboard service. Task, comment, and attachment changes are broadcast to every open client through server-sent events; reconnecting clients perform a full refresh so changes made while disconnected are not missed. A teammate using `taskctl` can point it at the shared service with `CODEX_TASKBOARD_URL=http://<host-ip>:47823`.

Production workers should use bound credentials instead of the legacy shared service secret. An empty `projects` array grants no project access. Keep the JSON and its secrets in the host's protected environment file or secret manager, never in this repository:

```json
[
  {
    "agentId": "codex-mini",
    "secret": "<unique-secret-from-secret-manager>",
    "device": "Mini",
    "projects": ["dashi-taskboard"],
    "capabilities": ["taskboard", "ops"]
  }
]
```

LAN mode has no account authentication: anyone on the trusted local network who can reach the URL can read and write the taskboard. Public internet and cloud deployment require an authenticated deployment boundary.

## Share through Cloudflare

For two trusted collaborators, the taskboard can run on Cloudflare with Worker Static Assets and API routes, D1 as the authoritative business database, and a private R2 bucket for attachments. The deployment uses HTTPS Basic Authentication with a shared password and refreshes open boards after a global revision changes.

Each device keeps its own project checkout mapping and continues to use a local companion for Codex, Git/worktree, Skill, and MCP capabilities. Cloud mode never falls back to or double-writes the local SQLite database.

See [Cloud collaboration](docs/cloud-collaboration.md) for owner deployment, existing GitHub installation setup, password rotation, local path mapping, and the one-time local-data migration flow.

## Verify

```bash
npm run check
```

This runs TypeScript checking, a production frontend build, and the server/CLI/injection test suite.
