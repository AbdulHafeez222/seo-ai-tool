import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import nodemailer from 'nodemailer';

const uri = process.env.TEST_MONGODB_URI;
test('password recovery expires and consumes tokens, hides account existence and revokes old credentials', { skip: !uri }, async () => {
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:27019\/seo_beta_acceptance(?:\?|$)/);
  Object.assign(process.env, { JWT_SECRET: crypto.randomBytes(32).toString('hex'), NODE_ENV: 'test', LOG_LEVEL: 'ERROR',
    PASSWORD_RESET_ENABLED: 'true', SMTP_HOST: 'smtp.fixture.invalid', MAIL_FROM: 'support@example.com', APP_ORIGIN: 'http://localhost' });
  delete process.env.MONGODB_URI;
  const originalTransport = nodemailer.createTransport;
  const mail = [];
  nodemailer.createTransport = options => {
    assert.equal(options.secure, true); assert.equal(options.port, 465);
    return { sendMail: async message => { mail.push(message); }, close() {} };
  };
  const api = await import('../server.js');
  await mongoose.connect(uri);
  const Reset = mongoose.models.PasswordReset;
  const server = api.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_ORIGIN = base;
  const password = crypto.randomBytes(16).toString('hex'), newPassword = crypto.randomBytes(16).toString('hex');
  const user = await api.User.create({ email: `recovery-${crypto.randomUUID()}@example.com`, passwordHash: await api.hashPassword(password), apiKey: api.generateApiKey() });
  const oldToken = api.signAuthToken(user), oldKey = user.apiKey;
  async function post(path, body) {
    const response = await fetch(base + path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  const requestReset = () => post('/auth/forgot-password', { email: user.email });
  const deliveredToken = () => new URL(mail.at(-1).text.match(/http[^\s]+/)[0]).hash.slice('#reset-token='.length);
  try {
    const known = await requestReset();
    const unknown = await post('/auth/forgot-password', { email: `absent-${crypto.randomUUID()}@example.com` });
    assert.deepEqual(known, unknown); assert.equal(mail.length, 1);
    const first = deliveredToken();
    const stored = await Reset.findOne({ userId: user._id }).lean();
    assert.equal(stored.tokenHash, crypto.createHash('sha256').update(first).digest('hex'));
    assert.ok(!JSON.stringify(stored).includes(first));
    await Reset.updateOne({ _id: stored._id }, { $set: { expiresAt: new Date(0) } });
    assert.equal((await post('/auth/reset-password', { token: first, newPassword })).status, 400);
    await requestReset(); const second = deliveredToken();
    await requestReset(); const current = deliveredToken();
    assert.equal((await post('/auth/reset-password', { token: second, newPassword })).status, 400);
    const attempts = await Promise.all([1, 2].map(() => post('/auth/reset-password', { token: current, newPassword })));
    assert.deepEqual(attempts.map(r => r.status).sort(), [200, 400]);
    const refreshed = await api.User.findById(user._id);
    assert.notEqual(refreshed.apiKey, oldKey);
    assert.equal(await api.verifyPasswordHash(newPassword, refreshed.passwordHash), true);
    assert.equal((await post('/auth/login', { email: user.email, password })).status, 401);
    assert.equal((await post('/auth/login', { email: user.email, password: newPassword })).status, 200);
    const revoked = await fetch(base + '/auth/me', { headers: { Authorization: `Bearer ${oldToken}` } });
    assert.notEqual(revoked.status, 200);
  } finally {
    nodemailer.createTransport = originalTransport;
    await Reset.deleteMany({ userId: user._id }); await api.User.deleteOne({ _id: user._id });
    await new Promise(resolve => server.close(resolve)); await mongoose.disconnect();
  }
});
