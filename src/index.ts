#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import SSH2Module from 'ssh2';
const { Client: SSHClient, utils: sshUtils } = SSH2Module as typeof import('ssh2');
import { z } from 'zod';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFile } from 'fs/promises';
import { resolve as resolvePath } from 'path';
import os from 'os';

// Example usage: node build/index.js --host=1.2.3.4 --port=22 --user=root --password=pass --key=path/to/key --timeout=5000
function parseArgv() {
  const args = process.argv.slice(2);
  const config: Record<string, string> = {};
  for (const arg of args) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) {
      config[match[1]] = match[2];
    }
  }
  return config;
}
const isCliEnabled = process.env.SSH_MCP_DISABLE_MAIN !== '1';
const argvConfig = isCliEnabled ? parseArgv() : {} as Record<string, string>;

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function expandPath(input: string): string {
  if (!input) return input;
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return resolvePath(os.homedir(), input.slice(2));
  if (input.startsWith('~')) return resolvePath(os.homedir(), input.slice(1));
  return resolvePath(input);
}

const HOST = argvConfig.host || process.env.SSH_MCP_HOST;
const PORT = parseInteger(argvConfig.port ?? process.env.SSH_MCP_PORT, 22);
const USER = argvConfig.user || process.env.SSH_MCP_USER;
const PASSWORD = argvConfig.password || process.env.SSH_MCP_PASSWORD;
const KEY = argvConfig.key || process.env.SSH_MCP_KEY;
const KEY_PASSPHRASE = argvConfig.keyPassphrase || argvConfig.passphrase || process.env.SSH_MCP_KEY_PASSPHRASE;
const DEFAULT_TIMEOUT = parseInteger(argvConfig.timeout ?? process.env.SSH_MCP_TIMEOUT, 60000); // 60 seconds default timeout

function ensureSshConfig() {
  if (!HOST) {
    throw new McpError(ErrorCode.InvalidParams, 'SSH host must be provided via --host or SSH_MCP_HOST');
  }
  if (!USER) {
    throw new McpError(ErrorCode.InvalidParams, 'SSH username must be provided via --user or SSH_MCP_USER');
  }
  if (Number.isNaN(PORT) || PORT <= 0 || PORT > 65535) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid SSH port: ${PORT}`);
  }
  if (Number.isNaN(DEFAULT_TIMEOUT) || DEFAULT_TIMEOUT <= 0) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid timeout: ${DEFAULT_TIMEOUT}`);
  }
}

if (isCliEnabled) {
  ensureSshConfig();
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
  if (trimmedCommand.length > 1000) {
    throw new McpError(ErrorCode.InvalidParams, 'Command is too long (max 1000 characters)');
  }
  
  return trimmedCommand;
}

// Escape command for use in shell contexts (like pkill)
export function escapeCommandForShell(command: string): string {
  // Replace single quotes with escaped single quotes
  return command.replace(/'/g, "'\"'\"'");
}

const server = new McpServer({
  name: 'SSH MCP Server',
  version: '1.0.9',
  capabilities: {
    resources: {},
    tools: {},
  },
});

