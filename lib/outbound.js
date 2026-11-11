import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import axios from 'axios';

const denied = new net.BlockList();
for (const [base, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) denied.addSubnet(base, bits, 'ipv4');
for (const [base, bits] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) denied.addSubnet(base, bits, 'ipv6');
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !denied.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !denied.check(address, 'ipv6');
}

export function parsePublicUrl(value) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port)) || value.length > 2048 ||
      /[\u0000-\u0020\\]/.test(value) || !host.includes('.') && !net.isIP(host) ||
      /(^|\.)(localhost|local|internal|test|invalid)$/.test(host) || host.endsWith('.') ||
      net.isIP(host) && !isPublicAddress(host)) throw new Error('Unsafe target URL');
  url.hash = '';
  return url;
}

export async function resolvePublicUrl(value, lookup = dns.lookup) {
  const url = parsePublicUrl(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const records = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] :
    await Promise.race([lookup(host, { all: true, verbatim: true }), new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('DNS timeout')), 3000); timer.unref();
    })]);
  if (!records.length || records.some(r => !isPublicAddress(r.address))) throw new Error('Unsafe target address');
  return { url, records };
}

// Every hop gets DNS validation and a pinned socket lookup. No proxy, insecure
// TLS, ambient cookies, or authorization headers are forwarded to targets.
export async function safeRequest(value, options = {}) {
  const deadline = AbortSignal.timeout(Math.min(options.timeout || 12000, 20000));
  let current = value;
  const chain = [];
  const maxRedirects = Math.min(options.maxRedirects ?? 5, 6);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { url, records } = await resolvePublicUrl(current);
    if (chain.some(item => item.from === url.href)) throw new Error('Redirect loop detected');
    const lookup = (_hostname, opts, cb) => {
      if (opts?.all) cb(null, records);
      else { const record = records.find(r => !opts?.family || opts.family === r.family) || records[0]; cb(null, record.address, record.family); }
    };
    const response = await axios.request({
      ...options, url: url.href, method: options.method || 'GET',
      headers: { 'User-Agent': 'AIVisibilityAudit/1.0', Accept: '*/*' },
      proxy: false, maxRedirects: 0, signal: deadline, timeout: Math.min(options.timeout || 12000, 20000),
      httpAgent: new http.Agent({ lookup }), httpsAgent: new https.Agent({ lookup, rejectUnauthorized: true }),
      maxContentLength: Math.min(options.maxContentLength || 5 * 1024 * 1024, 5 * 1024 * 1024),
      maxBodyLength: 1024, validateStatus: () => true
    });
    if ([301,302,303,307,308].includes(response.status) && response.headers.location) {
      const next = new URL(response.headers.location, url).href;
      chain.push({ from: url.href, location: next, status: response.status });
      current = next;
      continue;
    }
    response.safeFinalUrl = url.href;
    response.safeRedirectChain = chain;
    return response;
  }
  throw new Error('Redirect limit exceeded');
}

export const safeHttp = {
  get: (url, options) => safeRequest(url, options),
  head: (url, options) => safeRequest(url, { ...options, method: 'HEAD' })
};
