import { neon } from "@neondatabase/serverless";
import { LENSES, REVIEW_LENSES, type Finding, type Node, type Repo, type Trace, type WorkItem, type Tier, type ReviewTarget, type ReviewComment, type Project, type ProjectEvent } from "./types";
import { aggregate, aggregateSemantic, MIN_CONSENSUS, type Aggregated } from "./aggregate";
import { embed, embeddingModel, embeddingsEnabled } from "./embeddings";

/* ---------- document-store backend: in-memory for dev, Neon (kv table) for prod ---------- */
type Doc = Record<string, any>;
interface Backend {
  list(coll: string): Promise<Doc[]>;
  get(coll: string, id: string): Promise<Doc | null>;
  set(coll: string, id: string, data: Doc): Promise<void>;
}

function memBackend(): Backend {
  const g = globalThis as any;
  const m: Map<string, Map<string, Doc>> = g.__pw_mem || (g.__pw_mem = new Map());
  const c = (k: string) => m.get(k) || (m.set(k, new Map()), m.get(k)!);
  return {
    async list(coll) { return [...c(coll).values()]; },
    async get(coll, id) { return c(coll).get(id) ?? null; },
    async set(coll, id, data) { c(coll).set(id, data); },
  };
}

function neonBackend(url: string): Backend {
  const sql = neon(url);
  const g = globalThis as any;
  const ready: Promise<void> = g.__pw_neon_ready || (g.__pw_neon_ready = (async () => {
    await sql`CREATE TABLE IF NOT EXISTS kv (
      coll text NOT NULL, id text NOT NULL, data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (coll, id))`;
  })());
  return {
    async list(coll) { await ready; const r = await sql`SELECT data FROM kv WHERE coll=${coll}`; return r.map((x: any) => x.data); },
    async get(coll, id) { await ready; const r = await sql`SELECT data FROM kv WHERE coll=${coll} AND id=${id}`; return r[0]?.data ?? null; },
    async set(coll, id, data) { await ready; await sql`INSERT INTO kv (coll,id,data) VALUES (${coll},${id},${data as any})
      ON CONFLICT (coll,id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`; },
  };
}

const be: Backend = process.env.DATABASE_URL ? neonBackend(process.env.DATABASE_URL) : memBackend();

/* ---------- helpers ---------- */
const now = () => new Date().toISOString();
export const slug = (s: string) => (s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60) || "x");
const rid = () => Math.random().toString(36).slice(2, 10);
const isLive = (iso?: string) => !!iso && Date.now() - new Date(iso).getTime() < 90_000;

/* ---------- contributors / join ---------- */
export async function join(handle: string, location: string, code: string) {
  const expected = process.env.JOIN_CODE || "patchwork";
  if ((code || "").trim() !== expected) return { ok: false as const, error: "Wrong join code." };
  const h = (handle || "").trim().slice(0, 40);
  if (!h) return { ok: false as const, error: "Pick a handle." };
  const token = rid() + rid();
  const cid = rid();   // public node id — safe to expose in /api/state, unlike the token
  await be.set("contributors", token, { token, cid, handle: h, location: (location || "").slice(0, 40), createdAt: now() });
  await heartbeat(cid, h, { location, status: "idle" });
  return { ok: true as const, token, cid, handle: h };
}
export async function authed(token: string) {
  if (!token) return null;
  return (await be.get("contributors", token)) as any;
}

/* ---------- repos + work fan-out ---------- */
export async function addRepo(name: string, url: string, language: string, targets: string[], addedBy: string) {
  const id = slug(name);
  const repo: Repo = { name, url, language, targets, addedBy, addedAt: now(), status: "active" };
  await be.set("repos", id, repo);
  const areas = targets.length ? targets : [""];
  let n = 0;
  for (const target of areas) {
    for (const L of LENSES) {
      const wid = rid();
      const wi: WorkItem = { id: wid, repo: name, target, lens: L.lens, oracle: L.oracle, status: "queued", updatedAt: now() };
      await be.set("work_items", wid, wi);
      if (++n >= 12) break;
    }
    if (n >= 12) break;
  }
  return { repo, workItems: n };
}

