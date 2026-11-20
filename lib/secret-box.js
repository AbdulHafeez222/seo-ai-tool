import crypto from 'node:crypto';

export function readEncryptionKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('A canonical base64 32-byte encryption key is required.');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw new Error('Invalid encryption key.');
  return key;
}

export function sealBytes(bytes, key, purpose) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(purpose));
  const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function openBytes(box, key, purpose) {
  if (typeof box !== 'string') throw new Error('Invalid encrypted envelope.');
  const [version, iv, tag, data, extra] = box.split('.');
  if (version !== 'v1' || extra !== undefined || !iv || !tag || !data || ![iv, tag, data].every(value => /^[A-Za-z0-9_-]+$/.test(value))) throw new Error('Invalid encrypted envelope.');
  const nonce = Buffer.from(iv, 'base64url'), authTag = Buffer.from(tag, 'base64url');
  if (nonce.length !== 12 || authTag.length !== 16) throw new Error('Invalid encrypted envelope.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(purpose));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]);
}

export const sealJson = (value, key, purpose) => sealBytes(Buffer.from(JSON.stringify(value)), key, purpose);
export const openJson = (box, key, purpose) => JSON.parse(openBytes(box, key, purpose).toString('utf8'));
