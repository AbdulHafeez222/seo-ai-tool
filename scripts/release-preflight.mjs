// Read-only acceptance of hosting secrets and database connectivity.
// Never emit credential values, connection strings, customer rows or raw errors.
import mongoose from 'mongoose';

const checks = {
  jwtConfigured: Buffer.byteLength(process.env.JWT_SECRET || '') >= 32,
  databaseConfigured: Boolean(process.env.MONGODB_URI),
  productionMode: process.env.NODE_ENV === 'production',
  httpsOrigin: /^https:\/\//.test(process.env.APP_ORIGIN || ''),
  browserEgressIsolationConfirmed: process.env.CRAWLER_EGRESS_ISOLATED === 'true',
  passwordRecoveryEnabled: process.env.PASSWORD_RESET_ENABLED === 'true',
  databaseReachable: false,
  emailUniqueIndex: false,
  apiKeyUniqueIndex: false
};
try {
  if (checks.databaseConfigured) {
    await mongoose.connect(process.env.MONGODB_URI, {autoIndex:false, autoCreate:false, serverSelectionTimeoutMS:10000, connectTimeoutMS:10000});
    checks.databaseReachable = true;
    // Catalog metadata only. No user documents or customer data are read.
    const indexes = await mongoose.connection.db.collection('users').indexes();
    checks.emailUniqueIndex = indexes.some(i=>i.unique && i.key.email === 1 && Object.keys(i.key).length === 1 && !i.partialFilterExpression);
    checks.apiKeyUniqueIndex = indexes.some(i=>i.unique && i.key.apiKey === 1 && Object.keys(i.key).length === 1 && !i.partialFilterExpression);
  }
} catch (error) {
  checks.databaseCatalogCheckFailed = true;
  const detail = [error?.message, error?.cause?.message, ...Array.from(error?.reason?.servers?.values?.() || []).map(s=>s.error?.message)].join(' ');
  checks.databaseFailureCategory = /ENOTFOUND|EAI_AGAIN|querySrv|queryTxt/i.test(detail) ? 'DNS_LOOKUP' : /authentication failed|bad auth|AuthenticationFailed/i.test(detail) ? 'AUTHENTICATION' : /not authorized|Unauthorized/i.test(detail) ? 'PERMISSION' : /ECONNREFUSED|ETIMEDOUT|timed out|Server selection/i.test(detail) ? 'NETWORK_OR_ACCESS_LIST' : 'CONNECTION_OR_CATALOG';
} finally {
  await mongoose.disconnect();
}
console.log(JSON.stringify(checks));
if (!checks.jwtConfigured || !checks.databaseReachable || !checks.productionMode || !checks.httpsOrigin || !checks.emailUniqueIndex || !checks.apiKeyUniqueIndex) process.exitCode=1;
