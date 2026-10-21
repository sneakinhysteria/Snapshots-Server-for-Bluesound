// Reads the current speaker layout into a Snapshot. Speakers are identified by MAC,
// because home cinema members change IP (they move to the soundbar's private subnet).

import {
  getSlaveLevel, getVolume, memberSyncStatus,
  type SyncStatus, type VolumeState,
} from './bluos.ts';
import { discover } from './discovery.ts';
import { devices, events, kv } from './store.ts';
import { readSettings, SKIPPED_SETTINGS, type StoredSetting } from './settings.ts';

export interface SnapshotMember {
  mac: string;
  name: string;
  model: string;
  channelMode: string;
  distance?: number;
  levelDb: number;
}

export interface SnapshotZone {
  leader: { mac: string; name: string; model: string; channelMode?: string; distance?: number };
  groupName?: string;                       // fixed group name (e.g. "Stereo", "Living Room")
  members: SnapshotMember[];                // fixed group members (stereo partner, surrounds)
  sub?: { mac: string; name: string; levelDb: number };
  dynamicSlaves: { mac: string; name: string }[];
  volume: VolumeState;
  settings: StoredSetting[];                // audio/sub settings of all speakers in the zone
  airplayName?: string;                     // AirPlay 2 receiver offered while this zone is active
}

/** Last setup read from the speakers (refresh, scan, background update or end of a recall); persisted. */
export const latest: { current?: Snapshot } = { current: kv.get<Snapshot>('current') };
export function setLatest(current: Snapshot) {
  if (latest.current) logGroupChanges(latest.current, current);
  latest.current = current;
  kv.set('current', current);
}

const CHANNEL: Record<string, string> = {
  front: 'front', left: 'left channel', right: 'right channel', side_left: 'left surround', side_right: 'right surround',
  rear_left: 'left rear', rear_right: 'right rear',
};

/** Each speaker's place in a setup, e.g. 'right surround in "Home Theater"'. */
export function roles(s: Snapshot): Map<string, string> {
  const out = new Map<string, string>();
  for (const z of s.zones) {
    if (z.groupName || z.members.length) {
      // Fixed group (stereo pair, home cinema): the group has a name of its own.
      const label = `"${z.groupName ?? z.leader.name}"`;
      out.set(z.leader.mac, `leader of ${label}`);
      for (const m of z.members) out.set(m.mac, `${CHANNEL[m.channelMode] ?? 'member'} in ${label}`);
      if (z.sub) out.set(z.sub.mac, `subwoofer in ${label}`);
    } else {
      // A single player, possibly with a paired sub: name the speakers, not a group.
      const extras = [
        z.sub && `with subwoofer ${z.sub.name}`,
        z.dynamicSlaves.length && `grouped with ${z.dynamicSlaves.map((d) => d.name).join(', ')}`,
      ].filter(Boolean);
      out.set(z.leader.mac, ['standalone', ...extras].join(', '));
      if (z.sub) out.set(z.sub.mac, `subwoofer of ${z.leader.name}`);
    }
    for (const d of z.dynamicSlaves) out.set(d.mac, `grouped with "${z.groupName ?? z.leader.name}"`);
  }
  return out;
}

// Speakers leaving or joining groups, or disappearing, are logged so dropouts can be traced later.
function logGroupChanges(before: Snapshot, after: Snapshot) {
  const a = roles(before), b = roles(after);
  for (const mac of new Set([...a.keys(), ...b.keys()])) {
    const was = a.get(mac), now = b.get(mac);
    if (was === now) continue;
    const player = devices.list().find((d) => d.mac === mac)?.name ?? mac;
    const detail = !now ? `not found (was ${was})` : !was ? `found again: ${now}` : `${was} → ${now}`;
    events.add({ mac, player, kind: 'group', detail });
  }
}

export interface Snapshot {
  version: 1;
  capturedAt: string;
  zones: SnapshotZone[];
}

export async function resolveMac(leader: SyncStatus, m: { id: string; port: number; name?: string }, lan: Map<string, SyncStatus>) {
  for (const p of lan.values()) if (p.host === m.id) return { mac: p.mac, name: p.name, model: p.modelName };
  try {
    const s = await memberSyncStatus(leader.host, m);
    if (s.mac) {
      const prev = devices.list().find((d) => d.mac === s.mac);
      if (prev) devices.upsert({ mac: s.mac, name: prev.name, model: s.modelName || prev.model, modelCode: s.model, version: s.version, lastIp: prev.lastIp });
      if (prev && !prev.foundBy) devices.setFoundBy(s.mac, 'group leader');
      if (prev) devices.setDirect(s.mac, m.id, leader.mac); // reachable only through this leader
      return { mac: s.mac, name: s.name, model: s.modelName };
    }
  } catch {
    // fall back to the registry below
  }
  const byName = devices.list().find((d) => d.name === m.name);
  if (byName) return { mac: byName.mac, name: byName.name, model: byName.model };
  throw new Error(`Cannot identify group member ${m.name || m.id} of ${leader.name}`);
}

