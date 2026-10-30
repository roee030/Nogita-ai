/**
 * One Slack app for every company means one events URL. The control plane checks Slack's signature, finds the
 * company by workspace, and passes the event on to that company's cell, signed again with the cell's own secret (the
 * cell checks it as it always checked Slack's). Nothing is stored or logged: the body only passes through.
 */
import { createHmac } from 'node:crypto';
import { verifySlackSignature } from '../adapters/slack.ts';
import { companyBySlackTeam, type CompanyStore } from './store.ts';
import type { Vault } from './vault.ts';

export interface RoutedResponse { status: number; body: string; contentType?: string }

export function signForCell(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

export async function routeSlackEvent(request: { body: string; timestamp: string | null; signature: string | null;
  retryNum?: string | null; retryReason?: string | null },
  context: { signingSecret: string; store: CompanyStore; vault: Vault; http?: typeof fetch; nowSec?: () => number }): Promise<RoutedResponse> {
  const nowSec = context.nowSec ?? (() => Math.floor(Date.now() / 1000));
  if (!verifySlackSignature(context.signingSecret, request.timestamp, request.signature, request.body, nowSec())) {
    return { status: 401, body: 'bad signature' };
  }
  let event: { type?: string; challenge?: string; team_id?: string; authorizations?: Array<{ team_id?: string }>;
    event?: { type?: string } };
  try { event = JSON.parse(request.body); } catch { return { status: 400, body: 'expected JSON' }; }
  if (event.type === 'url_verification') return { status: 200, body: event.challenge ?? '', contentType: 'text/plain' };
  const teamId = event.team_id ?? event.authorizations?.[0]?.team_id;
  const company = teamId ? companyBySlackTeam(context.store, teamId) : undefined;
  // A workspace that uninstalled Nogita, or one no company has: accept, so Slack stops sending.
  if (!company) return { status: 200, body: '' };
  if (event.event?.type === 'app_uninstalled' || event.event?.type === 'tokens_revoked') {
    company.connections = company.connections.filter(c => !(c.kind === 'slack' && c.teamId === teamId));
    context.store.put(company);
    return { status: 200, body: '' };
  }
  if (!company.cell || company.cell.status === 'deleting') return { status: 503, body: 'cell not running' };
  const timestamp = String(nowSec());
  const secret = context.vault.open(company.id, company.cell.secrets.slackSigningSecret);
  try {
    const response = await (context.http ?? fetch)(new URL('/slack/events', company.cell.url), {
      method: 'POST', body: request.body,
      headers: { 'Content-Type': 'application/json', 'X-Slack-Request-Timestamp': timestamp,
        'X-Slack-Signature': signForCell(secret, timestamp, request.body),
        ...(request.retryNum ? { 'X-Slack-Retry-Num': request.retryNum } : {}),
        ...(request.retryReason ? { 'X-Slack-Retry-Reason': request.retryReason } : {}) },
      // Slack waits three seconds; a slow cell gets a retry from Slack rather than a lost event.
      signal: AbortSignal.timeout(2500),
    });
    return { status: response.status >= 500 ? 503 : response.status, body: '' };
  } catch {
    return { status: 503, body: 'cell unreachable' };
  }
}