/* ---------- claim a work item ---------- */
export async function claimWork(cid: string, handle: string) {
  const items = (await be.list("work_items")) as WorkItem[];
  const next = items.filter((w) => w.status === "queued").sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
  if (!next) return null;
  next.status = "running"; next.claimedBy = handle; next.claimedAt = now(); next.updatedAt = now();
  await be.set("work_items", next.id, next);
  await heartbeat(cid, handle, { status: "running", currentWork: `${next.repo}${next.target ? " · " + next.target : ""} · ${next.lens}` });
  await addTrace(handle, "status", `claimed ${next.repo}${next.target ? "/" + next.target : ""} — lens ${next.lens} (${next.oracle})`);
  return next;
}

/* ---------- submit a finding ---------- */
export async function submitFinding(cid: string, handle: string, f: Partial<Finding> & { workItem?: string }) {
  const id = "f-" + rid();
  const finding: Finding = {
    id, repo: f.repo || "unknown", workItem: f.workItem, title: (f.title || "untitled").slice(0, 200),
    oracle: f.oracle || "logic-authz", severity: (f.severity as any) || "medium",
    claimed: (f.claimed as Tier) || "reproduced", tier: "pending", patch: !!f.patch,
    contributor: handle, createdAt: now(), pov: (f as any).pov, patchDiff: (f as any).patchDiff,
  };
  await be.set("findings", id, finding);
  if (f.workItem) {
    const wi = (await be.get("work_items", f.workItem)) as WorkItem | null;
    if (wi) { wi.status = "done"; wi.findingId = id; wi.updatedAt = now(); await be.set("work_items", wi.id, wi); }
  }
  const node = (await be.get("nodes", cid)) as Node | null;
  if (node) { node.findingsCount = (node.findingsCount || 0) + 1; node.workDone = (node.workDone || 0) + 1; node.status = "idle"; node.lastSeen = now(); await be.set("nodes", node.id, node); }
  await addTrace(handle, "finding", `submitted "${finding.title}" (${finding.severity}, claimed ${finding.claimed}) — awaiting central verify`);
  return finding;
}

/* ---------- central verifier flips the confirmed tier ---------- */
export async function verifyFinding(id: string, tier: Tier, log?: string) {
  const f = (await be.get("findings", id)) as Finding | null;
  if (!f) return null;
  f.tier = tier; if (log) f.verifyLog = String(log).slice(0, 4000); await be.set("findings", id, f);
  await addTrace("verifier", tier === "reproduced" ? "finding" : "status",
    `${tier === "reproduced" ? "✓ verified" : "✗ rejected"}: "${f.title}" → ${tier}`);
  return f;
}

/* ---------- node heartbeat ---------- */
export async function heartbeat(cid: string, handle: string, patch: Partial<Node>) {
  const id = cid;   // one node per contributor, so same-handle joins never collide
  const prev = (await be.get("nodes", id)) as Node | null;
  const node: Node = {
    id, handle, location: patch.location ?? prev?.location ?? "", status: (patch.status as any) ?? prev?.status ?? "idle",
    currentWork: patch.currentWork ?? prev?.currentWork, workDone: prev?.workDone ?? 0,
    findingsCount: prev?.findingsCount ?? 0, lastSeen: now(),
  };
  await be.set("nodes", id, node);
  return node;
}

/* ---------- traces (bounded rolling log in a single doc) ---------- */
export async function addTrace(node: string, kind: Trace["kind"], text: string) {
  const doc = ((await be.get("meta", "traces")) as any) || { items: [] };
  doc.items.push({ id: rid(), node, kind, text: String(text).slice(0, 500), ts: now() });
  if (doc.items.length > 2000) doc.items = doc.items.slice(-2000);
  await be.set("meta", "traces", doc);
}

