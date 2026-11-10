import { command as runtimeCommand } from './runtime';
import type { CommandFn } from './tools';

export interface KnowledgeSnippet {
  path: string;
  text: string;
  root: string;
}

export interface KnowledgeSearch {
  snippets: KnowledgeSnippet[];
  missing: string[];
  note: string;
}

export async function refreshKnowledge(roots: string[], run: CommandFn = runtimeCommand): Promise<{ ok: string[]; errors: string[] }> {
  const ok: string[] = [];
  const errors: string[] = [];
  for (const root of roots) {
    try {
      await run('knowledge_update', { root });
      ok.push(root);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { ok, errors };
}

export async function searchKnowledge(query: string, roots: string[], enabled: boolean, run: CommandFn = runtimeCommand): Promise<KnowledgeSearch> {
  if (!enabled) return { snippets: [], missing: [], note: '' };
  try {
    return await run('knowledge_search', { roots, query, limit: 4 });
  } catch {
    return { snippets: [], missing: [], note: '这次没查到本地文档。' };
  }
}

export function formatKnowledgeContext(snippets: KnowledgeSnippet[]): string {
  if (!snippets.length) return '';
  return snippets.map(snippet => `【${snippet.path}】\n${snippet.text}`).join('\n\n');
}

export async function removeKnowledge(root: string, run: CommandFn = runtimeCommand): Promise<void> {
  await run('knowledge_remove', { root });
}
