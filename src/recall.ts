// Recreates a stored snapshot: dissolve groups that differ, wait for the speakers to return
// to the LAN, rebuild fixed groups and sub pairings, restore levels and volume, then verify.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { BLUOS_PORT, bluosGet, bluosPost, memberSyncStatus, setSlaveLevel, setVolume, syncStatus, type SyncStatus } from './bluos.ts';
import { selfUrl } from './stream.ts';
import { expectVolume } from './origin.ts';
import { reconcileAirplay } from './airplay.ts';
import { discover, probeHosts } from './discovery.ts';
import { captureSnapshot, isSurround, macResolver, setLatest, resolveMac, zoneKey, zoneMacs, type Snapshot, type SnapshotZone } from './snapshot.ts';
import { diffSettings, restoreSettings } from './settings.ts';
import { devices } from './store.ts';

export interface Job {
  id: string;
  snapshotId: number;
  snapshotName: string;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt?: string;
  log: { t: string; level: 'info' | 'warn' | 'error'; msg: string }[];
  differences: string[];
  after?: Snapshot;      // setup read back at the end of the recall
}

const jobs = new Map<string, Job>();
let running: Job | undefined;

let last: Job | undefined;
export const getJob = (id: string) => jobs.get(id);
export const runningJob = () => running;
export const lastJob = () => last;

const DISSOLVE_TIMEOUT_MS = 180_000;
const GROUP_TIMEOUT_MS = 60_000;
// Speakers leaving a home cinema group need time before they can form a working group again
// (the BluOS app took ~45 s; grouping after 15 s produced a pair that never started playback).
const SETTLE_AFTER_SURROUND_MS = 30_000;
const PLAYBACK_CHECK_MS = 20_000;

export function startRecall(snapshotId: number, snapshotName: string, target: Snapshot): Job {
  if (running) throw new Error(`Recall of "${running.snapshotName}" is still running`);
  const job: Job = {
    id: randomUUID(), snapshotId, snapshotName, status: 'running',
    startedAt: new Date().toISOString(), log: [], differences: [],
  };
  jobs.set(job.id, job);
  running = job;
  last = job;
  const log = (msg: string, level: Job['log'][number]['level'] = 'info') =>
    job.log.push({ t: new Date().toISOString(), level, msg });

  recall(target, log, job)
    .then(() => { job.status = job.differences.length ? 'failed' : 'done'; })
    .catch((e) => { log(String(e?.message ?? e), 'error'); job.status = 'failed'; })
    .finally(() => { job.finishedAt = new Date().toISOString(); running = undefined; });
  return job;
}

type Log = (msg: string, level?: 'info' | 'warn' | 'error') => void;

async function waitFor<T>(what: string, timeoutMs: number, check: (attempt: number) => Promise<T | undefined>): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    const r = await check(attempt).catch(() => undefined);
    if (r !== undefined) return r;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await sleep(3000);
  }
}

// Group changes can take longer than a normal request (the soundbar moves members to its own subnet).
// A timeout is not fatal: the outcome is checked by polling SyncStatus afterwards.
async function groupCommand(host: string, path: string, params: Record<string, string | number | undefined>, log: Log) {
  try {
    await bluosGet(host, path, params, 30_000);
  } catch (e: any) {
    if (e?.name !== 'TimeoutError') throw e;
    log(`${path} on ${host} did not answer within 30 s, checking result`, 'warn');
  }
}

const isFree = (p: SyncStatus) => !p.master && p.members.length === 0 && p.slaves.length === 0;

async function dissolve(leader: SyncStatus, log: Log) {
  const fixed = leader.members.filter((m) => !m.isSub);
  const subs = leader.members.filter((m) => m.isSub);
  if (fixed.length) {
    log(`Dissolving "${leader.name}"`);
    if (leader.zoneUngroup) await groupCommand(leader.host, leader.zoneUngroup, {}, log);
    else await groupCommand(leader.host, '/RemoveSlave', {
      slaves: fixed.map((m) => m.id).join(','), ports: fixed.map((m) => m.port).join(','),
    }, log);
  }
  for (const s of leader.slaves) {
    log(`Removing ${s.id} from group "${leader.name}"`);
    await groupCommand(leader.host, '/RemoveSlave', { slave: s.id, port: s.port }, log);
  }
  for (const s of subs) {
    log(`Unpairing ${s.name} from "${leader.name}"`);
    await groupCommand(leader.host, '/RemoveSlave', { slave: s.id, port: s.port }, log);
  }
}

