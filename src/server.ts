import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { join } from 'node:path';
import { applyEdits, validateSnapshot, backfillMeta, captureSnapshot, carryOver, isActive, latest, setLatest, type Snapshot, type ZoneEdit } from './snapshot.ts';
import { airplayAvailable, airplayEvent, airplayStatus, pcmSource, reconcileAirplay, setAirplayLogger, stopAllAirplay } from './airplay.ts';
import { registerStreams } from './stream.ts';
import { versionInfo } from './version.ts';
import { cover, nowPlaying, nowPlayingBus, type NowPlaying } from './metadata.ts';
import { startMonitor } from './monitor.ts';
import { startLsdp } from './lsdp.ts';
import { startMdns } from './mdns.ts';
import { guardInfo, seedGuard, setGuardMode, type GuardMode } from './guard.ts';
import { setTvStartConfig, tvStartConfig, type TvStartConfig } from './tvstart.ts';
import { speakerList } from './speakers.ts';
import { discover, probeHosts, scanSubnets } from './discovery.ts';
import { getJob, lastJob, runningJob, startRecall } from './recall.ts';
import { devices, eventBus, events, snapshots, type PlayerEvent } from './store.ts';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

app.register(fastifyStatic, { root: join(import.meta.dirname, '..', 'public') });
registerStreams(app, pcmSource);

// Clients like Home Assistant's rest_command send a content type (e.g. form or text) with an
// empty POST body; without a parser Fastify rejects those with 415. Bodies we need are JSON.
const lenient = (req: unknown, body: string | Buffer, done: (err: Error | null, body?: unknown) => void) => {
  if (!body || !String(body).trim()) return done(null, undefined);
  try { done(null, JSON.parse(String(body))); } catch { done(null, String(body)); }
};
app.removeContentTypeParser('application/json');
app.addContentTypeParser('application/json', { parseAs: 'string' }, lenient);
app.addContentTypeParser('*', { parseAs: 'string' }, lenient);
setAirplayLogger((msg) => app.log.info(msg));

const busy = () => {
  const job = runningJob();
  if (job) throw Object.assign(new Error(`Recall of "${job.snapshotName}" is running`), { statusCode: 409 });
};
const findSnapshot = (id: string) => {
  const s = snapshots.get(Number(id));
  if (!s) throw Object.assign(new Error('Snapshot not found'), { statusCode: 404 });
  return s;
};
const cleanName = (name: unknown) => {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) throw Object.assign(new Error('Name is required'), { statusCode: 400 });
  return n.slice(0, 100);
};

function afterRead(current: Snapshot) {
  setLatest(current);
  reconcileAirplay(current);
  for (const s of snapshots.list()) {
    const filled = backfillMeta(s.data, current);
    if (filled) snapshots.update(s.id, { data: filled }, false);
  }
}

const withActive = (current: Snapshot) =>
  ({ ...current, activeSnapshotIds: snapshots.list().filter((s) => isActive(s.data, current)).map((s) => s.id) });

// ?cached=1 answers immediately with the last stored read (kept fresh by the monitor).
app.get<{ Querystring: { cached?: string } }>('/api/current', async (req) => {
  if (req.query.cached && latest.current) return withActive(latest.current);
  busy();
  const current = await captureSnapshot();
  afterRead(current);
  return withActive(current);
});

// Re-read the setup in the background when a player reports a grouping change.
let refreshTimer: NodeJS.Timeout | undefined;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (runningJob()) return; // a recall reads the setup itself when it finishes
    // Known addresses only: syncStat also changes with volume, so this runs often.
    probeHosts(devices.list().map((d) => d.lastIp).filter(Boolean))
      .then(captureSnapshot).then(afterRead)
      .catch((e) => app.log.warn(`Background read failed: ${e.message}`));
  }, 5000);
}

app.get<{ Querystring: { limit?: string; kind?: string } }>('/api/events', async (req) =>
  events.list(Math.min(Number(req.query.limit ?? 200) || 200, 1000), req.query.kind || undefined));

app.get<{ Querystring: { scan?: string } }>('/api/speakers', async (req) => {
  if (req.query.scan) {
    busy();
    const lan = await discover();
    afterRead(await captureSnapshot(lan));
  }
  return { subnets: scanSubnets(), scan: process.env.BLUOS_SCAN !== 'off', speakers: speakerList(latest.current) };
});

