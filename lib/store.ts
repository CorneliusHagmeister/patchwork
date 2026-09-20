import { neon } from "@neondatabase/serverless";
import { LENSES, type Finding, type Node, type Repo, type Trace, type WorkItem, type Tier } from "./types";

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
  if (doc.items.length > 200) doc.items = doc.items.slice(-200);
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

/* ---------- full state for the dashboard ---------- */
export async function getState() {
  await maybeSeed();
  const [repos, work, findings, nodes, tracesDoc] = await Promise.all([
    be.list("repos"), be.list("work_items"), be.list("findings"), be.list("nodes"), be.get("meta", "traces"),
  ]);
  const traces: Trace[] = ((tracesDoc as any)?.items || []).slice(-120).reverse();
  const liveNodes = (nodes as Node[]).filter((n) => isLive(n.lastSeen));
  const stats = {
    nodesLive: liveNodes.length,
    inflight: (work as WorkItem[]).filter((w) => w.status === "running" || w.status === "claimed").length,
    queued: (work as WorkItem[]).filter((w) => w.status === "queued").length,
    confirmed: (findings as Finding[]).filter((f) => f.tier === "reproduced").length,
    overclaims: (findings as Finding[]).filter((f) => f.claimed === "reproduced" && (f.tier === "analytical" || f.tier === "refuted")).length,
    repos: (repos as Repo[]).length,
  };
  return { repos, work, findings, nodes, traces, stats, serverTime: now() };
}
