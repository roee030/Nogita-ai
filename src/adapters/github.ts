import type { CodePort, Evidence } from '../core/contracts.ts';

interface TreeEntry { path: string; type: string; sha: string; size?: number }
interface IndexedFile { path: string; text: string; lower: string }
interface RepositoryTree { sha: string; tree: TreeEntry[]; truncated?: boolean }
interface GitBlob { content?: string; encoding?: string }

const allowedExtensions = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|java|cs|rb|rs|php|md|json|yaml|yml|sql|sh|toml|xml|html|css|scss|vue|svelte|proto)$/i;
const excludedPaths = /(^|\/)(?:node_modules|dist|build|\.git|vendor|coverage|\.next|\.turbo|target|out|\.superpowers)(\/|$)|(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|[^/]+\.lock)$/i;
const excludedCredentialPaths = /(?:^|\/)(?:\.env(?:$|[._-][^/]*)|[^/]*(?:secret|credential|service[-_]?account|private[-_]?key|id_rsa)[^/]*|[^/]+\.(?:pem|key|p12|pfx|keystore))(?:\/|$)/i;
const excludedFiles = /(?:\.min\.(?:js|css)|\.map)$/i;
const stopWords = new Set(['a','an','and','are','as','at','be','but','by','can','code','do','does','for','from','how','i','in','is','it','of','on','or','our','please','repo','repository','show','tell','that','the','this','to','what','when','where','which','who','why','with','you']);
const MAX_FILES = 300;
const MAX_FILE_BYTES = 100 * 1024;
const MAX_INDEX_BYTES = 5 * 1024 * 1024;
const MAX_EVIDENCE = 4;
const MAX_EXCERPT_CHARS = 2400;
const FETCH_CONCURRENCY = 8;

function queryTerms(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_]{2,}/gu)?.filter(term => !stopWords.has(term)) ?? [])];
}

function countOccurrences(text: string, term: string): number {
  let count = 0;
  let offset = 0;
  while (count < 8) {
    const index = text.indexOf(term, offset);
    if (index < 0) break;
    count++;
    offset = index + term.length;
  }
  return count;
}

function excerptFor(text: string, terms: readonly string[]): string {
  const lines = text.split(/\r?\n/);
  const matching = new Set<number>();
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const lineLower = lines[lineIndex]!.toLocaleLowerCase();
    if (terms.some(term => lineLower.includes(term))) matching.add(lineIndex);
  }
  if (matching.size === 0) return text.slice(0, MAX_EXCERPT_CHARS);

  const ranges = [...new Set([...matching].map(line => `${Math.max(0, line - 2)}:${Math.min(lines.length - 1, line + 2)}`))]
    .map(range => range.split(':').map(Number) as [number, number]);
  const ranked = ranges.map(([start, end]) => {
    const window = lines.slice(start, end + 1).join('\n').toLocaleLowerCase();
    return { start, end, coverage: terms.filter(term => window.includes(term)).length };
  }).sort((a, b) => b.coverage - a.coverage || a.start - b.start).slice(0, 3)
    .sort((a, b) => a.start - b.start);
  const chunks: string[] = [];
  let length = 0;
  for (const { start, end } of ranked) {
    const chunk = lines.slice(start, end + 1).map((line, index) => `${start + index + 1}: ${line}`).join('\n');
    if (length + chunk.length > MAX_EXCERPT_CHARS) {
      const remaining = MAX_EXCERPT_CHARS - length;
      if (remaining > 0) chunks.push(chunk.slice(0, remaining));
      break;
    }
    chunks.push(chunk);
    length += chunk.length;
  }
  return chunks.join('\n…\n');
}

