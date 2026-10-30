import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

for (const dir of ['.', 'lib', 'public']) {
  for (const file of readdirSync(dir).filter(f => /\.(js|mjs)$/.test(f))) {
    const path = `${dir}/${file}`;
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(1); }
  }
}
const html = readFileSync('public/index.html', 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(Boolean);
for (const source of scripts) new vm.Script(source);
const code = scripts.join('\n') + readFileSync('public/features.js', 'utf8');
const handlers = [...html.matchAll(/\bon(?:click|input|change|submit)="([^"]*)"/g)];
const missing = new Set();
for (const [,handler] of handlers) for (const [,name] of handler.matchAll(/\b([A-Za-z_$][\w$]*)\(/g)) {
  if (!new RegExp(`(?:function\\s+${name}\\s*\\(|(?:const|let)\\s+${name}\\s*=)`).test(code)) missing.add(name);
}
if (missing.size) throw new Error(`Undefined UI handlers: ${[...missing].join(', ')}`);
JSON.parse(readFileSync('package-lock.json', 'utf8'));
console.log('All JavaScript and inline scripts parse; visible static handlers resolve; lockfile is JSON.');
