import { CodeLookupRateLimitError, type CiRun, type CiStatus, type CodeChange, type CodeFile, type CodePort, type Evidence,
  type RepoActivity } from '../core/contracts.ts';
import { gunzipSync } from 'node:zlib';
import { readToken, type TokenSource } from './token-source.ts';

interface TreeEntry { path: string; type: string; sha: string; size?: number }
interface IndexedFile { path: string; text: string; lower: string }
interface IndexBuild { files: IndexedFile[]; skippedLargeFiles: number }
interface RepositoryTree { sha: string; tree: TreeEntry[]; truncated?: boolean }
interface GitBlob { content?: string; encoding?: string }

const allowedExtensions = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|java|cs|rb|rs|php|md|json|yaml|yml|sql|sh|toml|xml|html|css|scss|vue|svelte|proto)$/i;
const allowedNames = new Set(['dockerfile', 'makefile', 'procfile', '.gitignore', '.dockerignore', '.editorconfig',
  '.node-version', 'license', 'copying', 'notice']);
const excludedPaths = /(^|\/)(?:node_modules|dist|build|\.git|vendor|coverage|\.next|\.turbo|target|out|\.superpowers)(\/|$)|(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|[^/]+\.lock)$/i;
const excludedCredentialPaths = /(?:^|\/)(?:\.env(?:$|[._-][^/]*)|[^/]*(?:secret|credential|service[-_]?account|private[-_]?key|id_rsa)[^/]*|[^/]+\.(?:pem|key|p12|pfx|keystore))(?:\/|$)/i;
const excludedFiles = /(?:\.min\.(?:js|css)|\.map)$/i;
const stopWords = new Set(['a','an','and','are','as','at','be','but','by','can','code','do','does','for','from','how','i','in','is','it','of','on','or','our','please','repo','repository','show','tell','that','the','this','to','what','when','where','which','who','why','with','you']);
const searchAliases: Record<string, readonly string[]> = {
  configuration: ['config'], environment: ['env'], providers: ['provider'],
  processing: ['process'], repeated: ['repeat'], conversations: ['conversation'],
};
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_EVIDENCE = 4;
const MAX_EXCERPT_CHARS = 2400;
const FETCH_CONCURRENCY = 8;
const DEFAULT_INDEX_TTL_MS = 30_000;
const MAX_TREE_NODES = 10_000;
const MAX_TREE_ENTRIES = 100_000;
const MAX_INDEX_FILES = 10_000;
const MAX_INDEX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_COMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_UNPACKED_BYTES = 64 * 1024 * 1024;
const MAX_GIT_ADVERTISEMENT_BYTES = 1024 * 1024;
const MAX_GITHUB_JSON_BYTES = 16 * 1024 * 1024;
const MAX_READ_LINES = 400;
const MAX_READ_CHARS = 24_000;
const MAX_LISTED_PATHS = 500;

interface GitHubCommit {
  sha?: string;
  commit?: { message?: string; author?: { name?: string; date?: string }; tree?: { sha?: string } };
  author?: { login?: string } | null;
  parents?: Array<{ sha?: string }>;
  stats?: { additions?: number; deletions?: number };
  files?: GitHubFile[];
}
interface GitHubFile { filename?: string; status?: string; additions?: number; deletions?: number; patch?: string }
interface GitHubPull {
  number?: number; title?: string; body?: string | null; state?: string; user?: { login?: string } | null;
  merged_at?: string | null; updated_at?: string; created_at?: string; additions?: number; deletions?: number;
  head?: { ref?: string; sha?: string };
}
interface GitHubRun {
  id?: number; name?: string; status?: string; conclusion?: string | null; head_sha?: string; head_branch?: string | null;
  event?: string; html_url?: string; run_started_at?: string;
}
interface GitHubJob { name?: string; conclusion?: string | null; html_url?: string; steps?: Array<{ name?: string; conclusion?: string | null }> }
interface GitHubDeployment { id?: number; sha?: string; environment?: string; created_at?: string }
interface GitHubDeploymentStatus { state?: string; environment_url?: string; target_url?: string }

const MAX_CI_RUNS = 10;
/** Jobs are read for this many of the newest failed runs: one call each. */
const MAX_FAILED_RUNS_DETAILED = 3;
/** Deployments whose state is read while looking for the newest successful one: one call each. */
const MAX_DEPLOYMENTS_CHECKED = 5;
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);
const MAX_ACTIVITY_PAGES = 3;
const MAX_TOP_FILES = 15;
const MAX_BODY_CHARS = 600;
const MAX_CHANGE_FILES = 100;
const MAX_FILE_PATCH_CHARS = 3_000;
const MAX_CHANGE_PATCH_CHARS = 12_000;
interface IndexedRevision { files: IndexedFile[]; commitSha: string }

function isSupportedTextFile(path: string): boolean {
  return allowedExtensions.test(path) || allowedNames.has(path.split('/').at(-1)?.toLocaleLowerCase() ?? '');
}

