// Watches all reachable players via long-polling (/Volume and /Status, as documented in the
// BluOS API) and logs volume, input and format changes. Used to find out what changes the
// soundbar volume and when HDMI audio starts with a wrong sample rate.

import { setTimeout as sleep } from 'node:timers/promises';
import { bluosGet } from './bluos.ts';
import { discover, probeHosts } from './discovery.ts';
import { devices, events } from './store.ts';
import { onVolumeChange } from './guard.ts';
import { onPlaybackChange, onVolumeAfterStart } from './tvstart.ts';
import { claimVolume } from './origin.ts';
import { latest } from './snapshot.ts';

// Name of the group a member belongs to, from the last read setup.
function groupOf(mac: string): string | undefined {
  const z = latest.current?.zones.find((x) => x.members.some((m) => m.mac === mac) || x.sub?.mac === mac
    || x.dynamicSlaves.some((s) => s.mac === mac));
  return z ? (z.groupName ?? z.leader.name) : undefined;
}

const LONG_POLL_S = 100;
const RESCAN_MS = 5 * 60_000;

interface Watch { mac: string; host: string; name: string; stop: boolean }
const watches = new Map<string, Watch>();

const text = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'object' ? String((v as any)['#text'] ?? '') : String(v));

async function longPoll(w: Watch, path: string, onChange: (body: any, first: boolean) => void) {
  let etag = '';
  let first = true;
  while (!w.stop) {
    const started = Date.now();
    try {
      const body = await bluosGet(w.host, path, etag ? { timeout: LONG_POLL_S, etag } : undefined, (LONG_POLL_S + 10) * 1000);
      const root = body.volume ?? body.status;
      const next = root?.etag ?? '';
      if (next !== etag) { onChange(body, first); first = false; }
      etag = next;
    } catch {
      await sleep(10_000); // player offline (e.g. moved into a home cinema subnet) or restarting
      etag = '';
    }
    // The API requires at least one second between consecutive requests for the same resource.
    const elapsed = Date.now() - started;
    if (elapsed < 1000) await sleep(1000 - elapsed);
  }
}

let onGroupingChange: () => void = () => {};

function watch(mac: string, host: string, name: string) {
  const w: Watch = { mac, host, name, stop: false };
  watches.set(mac, w);
  const log = (kind: string, detail: string) => events.add({ mac, player: w.name, kind, detail });

  let vol: { level: string; mute: string } | undefined;
  longPoll(w, '/Volume', (body, first) => {
    const v = body.volume;
    const now = { level: text(v), mute: v.mute ?? '0' };
    if (!first && vol && (now.level !== vol.level || now.mute !== vol.mute)) {
      const parts = [`${vol.level} → ${now.level}`, `${v.db} dB`];
      if (now.mute !== vol.mute) parts.push(now.mute === '1' ? 'muted' : 'unmuted');
      const source = (!v.source && claimVolume(w.host, Number(now.level))) || v.source || '';
      // "Master": a group member mirroring its leader's volume, not a change of its own.
      const group = source === 'Master' ? groupOf(mac) : undefined;
      parts.push(source === 'Master' ? `follows group volume of "${group ?? 'leader'}"` : `source: ${source || '(none)'}`);
      log('volume', parts.join(', '));
      if (now.mute === vol.mute) {
        const change = { mac, host: w.host, player: w.name, from: Number(vol.level), to: Number(now.level), source, t: Date.now() };
        onVolumeChange(change);
        onVolumeAfterStart(change);
      }
    }
    vol = now;
  });

  let input = '';
  let syncStat = '';
  longPoll(w, '/Status', (body, first) => {
    const s = body.status ?? {};
    // syncStat changes when the player's name, volume or grouping changes (BluOS API 2.1).
    const ss = text(s.syncStat);
    if (!first && syncStat && ss !== syncStat) onGroupingChange();
    syncStat = ss;
    const desc = [s.state, s.service, s.inputId, s.title1, s.streamFormat, s.quality].map(text).filter(Boolean).join(' | ');
    if (desc !== input) {
      log('playback', desc || '(idle)');
      onPlaybackChange(mac, w.host, w.name, {
        state: text(s.state), service: text(s.service), inputId: text(s.inputId), title: text(s.title1),
        format: text(s.streamFormat) || text(s.quality),
      });
    }
    input = desc;
  });
}

async function refresh(full: boolean) {
  const lan = full ? await discover() : await probeHosts(devices.list().map((d) => d.lastIp).filter(Boolean));
  for (const p of lan.values()) {
    const w = watches.get(p.mac);
    if (w) { w.host = p.host; continue; }
    watch(p.mac, p.host, devices.list().find((d) => d.mac === p.mac)?.name ?? p.name);
  }
}

export function startMonitor(logWarn: (msg: string) => void, groupingChanged: () => void) {
  onGroupingChange = groupingChanged;
  let n = 0;
  const loop = async () => {
    // Every 30 minutes also re-read the setup, so group changes are logged even without a syncStat change.
    const full = n++ % 6 === 0;
    try { await refresh(full); if (full && n > 1) onGroupingChange(); } catch (e: any) { logWarn(`Monitor refresh failed: ${e.message}`); }
    setTimeout(loop, RESCAN_MS);
  };
  loop();
}
