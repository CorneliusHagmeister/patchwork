// GitHub enrichment for the repos under audit.
//
// Everything here is read-only and best-effort: if the token is missing, the rate limit is hit,
// or GitHub is slow, each call resolves to null and the UI falls back to what the platform
// already knows. A repo page must never fail because GitHub had a bad minute.
//
// Responses are cached in-process. On Vercel each instance keeps its own cache, which is fine —
// the point is to avoid re-fetching on every poll of a board that refreshes every 1.5s.

const TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { at: number; value: any }>();

export interface GhRepo {
  fullName: string;
  description: string;
  stars: number;
  forks: number;
  openIssues: number;
  watchers: number;
  language: string | null;
  license: string | null;
  topics: string[];
  defaultBranch: string;
  pushedAt: string;
  createdAt: string;
  htmlUrl: string;
  archived: boolean;
}

export interface GhContributor {
  login: string;
  avatarUrl: string;
  contributions: number;
  htmlUrl: string;
}

export interface GhCommit {
  sha: string;
  message: string;
  author: string;
  avatarUrl: string | null;
  date: string;
  htmlUrl: string;
}

export interface GhLanguage {
  name: string;
  bytes: number;
  pct: number;
}

export interface RepoIntel {
  ok: boolean;
  reason?: string;
  repo: GhRepo | null;
  contributors: GhContributor[];
  languages: GhLanguage[];
  commits: GhCommit[];
}

export interface GhPull {
  number: number;
  title: string;
  author: string;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  draft: boolean;
  labels: string[];
  baseRef: string;
}

/** Pull `owner/repo` out of any GitHub URL. Returns null for anything else. */
export function parseSlug(url: string): string | null {
  const m = String(url || "").match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/);
  if (!m) return null;
  return `${m[1]}/${m[2].replace(/\.git$/, "")}`;
}

async function gh<T>(path: string): Promise<T | null> {
  const token = process.env.GITHUB_TOKEN;
  const key = path;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(`https://api.github.com${path}`, {
      signal: ctl.signal,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "patchwork-swarm",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      cache: "no-store",
    });
    if (!r.ok) {
      // Cache misses too, briefly, so a 404 or a rate-limit doesn't retry on every poll.
      cache.set(key, { at: Date.now() - TTL_MS + 60_000, value: null });
      return null;
    }
    const value = (await r.json()) as T;
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Everything the repo page needs, in one call. Never throws. */
export async function repoIntel(url: string): Promise<RepoIntel> {
  const empty: RepoIntel = { ok: false, repo: null, contributors: [], languages: [], commits: [] };

  const slug = parseSlug(url);
  if (!slug) return { ...empty, reason: "not a GitHub URL" };
  if (!process.env.GITHUB_TOKEN) {
    // Unauthenticated is 60/hr per IP and shared on Vercel — not worth the flakiness.
    return { ...empty, reason: "GITHUB_TOKEN not set" };
  }

  const [raw, contribs, langs, commits] = await Promise.all([
    gh<any>(`/repos/${slug}`),
    gh<any[]>(`/repos/${slug}/contributors?per_page=12`),
    gh<Record<string, number>>(`/repos/${slug}/languages`),
    gh<any[]>(`/repos/${slug}/commits?per_page=6`),
  ]);

  if (!raw) return { ...empty, reason: "GitHub did not return this repository" };

  const repo: GhRepo = {
    fullName: raw.full_name,
    description: raw.description || "",
    stars: raw.stargazers_count ?? 0,
    forks: raw.forks_count ?? 0,
    openIssues: raw.open_issues_count ?? 0,
    watchers: raw.subscribers_count ?? 0,
    language: raw.language ?? null,
    license: raw.license?.spdx_id ?? null,
    topics: raw.topics || [],
    defaultBranch: raw.default_branch || "main",
    pushedAt: raw.pushed_at || "",
    createdAt: raw.created_at || "",
    htmlUrl: raw.html_url || url,
    archived: !!raw.archived,
  };

  const totalBytes = Object.values(langs || {}).reduce((a, b) => a + b, 0) || 1;
  const languages: GhLanguage[] = Object.entries(langs || {})
    .map(([name, bytes]) => ({ name, bytes, pct: Math.round((bytes / totalBytes) * 1000) / 10 }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 6);

  return {
    ok: true,
    repo,
    languages,
    contributors: (contribs || [])
      .filter((c) => c && c.type !== "Bot")
      .map((c) => ({
        login: c.login,
        avatarUrl: c.avatar_url,
        contributions: c.contributions ?? 0,
        htmlUrl: c.html_url,
      })),
    commits: (commits || []).map((c) => ({
      sha: (c.sha || "").slice(0, 7),
      message: String(c.commit?.message || "").split("\n")[0].slice(0, 120),
      author: c.commit?.author?.name || c.author?.login || "unknown",
      avatarUrl: c.author?.avatar_url ?? null,
      date: c.commit?.author?.date || "",
      htmlUrl: c.html_url || "",
    })),
  };
}

/**
 * Open pull requests on a repo, newest first — the operator's menu for starting a review round.
 * Best-effort like everything else here: an empty array means "couldn't ask", not "none open".
 */
export async function openPulls(url: string, limit = 10): Promise<GhPull[]> {
  const slug = parseSlug(url);
  if (!slug || !process.env.GITHUB_TOKEN) return [];
  const rows = await gh<any[]>(`/repos/${slug}/pulls?state=open&sort=updated&direction=desc&per_page=${limit}`);
  return (rows || []).map((p) => ({
    number: p.number,
    title: String(p.title || "").slice(0, 200),
    author: p.user?.login || "unknown",
    avatarUrl: p.user?.avatar_url ?? null,
    createdAt: p.created_at || "",
    updatedAt: p.updated_at || "",
    htmlUrl: p.html_url || "",
    draft: !!p.draft,
    labels: (p.labels || []).map((l: any) => l.name).slice(0, 4),
    baseRef: p.base?.ref || "",
  }));
}