/* ---------- one-time demo seed (real findings) so the board is alive on first load ---------- */
async function maybeSeed() {
  const g = globalThis as any;
  if (g.__pw_seeded || process.env.PW_NO_SEED === "1") return;
  g.__pw_seeded = true;
  const existing = await be.list("repos");
  if (existing.length) return;
  const repos = [
    { name: "snare", url: "https://github.com/softdevteam/snare", language: "Rust", targets: ["src/httpserver.rs", "src/config.rs"] },
    { name: "pizauth", url: "https://github.com/ltratt/pizauth", language: "Rust", targets: ["src/config.rs", "src/server/http_server.rs"] },
    { name: "who-targets-me", url: "https://github.com/whotargetsme/who-targets-me", language: "Rust", targets: [] },
    { name: "vibe-kanban", url: "https://github.com/BloopAI/vibe-kanban", language: "Rust", targets: [] },
  ];
  for (const r of repos) await be.set("repos", slug(r.name), { ...r, addedBy: "seed", addedAt: now(), status: "active" });
  const nodes = [
    { handle: "cor", location: "London", status: "idle", workDone: 5, findingsCount: 2, currentWork: "pizauth · fuzz-lane" },
    { handle: "mira", location: "Lisbon", status: "idle", workDone: 3, findingsCount: 1, currentWork: "pizauth config parser" },
  ];
  for (const n of nodes) await be.set("nodes", slug(n.handle), { id: slug(n.handle), ...n, lastSeen: now() });
  const F = (id: string, d: any) => be.set("findings", id, { id, patch: false, createdAt: now(), ...d });
  await F("snare-h1", { repo: "snare", title: "Pre-auth unbounded read_line → single-connection memory-exhaustion DoS", oracle: "resource-exhaustion", severity: "high", claimed: "reproduced", tier: "reproduced", patch: true, contributor: "cor" });
  await F("snare-h2", { repo: "snare", title: "Unauthenticated command execution when a matched repo has cmd but no secret", oracle: "logic-authz", severity: "high", claimed: "reproduced", tier: "reproduced", patch: true, contributor: "cor" });
  await F("pizauth-h1", { repo: "pizauth", title: "Hard-coded ChaCha20-Poly1305 key makes dumped secrets trivially decryptable", oracle: "secrets-exposure", severity: "medium", claimed: "reproduced", tier: "reproduced", patch: true, contributor: "mira" });
  await F("snare-h3", { repo: "snare", title: "Slowloris handler-thread exhaustion via per-syscall timeout + 16-slot cap", oracle: "resource-exhaustion", severity: "medium", claimed: "analytical", tier: "analytical", contributor: "dev-berlin" });
  await F("pizauth-n2", { repo: "pizauth", title: "restore accepts forgeable dumps → token/credential injection", oracle: "crypto-misuse", severity: "medium", claimed: "reproduced", tier: "analytical", contributor: "anon-nyc" });
  await F("vibe-sub", { repo: "vibe-kanban", title: "Subprocess arg injection via agent spawn (claimed RCE)", oracle: "logic-authz", severity: "high", claimed: "reproduced", tier: "refuted", contributor: "anon-nyc" });
  const W = (id: string, d: any) => be.set("work_items", id, { id, updatedAt: now(), ...d });
  await W("w1", { repo: "snare", target: "src/httpserver.rs", lens: "recency-diff", oracle: "resource-exhaustion", status: "done", claimedBy: "cor" });
  await W("w2", { repo: "snare", target: "src/httpserver.rs", lens: "taint-pair", oracle: "logic-authz", status: "done", claimedBy: "cor" });
  await W("w3", { repo: "pizauth", target: "src/server/state.rs", lens: "sink-first", oracle: "secrets-exposure", status: "done", claimedBy: "mira" });
  await W("w4", { repo: "snare", target: "src/config.rs", lens: "fuzz-lane", oracle: "panic-dos", status: "running", claimedBy: "dev-berlin" });
  await W("w5", { repo: "pizauth", target: "src/server/http_server.rs", lens: "recency-diff", oracle: "resource-exhaustion", status: "queued" });
  await W("w6", { repo: "who-targets-me", target: "", lens: "sink-first", oracle: "logic-authz", status: "queued" });
  await W("w7", { repo: "who-targets-me", target: "", lens: "cwe-similarity", oracle: "memory-safety", status: "queued" });
  await W("w8", { repo: "vibe-kanban", target: "", lens: "taint-pair", oracle: "logic-authz", status: "queued" });
  await addTrace("cor", "finding", "submitted: unbounded read_line DoS (reproduced, patch attached)");
  await addTrace("verifier", "finding", "✓ verified: snare unauthenticated command execution → reproduced");
  await addTrace("verifier", "status", "✗ rejected: vibe-kanban subprocess arg injection → refuted (could not reproduce)");
}

