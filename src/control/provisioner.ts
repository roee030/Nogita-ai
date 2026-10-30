/**
 * Creating, updating and removing a company's cell. Behind an interface so the host can change (Render today; Fly.io
 * Machines or Kubernetes later) without touching the rest of the control plane.
 */
import { CELL_DISK_MOUNT } from './cell.ts';

export interface CellSpec { companyId: string; env: Record<string, string> }
export type CellStatus = 'building' | 'live' | 'failed' | 'unknown';

export interface Provisioner {
  /** A new service with its own persistent disk; returns where it runs. */
  create(spec: CellSpec): Promise<{ serviceId: string; url: string }>;
  /** Replaces the cell's environment and deploys it again. */
  update(serviceId: string, env: Record<string, string>): Promise<void>;
  status(serviceId: string): Promise<CellStatus>;
  /** Removes the service and its disk. */
  destroy(serviceId: string): Promise<void>;
}

export interface RenderOptions {
  apiKey: string;
  /** The Render workspace (owner) the cells are created in. */
  ownerId: string;
  /** The Nogita repository and branch every cell runs. */
  repo: string;
  branch: string;
  plan?: string;
  region?: string;
  diskGb?: number;
}

const API = 'https://api.render.com/v1';

/** Render's REST API: a Node web service per company, with a disk for its state. */
export class RenderProvisioner implements Provisioner {
  constructor(private readonly options: RenderOptions, private readonly http: typeof fetch = fetch) {
    if (!options.apiKey || !options.ownerId || !options.repo) throw new Error('Render provisioner needs an API key, owner and repo');
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.http(`${API}${path}`, {
      method, headers: { Authorization: `Bearer ${this.options.apiKey}`, Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      let detail = '';
      try { detail = ((await response.json()) as { message?: string }).message ?? ''; } catch { /* keep generic */ }
      throw new Error(`Render ${method} ${path.split('/').slice(0, 3).join('/')} failed: HTTP ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`);
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  private static envVars(env: Record<string, string>) {
    return Object.entries(env).map(([key, value]) => ({ key, value }));
  }

  async create(spec: CellSpec): Promise<{ serviceId: string; url: string }> {
    const result = await this.call<{ service?: { id?: string; serviceDetails?: { url?: string } }; id?: string;
      serviceDetails?: { url?: string } }>('POST', '/services', {
      type: 'web_service', name: `nogita-${spec.companyId}`, ownerId: this.options.ownerId,
      repo: this.options.repo, branch: this.options.branch, autoDeploy: 'no',
      envVars: RenderProvisioner.envVars(spec.env),
      serviceDetails: {
        runtime: 'node', plan: this.options.plan ?? 'starter', region: this.options.region ?? 'frankfurt',
        healthCheckPath: '/health', numInstances: 1,
        disk: { name: 'nogita-state', mountPath: CELL_DISK_MOUNT, sizeGB: this.options.diskGb ?? 1 },
        envSpecificDetails: { buildCommand: 'npm ci', startCommand: 'npm start' },
      },
    });
    const service = result.service ?? result;
    if (!service.id || !service.serviceDetails?.url) throw new Error('Render did not return the new service');
    return { serviceId: service.id, url: service.serviceDetails.url };
  }

  async update(serviceId: string, env: Record<string, string>): Promise<void> {
    await this.call('PUT', `/services/${encodeURIComponent(serviceId)}/env-vars`, RenderProvisioner.envVars(env));
    await this.call('POST', `/services/${encodeURIComponent(serviceId)}/deploys`, { clearCache: 'do_not_clear' });
  }

  async status(serviceId: string): Promise<CellStatus> {
    const deploys = await this.call<Array<{ deploy?: { status?: string } }>>('GET', `/services/${encodeURIComponent(serviceId)}/deploys?limit=1`);
    const status = deploys[0]?.deploy?.status ?? '';
    if (status === 'live') return 'live';
    if (/failed|canceled|deactivated/.test(status)) return 'failed';
    if (/created|in_progress|queued/.test(status)) return 'building';
    return 'unknown';
  }

  async destroy(serviceId: string): Promise<void> {
    try { await this.call('DELETE', `/services/${encodeURIComponent(serviceId)}`); }
    catch (error) { if (!/HTTP 404/.test(String(error))) throw error; }
  }
}

/** For tests and local runs: cells that exist only in memory. */
export class MemoryProvisioner implements Provisioner {
  readonly cells = new Map<string, { companyId: string; env: Record<string, string>; deploys: number }>();
  private next = 1;
  async create(spec: CellSpec) {
    const serviceId = `srv-${this.next++}`;
    this.cells.set(serviceId, { companyId: spec.companyId, env: { ...spec.env }, deploys: 1 });
    return { serviceId, url: `https://nogita-${spec.companyId}.cells.test` };
  }
  async update(serviceId: string, env: Record<string, string>) {
    const cell = this.cells.get(serviceId);
    if (!cell) throw new Error('no such cell');
    cell.env = { ...env };
    cell.deploys++;
  }
  async status(serviceId: string): Promise<CellStatus> { return this.cells.has(serviceId) ? 'live' : 'unknown'; }
  async destroy(serviceId: string) { this.cells.delete(serviceId); }
}
