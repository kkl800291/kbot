import { describe, expect, it } from 'vitest';
import { McpSessions } from '../src/services/mcp';
import type { CommandFn } from '../src/services/tools';

describe('mcp session client', () => {
  it('keeps secrets out of the command line and isolates a failed call', async () => {
    const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
    const run: CommandFn = async (name, args) => {
      calls.push({ name, args });
      if (name === 'mcp_call_tool' && args?.name === 'broken') throw new Error('工具服务「broken」已断开');
      if (name === 'mcp_start') return { name: args?.name, protocolVersion: '2025-11-25', serverName: 'fake', instructions: '', tools: [{ name: 'echo' }] };
      if (name === 'mcp_call_tool') return 'pong';
      return {};
    };
    const sessions = new McpSessions(run);
    await sessions.saveSecret('notes', 'API_TOKEN', 'secret-value');
    await sessions.start({ name: 'notes', command: '/usr/local/bin/notes-mcp', args: ['--stdio'], secret_envs: ['API_TOKEN'] });
    await expect(sessions.call('broken', 'echo', { text: 'x' })).rejects.toThrow(/已断开/);
    await expect(sessions.call('notes', 'echo', { text: 'ping' })).resolves.toBe('pong');
    expect(calls[0]).toMatchObject({ name: 'mcp_save_secret', args: { name: 'notes', env: 'API_TOKEN', value: 'secret-value' } });
    expect(JSON.stringify(calls[1].args)).not.toContain('secret-value');
    expect(calls[1].args).toMatchObject({ command: '/usr/local/bin/notes-mcp', args: ['--stdio'], secret_envs: ['API_TOKEN'] });
    expect(calls.at(-1)).toMatchObject({ name: 'mcp_call_tool', args: { name: 'notes', tool: 'echo', arguments: { text: 'ping' } } });
  });
});