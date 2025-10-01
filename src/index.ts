#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { ClientChannel, ConnectConfig } from 'ssh2';
import SSH2Module from 'ssh2';
const { Client: SSHClient, utils: sshUtils } = SSH2Module as typeof import('ssh2');
import { z } from 'zod';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFile, writeFile, mkdir, stat } from 'fs/promises';
import { resolve as resolvePath } from 'path';
import os from 'os';
import { randomUUID } from 'crypto';

function expandPath(input: string | undefined): string | undefined {
  if (!input) return input;
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return resolvePath(os.homedir(), input.slice(2));
  if (input.startsWith('~')) return resolvePath(os.homedir(), input.slice(1));
  return resolvePath(input);
}

const DEFAULT_TIMEOUT = 2 * 60 * 60 * 1000; // 2 hours default timeout

const HOSTS_DIR = resolvePath(os.homedir(), '.ssh-mcp');
const HOSTS_FILE = resolvePath(HOSTS_DIR, 'hosts.json');

type StoredHost = {
  id: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  keyPath?: string;
};

const HostsSchema = z.object({
  hosts: z.array(z.object({
    id: z.string(),
    host: z.string(),
    port: z.number().int().positive().default(22),
    username: z.string(),
    password: z.string().optional(),
    keyPath: z.string().optional(),
  })).default([]),
});

async function ensureHostsFile(): Promise<void> {
  await mkdir(HOSTS_DIR, { recursive: true });
  try {
    const stats = await stat(HOSTS_FILE);
    if (!stats.isFile()) {
      throw new McpError(ErrorCode.InternalError, `${HOSTS_FILE} exists but is not a file`);
    }
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      await writeFile(HOSTS_FILE, JSON.stringify({ hosts: [] }, null, 2), 'utf8');
    } else if (err?.code !== 'EISDIR') {
      throw err;
    } else {
      throw new McpError(ErrorCode.InternalError, `${HOSTS_FILE} is a directory`);
    }
  }
}

async function readHosts(): Promise<StoredHost[]> {
  await ensureHostsFile();
  const raw = await readFile(HOSTS_FILE, 'utf8');
  const parsed = HostsSchema.safeParse(JSON.parse(raw || '{}'));
  if (!parsed.success) {
    throw new McpError(ErrorCode.InternalError, `Failed to parse hosts.json: ${parsed.error.message}`);
  }
  return parsed.data.hosts;
}

async function writeHosts(hosts: StoredHost[]): Promise<void> {
  await ensureHostsFile();
  await writeFile(HOSTS_FILE, JSON.stringify({ hosts }, null, 2), 'utf8');
}

