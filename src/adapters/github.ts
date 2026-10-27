import type { CodePort, Evidence } from '../core/contracts.ts';

interface TreeEntry { path: string; type: string; size?: number }
const allowedExtensions = /\.(?:ts|tsx|js|jsx|py|go|java|cs|rb|rs|php|md|json|yaml|yml|sql)$/i;
const excludedPaths = /(^|\/)(?:node_modules|dist|build|\.git|vendor|coverage)(\/|$)/i;
const stopWords = new Set(['the','and','for','how','does','this','that','what','why','with','where','our','are','from','can','you','please','show','tell','about','code','implemented']);

export class GitHubCode implements CodePort {
  readonly name = 'github';
  private readonly api = 'https://api.github.com';
  constructor(private readonly config: { token?: string; publicRepo?: boolean; owner: string; repo: string; ref: string },
              private readonly http: typeof fetch = fetch) {
    if ((!config.token && config.publicRepo !== true) || !/^[a-zA-Z0-9_-]+$/.test(config.owner) || !/^[\w.-]+$/.test(config.repo) || !/^[\w./-]+$/.test(config.ref)) {
      throw new Error('GitHub configuration invalid');
    }
  }
  private async get<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Nogita-V1',
    };
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
    const res = await this.http(`${this.api}${path}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`GitHub API failed: HTTP ${res.status}`);
    return await res.json() as T;
  }
  async findEvidence(query: string): Promise<Evidence[]> {
    const { owner, repo, ref } = this.config;
    const tree = await this.get<{ tree: TreeEntry[]; truncated?: boolean }>(
      `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    if (tree.truncated) throw new Error('GitHub tree truncated; index/search fallback required');
    const words = query.toLowerCase().match(/[a-z0-9_]{3,}/g)?.filter(w => !stopWords.has(w)) ?? [];
    const candidates = tree.tree.filter(e => e.type === 'blob' && allowedExtensions.test(e.path)
      && !excludedPaths.test(e.path) && (e.size ?? 0) <= 30000);
    const scored = candidates.map(e => ({...e, score: words.reduce((sum, w) => sum + (e.path.toLowerCase().includes(w) ? 1 : 0), 0) }));
    scored.sort((a,b) => b.score - a.score || a.path.localeCompare(b.path));
    if (!scored.length || !scored[0]!.score) return [];
    const results: Evidence[] = [];
    for (const file of scored.slice(0, 3)) {
      if (file.score === 0) continue;
      const resource = await this.get<{ content?: string; encoding?: string }>(
        `/repos/${owner}/${repo}/contents/${file.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
      if (resource.encoding !== 'base64' || !resource.content) continue;
      const text = Buffer.from(resource.content.replace(/\s+/g, ''), 'base64').toString('utf8');
      results.push({ path: file.path,
        url: `https://github.com/${owner}/${repo}/blob/${encodeURIComponent(ref)}/${file.path.split('/').map(encodeURIComponent).join('/')}`,
        excerpt: text.slice(0, 8000) });
    }
    return results;
  }
}