// Live activity log (Server-Sent Events).
app.get('/api/events/stream', (req, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (e: PlayerEvent) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
  const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000); // keeps proxies from closing it
  eventBus.on('event', send);
  reply.raw.on('close', () => { clearInterval(ping); eventBus.off('event', send); });
});

app.get('/api/guard', async () => guardInfo());
app.put<{ Body: { mode?: GuardMode } }>('/api/guard', async (req) => {
  if (!['off', 'detect', 'undo', 'lock'].includes(req.body?.mode as string)) {
    throw Object.assign(new Error('mode must be off, detect, undo or lock'), { statusCode: 400 });
  }
  setGuardMode(req.body.mode!);
  return guardInfo();
});

app.get('/api/tvstart', async () => tvStartConfig());
app.put<{ Body: Partial<TvStartConfig> }>('/api/tvstart', async (req) => {
  setTvStartConfig(req.body ?? {});
  return tvStartConfig();
});

// AirPlay now-playing metadata, readable from other pages (e.g. an artwork display) via CORS.
app.addHook('onSend', async (req, reply) => {
  if (req.url.startsWith('/api/airplay')) reply.header('access-control-allow-origin', '*');
});

app.get('/api/version', async () => versionInfo());

app.get('/api/airplay', async () => ({ available: airplayAvailable(), receivers: airplayStatus() }));

// cover: path on this server; coverUrl: full URL (for Home Assistant's entity_picture etc.),
// built from the address the caller used to reach this app.
const withCover = (id: string, np: NowPlaying | undefined, host?: string) => {
  if (!np) return null;
  const cover = np.coverId ? `/api/airplay/${id}/cover?v=${np.coverId}` : null;
  const base = process.env.PUBLIC_URL?.replace(/\/$/, '') ?? (host ? `http://${host}` : '');
  return { ...np, cover, coverUrl: cover && base ? base + cover : null };
};

app.get<{ Params: { id: string } }>('/api/airplay/:id/nowplaying', async (req) => {
  const r = airplayStatus().find((x) => x.id === req.params.id);
  if (!r) throw Object.assign(new Error('No such AirPlay receiver'), { statusCode: 404 });
  return { id: r.id, name: r.name, playing: r.playing, ...withCover(r.id, nowPlaying(r.id), req.headers.host) };
});

app.get<{ Params: { id: string } }>('/api/airplay/:id/cover', async (req, reply) => {
  const c = cover(req.params.id);
  if (!c) throw Object.assign(new Error('No cover'), { statusCode: 404 });
  reply.header('content-type', c.mime).header('cache-control', 'public, max-age=86400');
  return c.data;
});

// Live updates of all receivers' now-playing data (Server-Sent Events).
app.get('/api/airplay/stream', (req, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
    'access-control-allow-origin': '*',
  });
  const send = (id: string, np?: NowPlaying) => {
    const r = airplayStatus().find((x) => x.id === id);
    reply.raw.write(`data: ${JSON.stringify({ id, name: r?.name, playing: r?.playing ?? false, ...withCover(id, np, req.headers.host) })}\n\n`);
  };
  for (const r of airplayStatus()) send(r.id, nowPlaying(r.id));
  const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
  nowPlayingBus.on('update', send);
  reply.raw.on('close', () => { clearInterval(ping); nowPlayingBus.off('update', send); });
});

// Session hooks from shairport-sync (docker/airplay-hook.sh), local only.
app.get<{ Params: { id: string; event: string }; Querystring: { v?: string } }>('/internal/airplay/:id/:event', async (req, reply) => {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip)) return reply.code(403).send();
  airplayEvent(req.params.id, req.params.event, req.query.v).catch((e) => app.log.warn(`AirPlay ${req.params.event}: ${e.message}`));
  return { ok: true };
});

app.get('/api/snapshots', async () => snapshots.list());

app.post<{ Body: { name?: string } }>('/api/snapshots', async (req, reply) => {
  busy();
  const name = cleanName(req.body?.name);
  reply.code(201);
  return snapshots.create(name, await captureSnapshot());
});

