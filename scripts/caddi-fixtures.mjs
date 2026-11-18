#!/usr/bin/env node
import { startQualificationFixtures } from '../src/caddi/qualification/server.mjs';
import { qualificationMatrix, qualificationWorkload } from '../src/caddi/qualification/matrix.mjs';

const usage = 'Usage: node scripts/caddi-fixtures.mjs --serve [--port N] [--duration-ms N] [--session-ttl-ms N]\n       node scripts/caddi-fixtures.mjs --matrix\nNo browser is launched. --serve binds only 127.0.0.1; default lifetime 30 minutes.\n';
async function main() {
  const args = process.argv.slice(2);
  if (!args.length || (args.length === 1 && args[0] === '--help')) { process.stdout.write(usage); return; }
  if (args.length === 1 && args[0] === '--matrix') {
    process.stdout.write(JSON.stringify({ matrix: qualificationMatrix(), workload: qualificationWorkload() }, null, 2) + '\n'); return;
  }
  if (args[0] !== '--serve') throw new Error('Choose --serve or --matrix.');
  const options = {}, keys = { '--port': 'port', '--duration-ms': 'durationMs', '--session-ttl-ms': 'sessionTtlMs' };
  for (let index = 1; index < args.length; index += 2) {
    const key = Object.hasOwn(keys, args[index]) ? keys[args[index]] : null, raw = args[index + 1];
    if (!key || Object.hasOwn(options, key) || raw === undefined || !/^(?:0|[1-9][0-9]*)$/.test(raw)) throw new Error('Invalid or duplicate fixture option.');
    options[key] = Number(raw);
  }
  const fixture = await startQualificationFixtures(options);
  process.stdout.write(JSON.stringify({ mode: 'synthetic-http-fixtures', origin: fixture.origin, serverId: fixture.serverId, nativeQualified: false, durationMs: options.durationMs ?? 1800000 }) + '\n');
  const shutdown = () => { fixture.stop().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
main().catch(error => { process.stderr.write('Fixture runner: ' + (error.code ?? error.message) + '\n'); process.exitCode = 1; });
