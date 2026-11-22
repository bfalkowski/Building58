// The container's first process after tini (docker/start.sh). Docker delivers each connection from its
// own network address, and the relay's local-only check refuses those. So the relay listens on
// 127.0.0.1 inside the container, and this passes each connection on FORWARD_PORT to it from 127.0.0.1.
// The boundary is then the port compose.yaml publishes, on the host's 127.0.0.1 only
// (docs/manual/how-it-works.html#guards).
//
// It starts the relay as its child and ends with it, so the container stops when either one stops.
'use strict';
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const RELAY_PORT = Number(process.env.PORT || 8787);
const FORWARD_PORT = Number(process.env.FORWARD_PORT || 8800);

const relay = spawn(process.execPath, [path.join(__dirname, 'server.js')], { stdio: 'inherit' });
let failed = false;
relay.on('exit', (code, signal) => process.exit(failed ? 1 : code === null ? (signal === 'SIGTERM' ? 0 : 1) : code));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => relay.kill(sig));

const server = net.createServer((client) => {
  const to = net.connect(RELAY_PORT, '127.0.0.1');
  const end = () => { client.destroy(); to.destroy(); };
  client.on('error', end); to.on('error', end);
  client.on('close', end); to.on('close', end);
  client.pipe(to).pipe(client);
});
server.on('error', (e) => { console.error('The forwarder cannot listen on port ' + FORWARD_PORT + ': ' + e.message); failed = true; relay.kill('SIGTERM'); });
server.listen(FORWARD_PORT, '0.0.0.0', () => console.log('Forwarding port ' + FORWARD_PORT + ' in the container to the relay on 127.0.0.1:' + RELAY_PORT + '.'));
