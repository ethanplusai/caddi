#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { createBrokerClient } from '../src/caddi/clients/broker-client.mjs';
import { createMcpSession, serveMcpStdio, toBrokerRequest } from '../src/caddi/clients/mcp.mjs';

async function readBounded(stream, maximum, timeoutMs = 5000) {
  const chunks = []; let bytes = 0;
  const timer = setTimeout(() => stream.destroy(new Error('Input deadline exceeded')), timeoutMs);
  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > maximum) throw new Error('Input exceeds bound');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); }
}
const [mode, ...args] = process.argv.slice(2);
const options = {};
try {
  if (!['mcp', 'call'].includes(mode)) throw new Error('Usage: node scripts/caddi-client.mjs mcp|call --socket <private-socket> --credential-fd <inherited-fd>');
  for (let i = 0; i < args.length; i += 2) {
    if (!['--socket', '--credential-fd'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Invalid command options');
    options[args[i]] = args[i + 1];
  }
  const fd = Number(options['--credential-fd']);
  if (!options['--socket'] || !Number.isInteger(fd) || fd < 3 || fd > 255) throw new Error('Private socket and inherited credential FD >=3 are required');
  let used = false;
  const client = createBrokerClient({ socketPath: options['--socket'], credentialProvider: async () => {
    if (used) throw new Error('Credential descriptor already consumed');
    used = true;
    const bytes = await readBounded(createReadStream(null, { fd, autoClose: true }), 4096);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r?\n$/, ''); }
    finally { bytes.fill(0); }
  } });
  if (mode === 'mcp') {
    serveMcpStdio({ input: process.stdin, output: process.stdout, session: createMcpSession({ client }) });
  } else {
    try {
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(process.stdin, 65536)));
      const result = await client.request(toBrokerRequest(data.name, data.arguments));
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exitCode = result.status === 'completed' ? 0 : 2;
    } finally { client.close(); }
  }
} catch (error) {
  process.stderr.write((error.code && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'CADDI_CLIENT_ERROR') + ': ' +
    (error.message?.startsWith('Usage:') ? error.message : 'Client setup or request failed; credentials were not printed.') + '\n');
  process.exitCode = 2;
}
