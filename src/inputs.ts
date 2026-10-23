// Inputs (HDMI, optical, analog, …) and group volume per zone, as the iOS/tvOS apps show them.

import { setTimeout as sleep } from 'node:timers/promises';
import { bluosGet, getVolume, type VolumeState } from './bluos.ts';
import { expectVolume } from './origin.ts';
import { latest } from './snapshot.ts';
import { devices, kv } from './store.ts';

export interface Input { id: string; name: string; url: string; kind: string; connector: string }
export interface ZoneControls {
  mac: string;
  title: string;
  inputs: Input[];
  playingInputId: string | null;
  playing: string;             // "Playing TV", "Playing <title>", "Not playing"
  volume: VolumeState;
}

const CONNECTOR: Record<string, string> = {
  earc: 'HDMI eARC', arc: 'HDMI ARC', hdmi: 'HDMI', spdif: 'Digital in', optical: 'Digital in', coax: 'Digital in',
  analog: 'Analog in', bluetooth: 'Bluetooth',
};
const asInput = (id: string, name: string, url: string, kind: string): Input =>
  ({ id, name, url, kind, connector: CONNECTOR[kind] ?? kind });

const bad = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function hostOf(mac: string): string {
  const d = devices.list().find((x) => x.mac === mac);
  if (!d?.lastIp) throw bad(404, 'Unknown player');
  return d.lastIp;
}

// The soundbar leaves the playing input out of its list; earlier lists keep it in place.
function merge(fresh: Input[], previous: Input[], playing?: Input): Input[] {
  const out = [...fresh];
  previous.forEach((p, i) => { if (!out.some((x) => x.id === p.id)) out.splice(Math.min(i, out.length), 0, p); });
  if (playing && !out.some((x) => x.id === playing.id)) out.push(playing);
  return out;
}

async function readZone(mac: string, title: string): Promise<ZoneControls> {
  const host = hostOf(mac);
  const [browse, status, volume] = await Promise.all([
    bluosGet(host, '/RadioBrowse', { service: 'Capture' }).catch(() => undefined),
    bluosGet(host, '/Status').then((b) => b.status).catch(() => ({})),
    getVolume(host),
  ]);
  const fresh = list<any>(browse?.radiotime?.item).filter((i) => i.inputType)
    .map((i) => asInput(String(i.id), String(i.text), decodeURIComponent(String(i.URL)), String(i.inputType)));
  const capture = status.service === 'Capture' && status.streamUrl;
  const playingInput = capture
    ? asInput(String(status.inputId ?? status.streamUrl), String(status.title1 ?? 'Input'), String(status.streamUrl), String(status.inputTypeIndex ?? '').split('-')[0])
    : undefined;
  const key = `inputs:${mac}`;
  const inputs = merge(fresh, kv.get<Input[]>(key) ?? [], playingInput);
  if (JSON.stringify(inputs) !== JSON.stringify(kv.get(key))) kv.set(key, inputs);
  const playingId = capture ? inputs.find((i) => i.url === status.streamUrl)?.id ?? null : null;
  const active = ['play', 'stream'].includes(status.state);
  const playing = playingId ? `Playing ${inputs.find((i) => i.id === playingId)!.name}`
    : active && status.title1 ? `Playing ${status.title1}` : 'Not playing';
  return { mac, title, inputs, playingInputId: playingId, playing, volume };
}

/** One entry per zone (group leader or single speaker), in layout order. */
export async function zoneControls(): Promise<ZoneControls[]> {
  const zones = latest.current?.zones ?? [];
  const names = new Map(devices.list().map((d) => [d.mac, d.name]));
  const all = await Promise.all(zones.map((z) =>
    readZone(z.leader.mac, z.groupName ?? names.get(z.leader.mac) ?? z.leader.name).catch(() => undefined)));
  return all.filter((z): z is ZoneControls => !!z);
}

export async function selectInput(mac: string, id: string): Promise<ZoneControls> {
  const host = hostOf(mac);
  const input = (kv.get<Input[]>(`inputs:${mac}`) ?? []).find((i) => i.id === id);
  if (!input) throw bad(404, 'Unknown input');
  await bluosGet(host, '/Play', { url: input.url }, 15_000);
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    const st = (await bluosGet(host, '/Status').catch(() => undefined))?.status;
    if (st?.service === 'Capture' && st.streamUrl === input.url) return zone(mac);
    await sleep(500);
  }
  throw bad(502, `The speakers didn't switch to ${input.name}.`);
}

export async function setGroupVolume(mac: string, v: { level?: number; mute?: boolean }): Promise<ZoneControls> {
  const host = hostOf(mac);
  if (v.level !== undefined && (typeof v.level !== 'number' || !Number.isFinite(v.level) || v.level < 0 || v.level > 100)) {
    throw bad(400, 'level must be between 0 and 100');
  }
  const cur = await getVolume(host);
  const level = v.level === undefined ? undefined : Math.round(v.level);
  if (v.mute === true) {
    expectVolume(host, 0, 'Web UI');
    await bluosGet(host, '/Volume', { mute: 1, tell_slaves: 1 });
  } else if (v.mute === false || (level !== undefined && cur.mute)) {
    expectVolume(host, cur.muteLevel ?? cur.level, 'Web UI');
    await bluosGet(host, '/Volume', { mute: 0, tell_slaves: 1 });
  }
  if (level !== undefined && v.mute !== true) {
    expectVolume(host, level, 'Web UI');
    await bluosGet(host, '/Volume', { level, tell_slaves: 1 });
  }
  return zone(mac);
}

async function zone(mac: string): Promise<ZoneControls> {
  const z = (await zoneControls()).find((x) => x.mac === mac);
  if (!z) throw bad(404, 'Player is not leading a zone');
  return z;
}
