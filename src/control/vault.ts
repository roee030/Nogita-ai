/**
 * Secrets at rest in the control plane: the companies' own provider keys and their OAuth tokens. Each company's
 * secrets are sealed with a key derived for that company, and the company id is bound into every value, so a sealed
 * value copied into another company's record does not open.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/** A sealed value: "v1.<iv>.<tag>.<ciphertext>", base64url. */
export type Sealed = string & { readonly __sealed: true };

export class Vault {
  private readonly master: Buffer;

  constructor(masterKeyBase64: string) {
    this.master = Buffer.from(masterKeyBase64, 'base64');
    if (this.master.length !== 32) throw new Error('CONTROL_VAULT_KEY must be 32 random bytes, base64');
  }

  private key(companyId: string): Buffer {
    return Buffer.from(hkdfSync('sha256', this.master, 'nogita-vault-v1', `company:${companyId}`, 32));
  }

  seal(companyId: string, plaintext: string): Sealed {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(companyId), iv);
    cipher.setAAD(Buffer.from(companyId));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), body].map(part => typeof part === 'string' ? part : part.toString('base64url')).join('.') as Sealed;
  }

  open(companyId: string, sealed: Sealed): string {
    const [version, iv, tag, body] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || body === undefined) throw new Error('sealed value is malformed');
    const decipher = createDecipheriv('aes-256-gcm', this.key(companyId), Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(companyId));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  }
}
