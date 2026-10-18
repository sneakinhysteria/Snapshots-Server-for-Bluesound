// Audio and subwoofer settings of a zone, read from the leader's self-describing settings tree
// (/Settings?id=<page>). The leader's tree also covers its members and paired sub; their entries
// point at the member directly (http://ip:port/...) or via /proxyToSlave on the leader.
// Writes mirror the BluOS app: POST <url> with form body "<name>=<value>" (docs/capture).

import { XMLParser } from 'fast-xml-parser';
import { bluosGetText, bluosPost, type SyncStatus } from './bluos.ts';
import { devices } from './store.ts';

export interface SettingMeta {
  type: 'boolean' | 'list' | 'range' | 'dual-range';
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
}

export interface StoredSetting {
  owner: string;      // MAC of the speaker the setting belongs to
  ownerName: string;
  name: string;
  label: string;
  value: string;
  meta?: SettingMeta; // allowed values, used by the editor
}

interface LiveSetting extends StoredSetting {
  host: string;       // host[:port] to post to
  path: string;       // path (incl. query) to post to
}

const WRITABLE = new Set(['boolean', 'list', 'range', 'dual-range']);
// db: member balance / sub trim, handled through /SlaveVolume levels.
// I3DDisable: toggling Spatial Audio triggers a firmware upgrade on the player.
export const SKIPPED_SETTINGS = new Set(['db', 'I3DDisable', 'reset', 'unpair', 'swaplr', 'ungroup']);
const PAGES = /^(audio|subw|zone|zone_player-.+)$/;

// Settings use both a value attribute and <value> child elements, so attributes get a prefix here.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseAttributeValue: false,
  parseTagValue: false,
  isArray: (name) => ['setting', 'menuGroup', 'value'].includes(name),
});
const readPage = async (host: string, id?: string) =>
  parser.parse(await bluosGetText(host, '/Settings', id ? { id } : undefined)).settings;

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// Resolves a settings URL to the host to post to, the path, and the IP of the speaker it targets.
function target(url: string, leaderHost: string): { host: string; path: string; ip: string } {
  if (url.startsWith('http://')) {
    const u = new URL(url);
    return { host: u.host, path: u.pathname + u.search, ip: u.hostname };
  }
  const proxied = url.match(/^\/proxyToSlave\?slave=([^&]+)/);
  if (proxied) return { host: leaderHost, path: url, ip: decodeURIComponent(proxied[1]).split(':')[0] };
  return { host: leaderHost, path: url, ip: leaderHost };
}

interface RawSetting { name: string; label: string; value: string; meta: SettingMeta; host: string; path: string; ip: string }

function metaOf(item: any): SettingMeta {
  const values = asArray<any>(item.value);
  const options = values.filter((v) => v?.['@name'] !== undefined)
    .map((v) => ({ value: String(v['@name']), label: String(v['@displayName'] ?? v['@name']) }));
  const range = values.find((v) => v?.['@min'] !== undefined);
  const n = (x: unknown) => (x === undefined ? undefined : Number(x));
  const meta: SettingMeta = { type: item['@class'] };
  if (options.length) meta.options = options;
  else if (item['@class'] === 'boolean') meta.options = [{ value: 'ON', label: 'On' }, { value: 'OFF', label: 'Off' }];
  if (range) Object.assign(meta, { min: n(range['@min']), max: n(range['@max']), step: n(range['@step']) });
  return meta;
}

// Entries without a url (e.g. volume limits) are written to the url of their menu group.
function collect(node: any, inheritedUrl: string | undefined, leaderHost: string, out: RawSetting[]) {
  for (const item of [...asArray(node.menuGroup), ...asArray(node.setting)]) {
    const url = item['@url'] ?? inheritedUrl;
    const name = item['@name'];
    if (name && WRITABLE.has(item['@class']) && !SKIPPED_SETTINGS.has(name) && item['@readonly'] !== 'true' && url && item['@value'] !== undefined) {
      out.push({ name, label: item['@displayName'] ?? name, value: String(item['@value']), meta: metaOf(item), ...target(url, leaderHost) });
    }
    collect(item, url, leaderHost, out);
  }
}