async function getHostConfig(hostId: string): Promise<ConnectConfig> {
  const hosts = await readHosts();
  const host = hosts.find((h) => h.id === hostId);
  if (!host) {
    throw new McpError(ErrorCode.InvalidParams, `Host '${hostId}' not found`);
  }

  const config: ConnectConfig = {
    host: host.host,
    port: host.port ?? 22,
    username: host.username,
  };

  if (host.password) {
    config.password = host.password;
  } else if (host.keyPath) {
    const expanded = expandPath(host.keyPath);
    if (!expanded) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid key path for host '${hostId}'`);
    }
    const keyContent = await readFile(expanded, 'utf8');
    config.privateKey = keyContent;
  } else {
    // Fallback to SSH agent if available
    if (process.env.SSH_AUTH_SOCK) {
      config.agent = process.env.SSH_AUTH_SOCK;
      config.agentForward = true;
    }
  }

  return config;
}

// Command sanitization and validation
export function sanitizeCommand(command: string): string {
  if (typeof command !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'Command must be a string');
  }
  
  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    throw new McpError(ErrorCode.InvalidParams, 'Command cannot be empty');
  }
  
  // Length check
  if (trimmedCommand.length > 15000) {
    throw new McpError(ErrorCode.InvalidParams, 'Command is too long (max 1000 characters)');
  }
  
  return trimmedCommand;
}

// Escape command for use in shell contexts (like pkill)
export function escapeCommandForShell(command: string): string {
  // Replace single quotes with escaped single quotes
  return command.replace(/'/g, "'\"'\"'");
}

const activeSessions = new Map<string, PersistentSession>();
const DEFAULT_SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

const server = new McpServer({
  name: 'SSH MCP Server',
  version: '1.0.9',
  capabilities: {
    resources: {},
    tools: {},
  },
});

server.tool(
  "add-host",
  "Persist a new SSH host configuration.",
  {
    host_id: z.string().describe("Unique identifier for the host. we recommend user@hostname"),
    host: z.string().describe("Hostname or IP address"),
    port: z.number().int().positive().default(22).describe("SSH port (default 22)"),
    username: z.string().describe("SSH username"),
    password: z.string().optional().describe("Password for authentication"),
    keyPath: z.string().optional().describe("Path to private key (defaults to SSH agent if omitted)"),
  },
  async ({ host_id, host, port, username, password, keyPath }) => {
    const hosts = await readHosts();
    if (hosts.some((h) => h.id === host_id)) {
      throw new McpError(ErrorCode.InvalidParams, `Host '${host_id}' already exists`);
    }
    hosts.push({
      id: host_id,
      host,
      port,
      username,
      password,
      keyPath,
    });
    await writeHosts(hosts);
    return { content: [{ type: 'text', text: `Host '${host_id}' added` }] };
  }
);

server.tool(
  "list-hosts",
  "List all stored SSH host configurations.",
  {},
  async () => {
    const hosts = await readHosts();
    if (hosts.length === 0) {
      return { content: [{ type: 'text', text: 'No hosts configured' }] };
    }
    const lines = hosts.map((host) =>
      `id=${host.id} host=${host.host}:${host.port} user=${host.username} auth=${host.password ? 'password' : host.keyPath ? 'key' : 'agent'}`
    );
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

server.tool(
  "remove-host",
  "Remove a stored SSH host configuration.",
  {
    host_id: z.string().describe("Identifier of the host to remove"),
  },
  async ({ host_id }) => {
    const hosts = await readHosts();
    const next = hosts.filter((host) => host.id !== host_id);
    if (next.length === hosts.length) {
      throw new McpError(ErrorCode.InvalidParams, `Host '${host_id}' does not exist`);
    }
    await writeHosts(next);
    return { content: [{ type: 'text', text: `Host '${host_id}' removed` }] };
  }
);

server.tool(
  "edit-host",
  "Edit fields of an existing host configuration.",
  {
    host_id: z.string().describe("Identifier of the host to edit"),
    host: z.string().optional(),
    port: z.number().int().positive().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    keyPath: z.string().optional(),
  },
  async ({ host_id, host, port, username, password, keyPath }) => {
    const hosts = await readHosts();
    const target = hosts.find((h) => h.id === host_id);
    if (!target) {
      throw new McpError(ErrorCode.InvalidParams, `Host '${host_id}' does not exist`);
    }
    if (host) target.host = host;
    if (port) target.port = port;
    if (username) target.username = username;
    if (password !== undefined) target.password = password;
    if (keyPath !== undefined) target.keyPath = keyPath;
    await writeHosts(hosts);
    return { content: [{ type: 'text', text: `Host '${host_id}' updated` }] };
  }
);

server.tool(
  "start-session",
  "Start a new SSH session for a stored host.",
  {
    host_id: z.string().describe("Identifier of the host to connect"),
    sessionId: z.string().optional().describe("Optional session identifier; generated if omitted"),
  },
  async ({ host_id, sessionId }) => {
    const hostConfig = await getHostConfig(host_id);
    const id = sessionId && sessionId.trim() ? sessionId.trim() : randomUUID();
    if (activeSessions.has(id)) {
      throw new McpError(ErrorCode.InvalidParams, `Session '${id}' already exists`);
    }
    await getOrCreateSession(id, hostConfig, true);
    return { content: [{ type: 'text', text: id }] };
  }
);

server.tool(
  "exec",
  "Execute a shell command on an existing SSH session.",
  {
    session_id: z.string().describe("Identifier of the session to use"),
    command: z.string().describe("Command to execute"),
  },
  async ({ session_id, command }) => {
    const sanitizedCommand = sanitizeCommand(command);
    const session = activeSessions.get(session_id);
    if (!session) {
      throw new McpError(ErrorCode.InvalidParams, `Session '${session_id}' does not exist`);
    }
    const { output, exitCode } = await session.execute(sanitizedCommand);
    if (exitCode !== 0) {
      throw new McpError(ErrorCode.InternalError, `Error (code ${exitCode}):\n${output}`);
    }
    return {
      content: [{ type: 'text', text: output }],
    };
  }
);

server.tool(
  "close-session",
  "Close an existing persistent SSH session.",
  {
    sessionId: z.string().describe("Identifier of the session to close"),
  },
  async ({ sessionId }) => {
    const session = activeSessions.get(sessionId);
    if (!session) {
      throw new McpError(ErrorCode.InvalidParams, `Session '${sessionId}' does not exist`);
    }
    session.dispose();
    activeSessions.delete(sessionId);
    return { content: [{ type: 'text', text: `Session '${sessionId}' closed` }] };
  }
);

server.tool(
  "list-sessions",
  "List all active SSH sessions with metadata.",
  {},
  async () => {
    if (activeSessions.size === 0) {
      return { content: [{ type: 'text', text: 'No active sessions' }] };
    }

    const lines: string[] = [];
    for (const [id, session] of activeSessions.entries()) {
      const info = session.getInfo();
      const uptimeMs = Date.now() - info.createdAt;
      const minutes = Math.floor(uptimeMs / 60000);
      const seconds = Math.floor((uptimeMs % 60000) / 1000);
      lines.push(
        `session=${id} host=${info.host}:${info.port} user=${info.username} uptime=${minutes}m${seconds}s lastCommand=${info.lastCommand ?? 'n/a'}`
      );
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  }
);

export async function execSshCommand(hostId: string, command: string, sessionId = 'legacy') {
  const config = await getHostConfig(hostId);
  const session = await getOrCreateSession(sessionId, config);
  const { output, exitCode } = await session.execute(command);
  if (exitCode !== 0) {
    throw new McpError(ErrorCode.InternalError, `Error (code ${exitCode}):\n${output}`);
  }
  return {
    content: [{ type: 'text', text: output }],
  };
}

async function getOrCreateSession(id: string, config: ConnectConfig, forceNew = false): Promise<PersistentSession> {
  let session = activeSessions.get(id);
  if (session && forceNew) {
    session.dispose();
    activeSessions.delete(id);
    session = undefined;
  }

  if (!session) {
    session = new PersistentSession(id, config, DEFAULT_SESSION_TTL_MS, (disposedId) => {
      if (activeSessions.get(disposedId) === session) {
        activeSessions.delete(disposedId);
      }
    });
    activeSessions.set(id, session);
  }

  await session.ensureConnected();
  return session;
}

class PersistentSession {
  private conn: InstanceType<typeof SSHClient> | null = null;
  private shell: ClientChannel | null = null;
  private buffer = '';
  private pendingCommand: {
    resolve: (result: { output: string; exitCode: number }) => void;
    reject: (error: Error) => void;
    marker: string;
  } | null = null;
  private inactivityTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private readonly createdAt = Date.now();
  private lastCommand: string | null = null;

  constructor(
    private readonly id: string,
    private readonly config: ConnectConfig,
    private readonly timeoutMs = DEFAULT_SESSION_TTL_MS,
    private readonly onDispose?: (id: string) => void,
  ) {}

  getInfo() {
    return {
      id: this.id,
      host: this.config.host ?? 'unknown',
      port: this.config.port ?? 22,
      username: this.config.username ?? 'unknown',
      createdAt: this.createdAt,
      lastCommand: this.lastCommand,
      disposed: this.disposed,
    };
  }

  async ensureConnected(): Promise<void> {
    if (this.disposed) {
      throw new McpError(ErrorCode.InternalError, `Session ${this.id} has been disposed`);
    }
    if (this.conn && this.shell) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const conn = new SSHClient();
      this.conn = conn;

      const handleError = (err: Error) => {
        this.cleanup(err);
        reject(err);
      };

      conn.once('ready', () => {
        conn.shell({ term: 'xterm', rows: 40, cols: 120 }, (err, stream) => {
          if (err) {
            handleError(err);
            return;
          }

          this.shell = stream;
          stream.setEncoding('utf8');
          stream.on('data', (data: string) => {
            this.buffer += data;
            this.processPending();
          });
          stream.on('close', () => {
            this.cleanup();
          });
          stream.stderr?.on('data', (data: string) => {
            this.buffer += data;
            this.processPending();
          });

          // Remove shell prompt noise
          stream.write('export PS1=""\n');
          stream.write('stty -echo 2>/dev/null\n');
          resolve();
        });
      });

      conn.once('error', handleError);
      conn.once('end', () => this.cleanup());
      conn.connect(this.config);
    });

    this.resetInactivityTimer();
  }

  async execute(command: string): Promise<{ output: string; exitCode: number }> {
    await this.ensureConnected();

    if (!this.shell) {
      throw new McpError(ErrorCode.InternalError, 'SSH shell not ready');
    }
    if (this.pendingCommand) {
      throw new McpError(ErrorCode.InternalError, 'Another command is still running in this session');
    }

    this.lastCommand = command;
    this.resetInactivityTimer();

    const token = randomUUID();
    const marker = `__MCP_DONE__${token}__`;

    return new Promise((resolve, reject) => {
      this.pendingCommand = {
        marker,
        resolve,
        reject,
      };

      const commandWithNewline = command.endsWith('\n') ? command : command + '\n';
      this.shell!.write(commandWithNewline, (err) => {
        if (err) {
          this.rejectPending(err);
          return;
        }
        this.shell!.write(`printf '${marker}%d\n' $?\n`, (printfErr) => {
          if (printfErr) {
            this.rejectPending(printfErr);
          }
        });
      });
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cleanup();
  }

  private resetInactivityTimer(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
    }

    this.inactivityTimer = setTimeout(() => {
      this.dispose();
    }, this.timeoutMs);
  }

  private processPending(): void {
    if (!this.pendingCommand) {
      return;
    }

    const { marker, resolve } = this.pendingCommand;
    const markerIndex = this.buffer.indexOf(marker);
    if (markerIndex === -1) {
      return;
    }

    const afterMarker = this.buffer.slice(markerIndex + marker.length);
    const newlineIndex = afterMarker.indexOf('\n');
    if (newlineIndex === -1) {
      return;
    }

    const exitCodeText = afterMarker.slice(0, newlineIndex).trim();
    const remaining = afterMarker.slice(newlineIndex + 1);

    const output = this.buffer.slice(0, markerIndex).replace(/\r/g, '');
    const exitCode = Number.parseInt(exitCodeText, 10);

    this.buffer = remaining;
    this.pendingCommand = null;

    const finalOutput = output.replace(/__MCP_READY__\s*/g, '').replace(/\s+$/, '');

    resolve({ output: finalOutput, exitCode: Number.isNaN(exitCode) ? 0 : exitCode });
    this.resetInactivityTimer();
  }

  private rejectPending(error: Error): void {
    if (!this.pendingCommand) {
      return;
    }
    this.pendingCommand.reject(error);
    this.pendingCommand = null;
  }

  private cleanup(error?: Error): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    if (this.shell) {
      this.shell.removeAllListeners();
      this.shell.end();
      this.shell = null;
    }

    if (this.conn) {
      this.conn.removeAllListeners();
      this.conn.end();
      this.conn = null;
    }

    if (this.pendingCommand) {
      this.pendingCommand.reject(error ?? new Error('SSH session closed'));
      this.pendingCommand = null;
    }

    this.buffer = '';

    if (this.disposed) {
      this.onDispose?.(this.id);
    }
  }
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SSH MCP Server running on stdio");
}

if (process.env.SSH_MCP_DISABLE_MAIN !== '1') {
  main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
  });
}

export {};