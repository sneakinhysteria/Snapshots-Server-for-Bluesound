// CEC volume protection. Some TVs send volume commands over HDMI-CEC by themselves (at power-on,
// for "volume sync", or from firmware bugs). The guard groups CEC volume changes into sequences,
// learns repeating patterns per player (a regular interval, e.g. a Philips TV stepping the volume
// every ~15 min 01 s) and, depending on the mode, logs or undoes them. Remote clicks are irregular
// and stay untouched; "lock" undoes every CEC volume change.

import { bluosGet } from './bluos.ts';
import { events, kv } from './store.ts';
import { expectVolume } from './origin.ts';

export type GuardMode = 'off' | 'detect' | 'undo' | 'lock';

export interface VolumeChange { mac: string; host: string; player: string; from: number; to: number; source: string; t: number; unmuted?: boolean }

interface Seq { mac: string; host: string; player: string; t: number; from: number; to: number; steps: number; minGap: number; unmuted?: boolean }

export interface Pattern {
  mac: string;
  player: string;
  periodMs: number;
  anchor: number;          // start of the latest matching sequence
  matches: number;         // sequences in the last 24 h that fit the rhythm
  since: number;           // first matching sequence
  up: number;              // matching sequences going up / down
  down: number;
  minSteps: number;
  maxSteps: number;
  bursty: boolean;         // matching sequences contain steps < BURST_GAP_MS apart
}

const COLLECT_MS = 1500;          // a burst is judged as a whole
const BURST_GAP_MS = 300;         // faster than remote clicks
const HISTORY_MS = 24 * 3_600_000;
const MIN_PERIOD_MS = 60_000, MAX_PERIOD_MS = 2 * 3_600_000;
const MAX_CYCLES = 8;             // expect the rhythm at most this many periods after the last match
const MIN_MATCHES = 3;
const tolerance = (periodMs: number) => Math.max(4000, periodMs * 0.005); // learning
const window = (periodMs: number) => Math.max(15_000, periodMs * 0.02);   // undoing

// Migration from the first version ({ enabled: boolean }).
const stored = kv.get<{ mode?: GuardMode; enabled?: boolean }>('guard');
let mode: GuardMode = stored?.mode ?? (stored?.enabled ? 'undo' : 'detect');
let undone = kv.get<number>('guardUndone') ?? 0;
let lastAction: string | undefined;

const sequences = new Map<string, Seq[]>();   // by MAC, last 24 h
const patterns = new Map<string, Pattern>();  // by MAC
const pending = new Map<string, VolumeChange[]>();
// Later reference points than the learned chain: a recognised drift or a TV start after a long pause.
// Persisted, so a restart of the app doesn't lose the rhythm.
const anchors = new Map<string, number>(Object.entries(kv.get<Record<string, number>>('guardAnchors') ?? {}));
const setAnchor = (mac: string, t: number) => {
  anchors.set(mac, t);
  kv.set('guardAnchors', Object.fromEntries(anchors));
};

function setPattern(mac: string, p: Pattern | undefined) {
  if (!p) { patterns.delete(mac); return; }
  // A later reference point is used if it fits the learned rhythm, or if the learned chain is too
  // old to predict anything (e.g. a TV start after a pause). This ignores misdetections.
  const a = anchors.get(mac);
  if (a && a > p.anchor) {
    const k = Math.round((a - p.anchor) / p.periodMs);
    if (k > MAX_CYCLES || Math.abs(a - (p.anchor + k * p.periodMs)) <= window(p.periodMs)) p.anchor = a;
  }
  patterns.set(mac, p);
}

// ---- Pattern learning ----

let recentAnchor = 0;

