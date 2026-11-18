#!/usr/bin/env node
// Development MCP entry: human-approved enrollment, no credential files or argv.
import { serveMcpStdio } from '../src/caddi/clients/mcp.mjs';
import { connectDesktopClient, createDesktopMcpSession } from '../src/caddi/desktop/mcp.mjs';
import { createLazyDesktopClient } from '../src/caddi/desktop/lazy-client.mjs';

const args = process.argv.slice(2), options = {}, controller = new AbortController();
let client, session, server;
const stop = () => { controller.abort(); server?.close(); session?.close(); client?.close(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  for (let index = 0; index < args.length; index += 2) {
    if (!['--socket', '--rendezvous', '--name'].includes(args[index]) || !args[index + 1] || options[args[index]]) throw new Error('options');
    options[args[index]] = args[index + 1];
  }
  if (!!options['--socket'] === !!options['--rendezvous']) {
    process.stderr.write('Usage: node scripts/caddi-desktop-client.mjs (--rendezvous <private-runtime-descriptor> | --socket <temporary-enrollment-socket>) [--name <display-name>]\n');
    process.exitCode = 2;
  } else {
    const clientName = options['--name'] ?? 'Coding agent';
    const connect = ({ onPending } = {}) => connectDesktopClient({
      socketPath: options['--socket'], rendezvousPath: options['--rendezvous'], clientName, signal: controller.signal, onPending });
    const announce = ({ comparisonCode }) => {
      process.stderr.write('Caddi connection code: ' + comparisonCode + '. Compare this code in Caddi before approving this session, workspace and origins. The display name is unverified; restarting Caddi requires a new approval.\n');
    };
    // A coding tool gives its MCP servers a short time to answer, and approval is a person's step. Answer at once;
    // ask for approval with the first tool call (see lazy-client.mjs).
    client = createLazyDesktopClient({ connect, clientName, onPending: announce });
    session = createDesktopMcpSession({ client });
    server = serveMcpStdio({ input: process.stdin, output: process.stdout, session });
  }
} catch (error) {
  stop();
  const code = /^[A-Z0-9_]{1,64}$/.test(error.code ?? '') ? error.code : 'CADDI_CLIENT_ERROR';
  process.stderr.write(code + ': Desktop connection ended. No credential or page content was printed.\n');
  process.exitCode = 2;
}