export const macResolver = (leader: SyncStatus, lan: Map<string, SyncStatus>) =>
  (ip: string) => resolveMac(leader, { id: ip, port: 11000 }, lan);

async function captureZone(leader: SyncStatus, lan: Map<string, SyncStatus>): Promise<SnapshotZone> {
  const settings = await readSettings(leader, macResolver(leader, lan));
  const known = devices.list().find((d) => d.mac === leader.mac);
  const zone: SnapshotZone = {
    leader: {
      mac: leader.mac,
      name: leader.group ? (known?.name ?? leader.name) : leader.name,
      model: leader.modelName,
      channelMode: leader.channelMode,
      distance: leader.distance,
    },
    groupName: leader.group,
    members: [],
    dynamicSlaves: [],
    volume: await getVolume(leader.host),
    settings,
  };

  for (const m of leader.members) {
    const id = await resolveMac(leader, m, lan);
    const levelDb = await getSlaveLevel(leader.host, m).catch(() => 0);
    if (m.isSub) zone.sub = { mac: id.mac, name: id.name, levelDb };
    else zone.members.push({ mac: id.mac, name: id.name, model: id.model, channelMode: m.channelMode, distance: m.distance, levelDb });
  }
  for (const s of leader.slaves) {
    const id = await resolveMac(leader, s, lan);
    zone.dynamicSlaves.push({ mac: id.mac, name: id.name });
  }
  return zone;
}

/** Players that are not members of another player's group. */
export function roots(lan: Map<string, SyncStatus>): SyncStatus[] {
  return [...lan.values()].filter((p) => !p.master);
}

export async function captureSnapshot(lan?: Map<string, SyncStatus>): Promise<Snapshot> {
  const players = lan ?? (await discover());
  const zones: SnapshotZone[] = [];
  for (const p of roots(players)) zones.push(await captureZone(p, players));
  zones.sort((a, b) => a.leader.name.localeCompare(b.leader.name));
  return { version: 1, capturedAt: new Date().toISOString(), zones };
}

/** Key describing a zone's layout (not volumes); equal keys mean the zone needs no rebuild. */
export const isSurround = (z: SnapshotZone) => z.members.some((m) => !['left', 'right'].includes(m.channelMode));

// Distances are part of the layout for surround groups: they can only be set when the group is created.
export function zoneKey(z: SnapshotZone): string {
  const dist = (d?: number) => (isSurround(z) ? `@${(d ?? 0).toFixed(1)}` : '');
  return JSON.stringify([
    z.leader.mac, z.leader.channelMode ?? '', z.groupName ?? '', dist(z.leader.distance),
    z.members.map((m) => `${m.mac}:${m.channelMode}${dist(m.distance)}`).sort(),
    z.sub?.mac ?? '',
    z.dynamicSlaves.map((s) => s.mac).sort(),
  ]);
}

export function zoneMacs(z: SnapshotZone): string[] {
  return [z.leader.mac, ...z.members.map((m) => m.mac), ...(z.sub ? [z.sub.mac] : []), ...z.dynamicSlaves.map((s) => s.mac)];
}

export interface ZoneEdit {
  leaderMac: string;
  airplayName?: string;
  leaderDistance?: number;
  volume?: { level: number; mute: boolean };
  members?: { mac: string; levelDb?: number; distance?: number }[];
  sub?: { levelDb: number };
  settings?: { owner: string; name: string; value: string }[];
}

const bad = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });
const checkNum = (v: unknown, min: number, max: number, what: string) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw bad(`${what} must be between ${min} and ${max}`);
  return v;
};