function analyze(mac: string): Pattern | undefined {
  recentAnchor = 0;
  const seqs = (sequences.get(mac) ?? []).filter((s) => s.t > Date.now() - HISTORY_MS);
  sequences.set(mac, seqs);
  if (seqs.length < MIN_MATCHES) return undefined;

  // Candidate periods: the most frequent pairwise intervals (2 s buckets).
  const buckets = new Map<number, number>();
  for (let i = 0; i < seqs.length; i++) for (let j = i + 1; j < seqs.length; j++) {
    const dt = seqs[j].t - seqs[i].t;
    if (dt >= MIN_PERIOD_MS && dt <= MAX_PERIOD_MS) buckets.set(Math.round(dt / 2000), (buckets.get(Math.round(dt / 2000)) ?? 0) + 1);
  }
  // Every interval seen at least twice is a candidate (manual clicks create many short ones).
  const candidates = [...buckets.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 80).map(([b]) => b * 2000);

  // For each candidate period, follow chains event to event (gaps of 1..MAX_CYCLES periods, fixed
  // tolerance) so period errors don't accumulate. Chance matches are discounted.
  let best: { period: number; matched: Seq[]; ks: number[]; score: number } | undefined;
  for (const period of candidates) {
    const tol = tolerance(period);
    for (let a = 0; a < seqs.length; a++) {
      const matched = [seqs[a]], ks = [0];
      let lastT = seqs[a].t, lastK = 0;
      for (let i = a + 1; i < seqs.length; i++) {
        const k = Math.round((seqs[i].t - lastT) / period);
        if (k < 1 || k > MAX_CYCLES) { if (k > MAX_CYCLES) break; continue; }
        if (Math.abs(seqs[i].t - (lastT + k * period)) <= tol) {
          matched.push(seqs[i]); lastK += k; ks.push(lastK); lastT = seqs[i].t;
        }
      }
      // Expected chance hits: each followed period has a 2·tol wide window.
      const chance = (lastK || 1) * Math.min(1, (2 * tol * seqs.length) / Math.max(1, seqs[seqs.length - 1].t - seqs[0].t));
      const score = matched.length - chance;
      if (!best || score > best.score || (score === best.score && period < best.period)) best = { period, matched, ks, score };
    }
  }
  if (!best || best.matched.length < MIN_MATCHES || best.score < MIN_MATCHES - 1) return undefined;

  // For predictions, the most recent chain at that period matters (e.g. after the TV was off for
  // hours the strongest chain may be from the morning).
  {
    const tol = tolerance(best.period);
    let latest: Seq[] | undefined;
    for (let a = 0; a < seqs.length; a++) {
      const chain = [seqs[a]];
      for (let i = a + 1; i < seqs.length; i++) {
        const k = Math.round((seqs[i].t - chain[chain.length - 1].t) / best.period);
        if (k > MAX_CYCLES) break;
        if (k >= 1 && Math.abs(seqs[i].t - (chain[chain.length - 1].t + k * best.period)) <= tol) chain.push(seqs[i]);
      }
      if (chain.length >= MIN_MATCHES && (!latest || chain[chain.length - 1].t > latest[latest.length - 1].t)) latest = chain;
    }
    if (latest) recentAnchor = latest[latest.length - 1].t;
  }

  // Refine the period by least squares over (k, t).
  const n = best.ks.length, mk = best.ks.reduce((a, b) => a + b, 0) / n;
  const mt = best.matched.reduce((a, s) => a + s.t, 0) / n;
  const cov = best.ks.reduce((a, k, i) => a + (k - mk) * (best!.matched[i].t - mt), 0);
  const varK = best.ks.reduce((a, k) => a + (k - mk) ** 2, 0);
  const periodMs = varK ? Math.round(cov / varK) : best.period;

  const m = best.matched;
  return {
    mac, player: m[0].player, periodMs, anchor: Math.max(recentAnchor, ...m.map((s) => s.t)), matches: m.length,
    since: Math.min(...m.map((s) => s.t)),
    up: m.filter((s) => s.to > s.from).length, down: m.filter((s) => s.to < s.from).length,
    minSteps: Math.min(...m.map((s) => s.steps)), maxSteps: Math.max(...m.map((s) => s.steps)),
    bursty: m.some((s) => s.minGap < BURST_GAP_MS),
  };
}

