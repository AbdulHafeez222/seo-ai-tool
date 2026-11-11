import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

assert.ok(process.env.TEST_MONGOD_BINARY, 'Supply the path to a local mongod test binary.');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27020/seo_beta_reconnect?directConnection=true';
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'ERROR';
const api = await import('../server.js');
const directory = path.resolve('work/reconnection-db');
await mkdir(directory, { recursive: true });
let database;
const startDatabase = () => {
  database = spawn(process.env.TEST_MONGOD_BINARY, ['--dbpath', directory, '--bind_ip', '127.0.0.1', '--port', '27020'], { stdio: 'ignore' });
  return database;
};
const stopDatabase = async () => {
  if (!database || database.exitCode !== null) return;
  const ended = new Promise(resolve => database.once('exit', resolve));
  database.kill('SIGTERM');
  await ended;
};
const waitUntil = async (predicate, label) => {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out: ${label}`);
};
const server = api.app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const readiness = async () => (await fetch(`http://127.0.0.1:${server.address().port}/health/ready`)).status;
try {
  assert.equal(await api.connectToDatabase(), null, 'Initial connection must fail before the test DB starts');
  assert.equal(await readiness(), 503);
  startDatabase();
  await waitUntil(async () => (await readiness()) === 200, 'automatic recovery from failed startup');
  const marker = await api.Project.create({ userId: new mongoose.Types.ObjectId(), name: 'reconnection acceptance' });
  await stopDatabase();
  await waitUntil(async () => (await readiness()) === 503, 'readiness during outage');
  startDatabase();
  await waitUntil(async () => (await readiness()) === 200, 'driver recovery after server restart');
  assert.ok(await api.Project.findById(marker._id));
  await api.Project.deleteOne({ _id: marker._id });
  console.log(JSON.stringify({ passed: true, initialFailureRetried: true, outageReadiness: 503, recoveredReadiness: 200, retainedData: true }));
} finally {
  await mongoose.disconnect();
  await stopDatabase();
  await new Promise(resolve => server.close(resolve));
}
