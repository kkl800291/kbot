import { command as runtimeCommand } from './runtime';
import type { CommandFn } from './tools';

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpStarted {
  name: string;
  protocolVersion: string;
  serverName: string;
  instructions: string;
  tools: McpToolInfo[];
}

export class McpSessions {
  constructor(private run: CommandFn = runtimeCommand) {}

  start(input: { name: string; command: string; args?: string[]; env?: Record<string, string>; secret_envs?: string[] }): Promise<McpStarted> {
    return this.run('mcp_start', {
      name: input.name,
      command: input.command,
      args: input.args ?? [],
      env: input.env ?? {},
      secret_envs: input.secret_envs ?? [],
    });
  }

  listTools(name: string): Promise<McpToolInfo[]> {
    return this.run('mcp_list_tools', { name });
  }

  call(name: string, tool: string, arguments_: Record<string, unknown>): Promise<string> {
    return this.run('mcp_call_tool', { name, tool, arguments: arguments_ });
  }

  stop(name: string): Promise<void> {
    return this.run('mcp_stop', { name });
  }

  saveSecret(name: string, env: string, value: string): Promise<void> {
    return this.run('mcp_save_secret', { name, env, value });
  }

  deleteSecrets(name: string): Promise<void> {
    return this.run('mcp_delete_secrets', { name });
  }
}