function inWindow(p: Pattern | undefined, t: number): boolean {
  if (!p) return false;
  const k = Math.round((t - p.anchor) / p.periodMs);
  return k >= 1 && k <= MAX_CYCLES && Math.abs(t - (p.anchor + k * p.periodMs)) <= window(p.periodMs);
}

// ---- Handling ----

async function restore(s: Seq, why: string) {
  try {
    expectVolume(s.host, s.from, 'Guard');
    await bluosGet(s.host, '/Volume', { level: s.from, tell_slaves: 0 });
    if (s.unmuted) {
      // The change unmuted the player: mute it again (it keeps s.from as the level to return to).
      expectVolume(s.host, 0, 'Guard');
      await bluosGet(s.host, '/Volume', { mute: 1, tell_slaves: 0 });
    }
    undone++;
    kv.set('guardUndone', undone);
    lastAction = new Date().toISOString();
    events.add({ mac: s.mac, player: s.player, kind: 'guard', detail: `undone (${why}): ${s.to} → ${s.from}${s.unmuted ? ', muted again' : ''}` });
  } catch (e: any) {
    events.add({ mac: s.mac, player: s.player, kind: 'guard', detail: `could not undo (${why}): ${e.message}` });
  }
}

async function judge(changes: VolumeChange[]) {
  const first = changes[0], last = changes[changes.length - 1];
  const minGap = Math.min(Infinity, ...changes.slice(1).map((c, i) => c.t - changes[i].t));
  const seq: Seq = { mac: first.mac, host: first.host, player: first.player, t: first.t, from: first.from, to: last.to, steps: changes.length, minGap, unmuted: first.unmuted };

  const before = patterns.get(seq.mac);
  const rhythm = inWindow(before, seq.t);
  const burst = minGap < BURST_GAP_MS;
  // Fast steps against the learned direction are people (e.g. holding a volume key after the TV
  // started), not the TV's drift. A pattern with both directions accepts both.
  const up = seq.to > seq.from;
  const directionFits = !before || (up ? before.up > 0 : before.down > 0);
  const beyondHorizon = !before || seq.t - before.anchor > MAX_CYCLES * before.periodMs;

  (sequences.get(seq.mac) ?? sequences.set(seq.mac, []).get(seq.mac)!).push(seq);
  const automaticNow = rhythm || (burst && (before?.bursty ?? false) && directionFits);
  // Re-anchor on drifts that fit the rhythm, or on a burst after a long pause (rhythm lost).
  if (rhythm || (automaticNow && beyondHorizon)) setAnchor(seq.mac, seq.t);
  const learned = analyze(seq.mac);
  setPattern(seq.mac, learned);
  if (!before && learned) {
    events.add({ mac: seq.mac, player: seq.player, kind: 'guard',
      detail: `pattern recognised: CEC volume change every ${fmt(learned.periodMs)} (${learned.matches}×)` });
  }

  if (mode === 'off') return;
  if (mode === 'lock') return restore(seq, 'lock');

  const automatic = automaticNow;
  if (!automatic && (!burst || !directionFits)) return; // remote control or other manual change
  const why = rhythm ? `rhythm ${fmt(before!.periodMs)}` : 'burst';
  if (mode === 'undo' && automatic) return restore(seq, why);
  events.add({ mac: seq.mac, player: seq.player, kind: 'guard',
    detail: `automatic change detected (${why}): ${seq.from} → ${seq.to}${mode === 'undo' ? ', not undone (no learned pattern yet)' : ''}` });
}

/** Called by the monitor for every volume change. */
export function onVolumeChange(c: VolumeChange) {
  if (c.source !== 'CEC') return; // the app's own changes and app/remote-app changes have other sources
  const seq = pending.get(c.mac);
  if (seq) { seq.push(c); return; }
  pending.set(c.mac, [c]);
  setTimeout(() => {
    const s = pending.get(c.mac)!;
    pending.delete(c.mac);
    judge(s).catch(() => {});
  }, COLLECT_MS);
}

