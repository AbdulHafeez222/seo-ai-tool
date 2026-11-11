// Retry failed initial connections only. Once connected, the MongoDB driver
// owns topology recovery; opening another client during an outage leaks pools.
export function createDatabaseLifecycle({ connect, onFailure, schedule = setTimeout, cancel = clearTimeout, random = Math.random }) {
  let pending = null;
  let connection = null;
  let retry = null;
  let failures = 0;
  let stopped = false;
  function start() {
    if (stopped) return Promise.resolve(null);
    if (connection) return Promise.resolve(connection);
    if (pending) return pending;
    if (retry) { cancel(retry); retry = null; }
    pending = Promise.resolve().then(connect).then(value => {
      connection = value;
      failures = 0;
      return value;
    }).catch(error => {
      const delay = Math.min(60000, 1000 * 2 ** Math.min(failures++, 6)) + Math.floor(random() * 1000);
      onFailure(error, delay);
      if (!stopped) {
        retry = schedule(() => { retry = null; void start(); }, delay);
        retry?.unref?.();
      }
      return null;
    }).finally(() => { pending = null; });
    return pending;
  }
  return {
    start,
    stop() { stopped = true; if (retry) cancel(retry); retry = null; }
  };
}

export function databaseFailureCategory(error) {
  const details = [error?.code, error?.message, error?.cause?.message,
    ...Array.from(error?.reason?.servers?.values?.() || []).map(server => server.error?.message)].join(' ');
  if (/ENOTFOUND|EAI_AGAIN|querySrv|queryTxt/i.test(details)) return 'DNS_LOOKUP';
  if (/AuthenticationFailed|authentication failed|bad auth/i.test(details)) return 'AUTHENTICATION';
  if (/not authorized|Unauthorized/i.test(details)) return 'PERMISSION';
  if (/ECONNREFUSED|ETIMEDOUT|timed out|Server selection/i.test(details)) return 'NETWORK_OR_ACCESS_LIST';
  return 'CONNECTION';
}