function checkSetting(s: StoredSetting, value: unknown): string {
  if (typeof value !== 'string' || value.length > 50) throw bad(`${s.label}: invalid value`);
  const m = s.meta;
  if (!m) return value;
  if (m.options && !m.options.some((o) => o.value === value)) throw bad(`${s.label}: ${value} is not an allowed value`);
  const lo = m.min ?? -Infinity, hi = m.max ?? Infinity;
  if (m.type === 'range') checkNum(Number(value), lo, hi, s.label);
  if (m.type === 'dual-range') {
    const [a, b] = value.split(',').map(Number);
    checkNum(a, lo, hi, s.label); checkNum(b, lo, hi, s.label);
    if (a > b) throw bad(`${s.label}: lower limit above upper limit`);
  }
  return value;
}

/** Applies edited values to a stored snapshot. Only values change; the layout stays as captured. */
export function applyEdits(snapshot: Snapshot, edits: ZoneEdit[]): Snapshot {
  const next: Snapshot = structuredClone(snapshot);
  for (const e of edits) {
    const z = next.zones.find((x) => x.leader.mac === e.leaderMac);
    if (!z) throw bad(`Unknown zone ${e.leaderMac}`);
    if (e.airplayName !== undefined) {
      const n = String(e.airplayName).trim();
      if (n.length > 50) throw bad('AirPlay name is too long');
      if (n) z.airplayName = n; else delete z.airplayName;
    }
    if (e.leaderDistance !== undefined) z.leader.distance = checkNum(e.leaderDistance, 0, 30, 'Distance');
    if (e.volume) {
      const level = checkNum(e.volume.level, 0, 100, 'Volume');
      z.volume = e.volume.mute ? { level: 0, mute: true, muteLevel: level } : { level, mute: false };
    }
    for (const me of e.members ?? []) {
      const m = z.members.find((x) => x.mac === me.mac);
      if (!m) throw bad(`Unknown member ${me.mac}`);
      if (me.levelDb !== undefined) m.levelDb = checkNum(me.levelDb, -10, 10, 'Level');
      if (me.distance !== undefined) m.distance = checkNum(me.distance, 0, 30, 'Distance');
    }
    if (e.sub && z.sub) z.sub.levelDb = checkNum(e.sub.levelDb, -10, 10, 'Sub level');
    for (const se of e.settings ?? []) {
      const s = z.settings.find((x) => x.owner === se.owner && x.name === se.name);
      if (!s) throw bad(`Unknown setting ${se.name}`);
      // Only changed values are validated, so a stored value the speaker no longer lists never blocks a save.
      if (se.value !== s.value) s.value = checkSetting(s, se.value);
    }
  }
  return next;
}

const MAC = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
const CHANNELS = new Set(['front', 'left', 'right', 'side_left', 'side_right', 'rear_left', 'rear_right']);
const str = (v: unknown, what: string, max = 100) => {
  if (typeof v !== 'string' || v.length > max) throw bad(`${what} must be a text of at most ${max} characters`);
  return v;
};
const mac = (v: unknown, what: string) => {
  const m = str(v, what).toUpperCase();
  if (!MAC.test(m)) throw bad(`${what} is not a MAC address`);
  return m;
};
const optNum = (v: unknown, min: number, max: number, what: string) => (v === undefined || v === null ? undefined : checkNum(v, min, max, what));

const META_TYPES = new Set(['boolean', 'list', 'range', 'dual-range']);
function cleanMeta(m: any, at: string): StoredSetting['meta'] {
  if (!m || typeof m !== 'object') return undefined;
  if (!META_TYPES.has(m.type)) throw bad(`${at}: unknown setting type ${m.type}`);
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const options = Array.isArray(m.options)
    ? m.options.slice(0, 100).map((o: any) => ({ value: str(o?.value, `${at}: option`, 50), label: str(o?.label ?? o?.value, `${at}: option label`) }))
    : undefined;
  return { type: m.type, options, min: n(m.min), max: n(m.max), step: n(m.step) };
}

