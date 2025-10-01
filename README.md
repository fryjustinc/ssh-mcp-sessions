# SSH MCP Server

> A Model Context Protocol (MCP) server that gives LLM clients safe, persistent SSH access to remote machines.

---

## Table of Contents

1. [Overview](#overview)
2. [Key Features](#key-features)
3. [Architecture](#architecture)
4. [Installation](#installation)
5. [Running the Server](#running-the-server)
6. [Client Integrations](#client-integrations)
   - [Claude Desktop](#claude-desktop)
   - [Claude Code](#claude-code)
   - [Codex](#codex)
   - [Cursor](#cursor)
7. [Host Configuration](#host-configuration)
   - [Host Storage](#host-storage)
   - [Adding Hosts](#adding-hosts)
   - [Listing Hosts](#listing-hosts)
   - [Editing Hosts](#editing-hosts)
   - [Removing Hosts](#removing-hosts)
8. [Session Management](#session-management)
   - [Starting a Session](#starting-a-session)
   - [Listing Sessions](#listing-sessions)
   - [Executing Commands](#executing-commands)
   - [Closing Sessions](#closing-sessions)
9. [Authentication Modes](#authentication-modes)
10. [Timeouts & Inactivity Handling](#timeouts--inactivity-handling)
11. [Directory Structure](#directory-structure)
12. [Using the MCP Tools](#using-the-mcp-tools)
13. [Testing](#testing)
14. [Troubleshooting](#troubleshooting)
15. [Security Considerations](#security-considerations)
16. [Contributing](#contributing)
17. [License](#license)

---

## Overview

`ssh-mcp` lets MCP-compatible clients (such as Claude Code, Cursor, or custom MCP inspectors) control remote machines through SSH. Once hosts are registered, the server maintains persistent shell sessions that retain environment state between commands—ideal for multi-step workflows, long-running processes, or interactive diagnostics.

The server is implemented in TypeScript on top of the official [@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk).

---

## Key Features

- **MCP-compliant:** exposes functionality through standard MCP tool definitions.
- **Persistent sessions:** keep shell sessions alive, preserving working directory, environment variables, and process state across multiple commands.
- **Stored host profiles:** manage SSH targets through durable JSON configuration (`~/.ssh-mcp/hosts.json`).
- **Flexible authentication:** supports passwords, private keys, and SSH agent forwarding (fallback).
- **Timeout & cleanup safeguards:** sessions auto-close after prolonged inactivity; commands are marked and monitored for completion.
- **Structured listings:** query active sessions and saved hosts directly from the MCP client.

---

## Architecture

```
MCP Client ─┬─> add-host / edit-host / remove-host
            │
            ├─> list-hosts
            │
            ├─> start-session ─┬─> PersistentSession (ssh2 shell)
            │                  ├─> exec (reuses shell, captures stdout/stderr)
            │                  └─> close-session / auto-timeout
            │
            └─> list-sessions

Persistent configuration → ~/.ssh-mcp/hosts.json
```

Each active session maintains:
- SSH connection via [`ssh2`](https://www.npmjs.com/package/ssh2)
- Interactive shell (`conn.shell`) to support multi-command pipelines
- Buffered output with unique UUID markers to detect command completion
- Inactivity timer (defaults to 2 hours)

---

## Installation

Install the published package from npm so the `ssh-mcp-sessions` executable is available in your environment.

### Global install (preferred)

```bash
npm install -g ssh-mcp-sessions
```

Launch the server anywhere by running `ssh-mcp-sessions`.

### Project-local install

Inside your project:

```bash
npm install ssh-mcp-sessions
```

Run the server with `npx ssh-mcp-sessions` (or reference `./node_modules/.bin/ssh-mcp-sessions`).

> Building from source is only required for contributing. See the [Contributing](#contributing) section if you plan to work on the codebase itself.

---

## Running the Server

```bash
ssh-mcp-sessions
```

The server is purely stdio-based. Once running it prints:

```
SSH MCP Server running on stdio
```

You can register it with Claude Code or any other MCP client by pointing to the executable installed from npm:

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "npx",
      "args": [
        "ssh-mcp-sessions"
      ]
    }
  }
}
```

If you prefer to rely on PATH resolution (e.g., after a global install), you can simplify the entry to `{ "command": "ssh-mcp-sessions" }`.

> **Note:** The server no longer accepts CLI arguments for host/user/password. Everything is configured dynamically via MCP tools.

---

## Host Configuration

### Host Storage

- Hosts are persisted in `~/.ssh-mcp/hosts.json`.
- The directory is created automatically if it does not exist.
- File format:

```json
{
  "hosts": [
    {
      "id": "host",
      "host": "host.local",
      "port": 22,
      "username": "user",
      "password": "...",     // optional
      "keyPath": "~/.ssh/id_rsa" // optional
    }
  ]
}
```

Fields:
- `id` (string) — unique identifier used by all session commands.
- `host` (string) — hostname or IP.
- `port` (number, default 22) — SSH port.
- `username` (string) — SSH user.
- `password` (optional string) — password auth.
- `keyPath` (optional string) — private key path; tilde expansion supported.
    - If neither `password` nor `keyPath` is provided, the server attempts to use the local SSH agent via `SSH_AUTH_SOCK` (with agent forwarding enabled).

> The MCP tools ensure this file remains well-formed; never edit it manually unless you know what you’re doing.

### Adding Hosts

Tool: **`add-host`**

```json
{
  "host_id": "user@host.local",
  "host": "host.local",
  "port": 22,
  "username": "user",
  "password": "optional",
  "keyPath": "optional"
}
```

- `host_id`: new identifier. Must be unique.
- `host`: hostname or IP.
- `port`: optional (defaults to 22); provide integer > 0.
- `username`: SSH user.
- `password` or `keyPath`: optional; configure one or rely on agent.

Example (Claude Code command palette or inspector):

```
/mcp mcp-remote-ssh add-host {"host_id":"host","host":"host.local","username":"user"}
```

### Listing Hosts

Tool: **`list-hosts`**

Returns text with one host per line:

```
id=host host=host.local:22 user=user auth=agent
```

`auth` values:
- `password` — password field present
- `key` — keyPath present
- `agent` — neither password nor keyPath; agent fallback active

### Editing Hosts

Tool: **`edit-host`**

```json
{
  "host_id": "user@host.local",
  "port": 2222,
  "password": "new-pass"
}
```

Only supply the properties you want to change. Omitted fields remain unchanged; providing `null` to a field is not supported—set an empty string or remove the host instead.

### Removing Hosts

Tool: **`remove-host`**

```json
{
  "host_id": "user@host.local"
}
```

Deletes the entry from `hosts.json`. Active sessions using that host must be closed manually.

---

## Session Management

### Starting a Session

Tool: **`start-session`**

```json
{
  "host_id": "user@host.local"
}
```

Optionally you can supply `sessionId`; otherwise, a UUID is returned.

Example response:

```fff4b34b-56dd-4711-9555-c04e8b64249b
```

### Listing Sessions

Tool: **`list-sessions`**

Shows all active sessions with metadata:

```
session=fff4… host=host.local:22 user=user uptime=3m12s lastCommand=ls -la
```

### Executing Commands

Tool: **`exec`**

```json
{
  "session_id": "fff4b34b-56dd-4711-9555-c04e8b64249b",
  "command": "pwd"
}
```

- Commands are sanitized (trimmed, length-limited).
- Output is captured from the persistent shell and returned as plain text.
- Non-zero exit codes raise `McpError` with stderr in the message.

Example output:

```
/home/user
```

### Closing Sessions

Tool: **`close-session`**

```json
{
  "sessionId": "fff4b34b-56dd-4711-9555-c04e8b64249b"
}
```

> Note: session IDs for `close-session` use `sessionId` (camelCase) to remain backwards compatible with the underlying tool definition.

### Legacy Helper

Function `execSshCommand(hostId, command, sessionId?)` remains exported for programmatic use and simply delegates through the session machinery described above.

---

## Authentication Modes

1. **Password** — stored in `hosts.json`; transmitted to `ssh2` during connection.
2. **Private key** — `keyPath` read at runtime; supports encrypted keys (prompt user to set `SSH_MCP_KEY_PASSPHRASE` before launch if needed).
3. **SSH agent (fallback)** — if neither password nor key is set and `SSH_AUTH_SOCK` is present, the agent is passed to `ssh2` (`agentForward: true`).

---

## Timeouts & Inactivity Handling

- Each session has a **global inactivity timeout** (default 2 hours). Timer resets whenever a command executes successfully.
- If the timer elapses, the session cleans up the SSH connection, shell, and resolver buffer, and removes itself from `activeSessions`.
- Command completion uses a UUID marker: `printf '__MCP_DONE__{uuid}%d\n' $?`. Output before the marker is returned; numeric code after the marker becomes the exit status.

---

## Directory Structure

```
ssh-mcp/
├── build/                # Compiled JS output (npm run build)
├── src/index.ts          # Primary MCP server implementation
├── test/                 # Vitest tests (CLI-only; integration tests skipped)
├── package.json
├── README.md             # This document
└── ~/.ssh-mcp/hosts.json # Created at runtime (per user)
```

---

## Using the MCP Tools

Below is a typical workflow using Claude Code (commands start with `/mcp`), but the same JSON payloads apply to any MCP inspector.

1. **Add host**
   ```
   /mcp mcp-remote-ssh add-host {"host_id":"host","host":"host.local","username":"user"}
   ```

2. **Start session**
   ```
   /mcp mcp-remote-ssh start-session {"host_id":"host"}
   ```
   → returns `session_id`

3. **Run commands**
   ```
   /mcp mcp-remote-ssh exec {"session_id":"<id>","command":"pwd"}
   /mcp mcp-remote-ssh exec {"session_id":"<id>","command":"ls -la"}
   ```

4. **Inspect**
   ```
   /mcp mcp-remote-ssh list-sessions
   /mcp mcp-remote-ssh list-hosts
   ```

5. **Close session**
   ```
   /mcp mcp-remote-ssh close-session {"sessionId":"<id>"}
   ```

---

## Testing

Unit tests (Vitest):

```bash
npm run test
```

Integration smoke tests for SSH are not included by default because they require external infrastructure. You can manually validate with the workflow above.

---

## Troubleshooting

| Symptom | Possible Cause | Suggested Action |
|---------|----------------|------------------|
| `Host 'xyz' already exists` | Duplicate `host_id` | Use `edit-host` or pick a new ID. |
| `Host 'xyz' not found` | Missing entry | Run `list-hosts` to confirm; add host again if needed. |
| `Error (code X): …` | Remote command returned non-zero | Inspect the command output. The session remains open. |
| Session disappears from `list-sessions` | Inactivity timeout reached | Start a new session or reduce idle periods. |
| Permission denied (publickey) | Missing credentials | Ensure `keyPath` or agent has the right key. |
| `Invalid key path` | `keyPath` resolved to undefined or missing file | Provide an absolute/tilde path that exists. |

---

## Security Considerations

- Treat `~/.ssh-mcp/hosts.json` as sensitive; it may contain passwords or key paths.
- Prefer key-based or agent authentication where possible.
- Limit `hosts.json` permissions: `chmod 600 ~/.ssh-mcp/hosts.json`.
- Sessions inherit all privileges of the configured SSH user.
- Long-running sessions can be closed manually or rely on the inactivity timeout.

---

## Contributing

1. Fork the repo and create a branch.
2. Make your changes with tests and documentation updates.
3. Run `npm run build` and `npm run test` before submitting a PR.
4. Follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

Issues and feature requests are welcome via GitHub.

---

## License

[MIT](./LICENSE)

---

**Happy automating!** If this project improves your workflow, please star the repository or share feedback. Your contributions help make remote development safer and simpler for everyone. 

### Claude Desktop

Add an entry to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the appropriate config path on Windows/Linux:

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "npx",
      "args": [
        "ssh-mcp-sessions"
      ]
    }
  }
}
```

Restart Claude Desktop after saving the file. You can now use the MCP Inspector or the command palette (`Cmd/Ctrl+Shift+O`) to call tools like `add-host` and `start-session`.

### Claude Code (VS Code extension)

Update the Claude Code workspace settings (`.vscode/settings.json` or global settings) with:

```json
{
  "claude.mcpServers": {
    "ssh-mcp": {
      "command": "npx",
      "args": [
        "ssh-mcp-sessions"
      ]
    }
  }
}
```

Reload the window. The MCP panel will list `ssh-mcp`, and commands are available via the command palette (`Ctrl/Cmd+Shift+P` → “Claude: Run MCP Tool”).

### Codex (OpenAI GPT-4o/5 with MCP)

Create or edit `~/.config/openai-codex/mcp.json` (the path may differ per platform—use the location documented by the client). Add:

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "npx",
      "args": [
        "ssh-mcp-sessions"
      ]
    }
  }
}
```

Restart Codex or re-open the MCP inspector. The `ssh-mcp` tools will appear under the configured servers list.

### Cursor IDE

Open Cursor settings → “Model Context Protocol” (or edit `~/Library/Application Support/Cursor/mcp.json` directly) and include:

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "npx",
      "args": [
        "ssh-mcp-sessions"
      ]
    }
  }
}
```

After saving, reload Cursor. The MCP sidebar exposes the server; you can invoke tools via chat or the command palette (`Cmd/Ctrl+Shift+L`).

> **Tip:** If you prefer an explicit path instead of relying on `npx`, replace the command/args with the absolute path to the executable (`node_modules/.bin/ssh-mcp-sessions` for local installs or `/usr/local/lib/node_modules/ssh-mcp-sessions/build/index.js` for global installs). 