async function waitUntilFree(macs: string[], log: Log): Promise<Map<string, SyncStatus>> {
  log(`Waiting for ${macs.length} speaker(s) to be ungrouped and reachable`);
  return waitFor('speakers to return to the LAN', DISSOLVE_TIMEOUT_MS, async (attempt) => {
    const known = devices.list().filter((d) => macs.includes(d.mac)).map((d) => d.lastIp).filter(Boolean);
    const lan = attempt % 5 === 4 ? await discover() : await probeHosts(known);
    const ready = macs.every((m) => { const p = lan.get(m); return p && isFree(p); });
    return ready ? lan : undefined;
  });
}

// A member that misses the ungroup command can stay on the soundbar's private network and only
// comes back after a factory reset. So every member must answer before anything is changed.
async function checkResponding(toDissolve: SyncStatus[], needed: string[], lan: Map<string, SyncStatus>, log: Log) {
  const nameOf = (mac: string, fallback: string) => devices.list().find((d) => d.mac === mac)?.name ?? fallback;
  const fail = (name: string) => {
    throw new Error(`${name} doesn't respond. Nothing was changed. Restart it, wait until it plays again, then recall.`);
  };
  const ok = new Set(lan.keys());
  for (const leader of toDissolve) {
    for (const m of [...leader.members, ...leader.slaves]) {
      const onLan = [...lan.values()].find((p) => p.host === m.id && m.port === BLUOS_PORT);
      if (onLan) continue;
      const s = await memberSyncStatus(leader.host, m).catch(() => undefined);
      if (!s?.mac) fail(`${'name' in m && m.name ? m.name : m.id} (in "${leader.name}")`);
      ok.add(s!.mac);
    }
  }
  for (const mac of needed) if (!ok.has(mac)) fail(nameOf(mac, mac));
  log('All speakers respond');
}

function hostOf(lan: Map<string, SyncStatus>, mac: string, name: string): string {
  const p = lan.get(mac);
  if (!p) throw new Error(`${name} (${mac}) not found on the network`);
  return p.host;
}

async function build(z: SnapshotZone, lan: Map<string, SyncStatus>, log: Log) {
  const leaderHost = hostOf(lan, z.leader.mac, z.leader.name);
  const label = z.groupName ?? z.leader.name;

  if (z.members.length) {
    const surround = isSurround(z);
    log(`Creating "${label}": ${z.leader.name} (${z.leader.channelMode}) + ${z.members.map((m) => `${m.name} (${m.channelMode})`).join(', ')}`);
    // Parameter set mirrors the BluOS app: distances are only sent for surround setups.
    await groupCommand(leaderHost, '/AddSlave', {
      channelMode: z.leader.channelMode,
      distance: surround ? z.leader.distance : undefined,
      group: z.groupName,
      ports: z.members.map(() => 11000).join(','),
      slaveChannelMode: z.members.map((m) => m.channelMode).join(','),
      slaveDistance: surround ? z.members.map((m) => m.distance ?? 0).join(',') : undefined,
      slaves: z.members.map((m) => hostOf(lan, m.mac, m.name)).join(','),
    }, log);
    await waitFor(`"${label}" to form`, GROUP_TIMEOUT_MS, async () => {
      const s = await syncStatus(leaderHost);
      return s.members.filter((m) => !m.isSub).length >= z.members.length ? s : undefined;
    });
  }

  if (z.sub) {
    log(`Pairing ${z.sub.name} with "${label}"`);
    await groupCommand(leaderHost, '/AddSlave', {
      pairSlave: 1, slave: hostOf(lan, z.sub.mac, z.sub.name), slaveChannelMode: 'subwoofer',
    }, log);
    await waitFor(`${z.sub.name} to pair`, GROUP_TIMEOUT_MS, async () => {
      const s = await syncStatus(leaderHost);
      return s.members.some((m) => m.isSub) ? s : undefined;
    });
  }

  for (const d of z.dynamicSlaves) {
    log(`Grouping ${d.name} with "${label}"`);
    await groupCommand(leaderHost, '/AddSlave', { slave: hostOf(lan, d.mac, d.name), port: 11000 }, log);
  }
}

// Plays inaudible noise at volume 0 and checks that playback advances. A group can look complete
// in SyncStatus yet stay in "connecting" for any real audio (it still "plays" digital silence);
// only a restart of its speakers helps.
type Input = { url: string; title: string };