/** Validates snapshot data from outside (import) and returns a clean copy with only known fields. */
export function validateSnapshot(input: unknown): Snapshot {
  const d = input as any;
  if (!d || typeof d !== 'object' || d.version !== 1 || !Array.isArray(d.zones) || !d.zones.length) throw bad('data must be a snapshot (version 1 with zones)');
  if (d.zones.length > 20) throw bad('Too many zones');
  const seen = new Set<string>();
  const once = (m: string) => { if (seen.has(m)) throw bad(`Speaker ${m} appears more than once`); seen.add(m); return m; };
  const zones: SnapshotZone[] = d.zones.map((z: any, i: number) => {
    const at = `Zone ${i + 1}`;
    if (!z || typeof z !== 'object' || !z.leader || !z.volume) throw bad(`${at}: leader and volume are required`);
    const members = Array.isArray(z.members) ? z.members : [];
    const slaves = Array.isArray(z.dynamicSlaves) ? z.dynamicSlaves : [];
    const settings = Array.isArray(z.settings) ? z.settings : [];
    if (members.length > 10 || slaves.length > 20 || settings.length > 300) throw bad(`${at}: too many entries`);
    const level = checkNum(z.volume.level, 0, 100, `${at}: volume`);
    const zone: SnapshotZone = {
      leader: {
        mac: once(mac(z.leader.mac, `${at}: leader MAC`)), name: str(z.leader.name, `${at}: leader name`), model: str(z.leader.model ?? '', `${at}: leader model`),
        channelMode: z.leader.channelMode === undefined ? undefined : str(z.leader.channelMode, `${at}: leader channel`, 20),
        distance: optNum(z.leader.distance, 0, 30, `${at}: leader distance`),
      },
      groupName: z.groupName === undefined || z.groupName === null ? undefined : str(z.groupName, `${at}: group name`),
      members: members.map((m: any) => {
        if (!CHANNELS.has(m?.channelMode)) throw bad(`${at}: unknown channel ${m?.channelMode}`);
        return {
          mac: once(mac(m.mac, `${at}: member MAC`)), name: str(m.name, `${at}: member name`), model: str(m.model ?? '', `${at}: member model`),
          channelMode: m.channelMode, distance: optNum(m.distance, 0, 30, `${at}: distance`), levelDb: checkNum(m.levelDb ?? 0, -10, 10, `${at}: level`),
        };
      }),
      sub: z.sub ? { mac: once(mac(z.sub.mac, `${at}: sub MAC`)), name: str(z.sub.name, `${at}: sub name`), levelDb: checkNum(z.sub.levelDb ?? 0, -10, 10, `${at}: sub level`) } : undefined,
      dynamicSlaves: slaves.map((x: any) => ({ mac: once(mac(x?.mac, `${at}: grouped speaker MAC`)), name: str(x.name, `${at}: grouped speaker name`) })),
      volume: z.volume.mute ? { level: 0, mute: true, muteLevel: checkNum(z.volume.muteLevel ?? level, 0, 100, `${at}: volume`) } : { level, mute: false },
      settings: settings.map((x: any) => {
        const st: StoredSetting = {
          owner: mac(x?.owner, `${at}: setting owner`), ownerName: str(x.ownerName ?? '', `${at}: setting owner name`),
          name: str(x.name, `${at}: setting name`, 50), label: str(x.label ?? x.name, `${at}: setting label`), value: '',
          meta: cleanMeta(x.meta, at),
        };
        if (SKIPPED_SETTINGS.has(st.name)) throw bad(`${at}: setting ${st.name} cannot be stored`);
        st.value = checkSetting(st, x.value);
        return st;
      }),
    };
    if (z.airplayName) zone.airplayName = str(z.airplayName, `${at}: AirPlay name`, 50).trim() || undefined;
    return zone;
  });
  return { version: 1, capturedAt: typeof d.capturedAt === 'string' && !isNaN(Date.parse(d.capturedAt)) ? d.capturedAt : new Date().toISOString(), zones };
}

/** Keeps user-set values that a fresh capture does not contain (AirPlay names). */
export function carryOver(previous: Snapshot, fresh: Snapshot): Snapshot {
  for (const z of fresh.zones) {
    const old = previous.zones.find((o) => o.leader.mac === z.leader.mac);
    if (old?.airplayName) z.airplayName = old.airplayName;
  }
  return fresh;
}

/** Adds missing setting metadata (allowed values) to stored snapshots from a live read. */
export function backfillMeta(stored: Snapshot, live: Snapshot): Snapshot | undefined {
  const liveMeta = new Map(live.zones.flatMap((z) => z.settings).filter((s) => s.meta).map((s) => [`${s.owner}|${s.name}`, s.meta!]));
  let changed = false;
  for (const z of stored.zones) for (const s of z.settings) {
    const m = !s.meta && liveMeta.get(`${s.owner}|${s.name}`);
    if (m) { s.meta = m; changed = true; }
  }
  return changed ? stored : undefined;
}

/** A snapshot is active when every zone in it matches the current layout (volume, levels and settings ignored). */
export function isActive(stored: Snapshot, current: Snapshot): boolean {
  const keys = new Set(current.zones.map(zoneKey));
  return stored.zones.every((z) => keys.has(zoneKey(z)));
}