export class GitHubCode implements CodePort {
  readonly name = 'github';
  private readonly api = 'https://api.github.com';
  private indexedSha?: string;
  private indexedFiles?: IndexedFile[];
  private indexing?: { sha: string; promise: Promise<IndexedFile[]> };

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
    try { return await res.json() as T; }
    catch { throw new Error('GitHub API returned invalid JSON'); }
  }

  private async buildIndex(tree: RepositoryTree): Promise<IndexedFile[]> {
    const candidates = tree.tree.filter(entry => entry.type === 'blob' && allowedExtensions.test(entry.path)
      && !excludedPaths.test(entry.path) && !excludedCredentialPaths.test(entry.path) && !excludedFiles.test(entry.path)
      && Number.isSafeInteger(entry.size) && entry.size! >= 0 && entry.size! <= MAX_FILE_BYTES);
    if (candidates.length > MAX_FILES || candidates.reduce((total, entry) => total + entry.size!, 0) > MAX_INDEX_BYTES) {
      throw new Error('GitHub repository exceeds the bounded code-index limits');
    }
    if (candidates.some(entry => !/^[a-f0-9]{40,64}$/i.test(entry.sha))) {
      throw new Error('GitHub tree contains an invalid blob SHA');
    }

    const files: IndexedFile[] = [];
    let next = 0;
    const worker = async () => {
      while (next < candidates.length) {
        const entry = candidates[next++]!;
        const blob = await this.get<GitBlob>(`/repos/${this.config.owner}/${this.config.repo}/git/blobs/${encodeURIComponent(entry.sha)}`);
        if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
          throw new Error(`GitHub returned an unsupported blob payload for ${entry.path}`);
        }
        const encoded = blob.content.replace(/\s+/g, '');
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
          throw new Error(`GitHub returned an invalid blob encoding for ${entry.path}`);
        }
        const text = Buffer.from(encoded, 'base64').toString('utf8');
        if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
          throw new Error(`GitHub blob exceeded its declared size for ${entry.path}`);
        }
        files.push({ path: entry.path, text, lower: text.toLocaleLowerCase() });
      }
    };
    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, candidates.length) }, worker));
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  private async loadIndex(): Promise<IndexedFile[]> {
    const { owner, repo, ref } = this.config;
    const tree = await this.get<RepositoryTree>(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    if (tree.truncated) throw new Error('GitHub tree truncated; bounded full-repository index unavailable');
    if (!/^[a-f0-9]{40,64}$/i.test(tree.sha) || !Array.isArray(tree.tree)) {
      throw new Error('GitHub returned an invalid repository tree');
    }
    if (this.indexedSha === tree.sha && this.indexedFiles) return this.indexedFiles;
    if (this.indexing?.sha === tree.sha) return this.indexing.promise;

    const pending = { sha: tree.sha, promise: this.buildIndex(tree) };
    this.indexing = pending;
    try {
      const files = await pending.promise;
      if (this.indexing === pending) {
        this.indexedSha = tree.sha;
        this.indexedFiles = files;
        this.indexing = undefined;
      }
      return files;
    } catch (error) {
      if (this.indexing === pending) this.indexing = undefined;
      throw error;
    }
  }

  async prepare(): Promise<void> {
    await this.loadIndex();
  }

  async findEvidence(query: string): Promise<Evidence[]> {
    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    const files = await this.loadIndex();
    const phrase = query.toLocaleLowerCase().replace(/[^\p{L}\p{N}_]+/gu, ' ').trim();
    const scored = files.map(file => {
      const path = file.path.toLocaleLowerCase();
      let score = 0;
      let matchedTerms = 0;
      for (const term of terms) {
        const contentMatches = countOccurrences(file.lower, term);
        const pathMatches = countOccurrences(path, term);
        if (contentMatches || pathMatches) matchedTerms++;
        score += contentMatches ? 3 + Math.min(3, Math.log2(contentMatches)) : 0;
        score += pathMatches ? 5 : 0;
      }
      if (phrase.length >= 8 && file.lower.includes(phrase)) score += 6;
      score += matchedTerms / terms.length;
      return { file, score };
    }).filter(result => result.score > 0);
    scored.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));

    const { owner, repo, ref } = this.config;
    return scored.slice(0, MAX_EVIDENCE).map(({ file }) => ({
      path: file.path,
      url: `https://github.com/${owner}/${repo}/blob/${encodeURIComponent(ref)}/${file.path.split('/').map(encodeURIComponent).join('/')}`,
      excerpt: excerptFor(file.text, terms),
    }));
  }
}
