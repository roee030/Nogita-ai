/**
 * Starts the control plane (`npm run control`). Its settings are its own (CONTROL_*, the OAuth apps, Render), read
 * from .env.control locally: never the cell's .env, whose SLACK_SIGNING_SECRET is a cell's, not the Slack app's.
 */
import { createServer } from 'node:http';
import { loadDotEnv } from '../app/config.ts';
import { Vault } from './vault.ts';
import { FileCompanyStore } from './store.ts';
import type { OAuthApps } from './oauth.ts';
import { TokenBroker } from './broker.ts';
import { CompanyService } from './companies.ts';
import { MemoryProvisioner, RenderProvisioner, type Provisioner } from './provisioner.ts';
import { controlApp } from './server.ts';

loadDotEnv('.env.control');
const env = process.env;
const required = (name: string) => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Set ${name} to start the control plane`);
  return value;
};
const pair = (id: string, secret: string) => env[id]?.trim() && env[secret]?.trim()
  ? { clientId: env[id]!.trim(), clientSecret: env[secret]!.trim() } : undefined;

const publicUrl = required('CONTROL_PUBLIC_URL').replace(/\/$/, '');
const vault = new Vault(required('CONTROL_VAULT_KEY'));
const store = new FileCompanyStore(env.CONTROL_STATE_DIR ?? '.nogita-control');
const github = pair('GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET');
const apps: OAuthApps = {
  google: pair('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'),
  microsoft: pair('MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'),
  slack: pair('SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET'),
  atlassian: pair('ATLASSIAN_CLIENT_ID', 'ATLASSIAN_CLIENT_SECRET'),
  github: github && env.GITHUB_APP_SLUG && env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY
    ? { ...github, slug: env.GITHUB_APP_SLUG, appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n') }
    : undefined,
};
let provisioner: Provisioner;
if (env.RENDER_API_KEY) {
  provisioner = new RenderProvisioner({ apiKey: env.RENDER_API_KEY, ownerId: required('RENDER_OWNER_ID'), repo: required('CELL_REPO'),
    branch: env.CELL_BRANCH ?? 'main', plan: env.RENDER_PLAN, region: env.RENDER_REGION,
    diskGb: env.RENDER_DISK_GB ? Number(env.RENDER_DISK_GB) : undefined });
} else {
  console.warn('control_plane_without_render: cells are only simulated in memory');
  provisioner = new MemoryProvisioner();
}
const broker = new TokenBroker(store, vault, apps);
const companies = new CompanyService({ store, vault, apps, provisioner, broker, publicUrl });
const handler = controlApp({ store, vault, apps, companies, broker, publicUrl, sessionSecret: required('CONTROL_SESSION_SECRET'),
  slackSigningSecret: env.SLACK_SIGNING_SECRET });

const port = Number(env.PORT ?? 8788);
createServer((req, res) => void handler(req, res)).listen(port, env.HOST ?? '127.0.0.1', () => {
  console.log(`control_plane_listening ${publicUrl} (${Object.entries(apps).filter(([, app]) => app).map(([name]) => name).join(', ') || 'no apps'})`);
});
