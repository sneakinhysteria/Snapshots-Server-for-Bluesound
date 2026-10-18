// Installed version (commit the image was built from) and the newest image available on GitHub.

const REPO = 'sneakinhysteria/Snapshots-Server-for-Bluesound';
const CHECK_MS = 3_600_000; // GitHub allows 60 unauthenticated API requests per hour

export interface Build { commit: string; date: string | null }

const installed: Build = { commit: process.env.APP_COMMIT || 'dev', date: process.env.APP_COMMIT_DATE || null };
let available: { build: Build | null; checkedAt: number } = { build: null, checkedAt: 0 };

async function latestBuild(): Promise<Build | null> {
  // Newest successful image build on main, so "available" means the image can actually be pulled.
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/docker.yml/runs?branch=main&status=success&per_page=1`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'snapshots-server-for-bluesound' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
  const run = (await res.json()).workflow_runs?.[0];
  return run ? { commit: run.head_sha, date: run.head_commit?.timestamp ?? run.created_at } : null;
}

export async function versionInfo() {
  if (Date.now() - available.checkedAt > CHECK_MS) {
    try { available = { build: await latestBuild(), checkedAt: Date.now() }; }
    catch { available = { build: available.build, checkedAt: Date.now() - CHECK_MS + 300_000 }; } // retry in 5 min
  }
  const a = available.build;
  return {
    repo: `https://github.com/${REPO}`,
    installed,
    available: a,
    updateAvailable: !!a && installed.commit !== 'dev' && a.commit !== installed.commit,
  };
}
