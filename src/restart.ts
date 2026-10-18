// Restarts a speaker on request (Speakers tab, API). Uses the same command as the recall's
// fallback; the speaker's return is logged in the activity log.

import { setTimeout as sleep } from 'node:timers/promises';
import { bluosPost, syncStatus } from './bluos.ts';
import { runningJob } from './recall.ts';
import { latest } from './snapshot.ts';
import { speakerList } from './speakers.ts';
import { devices, events } from './store.ts';

const BACK_TIMEOUT_MS = 180_000;
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export async function restartSpeaker(mac: string): Promise<{ name: string; ip: string }> {
  const sp = speakerList(latest.current).find((s) => s.mac === mac.toUpperCase());
  if (!sp) throw fail(404, 'Unknown speaker');
  if (runningJob()) throw fail(409, 'A recall is running');
  // Direct Connect members can't be reached on port 80 from the LAN (the soundbar's proxy only forwards the API port).
  if (sp.via) throw fail(409, `${sp.name} is connected through ${sp.via} and can't be restarted from here. Restart ${sp.via}, or unplug ${sp.name}.`);
  const p = await syncStatus(sp.ip, 3000).catch(() => undefined);
  if (!p || p.mac !== sp.mac) throw fail(409, `${sp.name} doesn't respond at ${sp.ip}. Unplug it for 30 seconds instead.`);

  await bluosPost(`${sp.ip}:80`, '/reboot', { yes: '1' });
  events.add({ mac: sp.mac, player: sp.name, kind: 'restart', detail: 'restart requested' });
  waitForReturn(sp.mac, sp.name, sp.ip).catch(() => {});
  return { name: sp.name, ip: sp.ip };
}

async function waitForReturn(mac: string, name: string, ip: string) {
  const start = Date.now();
  await sleep(15_000); // let it go offline first
  while (Date.now() - start < BACK_TIMEOUT_MS) {
    const p = await syncStatus(devices.list().find((d) => d.mac === mac)?.lastIp || ip, 2000).catch(() => undefined);
    if (p?.mac === mac) {
      events.add({ mac, player: name, kind: 'restart', detail: `back after ${Math.round((Date.now() - start) / 1000)} s` });
      return;
    }
    await sleep(5000);
  }
  events.add({ mac, player: name, kind: 'restart', detail: `not back after ${BACK_TIMEOUT_MS / 60_000} min` });
}
