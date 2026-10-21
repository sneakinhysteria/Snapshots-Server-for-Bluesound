// Speaker overview for the UI, from the stored device list (updated by every discovery,
// background read and monitor rescan) and the last read setup.

import { roles, type Snapshot } from './snapshot.ts';
import { devices } from './store.ts';

export interface SpeakerInfo {
  mac: string;
  name: string;
  model: string;
  modelCode: string;
  ip: string;
  via?: string;           // name of the soundbar it is connected to directly
  version: string;
  reachable: boolean;
  role: string;
  foundBy: string;
  lastSeen: string;
}

// The monitor rescans every 5 minutes; a speaker that did not answer in two rounds counts as offline.
const REACHABLE_MS = 11 * 60_000;

export function speakerList(current?: Snapshot): SpeakerInfo[] {
  const all = devices.list();
  const fresh = (mac: string) => {
    const d = all.find((x) => x.mac === mac);
    return !!d && Date.now() - new Date(d.seenAt).getTime() < REACHABLE_MS;
  };
  const places = current ? roles(current) : new Map<string, string>();
  return all.map((d) => {
    let reachable = fresh(d.mac);
    const zone = current?.zones.find((z) => z.leader.mac === d.mac || z.members.some((m) => m.mac === d.mac) || z.sub?.mac === d.mac
      || z.dynamicSlaves.some((s) => s.mac === d.mac));
    const role = places.get(d.mac) ?? (reachable ? 'standalone' : 'not found');
    const surround = zone && zone.leader.mac !== d.mac && zone.members.some((m) => !['left', 'right'].includes(m.channelMode));
    const direct = !!zone && zone.leader.mac !== d.mac && !!d.directIp && d.directVia === zone.leader.mac;
    if (direct || surround) reachable ||= fresh(zone!.leader.mac); // only reachable through the leader
    return {
      mac: d.mac, name: d.name, model: d.model, modelCode: d.modelCode,
      ip: direct ? d.directIp : d.lastIp,
      via: direct ? all.find((x) => x.mac === zone!.leader.mac)?.name : undefined, version: d.version,
      reachable, role, foundBy: d.foundBy, lastSeen: d.seenAt,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
