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

### From npm (recommended)

Install the published package globally so the `ssh-mcp` executable is on your PATH:

```bash
npm install -g ssh-mcp-sessions
```

Once installed, you can launch the server anywhere by running `ssh-mcp`.

> Need a project-local install instead? Run `npm install ssh-mcp-sessions` inside your app and invoke `npx ssh-mcp` (or `node ./node_modules/ssh-mcp-sessions/build/index.js`).

### From source (development)

```bash
git clone https://github.com/fryjustinc/ssh-mcp.git
cd ssh-mcp
npm install
npm run build
```

The build step compiles TypeScript into `./build/index.js` and marks it executable.

---

## Running the Server

```bash
node build/index.js
```

The server is purely stdio-based. Once running it prints:

```
SSH MCP Server running on stdio
```

You can register it with Claude Code or any other MCP client:

```json
{
  "mcpServers": {
    "mcp-remote-ssh": {
      "command": "node",
      "args": [
        "/absolute/path/to/ssh-mcp/build/index.js"
      ]
    }
  }
}
```

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

```
```

## Client Integrations

The server speaks the standard MCP protocol, so registration mainly involves pointing your client at the executable produced by this package. The snippets below assume you installed the package globally (`npm install -g ssh-mcp-sessions`) so the `ssh-mcp` binary is available on your PATH. Replace absolute paths if you opted for a local install.

### Claude Desktop

Add an entry to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the appropriate config path on Windows/Linux:

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "ssh-mcp"
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
      "command": "ssh-mcp"
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
      "command": "ssh-mcp"
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
      "command": "ssh-mcp"
    }
  }
}
```

After saving, reload Cursor. The MCP sidebar exposes the server; you can invoke tools via chat or the command palette (`Cmd/Ctrl+Shift+L`).

> **Tip:** If you prefer an explicit path instead of relying on PATH lookup, replace `"command": "ssh-mcp"` with the absolute path to the built script, e.g. `/usr/local/lib/node_modules/ssh-mcp-sessions/build/index.js`.