/* ---------- review track: fan out a PR, collect comments, synthesize one review ---------- */
// The operator points the swarm at a pull request; the platform fans out one review work item
// per lens (mirroring how addRepo fans out hunting lenses). Review work lives in its own
// `review_work` collection so it never tangles with the hunt queue or claimWork.
export async function addReviewTarget(repo: string, prNumber: number, url: string, title: string, addedBy: string) {
  const id = `${slug(repo.split("/").pop() || repo)}-${prNumber}`;
  const target: ReviewTarget = { id, repo, prNumber, url, title, status: "open", addedBy, addedAt: now() };
  await be.set("review_targets", id, target);
  // Replicate each lens R times so multiple DIFFERENT agents review the same lens independently.
  // With R=1 the replication factor is 1 and consensus>1 is unreachable by construction — the
  // whole point of a swarm review is independent agreement, so each lens needs several reviewers.
  let n = 0;
  for (const L of REVIEW_LENSES) {
    for (let r = 0; r < reviewReplication(); r++) {
      const wid = rid();
      const wi: WorkItem = { id: wid, repo, target: `PR#${prNumber}`, lens: L.lens, oracle: L.category, status: "queued", updatedAt: now(), reviewTarget: id };
      await be.set("review_work", wid, wi);
      n++;
    }
  }
  await addTrace(addedBy, "status", `queued review of ${repo}#${prNumber} — ${REVIEW_LENSES.length} lenses × ${reviewReplication()} reviewers = ${n} items`);
  return { target, workItems: n, replication: reviewReplication() };
}

// How many independent agents should review each lens. >=1; default 3.
export const reviewReplication = () => Math.max(1, Number(process.env.REVIEW_REPLICATION) || 3);

export async function claimReview(cid: string, handle: string) {
  const items = (await be.list("review_work")) as WorkItem[];
  // A handle must not review the same lens on the same target twice — that would be one agent's
  // opinion counted as agreement. Skip any queued item whose (target, lens) this handle already took.
  const taken = new Set(
    items.filter((w) => w.claimedBy === handle).map((w) => `${w.reviewTarget}#${w.lens}`)
  );
  const next = items
    .filter((w) => w.status === "queued" && !taken.has(`${w.reviewTarget}#${w.lens}`))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
  if (!next) return null;
  next.status = "running"; next.claimedBy = handle; next.claimedAt = now(); next.updatedAt = now();
  await be.set("review_work", next.id, next);
  const t = (await be.get("review_targets", next.reviewTarget || "")) as ReviewTarget | null;
  await heartbeat(cid, handle, { status: "running", currentWork: `review ${next.repo}#${t?.prNumber ?? "?"} · ${next.lens}` });
  await addTrace(handle, "status", `claimed review lens ${next.lens} on ${next.repo}${t ? " #" + t.prNumber : ""}`);
  return { ...next, target: t };
}

export async function submitReview(
  cid: string, handle: string,
  b: { target: string; workItem?: string; comments: Partial<ReviewComment>[] }
) {
  const target = (await be.get("review_targets", b.target)) as ReviewTarget | null;
  if (!target) return { error: "unknown review target" as const };
  const saved: ReviewComment[] = [];
  for (const c of b.comments || []) {
    const id = "rc-" + rid();
    const rc: ReviewComment = {
      id, target: b.target, workItem: b.workItem,
      path: (c.path || "").slice(0, 300), line: typeof c.line === "number" ? c.line : undefined,
      category: (c.category as any) || "correctness", severity: (c.severity as any) || "info",
      body: (c.body || "").slice(0, 4000), suggestion: c.suggestion ? String(c.suggestion).slice(0, 4000) : undefined,
      lens: c.lens || "correctness", contributor: handle, createdAt: now(),
    };
    await be.set("review_comments", id, rc);
    saved.push(rc);
  }
  if (b.workItem) {
    const wi = (await be.get("review_work", b.workItem)) as WorkItem | null;
    if (wi) { wi.status = "done"; wi.updatedAt = now(); await be.set("review_work", wi.id, wi); }
  }
  const node = (await be.get("nodes", cid)) as Node | null;
  if (node) { node.workDone = (node.workDone || 0) + 1; node.status = "idle"; node.lastSeen = now(); await be.set("nodes", node.id, node); }
  await addTrace(handle, "finding", `submitted ${saved.length} review comment(s) on ${target.repo}#${target.prNumber}`);
  return { ok: true as const, count: saved.length, comments: saved };
}

// Cluster all comments for a target into one synthesized review. Pure logic lives in
// lib/aggregate; this just loads the rows and (optionally) records that we aggregated.
export async function aggregateReview(targetId: string, markAggregated = false): Promise<Aggregated | null> {
  const target = (await be.get("review_targets", targetId)) as ReviewTarget | null;
  if (!target) return null;
  const all = (await be.list("review_comments")) as ReviewComment[];
  const mine = all.filter((c) => c.target === targetId);
  // Cluster on meaning when the Superlinked engine is configured; otherwise fall back to the
  // lexical (path/line/category) heuristic. embed() returns null on any failure, so this can
  // never break the review path.
  let result: Aggregated;
  const vecs = embeddingsEnabled() ? await embed(mine.map((c) => c.body)) : null;
  if (vecs) result = aggregateSemantic(mine, target, vecs, embeddingModel());
  else result = aggregate(mine, target);
  if (markAggregated && target.status === "open") {
    target.status = "aggregated"; await be.set("review_targets", targetId, target);
  }
  return result;
}

