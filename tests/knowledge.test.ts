import { describe, expect, it } from 'vitest';
import { formatKnowledgeContext, refreshKnowledge, removeKnowledge, searchKnowledge } from '../src/services/knowledge';
import type { CommandFn } from '../src/services/tools';

describe('knowledge client', () => {
  it('does not search or attach snippets when the switch is off', async () => {
    const run: CommandFn = async () => { throw new Error('不应该调用'); };
    const result = await searchKnowledge('段落', ['/Users/z/notes'], false, run);
    expect(result).toEqual({ snippets: [], missing: [], note: '' });
    expect(formatKnowledgeContext(result.snippets)).toBe('');
  });

  it('formats the path with the snippet and clears that folder index', async () => {
    const calls: string[] = [];
    const run: CommandFn = async (name, args) => {
      calls.push(name);
      if (name === 'knowledge_search') {
        return { snippets: [{ path: 'sub/a.md', text: '新段落', root: '/Users/z/notes' }], missing: [], note: '' };
      }
      return args;
    };
    const found = await searchKnowledge('段落', ['/Users/z/notes'], true, run);
    expect(formatKnowledgeContext(found.snippets)).toBe('【sub/a.md】\n新段落');
    await removeKnowledge('/Users/z/notes', run);
    const refreshed = await refreshKnowledge(['/Users/z/notes', '/missing'], async name => {
      if (name === 'knowledge_update') throw new Error('文件夹已被移走');
      return {};
    });
    expect(refreshed.errors).toHaveLength(2);
    expect(calls).toEqual(['knowledge_search', 'knowledge_remove']);
  });

  it('keeps going when one folder fails to index', async () => {
    const roots = ['/ok', '/bad'];
    const result = await refreshKnowledge(roots, async (_name, args) => {
      if (args?.root === '/bad') throw new Error('无法读取');
      return { indexed: 1 };
    });
    expect(result.ok).toEqual(['/ok']);
    expect(result.errors).toEqual(['无法读取']);
  });
});