function isRateLimited(response: Response): boolean {
  return response.status === 429 ||
    (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
}

function isHistoryQuestion(query: string): boolean {
  const change = /\b(?:push(?:ed|es)?|commit(?:s|ted)?|merge(?:d|s)?|pull request|pr|changes?|changed)\b/i.test(query);
  const recent = /\b(?:last|latest|recent|most recent|what changed|what did we)\b/i.test(query);
  return change && recent;
}

function requestedRef(query: string, fallback: string): string {
  const match = query.match(/\bbranch\s+([a-z0-9._/-]{1,100})/i)
    ?? query.match(/\b(?:to|on|into)\s+(?:the\s+)?(main|master|develop|dev|[a-z0-9._-]+\/[a-z0-9._/-]+)\b/i);
  return match?.[1]?.replace(/[.,;:!?]+$/, '') || fallback;
}

function queryTerms(query: string): string[] {
  const words = query.toLocaleLowerCase().match(/[\p{L}\p{N}_]{2,}/gu)?.filter(term => !stopWords.has(term)) ?? [];
  return [...new Set(words.flatMap(word => [word, ...(searchAliases[word] ?? [])]))];
}

function redactSource(text: string): string {
  const withoutPrivateKeys = text.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    '[REDACTED]');
  return withoutPrivateKeys.split(/\r?\n/).map(line => {
    const assignment = line.match(/^(.*?\b[\w-]*(?:token|secret|password|credential|api[_-]?key|private[_-]?key|client[_-]?key)[\w-]*\b["']?\s*[:=])/i);
    if (assignment) return `${assignment[1]} [REDACTED]`;
    return line.replace(/(["'`])([\w/+.-]{24,})\1/g, '$1[REDACTED]$1')
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g,
      '[REDACTED]')
      .replace(/\bBearer\s+[A-Za-z0-9._~-]{20,}\b/gi, 'Bearer [REDACTED]');
  }).join('\n');
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

function tarString(bytes: Buffer): string {
  return bytes.toString('utf8').split('\0', 1)[0] ?? '';
}

function paxPath(bytes: Buffer): string | undefined {
  let offset = 0;
  let path: string | undefined;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0) throw new Error('GitHub archive contains an invalid PAX header');
    const length = Number(bytes.toString('ascii', offset, space));
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > bytes.length) {
      throw new Error('GitHub archive contains an invalid PAX record');
    }
    const record = bytes.toString('utf8', space + 1, offset + length - 1);
    if (record.startsWith('path=')) path = record.slice(5);
    offset += length;
  }
  return path;
}

function indexTarArchive(compressed: Buffer): IndexBuild {
  let archive: Buffer;
  try { archive = gunzipSync(compressed, { maxOutputLength: MAX_ARCHIVE_UNPACKED_BYTES }); }
  catch { throw new Error('GitHub returned an invalid or oversized archive'); }
  const files: IndexedFile[] = [];
  let skippedLargeFiles = 0;
  let offset = 0;
  let entries = 0;
  let extendedPath: string | undefined;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) return {
      files: files.sort((a, b) => a.path.localeCompare(b.path)), skippedLargeFiles,
    };
    if (++entries > MAX_TREE_NODES) throw new Error('GitHub archive has too many entries');
    const sizeText = tarString(header.subarray(124, 136)).trim();
    const size = Number.parseInt(sizeText, 8);
    if (!/^[0-7]+$/.test(sizeText) || !Number.isSafeInteger(size) || size < 0) {
      throw new Error('GitHub archive contains an invalid file size');
    }
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (next > archive.length) throw new Error('GitHub archive contains an incomplete entry');
    const data = archive.subarray(offset + 512, offset + 512 + size);
    const type = tarString(header.subarray(156, 157));
    if (type === 'x') extendedPath = paxPath(data);
    else if (type === '' || type === '0') {
      const prefix = tarString(header.subarray(345, 500));
      const name = tarString(header.subarray(0, 100));
      const archivePath = extendedPath ?? (prefix ? `${prefix}/${name}` : name);
      extendedPath = undefined;
      const segments = archivePath.split('/');
      if (segments.length < 2 || segments.some(segment => segment === '..' || segment === '.') ||
          archivePath.includes('\\') || archivePath.startsWith('/')) {
        throw new Error('GitHub archive contains an invalid source path');
      }
      const path = segments.slice(1).join('/');
      if (isSupportedTextFile(path) && !excludedPaths.test(path) && !excludedCredentialPaths.test(path) &&
          !excludedFiles.test(path)) {
        if (size <= MAX_FILE_BYTES) {
          const text = redactSource(data.toString('utf8'));
          files.push({ path, text, lower: text.toLocaleLowerCase() });
        } else skippedLargeFiles++;
      }
    } else extendedPath = undefined;
    offset = next;
  }
  throw new Error('GitHub archive is missing its end marker');
}

/** Files of a change with patches inside a fixed budget; credential-looking files never show their patch. */
function changedFiles(files: readonly GitHubFile[], more: boolean): Pick<CodeChange, 'files' | 'truncated'> {
  let budget = MAX_CHANGE_PATCH_CHARS;
  let truncated = more || files.length > MAX_CHANGE_FILES;
  const listed = files.filter(file => file.filename).slice(0, MAX_CHANGE_FILES).map(file => {
    const path = file.filename!;
    const entry: CodeChange['files'][number] = { path, status: file.status ?? 'modified',
      additions: file.additions ?? 0, deletions: file.deletions ?? 0 };
    if (!file.patch || excludedCredentialPaths.test(path)) return entry;
    let patch = redactSource(file.patch);
    if (patch.length > MAX_FILE_PATCH_CHARS) { patch = `${patch.slice(0, MAX_FILE_PATCH_CHARS)}\n... (patch cut)`; truncated = true; }
    if (patch.length > budget) { truncated = true; return entry; }
    budget -= patch.length;
    return { ...entry, patch };
  });
  return { files: listed, truncated };
}

export class GitHubCode implements CodePort {
  readonly name = 'github';
  private readonly api = 'https://api.github.com';
  private indexedSha?: string;
  private indexedBuild?: IndexBuild;
  private indexedCommitSha?: string;
  private indexExpiresAt = 0;
  private indexing?: { sha: string; promise: Promise<IndexBuild> };
  private readonly indexTtlMs: number;
  private readonly now: () => number;

  constructor(private readonly config: { token?: TokenSource; publicRepo?: boolean; owner: string; repo: string; ref: string },
              private readonly http: typeof fetch = fetch,
              options: { indexTtlMs?: number; now?: () => number } = {}) {
    if ((!config.token && config.publicRepo !== true) || !/^[a-zA-Z0-9_-]+$/.test(config.owner) || !/^[\w.-]+$/.test(config.repo) || !/^[\w./-]+$/.test(config.ref)) {
      throw new Error('GitHub configuration invalid');
    }
    this.indexTtlMs = options.indexTtlMs ?? (config.token ? DEFAULT_INDEX_TTL_MS : 5 * 60_000);
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.indexTtlMs) || this.indexTtlMs < 0) throw new Error('invalid GitHub index TTL');
  }

  private async get<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Nogita-V1',
    };
    if (this.config.token) headers.Authorization = `Bearer ${await readToken(this.config.token)}`;
    const res = await this.http(`${this.api}${path}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      if (isRateLimited(res)) {
        throw new CodeLookupRateLimitError();
      }
      throw new Error(`GitHub API failed: HTTP ${res.status}`);
    }
    if (!res.body) throw new Error('GitHub API returned invalid JSON');
    const declaredSize = Number(res.headers.get('content-length'));
    if (declaredSize > MAX_GITHUB_JSON_BYTES) throw new Error('GitHub API response size limit exceeded');
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_GITHUB_JSON_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new Error('GitHub API response size limit exceeded');
      }
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as T; }
    catch { throw new Error('GitHub API returned invalid JSON'); }
  }

  private async buildIndex(tree: RepositoryTree): Promise<IndexBuild> {
    const supported = tree.tree.filter(entry => entry.type === 'blob' && isSupportedTextFile(entry.path)
      && !excludedPaths.test(entry.path) && !excludedCredentialPaths.test(entry.path) && !excludedFiles.test(entry.path)
    );
    if (supported.some(entry => !Number.isSafeInteger(entry.size) || entry.size! < 0)) {
      throw new Error('GitHub repository contains an invalid source file size');
    }
    const candidates = supported.filter(entry => entry.size! <= MAX_FILE_BYTES);
    const skippedLargeFiles = supported.length - candidates.length;
    if (candidates.length > MAX_INDEX_FILES ||
        candidates.reduce((bytes, entry) => bytes + entry.size!, 0) > MAX_INDEX_SOURCE_BYTES) {
      throw new Error('GitHub repository index size limit exceeded');
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
        const decoded = Buffer.from(encoded, 'base64');
        if (decoded.length > MAX_FILE_BYTES) {
          throw new Error(`GitHub blob exceeded its declared size for ${entry.path}`);
        }
        const text = redactSource(decoded.toString('utf8'));
        files.push({ path: entry.path, text, lower: text.toLocaleLowerCase() });
      }
    };
    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, candidates.length) }, worker));
    return { files: files.sort((a, b) => a.path.localeCompare(b.path)), skippedLargeFiles };
  }

  private async buildPublicArchiveIndex(commitSha: string): Promise<IndexBuild> {
    const { owner, repo } = this.config;
    const response = await this.http(`https://codeload.github.com/${owner}/${repo}/tar.gz/${commitSha}`, {
      redirect: 'manual', signal: AbortSignal.timeout(20_000),
    });
    if (isRateLimited(response)) throw new CodeLookupRateLimitError();
    if (response.status >= 300 && response.status < 400) throw new Error('GitHub archive redirect is not trusted');
    if (!response.ok || !response.body) throw new Error(`GitHub archive failed: HTTP ${response.status}`);
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_ARCHIVE_COMPRESSED_BYTES) throw new Error('GitHub archive exceeds compressed size limit');
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    return indexTarArchive(Buffer.concat(chunks, total));
  }

  private async resolvePublicRef(): Promise<string> {
    const { owner, repo, ref } = this.config;
    if (/^[a-f0-9]{40}$/i.test(ref)) return ref;
    const response = await this.http(`https://github.com/${owner}/${repo}.git/info/refs?service=git-upload-pack`, {
      headers: { 'User-Agent': 'Nogita-V1' }, redirect: 'manual', signal: AbortSignal.timeout(10_000),
    });
    if (isRateLimited(response)) throw new CodeLookupRateLimitError();
    if (!response.ok || !response.body ||
        response.headers.get('content-type')?.split(';', 1)[0] !== 'application/x-git-upload-pack-advertisement') {
      throw new Error(`GitHub Git reference discovery failed: HTTP ${response.status}`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_GIT_ADVERTISEMENT_BYTES) throw new Error('GitHub Git reference list exceeds size limit');
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    const advertisement = Buffer.concat(chunks, total);
    const refs = new Map<string, string>();
    let offset = 0;
    while (offset < advertisement.length) {
      if (offset + 4 > advertisement.length) throw new Error('GitHub Git reference list is malformed');
      const lengthText = advertisement.toString('ascii', offset, offset + 4);
      if (!/^[a-f0-9]{4}$/i.test(lengthText)) throw new Error('GitHub Git reference list is malformed');
      const length = Number.parseInt(lengthText, 16);
      if (length === 0 || length === 1 || length === 2) { offset += 4; continue; }
      if (length < 4 || offset + length > advertisement.length) throw new Error('GitHub Git reference list is malformed');
      const line = advertisement.toString('utf8', offset + 4, offset + length);
      const match = line.match(/^([a-f0-9]{40}) (refs\/(?:heads|tags)\/[^\0\n]+)(?:\0[^\n]*)?\n?$/i);
      if (match) refs.set(match[2]!, match[1]!);
      offset += length;
    }
    const resolved = refs.get(`refs/heads/${ref}`) ?? refs.get(`refs/tags/${ref}^{}`) ??
      refs.get(`refs/tags/${ref}`);
    if (!resolved) throw new Error('GitHub public ref not found');
    return resolved;
  }

  private async loadPublicIndex(): Promise<IndexedRevision> {
    const commitSha = await this.resolvePublicRef();
    if (this.indexedSha === commitSha && this.indexedBuild) {
      this.indexedCommitSha = commitSha;
      this.indexExpiresAt = this.now() + this.indexTtlMs;
      return { files: this.indexedBuild.files, commitSha };
    }
    if (this.indexing?.sha === commitSha) return { files: (await this.indexing.promise).files, commitSha };
    const pending = { sha: commitSha, promise: this.buildPublicArchiveIndex(commitSha) };
    this.indexing = pending;
    try {
      const build = await pending.promise;
      if (this.indexing === pending) {
        this.indexedSha = commitSha;
        this.indexedBuild = build;
        this.indexedCommitSha = commitSha;
        this.indexExpiresAt = this.now() + this.indexTtlMs;
        this.indexing = undefined;
      }
      return { files: build.files, commitSha };
    } catch (error) {
      if (this.indexing === pending) this.indexing = undefined;
      throw error;
    }
  }

  private async expandTree(rootSha: string): Promise<RepositoryTree> {
    const { owner, repo } = this.config;
    const pending: Array<{ sha: string; prefix: string }> = [{ sha: rootSha, prefix: '' }];
    const entries: TreeEntry[] = [];
    let visited = 0;
    let totalEntries = 0;
    while (pending.length) {
      if (++visited > MAX_TREE_NODES) throw new Error('GitHub repository tree exceeds traversal limit');
      const current = pending.pop()!;
      const tree = await this.get<RepositoryTree>(`/repos/${owner}/${repo}/git/trees/${current.sha}`);
      if (tree.sha !== current.sha || tree.truncated || !Array.isArray(tree.tree)) {
        throw new Error('GitHub returned an incomplete subtree');
      }
      totalEntries += tree.tree.length;
      if (totalEntries > MAX_TREE_ENTRIES) {
        throw new Error('GitHub repository tree entry limit exceeded');
      }
      for (const entry of tree.tree) {
        if (!entry || !entry.path || entry.path === '.' || entry.path === '..' || /[\\/]/.test(entry.path) ||
            !/^[a-f0-9]{40,64}$/i.test(entry.sha)) throw new Error('GitHub returned an invalid tree entry');
        const path = `${current.prefix}${entry.path}`;
        if (entry.type === 'tree') pending.push({ sha: entry.sha, prefix: `${path}/` });
        else if (entry.type === 'blob') entries.push({ ...entry, path });
      }
    }
    return { sha: rootSha, tree: entries, truncated: false };
  }

  private async loadIndex(): Promise<IndexedRevision> {
    if (this.indexedBuild && this.indexedCommitSha && this.now() < this.indexExpiresAt) {
      return { files: this.indexedBuild.files, commitSha: this.indexedCommitSha };
    }
    if (!this.config.token && this.config.publicRepo === true) return this.loadPublicIndex();
    const { owner, repo, ref } = this.config;
    let tree = await this.get<RepositoryTree>(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    if (!/^[a-f0-9]{40,64}$/i.test(tree.sha) || !Array.isArray(tree.tree)) {
      throw new Error('GitHub returned an invalid repository tree');
    }
    if (tree.tree.length > MAX_TREE_ENTRIES) throw new Error('GitHub repository tree entry limit exceeded');
    const commit = await this.get<GitHubCommit>(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`);
    const commitSha = commit.sha;
    const commitTreeSha = commit.commit?.tree?.sha;
    if (!commitSha || !/^[a-f0-9]{40}$/i.test(commitSha) || !commitTreeSha ||
        !/^[a-f0-9]{40,64}$/i.test(commitTreeSha)) {
      throw new Error('GitHub returned an invalid commit revision');
    }
    if (commitTreeSha !== tree.sha) {
      tree = await this.get<RepositoryTree>(`/repos/${owner}/${repo}/git/trees/${commitTreeSha}?recursive=1`);
      if (tree.sha !== commitTreeSha || !Array.isArray(tree.tree)) {
        throw new Error('GitHub returned an incomplete pinned repository tree');
      }
    }
    if (tree.truncated) tree = await this.expandTree(tree.sha);
    if (this.indexedSha === tree.sha && this.indexedBuild) {
      this.indexedCommitSha = commitSha;
      this.indexExpiresAt = this.now() + this.indexTtlMs;
      return { files: this.indexedBuild.files, commitSha };
    }
    if (this.indexing?.sha === tree.sha) {
      return { files: (await this.indexing.promise).files, commitSha };
    }

    const pending = { sha: tree.sha, promise: this.buildIndex(tree) };
    this.indexing = pending;
    try {
      const build = await pending.promise;
      if (this.indexing === pending) {
        this.indexedSha = tree.sha;
        this.indexedBuild = build;
        this.indexedCommitSha = commitSha;
        this.indexExpiresAt = this.now() + this.indexTtlMs;
        this.indexing = undefined;
      }
      return { files: build.files, commitSha };
    } catch (error) {
      if (this.indexing === pending) this.indexing = undefined;
      throw error;
    }
  }

  async prepare(): Promise<void> {
    await this.loadIndex();
  }

  getCoverage(): { indexedFiles: number; skippedLargeFiles: number } | undefined {
    return this.indexedBuild && { indexedFiles: this.indexedBuild.files.length,
      skippedLargeFiles: this.indexedBuild.skippedLargeFiles };
  }

  private fileUrl(path: string, commitSha: string, startLine?: number, endLine?: number): string {
    const { owner, repo } = this.config;
    const anchor = startLine ? `#L${startLine}${endLine && endLine !== startLine ? `-L${endLine}` : ''}` : '';
    return `https://github.com/${owner}/${repo}/blob/${commitSha}/${path.split('/').map(encodeURIComponent).join('/')}${anchor}`;
  }

  /** Reads an indexed (already filtered and redacted) file; resolves a unique case-insensitive or suffix match. */
  async readFile(path: string, startLine?: number, endLine?: number): Promise<CodeFile | undefined> {
    const { files, commitSha } = await this.loadIndex();
    const wanted = path.trim().replace(/^\.?\/+/, '').toLocaleLowerCase();
    if (!wanted) return undefined;
    let file = files.find(item => item.path.toLocaleLowerCase() === wanted);
    if (!file) {
      const suffix = files.filter(item => item.path.toLocaleLowerCase().endsWith(`/${wanted}`));
      if (suffix.length === 1) file = suffix[0];
    }
    if (!file) return undefined;
    const lines = file.text.split('\n');
    const first = Math.min(Math.max(1, startLine ?? 1), lines.length);
    let last = Math.min(lines.length, Math.max(first, endLine ?? first + MAX_READ_LINES - 1), first + MAX_READ_LINES - 1);
    let body = '';
    for (let line = first; line <= last; line++) {
      const next = `${line}: ${lines[line - 1]}\n`;
      if (body.length + next.length > MAX_READ_CHARS) { last = line - 1; break; }
      body += next;
    }
    return { path: file.path, url: this.fileUrl(file.path, commitSha, first, last), text: body.trimEnd(),
      startLine: first, endLine: Math.max(first, last), totalLines: lines.length };
  }

  async listFiles(prefix?: string): Promise<string[]> {
    const { files } = await this.loadIndex();
    const wanted = prefix?.trim().replace(/^\.?\/+/, '').toLocaleLowerCase();
    const paths = files.map(file => file.path)
      .filter(path => !wanted || path.toLocaleLowerCase().startsWith(wanted)).sort();
    return paths.length > MAX_LISTED_PATHS
      ? [...paths.slice(0, MAX_LISTED_PATHS), `... ${paths.length - MAX_LISTED_PATHS} more; use a narrower prefix`]
      : paths;
  }

  async recentCommits(ref?: string): Promise<Evidence[]> {
    // Default to the indexed revision so history and code answers describe the same snapshot. Load it first: before
    // the index existed the first call read the branch head and later ones the snapshot, so two calls disagreed.
    if (!ref?.trim() && !this.indexedCommitSha) await this.loadIndex().catch(() => undefined);
    return this.findCommitEvidence(ref?.trim() || this.indexedCommitSha || this.config.ref);
  }

  /** Reads the live branch, not the snapshot: "what landed today" must include the push from five minutes ago. */
  async repoActivity(query: { since: string; until?: string; branch?: string }): Promise<RepoActivity> {
    const { owner, repo } = this.config;
    const since = new Date(query.since);
    const until = query.until ? new Date(query.until) : new Date(this.now());
    if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()) || since > until) throw new Error('invalid time range');
    const branch = query.branch?.trim() || this.config.ref;
    if (!/^[\w./-]{1,100}$/.test(branch)) throw new Error('invalid branch name');
    const range = `since=${encodeURIComponent(since.toISOString())}&until=${encodeURIComponent(until.toISOString())}`;
    let truncated = false;
    const commits: GitHubCommit[] = [];
    for (let page = 1; page <= MAX_ACTIVITY_PAGES; page++) {
      const batch = await this.get<GitHubCommit[]>(
        `/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&${range}&per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('GitHub returned an invalid commit history');
      commits.push(...batch);
      if (batch.length < 100) break;
      if (page === MAX_ACTIVITY_PAGES) truncated = true;
    }
    const pulls: GitHubPull[] = [];
    for (let page = 1; page <= MAX_ACTIVITY_PAGES; page++) {
      const batch = await this.get<GitHubPull[]>(`/repos/${owner}/${repo}/pulls?state=closed&base=${encodeURIComponent(branch)}` +
        `&sort=updated&direction=desc&per_page=50&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('GitHub returned an invalid pull request list');
      pulls.push(...batch);
      // Sorted by last update: once a page reaches back before the range, later pages cannot hold a merge inside it.
      if (batch.length < 50 || batch.some(pull => pull.updated_at && new Date(pull.updated_at) < since)) break;
      if (page === MAX_ACTIVITY_PAGES) truncated = true;
    }
    const valid = commits.filter(commit => commit.sha && /^[a-f0-9]{40}$/i.test(commit.sha));
    // One compare call sums the whole range: the commit list carries no files.
    let files: RepoActivity['files'];
    const newest = valid[0]?.sha;
    const base = valid.at(-1)?.parents?.[0]?.sha;
    if (newest && base && /^[a-f0-9]{40}$/i.test(base) && !truncated) {
      const compare = await this.get<{ files?: GitHubFile[] }>(`/repos/${owner}/${repo}/compare/${base}...${newest}`)
        .catch(() => undefined);
      const changed = (compare?.files ?? []).filter(file => file.filename);
      if (changed.length) {
        const size = (file: GitHubFile) => (file.additions ?? 0) + (file.deletions ?? 0);
        files = { changed: changed.length,
          additions: changed.reduce((sum, file) => sum + (file.additions ?? 0), 0),
          deletions: changed.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
          top: [...changed].sort((a, b) => size(b) - size(a)).slice(0, MAX_TOP_FILES).map(file => ({
            path: file.filename!, status: file.status ?? 'modified', additions: file.additions ?? 0, deletions: file.deletions ?? 0 })) };
        if (changed.length >= 300) truncated = true;
      }
    }
    return {
      repository: `${owner}/${repo}`, branch, since: since.toISOString(), until: until.toISOString(),
      ...(this.indexedCommitSha ? { snapshot: this.indexedCommitSha } : {}),
      commits: valid.map(commit => ({ sha: commit.sha!, url: `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
        author: commit.author?.login || commit.commit?.author?.name || 'unknown', date: commit.commit?.author?.date ?? '',
        title: (commit.commit?.message ?? '').split('\n')[0]!.slice(0, 200) })),
      mergedPullRequests: pulls.filter(pull => Number.isSafeInteger(pull.number) && pull.merged_at
          && new Date(pull.merged_at) >= since && new Date(pull.merged_at) <= until)
        .map(pull => ({ number: pull.number!, url: `https://github.com/${owner}/${repo}/pull/${pull.number}`,
          title: (pull.title ?? '').slice(0, 200), body: redactSource((pull.body ?? '').trim()).slice(0, MAX_BODY_CHARS),
          author: pull.user?.login ?? 'unknown', mergedAt: pull.merged_at! })),
      ...(files ? { files } : {}),
      truncated,
    };
  }

  async getChange(ref: { sha?: string; pr?: number }): Promise<CodeChange | undefined> {
    const { owner, repo } = this.config;
    const unlessMissing = <T>(promise: Promise<T>) => promise.catch((error: unknown) => {
      if (error instanceof Error && /HTTP (?:404|422)\b/.test(error.message)) return undefined;
      throw error;
    });
    if (ref.sha !== undefined) {
      if (!/^[a-f0-9]{7,40}$/i.test(ref.sha)) throw new Error('invalid commit sha');
      const commit = await unlessMissing(this.get<GitHubCommit>(`/repos/${owner}/${repo}/commits/${ref.sha}`));
      if (!commit?.sha) return undefined;
      const [title = '', ...rest] = (commit.commit?.message ?? '').trim().split('\n');
      return { kind: 'commit', id: commit.sha, url: `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
        title: title.slice(0, 200), body: redactSource(rest.join('\n').trim()).slice(0, MAX_BODY_CHARS),
        author: commit.author?.login || commit.commit?.author?.name || 'unknown', date: commit.commit?.author?.date,
        additions: commit.stats?.additions ?? 0, deletions: commit.stats?.deletions ?? 0,
        ...changedFiles(commit.files ?? [], (commit.files?.length ?? 0) >= 300) };
    }
    if (ref.pr === undefined || !Number.isSafeInteger(ref.pr) || ref.pr < 1) throw new Error('a commit sha or a pull request number is required');
    const pull = await unlessMissing(this.get<GitHubPull>(`/repos/${owner}/${repo}/pulls/${ref.pr}`));
    if (!pull?.number) return undefined;
    const files: GitHubFile[] = [];
    let more = false;
    for (let page = 1; page <= MAX_ACTIVITY_PAGES; page++) {
      const batch = await this.get<GitHubFile[]>(`/repos/${owner}/${repo}/pulls/${ref.pr}/files?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('GitHub returned an invalid file list');
      files.push(...batch);
      if (batch.length < 100) break;
      if (page === MAX_ACTIVITY_PAGES) more = true;
    }
    return { kind: 'pull_request', id: `#${pull.number}`, url: `https://github.com/${owner}/${repo}/pull/${pull.number}`,
      title: (pull.title ?? '').slice(0, 200), body: redactSource((pull.body ?? '').trim()).slice(0, MAX_BODY_CHARS),
      author: pull.user?.login ?? 'unknown', date: pull.merged_at ?? pull.created_at,
      state: pull.merged_at ? 'merged' : pull.state, additions: pull.additions ?? 0, deletions: pull.deletions ?? 0,
      ...changedFiles(files, more) };
  }

  /** Reads live: "did CI pass on main?" must see the run that finished a minute ago. */
  async ciStatus(target: { branch?: string; sha?: string; pr?: number }): Promise<CiStatus | undefined> {
    const { owner, repo } = this.config;
    const unlessMissing = <T>(promise: Promise<T>) => promise.catch((error: unknown) => {
      if (error instanceof Error && /HTTP (?:404|422)\b/.test(error.message)) return undefined;
      throw error;
    });
    let branch: string | undefined;
    let sha: string | undefined;
    if (target.pr !== undefined) {
      if (!Number.isSafeInteger(target.pr) || target.pr < 1) throw new Error('invalid pull request number');
      const pull = await unlessMissing(this.get<GitHubPull>(`/repos/${owner}/${repo}/pulls/${target.pr}`));
      if (!pull?.head?.sha || !/^[a-f0-9]{40}$/i.test(pull.head.sha)) return undefined;
      sha = pull.head.sha.toLowerCase();
      branch = pull.head.ref;
    } else if (target.sha !== undefined) {
      if (!/^[a-f0-9]{7,40}$/i.test(target.sha)) throw new Error('invalid commit sha');
      // Runs are filtered by the full sha only, so a short one is resolved first.
      const full = target.sha.length === 40 ? target.sha
        : (await unlessMissing(this.get<GitHubCommit>(`/repos/${owner}/${repo}/commits/${target.sha}`)))?.sha;
      if (!full || !/^[a-f0-9]{40}$/i.test(full)) return undefined;
      sha = full.toLowerCase();
    } else {
      branch = target.branch?.trim() || this.config.ref;
      if (!/^[\w./-]{1,100}$/.test(branch)) throw new Error('invalid branch name');
    }
    const filter = sha ? `head_sha=${sha}` : `branch=${encodeURIComponent(branch!)}`;
    const listed = await this.get<{ workflow_runs?: GitHubRun[] }>(`/repos/${owner}/${repo}/actions/runs?${filter}&per_page=${MAX_CI_RUNS}`);
    if (!Array.isArray(listed?.workflow_runs)) throw new Error('GitHub returned an invalid workflow run list');
    const runs = listed.workflow_runs.filter(run => Number.isSafeInteger(run.id) && run.head_sha).slice(0, MAX_CI_RUNS)
      .map(run => ({ id: run.id!, run: {
        workflow: (run.name || 'workflow').slice(0, 100), status: run.status ?? 'unknown',
        ...(run.conclusion ? { conclusion: run.conclusion } : {}), sha: run.head_sha!,
        ...(run.head_branch ? { branch: run.head_branch } : {}), ...(run.event ? { event: run.event } : {}),
        url: run.html_url ?? `https://github.com/${owner}/${repo}/actions/runs/${run.id}`,
        ...(run.run_started_at ? { startedAt: run.run_started_at } : {}) } as CiRun }));
    const failed = (conclusion?: string | null) => !!conclusion && FAILED_CONCLUSIONS.has(conclusion);
    await Promise.all(runs.filter(({ run }) => failed(run.conclusion)).slice(0, MAX_FAILED_RUNS_DETAILED).map(async ({ id, run }) => {
      const jobs = await this.get<{ jobs?: GitHubJob[] }>(`/repos/${owner}/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100`)
        .catch(() => undefined);
      // Left unset when the jobs could not be read, so "no failed job listed" is never claimed by mistake.
      if (!Array.isArray(jobs?.jobs)) return;
      run.failedJobs = jobs.jobs.filter(job => failed(job.conclusion)).map(job => {
        const step = job.steps?.find(item => failed(item.conclusion))?.name;
        return { name: (job.name || 'job').slice(0, 100), url: job.html_url ?? run.url, ...(step ? { step: step.slice(0, 100) } : {}) };
      });
    }));
    // A token without deployment access, or a repository that never deploys, still gets its CI answer.
    const deployment = await this.deployed(sha ? undefined : branch).catch(() => undefined);
    return { repository: `${owner}/${repo}`,
      target: { ...(target.pr !== undefined ? { pr: target.pr } : {}), ...(branch ? { branch } : {}), ...(sha ? { sha } : {}) },
      runs: runs.map(({ run }) => run), ...(deployment ? { deployment } : {}) };
  }

  /** The newest successful non-preview deployment (or the newest one, when none succeeded), and how far `branch` is past it. */
  private async deployed(branch?: string): Promise<CiStatus['deployment']> {
    const { owner, repo } = this.config;
    const list = await this.get<Array<GitHubDeployment & { transient_environment?: boolean }>>(
      `/repos/${owner}/${repo}/deployments?per_page=${MAX_DEPLOYMENTS_CHECKED * 2}`);
    if (!Array.isArray(list)) return undefined;
    const candidates = list.filter(item => Number.isSafeInteger(item.id) && item.sha && /^[a-f0-9]{40}$/i.test(item.sha)
      && item.transient_environment !== true).slice(0, MAX_DEPLOYMENTS_CHECKED);
    let chosen: NonNullable<CiStatus['deployment']> | undefined;
    for (const item of candidates) {
      const [status] = await this.get<GitHubDeploymentStatus[]>(`/repos/${owner}/${repo}/deployments/${item.id}/statuses?per_page=1`)
        .catch(() => [] as GitHubDeploymentStatus[]);
      const url = status?.environment_url || status?.target_url;
      const found = { sha: item.sha!.toLowerCase(), environment: (item.environment || 'unknown').slice(0, 100),
        state: status?.state ?? 'unknown', createdAt: item.created_at ?? '', ...(url ? { url } : {}) };
      chosen ??= found;
      if (found.state === 'success') { chosen = found; break; }
    }
    if (!chosen || !branch) return chosen;
    const compare = await this.get<{ status?: string; ahead_by?: number }>(
      `/repos/${owner}/${repo}/compare/${chosen.sha}...${branch}`).catch(() => undefined);
    if ((compare?.status === 'ahead' || compare?.status === 'identical') && Number.isSafeInteger(compare.ahead_by ?? 0)) {
      chosen.notDeployed = compare.ahead_by ?? 0;
    }
    return chosen;
  }

  async overview(): Promise<{ paths: string[]; readme?: string; revision?: string }> {
    const { files, commitSha } = await this.loadIndex();
    const paths = files.map(file => file.path).sort();
    const readme = files.find(file => /^readme(?:\.md)?$/i.test(file.path))?.text;
    return { paths, readme: readme?.slice(0, 3000), revision: commitSha };
  }

  async findEvidence(query: string): Promise<Evidence[]> {
    if (isHistoryQuestion(query)) return this.findCommitEvidence(requestedRef(query, this.config.ref));
    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    const { files, commitSha } = await this.loadIndex();
    const phrase = query.toLocaleLowerCase().replace(/[^\p{L}\p{N}_]+/gu, ' ').trim();
    const asksForPlanningDocs = /\b(?:design|specification|spec|plan|planning|proposal)\b/i.test(query);
    const scored = files.map(file => {
      const path = file.path.toLocaleLowerCase();
      let score = 0;
      let matchedTerms = 0;
      for (const term of terms) {
        const contentMatches = countOccurrences(file.lower, term);
        const pathMatches = countOccurrences(path, term);
        if (contentMatches || pathMatches) matchedTerms++;
        score += contentMatches ? 3 + Math.min(3, Math.log2(contentMatches)) : 0;
        score += pathMatches ? 28 : 0;
      }
      if (phrase.length >= 8 && file.lower.includes(phrase)) score += 6;
      score += matchedTerms / terms.length;
      if (matchedTerms >= 2 && /^src\//i.test(path)) score += 20;
      if (!asksForPlanningDocs && /^docs\/superpowers\//i.test(path)) score -= 30;
      return { file, score };
    }).filter(result => result.score > 0);
    scored.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));

    const { owner, repo } = this.config;
    return scored.slice(0, MAX_EVIDENCE).map(({ file }) => ({
      path: file.path,
      url: `https://github.com/${owner}/${repo}/blob/${commitSha}/${file.path.split('/').map(encodeURIComponent).join('/')}`,
      excerpt: excerptFor(file.text, terms),
    }));
  }

  private async findCommitEvidence(ref: string): Promise<Evidence[]> {
    const { owner, repo } = this.config;
    const commits = await this.get<GitHubCommit[]>(`/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(ref)}&per_page=10`);
    if (!Array.isArray(commits)) throw new Error('GitHub returned an invalid commit history');
    return commits.slice(0, MAX_EVIDENCE).flatMap(commit => {
      const sha = commit.sha;
      const message = commit.commit?.message?.trim();
      if (!sha || !/^[a-f0-9]{40}$/i.test(sha) || !message) return [];
      const date = commit.commit?.author?.date;
      return [{ path: `commit ${sha.slice(0, 7)}`,
        url: `https://github.com/${owner}/${repo}/commit/${sha}`,
        excerpt: `${date ? `Date: ${date}\n` : ''}${message.slice(0, MAX_EXCERPT_CHARS)}` }];
    });
  }
}