// When the group was on an input (e.g. TV), switching back to it is the check: playing state with
// an audio format, twice in a row. Falls back to the noise check if the input stays silent.
async function inputPlays(leaderHost: string, input: Input, log: Log): Promise<boolean> {
  log(`Checking playback with input ${input.title}`);
  await bluosGet(leaderHost, '/Play', { url: input.url }, 15_000);
  let good = 0;
  for (const until = Date.now() + 10_000; Date.now() < until;) {
    await sleep(1500);
    const st = (await bluosGet(leaderHost, '/Status')).status ?? {};
    good = ['stream', 'play'].includes(st.state) && (st.quality || st.streamFormat) ? good + 1 : 0;
    if (good >= 2) return true;
  }
  return false;
}

async function playbackWorks(leaderHost: string, log: Log, input?: Input): Promise<boolean> {
  if (input && await inputPlays(leaderHost, input, log).catch(() => false)) return true;
  log('Checking playback (silent)');
  expectVolume(leaderHost, 0, 'Recall (silent check)');
  await bluosGet(leaderHost, '/Volume', { level: 0, tell_slaves: 0 });
  try {
    await bluosGet(leaderHost, '/Play', { url: `${selfUrl(leaderHost)}/stream/check.flac` }, 15_000);
    const until = Date.now() + PLAYBACK_CHECK_MS;
    while (Date.now() < until) {
      await sleep(2000);
      const st = (await bluosGet(leaderHost, '/Status')).status ?? {};
      if (['stream', 'play'].includes(st.state) && Number(st.secs) >= 2) return true;
    }
    return false;
  } finally {
    await bluosGet(leaderHost, '/Stop').catch(() => {});
  }
}

async function rebootSpeakers(macs: string[], lan: Map<string, SyncStatus>, log: Log) {
  for (const mac of macs) {
    const p = lan.get(mac);
    if (!p) continue;
    log(`Restarting ${p.name}`);
    await bluosPost(`${p.host}:80`, '/reboot', { yes: '1' }).catch((e) => log(`Restart of ${p.name} failed: ${e.message}`, 'warn'));
  }
  await sleep(15_000); // let them go offline before polling for their return
}

/**
 * Builds a zone (unless it already matches) and checks it plays; on failure restarts its speakers
 * once and builds again.
 */
async function buildChecked(z: SnapshotZone, lan: Map<string, SyncStatus>, log: Log, job: Job, alreadyBuilt = false, input?: Input): Promise<Map<string, SyncStatus>> {
  if (!alreadyBuilt) await build(z, lan, log);
  if (!z.members.length && !z.sub) return lan;
  const label = z.groupName ?? z.leader.name;
  if (await playbackWorks(hostOf(lan, z.leader.mac, z.leader.name), log, input)) return lan;

  log(`"${label}" does not start playback, restarting its speakers`, 'warn');
  const leader = await syncStatus(hostOf(lan, z.leader.mac, z.leader.name));
  await dissolve(leader, log);
  lan = await waitUntilFree(zoneMacs(z), log);
  await rebootSpeakers([z.leader.mac, ...z.members.map((m) => m.mac)], lan, log);
  lan = await waitUntilFree(zoneMacs(z), log);
  await build(z, lan, log);
  if (!(await playbackWorks(hostOf(lan, z.leader.mac, z.leader.name), log, input))) {
    job.differences.push(`"${label}": playback does not start, even after restarting its speakers`);
    log(`"${label}" still does not start playback`, 'error');
  }
  return lan;
}

async function restoreLevels(z: SnapshotZone, lan: Map<string, SyncStatus>, log: Log) {
  const leaderHost = hostOf(lan, z.leader.mac, z.leader.name);
  const leader = await syncStatus(leaderHost);
  for (const m of leader.members) {
    const { mac } = await resolveMac(leader, m, lan);
    const target = m.isSub ? (z.sub?.mac === mac ? z.sub.levelDb : undefined) : z.members.find((t) => t.mac === mac)?.levelDb;
    if (target === undefined) continue;
    await setSlaveLevel(leaderHost, m, target);
  }
  log(`Levels restored for "${z.groupName ?? z.leader.name}"`);
  for (const w of await restoreSettings(leader, z.settings ?? [], macResolver(leader, lan))) log(w);
  await setVolume(leaderHost, z.volume);
}

