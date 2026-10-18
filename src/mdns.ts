// Announces the server via mDNS/Bonjour (_bluossnapshots._tcp), so the iOS/tvOS apps find it
// without an address. Uses avahi-publish, i.e. the host's Avahi when its D-Bus is mounted.

import { spawn, spawnSync } from 'node:child_process';
import { hostname } from 'node:os';

export const SERVICE_TYPE = '_bluossnapshots._tcp';

export function startMdns(port: number, warn: (msg: string) => void) {
  if (process.env.MDNS === 'off') return;
  if (spawnSync('avahi-publish', ['--help']).error) { warn('avahi-publish not found: server not announced via mDNS'); return; }
  const name = process.env.MDNS_NAME || `Snapshots Server for Bluesound on ${hostname()}`;
  const txt = [`version=${process.env.APP_COMMIT || 'dev'}`, 'path=/api'];
  let delay = 5_000;
  const run = () => {
    const started = Date.now();
    const proc = spawn('avahi-publish', ['-s', name, SERVICE_TYPE, String(port), ...txt], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => { err = (err + d).slice(-300); });
    proc.on('exit', (code) => {
      // Avahi not reachable yet or restarted: try again, backing off up to 5 minutes.
      delay = Date.now() - started > 60_000 ? 5_000 : Math.min(delay * 2, 300_000);
      warn(`mDNS announcement stopped (${code}): ${err.trim().split('\n').pop() ?? ''}; retrying in ${delay / 1000} s`);
      setTimeout(run, delay);
    });
  };
  run();
}