// Is a target ready to publish? Quorum = every lens has at least MIN_CONSENSUS reviews in. This is
// deliberately NOT gated on consensus existing: "quorum met, nothing agreed" is an honest outcome
// for a clean PR. `postable` reports how many points actually cleared the consensus bar. Pass the
// already-computed Aggregated to avoid re-clustering (the aggregate route does).
export async function reviewQuorum(targetId: string, agg?: Aggregated) {
  const target = (await be.get("review_targets", targetId)) as ReviewTarget | null;
  if (!target) return null;
  const work = ((await be.list("review_work")) as WorkItem[]).filter((w) => w.reviewTarget === targetId);
  const comments = ((await be.list("review_comments")) as ReviewComment[]).filter((c) => c.target === targetId);
  const byLens = new Map<string, number>();      // lens -> reviews submitted (work items done)
  for (const w of work) if (w.status === "done") byLens.set(w.lens, (byLens.get(w.lens) || 0) + 1);
  // Show every lens that was fanned out, even at 0 done, so the operator sees the full picture.
  const allLenses = new Set(work.map((w) => w.lens));
  const lenses = [...allLenses].map((lens) => ({ lens, done: byLens.get(lens) || 0, need: MIN_CONSENSUS }));
  const contributors = new Set(comments.map((c) => c.contributor)).size;
  const a = agg || aggregate(comments, target);
  return {
    targetId,
    lenses,
    replication: reviewReplication(),
    contributors,
    postable: a.agreed.length,                   // points that cleared the consensus bar
    ready: lenses.length > 0 && lenses.every((l) => l.done >= l.need),
  };
}

// Record that a synthesized review was posted to GitHub (called by the post route on success).
export async function markReviewPosted(targetId: string, postedUrl: string, postedIds: string[]) {
  const target = (await be.get("review_targets", targetId)) as ReviewTarget | null;
  if (!target) return null;
  target.status = "posted"; target.postedUrl = postedUrl; target.postedAt = now();
  await be.set("review_targets", targetId, target);
  for (const id of postedIds) {
    const rc = (await be.get("review_comments", id)) as ReviewComment | null;
    if (rc) { rc.posted = true; await be.set("review_comments", id, rc); }
  }
  await addTrace("operator", "finding", `posted synthesized review to ${target.repo}#${target.prNumber} → ${postedUrl}`);
  return target;
}

/* ---------- project-oriented impact rollup ---------- */
// Reconcile the two repo namings: findings store a short name ("snare"), review targets store
// "owner/repo" ("CorneliusHagmeister/snare"). Both collapse to the same key on the last segment.
const projectKey = (repo: string) => slug((repo || "").split("/").pop() || repo);