async function readLive(leader: SyncStatus, macOfIp: (ip: string) => Promise<{ mac: string; name: string }>): Promise<LiveSetting[]> {
  const root = await readPage(leader.host);
  const pages: string[] = [];
  const findPages = (node: any) => {
    for (const g of asArray(node?.menuGroup)) {
      if (PAGES.test(g['@id'] ?? '') && !pages.includes(g['@id'])) pages.push(g['@id']);
      findPages(g);
    }
  };
  findPages(root);
  if (leader.members.some((m) => m.isSub) && !pages.includes('subw')) pages.push('subw');

  const raw: RawSetting[] = [];
  for (const id of pages) {
    const page = await readPage(leader.host, id);
    if (page) collect(page, undefined, leader.host, raw);
  }

  // A fixed-group leader reports the group name in SyncStatus; its settings tree has the player name.
  const findGroup = (node: any, id: string): any => {
    for (const g of asArray(node?.menuGroup)) {
      if (g['@id'] === id) return g;
      const hit = findGroup(g, id);
      if (hit) return hit;
    }
  };
  const leaderName = (leader.group && findGroup(root, 'player')?.['@displayName']) || leader.name;
  if (leader.group && leaderName !== leader.name) {
    const prev = devices.list().find((d) => d.mac === leader.mac);
    devices.upsert({ mac: leader.mac, name: leaderName, model: prev?.model ?? leader.model, lastIp: leader.host });
  }
  const seen = new Set<string>();
  const result: LiveSetting[] = [];
  for (const r of raw) {
    const owner = r.ip === leader.host ? { mac: leader.mac, name: leaderName } : await macOfIp(r.ip);
    const key = `${owner.mac}|${r.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ owner: owner.mac, ownerName: owner.name, name: r.name, label: r.label, value: r.value, meta: r.meta, host: r.host, path: r.path });
  }
  return result;
}

type MacResolver = (ip: string) => Promise<{ mac: string; name: string }>;

export async function readSettings(leader: SyncStatus, macOfIp: MacResolver): Promise<StoredSetting[]> {
  return (await readLive(leader, macOfIp)).map(({ owner, ownerName, name, label, value, meta }) => ({ owner, ownerName, name, label, value, meta }));
}

const same = (a: string, b: string) => {
  const na = Number(a), nb = Number(b);
  return a === b || (a.trim() !== '' && b.trim() !== '' && Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) < 0.05);
};

/** Writes stored settings that differ from the live values. Returns the labels written. */
export async function restoreSettings(leader: SyncStatus, stored: StoredSetting[], macOfIp: MacResolver): Promise<string[]> {
  const live = await readLive(leader, macOfIp);
  const liveByKey = new Map(live.map((s) => [`${s.owner}|${s.name}`, s]));
  const changes = stored
    .map((s) => ({ s, l: liveByKey.get(`${s.owner}|${s.name}`) }))
    .filter((c): c is { s: StoredSetting; l: LiveSetting } => !!c.l && !same(c.l.value, c.s.value));

  // The soundbar keeps tone settings per listening mode: set the mode first, then send it along.
  // Sub on/off comes next, because sub settings depend on it.
  const presetOf = new Map(stored.filter((s) => s.name === 'preset').map((s) => [s.owner, s.value]));
  const rank = (name: string) => (name === 'preset' ? 0 : name === 'subwoofer' ? 1 : 2);
  changes.sort((a, b) => rank(a.s.name) - rank(b.s.name));

  const written: string[] = [];
  for (const { s, l } of changes) {
    if (s.name === 'preset') {
      // The app sets the listening mode through /audioPreset, not the advertised /alsa_setting.
      await bluosPost(l.host, l.path.replace('alsa_setting', 'audioPreset'), { preset: s.value });
    } else {
      const form: Record<string, string> = { [s.name]: s.value };
      const preset = presetOf.get(s.owner);
      if (preset && /alsa_setting/.test(l.path)) form.preset = preset;
      await bluosPost(l.host, l.path, form);
    }
    written.push(`${s.ownerName}: ${s.label} ${l.value} → ${s.value}`);
  }
  return written;
}

export function diffSettings(expected: StoredSetting[], actual: StoredSetting[]): string[] {
  const actualByKey = new Map(actual.map((s) => [`${s.owner}|${s.name}`, s]));
  const diffs: string[] = [];
  for (const e of expected) {
    const a = actualByKey.get(`${e.owner}|${e.name}`);
    if (!a) diffs.push(`${e.ownerName}: ${e.label} not available`);
    else if (!same(a.value, e.value)) diffs.push(`${e.ownerName}: ${e.label} is ${a.value}, expected ${e.value}`);
  }
  return diffs;
}