/** Rebuilds sequences and patterns from the activity log (after a restart). */
export function seedGuard() {
  const cutoff = Date.now() - HISTORY_MS;
  const vol = events.list(2000, 'volume').reverse()
    .filter((e) => e.detail.includes('source: CEC') && !/\b(un)?muted\b/.test(e.detail) && new Date(e.t).getTime() > cutoff)
    .sort((a, b) => a.t.localeCompare(b.t));
  for (const e of vol) {
    const m = e.detail.match(/^(\d+) → (\d+)/);
    if (!m) continue;
    const t = new Date(e.t).getTime();
    const list = sequences.get(e.mac) ?? sequences.set(e.mac, []).get(e.mac)!;
    const cur = list[list.length - 1];
    if (cur && t - cur.t < COLLECT_MS) {
      cur.minGap = Math.min(cur.minGap, t - (cur as any).lastT);
      cur.to = Number(m[2]); cur.steps++; (cur as any).lastT = t;
    } else {
      list.push(Object.assign({ mac: e.mac, host: '', player: e.player, t, from: Number(m[1]), to: Number(m[2]), steps: 1, minGap: Infinity }, { lastT: t }));
    }
  }
  // Fallback for anchors: the last drift the guard recognised (logged ~1.5 s after the drift began).
  for (const e of events.list(500, 'guard')) {
    if (!/^(undone|automatic change detected|drift)/.test(e.detail)) continue;
    const t = new Date(e.t).getTime() - COLLECT_MS;
    if (t > (anchors.get(e.mac) ?? 0)) setAnchor(e.mac, t);
  }
  for (const mac of sequences.keys()) setPattern(mac, analyze(mac));
}

/**
 * Called when a player switches to a TV input. A TV's timer apparently starts at power-on (first
 * drift observed 15 min 14 s after the TV input started, period 15 min 01 s), so after a pause
 * longer than the guard's horizon the TV start becomes the reference point.
 */
export function onTvStart(mac: string, t = Date.now()) {
  const p = patterns.get(mac);
  if (!p || t - p.anchor <= MAX_CYCLES * p.periodMs) return;
  setAnchor(mac, t);
  p.anchor = t;
  events.add({ mac, player: p.player, kind: 'guard', detail: `TV started: expecting CEC drift from ${new Date(t + p.periodMs).toLocaleTimeString('en-GB', { timeZone: process.env.TZ || 'UTC' })}` });
}

// ---- API ----

const fmt = (ms: number) => `${Math.floor(ms / 60_000)} min ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')} s`;

export function setGuardMode(m: GuardMode) {
  mode = m;
  kv.set('guard', { mode });
}

export function guardInfo() {
  const now = Date.now();
  const players = [...sequences.entries()].map(([mac, seqs]) => {
    const recent = seqs.filter((s) => s.t > now - HISTORY_MS);
    const p = patterns.get(mac);
    let next: number | undefined;
    if (p) {
      const k = Math.max(1, Math.ceil((now - p.anchor) / p.periodMs));
      if (k <= MAX_CYCLES) next = p.anchor + k * p.periodMs;
    }
    return {
      mac, player: recent[recent.length - 1]?.player ?? p?.player ?? mac,
      changes24h: recent.length,
      pattern: p ? {
        period: fmt(p.periodMs), periodMs: p.periodMs, matches: p.matches, since: new Date(p.since).toISOString(),
        direction: p.up && p.down ? 'up and down' : p.up ? 'up' : 'down',
        steps: p.minSteps === p.maxSteps ? `${p.minSteps}` : `${p.minSteps}–${p.maxSteps}`, bursty: p.bursty,
        last: new Date(p.anchor).toISOString(), next: next ? new Date(next).toISOString() : null,
      } : null,
    };
  }).filter((x) => x.changes24h || x.pattern);
  return { mode, undone, lastAction: lastAction ?? null, players };
}