export async function getProjects(): Promise<Project[]> {
  await maybeSeed();
  const [repos, findings, targets, comments] = await Promise.all([
    be.list("repos"), be.list("findings"), be.list("review_targets"), be.list("review_comments"),
  ]) as [Repo[], Finding[], ReviewTarget[], ReviewComment[]];

  const map = new Map<string, Project>();
  const ensure = (repo: string, seed?: Partial<Project>): Project => {
    const key = projectKey(repo);
    let p = map.get(key);
    if (!p) {
      p = {
        key, name: repo, url: undefined, language: undefined, contributors: [],
        findings: { total: 0, reproduced: 0, analytical: 0, refuted: 0, overclaims: 0, patches: 0 },
        review: { comments: 0, consensusPoints: 0, posted: 0 },
        contributions: 0, lastActivity: "", events: [],
      };
      map.set(key, p);
    }
    if (seed) Object.assign(p, { ...seed, findings: p.findings, review: p.review, events: p.events, contributors: p.contributors });
    return p;
  };
  const touch = (p: Project, ts: string) => { if (ts > p.lastActivity) p.lastActivity = ts; };
  const addWho = (p: Project, who?: string) => { if (who && !p.contributors.includes(who)) p.contributors.push(who); };

  // Seed from known repos so a project with no activity yet still appears.
  for (const r of repos) ensure(r.name, { name: r.name, url: r.url, language: r.language });

  // Findings
  for (const f of findings) {
    const p = ensure(f.repo);
    p.findings.total++;
    const over = f.claimed === "reproduced" && (f.tier === "analytical" || f.tier === "refuted");
    if (f.tier === "reproduced") p.findings.reproduced++;
    else if (f.tier === "analytical") p.findings.analytical++;
    else if (f.tier === "refuted") p.findings.refuted++;
    if (over) p.findings.overclaims++;
    if (f.patch) p.findings.patches++;
    p.contributions++; addWho(p, f.contributor); touch(p, f.createdAt);
    p.events.push({
      ts: f.createdAt,
      kind: over ? "over-claim" : f.tier === "reproduced" ? "verified" : "finding",
      text: over ? `over-claim rejected: "${f.title}"` : f.tier === "reproduced" ? `reproduced & ${f.patch ? "patched" : "confirmed"}: "${f.title}"` : `submitted: "${f.title}"`,
      who: f.contributor, severity: f.severity,
    });
  }

  // Review targets + their comments
  const byTarget = new Map<string, ReviewComment[]>();
  for (const c of comments) (byTarget.get(c.target) || byTarget.set(c.target, []).get(c.target)!).push(c);
  for (const t of targets) {
    const p = ensure(t.repo, { name: t.repo, url: `https://github.com/${t.repo}` });
    const cs = byTarget.get(t.id) || [];
    p.review.comments += cs.length;
    p.review.prNumber = t.prNumber;
    const agg = aggregate(cs, t);
    const consensus = agg.clusters.filter((c) => c.consensus >= 2).length;
    p.review.consensusPoints += consensus;
    p.contributions += cs.length;
    touch(p, t.addedAt);
    for (const c of cs) {
      addWho(p, c.contributor); touch(p, c.createdAt);
      p.events.push({
        ts: c.createdAt, kind: "review-comment", who: c.contributor, severity: c.severity,
        text: `commented on ${c.path}${c.line != null ? ":" + c.line : ""} (${c.category}) — PR#${t.prNumber}`,
      });
    }
    if (t.status === "posted" && t.postedUrl) {
      p.review.posted++;
      p.review.postedUrl = t.postedUrl;
      touch(p, t.postedAt || t.addedAt);
      p.events.push({
        ts: t.postedAt || t.addedAt, kind: "review-posted", url: t.postedUrl,
        text: `synthesized review posted to PR#${t.prNumber} (${cs.length} comments → ${consensus} consensus point${consensus === 1 ? "" : "s"})`,
      });
    }
  }

  const out = [...map.values()];
  for (const p of out) {
    p.events.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    p.events = p.events.slice(0, 40);
    if (!p.lastActivity) p.lastActivity = now();
  }
  // Most contributions first; ties broken by most recent activity.
  out.sort((a, b) => b.contributions - a.contributions || String(b.lastActivity).localeCompare(String(a.lastActivity)));
  return out;
}

/* ---------- full state for the dashboard ---------- */
export async function getState() {
  await maybeSeed();
  const [repos, work, findings, nodes, tracesDoc, reviewTargets, reviewWork, reviewComments] = await Promise.all([
    be.list("repos"), be.list("work_items"), be.list("findings"), be.list("nodes"), be.get("meta", "traces"),
    be.list("review_targets"), be.list("review_work"), be.list("review_comments"),
  ]);
  const traces: Trace[] = ((tracesDoc as any)?.items || []).slice(-600).reverse();
  const liveNodes = (nodes as Node[]).filter((n) => isLive(n.lastSeen));
  const stats = {
    nodesLive: liveNodes.length,
    inflight: (work as WorkItem[]).filter((w) => w.status === "running" || w.status === "claimed").length,
    queued: (work as WorkItem[]).filter((w) => w.status === "queued").length,
    confirmed: (findings as Finding[]).filter((f) => f.tier === "reproduced").length,
    overclaims: (findings as Finding[]).filter((f) => f.claimed === "reproduced" && (f.tier === "analytical" || f.tier === "refuted")).length,
    repos: (repos as Repo[]).length,
    reviewComments: (reviewComments as ReviewComment[]).length,
    reviewsPosted: (reviewTargets as ReviewTarget[]).filter((t) => t.status === "posted").length,
  };
  // The dashboard reads reviewTargets + reviewComments from here and fetches the clustered
  // consensus separately from /api/review/aggregate (which re-runs only when a comment lands).
  return { repos, work, findings, nodes, traces, stats, reviewTargets, reviewWork, reviewComments, serverTime: now() };
}