function compare(target: Snapshot, actual: Snapshot): string[] {
  const diffs: string[] = [];
  const actualByLeader = new Map(actual.zones.map((z) => [z.leader.mac, z]));
  for (const t of target.zones) {
    const a = actualByLeader.get(t.leader.mac);
    const label = t.groupName ?? t.leader.name;
    if (!a) { diffs.push(`"${label}": leader ${t.leader.name} is not a group leader`); continue; }
    if (zoneKey(a) !== zoneKey(t)) { diffs.push(`"${label}": layout differs from snapshot`); continue; }
    const level = (name: string, actual?: number, expected?: number) => {
      if (expected === undefined) return; // not known when the snapshot was taken, so nothing was restored
      if (actual === undefined) diffs.push(`"${label}": ${name} level could not be read, expected ${expected} dB`);
      else if (Math.abs(actual - expected) > 0.25) diffs.push(`"${label}": ${name} level ${actual} dB, expected ${expected} dB`);
    };
    for (const m of t.members) {
      const am = a.members.find((x) => x.mac === m.mac);
      if (am) level(m.name, am.levelDb, m.levelDb);
    }
    if (t.sub && a.sub) level(t.sub.name, a.sub.levelDb, t.sub.levelDb);
    for (const d of diffSettings(t.settings ?? [], a.settings)) diffs.push(`"${label}": ${d}`);
  }
  return diffs;
}

async function recall(target: Snapshot, log: Log, job: Job) {
  log('Reading current setup');
  let lan = await discover();
  const current = await captureSnapshot(lan);

  // Players on an input (TV/HDMI, optical, analog) are switched back to it at the end: the
  // playback check and regrouping leave them on another source, so TV sound would stay silent.
  const inputs = new Map<string, Input>();
  for (const p of lan.values()) {
    if (p.master) continue;
    const st = (await bluosGet(p.host, '/Status').catch(() => undefined))?.status;
    if (st?.service === 'Capture' && st.streamUrl) inputs.set(p.mac, { url: String(st.streamUrl), title: String(st.title1 ?? st.streamUrl) });
  }

  const targetKeys = new Set(target.zones.map(zoneKey));
  const keep = new Set(current.zones.filter((z) => targetKeys.has(zoneKey(z))).map(zoneKey));
  const rebuild = target.zones.filter((z) => !keep.has(zoneKey(z)));
  for (const z of target.zones) if (keep.has(zoneKey(z))) log(`"${z.groupName ?? z.leader.name}" already matches`);

  const toDissolve = current.zones.filter((z) => !keep.has(zoneKey(z)) && (z.members.length || z.sub || z.dynamicSlaves.length));
  const leaders = toDissolve.map((z) => lan.get(z.leader.mac)).filter((p): p is SyncStatus => !!p);
  const needed = [...new Set(rebuild.flatMap(zoneMacs))];
  await checkResponding(leaders, needed, lan, log);

  for (const leader of leaders) await dissolve(leader, log);

  if (needed.length) lan = await waitUntilFree(needed, log);
  if (needed.length && toDissolve.some(isSurround)) {
    log(`Letting speakers settle after leaving "${toDissolve.filter(isSurround).map((z) => z.groupName ?? z.leader.name).join('", "')}" (${SETTLE_AFTER_SURROUND_MS / 1000} s)`);
    await sleep(SETTLE_AFTER_SURROUND_MS);
  }

  for (const z of rebuild) {
    if (z.members.length || z.sub || z.dynamicSlaves.length) lan = await buildChecked(z, lan, log, job, false, inputs.get(z.leader.mac));
  }

  lan = await discover();
  // Groups that already matched are checked too: a recall of the active setup repairs a stuck group.
  for (const z of target.zones) {
    if (keep.has(zoneKey(z)) && (z.members.length || z.sub)) lan = await buildChecked(z, lan, log, job, true, inputs.get(z.leader.mac));
  }
  lan = await discover();
  for (const z of target.zones) {
    try {
      await restoreLevels(z, lan, log);
    } catch (e: any) {
      log(`Could not restore levels/settings for "${z.groupName ?? z.leader.name}": ${e.message}`, 'warn');
    }
  }

  for (const [mac, input] of inputs) {
    const p = lan.get(mac);
    if (!p) continue;
    // Already back on its input (the check used it): don't interrupt it again.
    const now = (await bluosGet(p.host, '/Status').catch(() => undefined))?.status;
    if (now?.streamUrl === input.url && ['stream', 'play'].includes(now.state)) continue;
    try {
      await bluosGet(p.host, '/Play', { url: input.url }, 15_000);
      log(`${devices.list().find((d) => d.mac === mac)?.name ?? p.name}: back to input ${input.title}`);
    } catch (e: any) {
      log(`Could not switch back to input ${input.title}: ${e.message}`, 'warn');
    }
  }

  log('Verifying');
  const after = await captureSnapshot(await discover());
  job.differences.push(...compare(target, after));
  job.after = after;
  setLatest(after);
  reconcileAirplay(after);
  if (job.differences.length) for (const d of job.differences) log(d, 'error');
  else log('Setup matches snapshot');
}