server.tool(
  "exec",
  "Execute a shell command on the remote SSH server and return the output.",
  {
    command: z.string().describe("Shell command to execute on the remote SSH server"),
  },
  async ({ command }) => {
    // Sanitize command input
    const sanitizedCommand = sanitizeCommand(command);

    ensureSshConfig();

    const sshConfig: any = {
      host: HOST,
      port: PORT,
      username: USER,
    };
    try {
      if (PASSWORD) {
        sshConfig.password = PASSWORD;
      } else {
        const keyPath = KEY ? expandPath(KEY) : resolvePath(os.homedir(), '.ssh', 'id_rsa');
        try {
          const keyContent = await readFile(keyPath, 'utf8');
          try {
            const parsedResult = sshUtils.parseKey(keyContent, KEY_PASSPHRASE);
            const parsedKeys = Array.isArray(parsedResult) ? parsedResult : [parsedResult];
            const parseError = parsedKeys.find((entry: any) => entry instanceof Error);
            if (parseError) {
              if (!KEY_PASSPHRASE && parseError instanceof Error && /Encrypted/i.test(parseError.message ?? '')) {
                throw new McpError(
                  ErrorCode.InvalidParams,
                  `SSH private key at ${keyPath} is encrypted; provide a passphrase via --keyPassphrase or SSH_MCP_KEY_PASSPHRASE`,
                );
              }
              throw new McpError(
                ErrorCode.InvalidParams,
                `Failed to parse SSH private key at ${keyPath}: ${parseError instanceof Error ? parseError.message : parseError}`,
              );
            }

            const encryptedWithoutPassphrase = parsedKeys.some((entry) => (entry as any)?.encrypted);
            if (encryptedWithoutPassphrase && !KEY_PASSPHRASE) {
              throw new McpError(
                ErrorCode.InvalidParams,
                `SSH private key at ${keyPath} is encrypted; provide a passphrase via --keyPassphrase or SSH_MCP_KEY_PASSPHRASE`,
              );
            }

            if (parsedKeys.length > 1) {
              throw new McpError(
                ErrorCode.InvalidParams,
                `SSH private key at ${keyPath} contains multiple key entries; provide a single key`);
            }

            const [parsedKey] = parsedKeys;
            const privatePem = parsedKey.getPrivatePEM(KEY_PASSPHRASE);
            sshConfig.privateKey = Buffer.isBuffer(privatePem) ? privatePem.toString('utf8') : privatePem;
          } catch (parseThrow: any) {
            if (!KEY_PASSPHRASE && parseThrow instanceof Error && /Encrypted/i.test(parseThrow.message ?? '')) {
              throw new McpError(
                ErrorCode.InvalidParams,
                `SSH private key at ${keyPath} is encrypted; provide a passphrase via --keyPassphrase or SSH_MCP_KEY_PASSPHRASE`,
              );
            }
            if (parseThrow instanceof McpError) {
              throw parseThrow;
            }
            throw new McpError(
              ErrorCode.InvalidParams,
              `Failed to parse SSH private key at ${keyPath}: ${parseThrow?.message || parseThrow}`,
            );
          }

          if (KEY_PASSPHRASE) {
            sshConfig.passphrase = KEY_PASSPHRASE;
          }
        } catch (readError: any) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Failed to read SSH private key from ${keyPath}: ${readError?.message || readError}`,
          );
        }
      }
      const result = await execSshCommand(sshConfig, sanitizedCommand);
      return result;
    } catch (err: any) {
      // Wrap unexpected errors
      if (err instanceof McpError) throw err;
      throw new McpError(ErrorCode.InternalError, `Unexpected error: ${err?.message || err}`);
    }
  }
);

export async function execSshCommand(sshConfig: any, command: string): Promise<{ [x: string]: unknown; content: ({ [x: string]: unknown; type: "text"; text: string; } | { [x: string]: unknown; type: "image"; data: string; mimeType: string; } | { [x: string]: unknown; type: "audio"; data: string; mimeType: string; } | { [x: string]: unknown; type: "resource"; resource: any; })[] }> {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    let timeoutId: NodeJS.Timeout;
    let isResolved = false;
    
    // Set up timeout
    timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        // Try to abort the running command before closing connection
        const abortTimeout = setTimeout(() => {
          // If abort command itself times out, force close connection
          conn.end();
        }, 5000); // 5 second timeout for abort command
        
        conn.exec('timeout 3s pkill -f \'' + escapeCommandForShell(command) + '\' 2>/dev/null || true', (err, abortStream) => {
          if (abortStream) {
            abortStream.on('close', () => {
              clearTimeout(abortTimeout);
              conn.end();
            });
          } else {
            clearTimeout(abortTimeout);
            conn.end();
          }
        });
        reject(new McpError(ErrorCode.InternalError, `Command execution timed out after ${DEFAULT_TIMEOUT}ms`));
      }
    }, DEFAULT_TIMEOUT);
    
    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);
            reject(new McpError(ErrorCode.InternalError, `SSH exec error: ${err.message}`));
          }
          conn.end();
          return;
        }
        let stdout = '';
        let stderr = '';
        stream.on('close', (code: number, signal: string) => {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);
            conn.end();
            if (stderr) {
              reject(new McpError(ErrorCode.InternalError, `Error (code ${code}):\n${stderr}`));
            } else {
              resolve({
                content: [{
                  type: 'text',
                  text: stdout,
                }],
              });
            }
          }
        });
        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
      });
    });
    conn.on('error', (err) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutId);
        reject(new McpError(ErrorCode.InternalError, `SSH connection error: ${err.message}`));
      }
    });
    conn.connect(sshConfig);
  });
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

export { parseArgv, ensureSshConfig };