// Store a snapshot from its data (e.g. one made in the iOS app). 409 if the name is taken.
app.post<{ Body: { name?: string; data?: unknown } }>('/api/snapshots/import', async (req, reply) => {
  const name = cleanName(req.body?.name);
  const data = validateSnapshot(req.body?.data);
  if (snapshots.list().some((s) => s.name.toLowerCase() === name.toLowerCase())) {
    throw Object.assign(new Error(`A snapshot named "${name}" exists`), { statusCode: 409 });
  }
  const created = snapshots.create(name, data);
  reconcileAirplay();
  reply.code(201);
  return created;
});

app.patch<{ Params: { id: string }; Body: { name?: string } }>('/api/snapshots/:id', async (req) => {
  findSnapshot(req.params.id);
  return snapshots.update(Number(req.params.id), { name: cleanName(req.body?.name) });
});

// Edit stored values (settings, levels, volume, distances) of a snapshot.
app.put<{ Params: { id: string }; Body: { zones?: ZoneEdit[] } }>('/api/snapshots/:id/values', async (req) => {
  const s = findSnapshot(req.params.id);
  if (!Array.isArray(req.body?.zones)) throw Object.assign(new Error('zones is required'), { statusCode: 400 });
  const updated = snapshots.update(s.id, { data: applyEdits(s.data, req.body.zones) });
  reconcileAirplay();
  return updated;
});

// Replace the stored layout with the current one.
app.post<{ Params: { id: string } }>('/api/snapshots/:id/capture', async (req) => {
  busy();
  const s = findSnapshot(req.params.id);
  return snapshots.update(s.id, { data: carryOver(s.data, await captureSnapshot()) });
});

app.delete<{ Params: { id: string } }>('/api/snapshots/:id', async (req, reply) => {
  findSnapshot(req.params.id);
  snapshots.remove(Number(req.params.id));
  reconcileAirplay();
  reply.code(204);
});

app.post<{ Params: { id: string } }>('/api/snapshots/:id/recall', async (req, reply) => {
  const s = findSnapshot(req.params.id);
  busy();
  reply.code(202);
  return startRecall(s.id, s.name, s.data);
});

// ---- Automation (Home Assistant, Node-RED, Shortcuts): names instead of ids ----

const byName = (name: string) => {
  const s = snapshots.list().find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
  if (!s) {
    const names = snapshots.list().map((x) => x.name).join(', ');
    throw Object.assign(new Error(`No snapshot named "${name}". Available: ${names}`), { statusCode: 404 });
  }
  return s;
};

app.post<{ Params: { name: string } }>('/api/recall/:name', async (req, reply) => {
  const s = byName(req.params.name);
  busy();
  reply.code(202);
  const job = startRecall(s.id, s.name, s.data);
  return { snapshot: s.name, job: job.id, status: job.status };
});

app.get('/api/state', async () => {
  const list = snapshots.list();
  const active = latest.current ? list.filter((s) => isActive(s.data, latest.current!)).map((s) => s.name) : [];
  const job = lastJob();
  return {
    active: active[0] ?? null,
    activeAll: active,
    names: list.map((s) => s.name),
    readAt: latest.current?.capturedAt ?? null,
    recall: job ? {
      snapshot: job.snapshotName, status: job.status, startedAt: job.startedAt,
      finishedAt: job.finishedAt ?? null, differences: job.differences,
    } : null,
    airplay: airplayStatus().map((r) => ({ name: r.name, playing: r.playing })),
  };
});

app.get('/api/jobs/running', async () => runningJob() ?? null);

app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req) => {
  const job = getJob(req.params.id);
  if (!job) throw Object.assign(new Error('Job not found'), { statusCode: 404 });
  return job;
});

await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 8095) });

if (!airplayAvailable()) app.log.warn('shairport-sync not found, AirPlay receivers disabled');
startLsdp((msg) => app.log.warn(msg));
seedGuard();
startMonitor((msg) => app.log.warn(msg), scheduleRefresh);
startMdns(Number(process.env.PORT ?? 8095), (msg) => app.log.warn(msg));
captureSnapshot().then(afterRead).catch((e) => app.log.warn(`Initial read failed: ${e.message}`));
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { stopAllAirplay(); process.exit(0); });
