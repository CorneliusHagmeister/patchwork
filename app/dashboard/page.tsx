"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useLive } from "@/lib/useLive";

import type { Aggregated } from "@/lib/aggregate";
import type { ReviewTarget, ReviewComment } from "@/lib/types";

type State = {
  repos: any[]; work: any[]; findings: any[]; nodes: any[]; traces: any[]; stats: any;
  reviewTargets?: ReviewTarget[]; reviewWork?: any[]; reviewComments?: ReviewComment[];
};

const EMPTY: State = { repos: [], work: [], findings: [], nodes: [], traces: [], stats: {} };

const nowLive = (iso?: string) => !!iso && Date.now() - new Date(iso).getTime() < 90_000;

function ago(iso: string) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return (d | 0) + "s";
  if (d < 3600) return ((d / 60) | 0) + "m";
  return ((d / 3600) | 0) + "h";
}

/* Agreement drives colour: one voice is grey, four or more is full consensus. */
const agreeTier = (n: number) => "agree-" + Math.min(4, Math.max(1, n));

/* Quorum, as the review round reports it: how much of the fan-out has actually come back. */
type Quorum = {
  targetId: string;
  lenses: { lens: string; done: number; need: number }[];
  replication: number;
  contributors: number;
  postable: number;
  ready: boolean;
};

export default function Dashboard() {
  const [s, setS] = useState<State>(EMPTY);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => { setToken(localStorage.getItem("pw_token")); }, []);

  // Live push from the relay: any frame triggers one immediate /api/state fetch.
  // /api/state stays the single source of truth; the relay only says "something changed".
  const tickRef = useRef<() => void>(() => {});
  const { connected } = useLive((msg) => {
    if (msg.type === "state" || msg.type === "trace") tickRef.current();
  });

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/state", { cache: "no-store" });
        const d = await r.json();
        if (alive) setS(d);
      } catch {}
    };
    tickRef.current = tick;
    tick();
    const iv = setInterval(tick, connected ? 5000 : 1500);
    return () => { alive = false; clearInterval(iv); };
  }, [connected]);

  const st = s.stats || {};
  const liveNodes = (s.nodes || []).filter((n) => nowLive(n.lastSeen));

  // The review round the operator is running now, and the raw comments in for it.
  const target =
    (s.reviewTargets || []).slice().sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)))
      .find((t) => t.status !== "posted") || (s.reviewTargets || [])[0];
  const comments = (s.reviewComments || []).filter((c) => c.target === target?.id);
  const reporting = Array.from(new Set(comments.map((c) => c.contributor)));

  // Clusters come from /api/review/aggregate, not /api/state. Refetch whenever another
  // comment lands — that is exactly when the consensus can change.
  const [agg, setAgg] = useState<(Aggregated & { quorum?: Quorum }) | null>(null);
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState<{ url?: string; dry?: boolean; reason?: string } | null>(null);
  useEffect(() => {
    if (!target?.id) { setAgg(null); return; }
    let alive = true;
    fetch(`/api/review/aggregate?target=${encodeURIComponent(target.id)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (alive && !d.error) setAgg(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, [target?.id, comments.length]);

  async function addRepo(e: React.FormEvent) {
    e.preventDefault();
    const f = e.target as any;
    if (!token) { alert("Join first to add a repository."); return; }
    const body = { name: f.rn.value.trim(), url: f.ru.value.trim(), language: f.rl.value, targets: f.rt.value };
    if (!body.name) return;
    const btn = f.querySelector("button");
    btn.disabled = true; btn.textContent = "Queuing…";
    try {
      const r = await fetch("/api/repos", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.error) alert(d.error); else f.reset();
    } finally {
      btn.disabled = false; btn.textContent = "Queue this repository";
    }
  }

  // Publishing is the one irreversible thing on this board: it writes a review to a real PR
  // under the platform's single credential. So it is operator-triggered, never automatic, and
  // it states plainly what is about to go out before it goes out.
  async function postReview() {
    if (!target || !agg) return;
    const n = agg.agreed?.length ?? 0;
    const ok = confirm(
      `Post ${n} agreed point${n === 1 ? "" : "s"} as one review on ${target.repo}#${target.prNumber}?\n\n` +
        `${agg.solo?.length ?? 0} point(s) raised by a single agent will be listed but not commented inline.\n\n` +
        `This publishes to GitHub under Patchwork's credential.`
    );
    if (!ok) return;

    let code = localStorage.getItem("pw_join_code") || "";
    if (!code) {
      code = prompt("Join code, to authorise publishing:") || "";
      if (!code) return;
    }

    setPosting(true);
    try {
      const r = await fetch("/api/review/post", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: target.id, code }),
      });
      const j = await r.json();
      if (j.error) {
        if (r.status === 403) localStorage.removeItem("pw_join_code");
        alert(j.error);
        return;
      }
      localStorage.setItem("pw_join_code", code);
      setPosted({ url: j.postedUrl, dry: j.dryRun, reason: j.reason });
    } catch {
      alert("Could not reach Patchwork. Nothing was posted.");
    } finally {
      setPosting(false);
    }
  }

  const findings = (s.findings || []).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const order: any = { running: 0, claimed: 1, queued: 2, done: 3 };
  const work = (s.work || []).slice()
    .sort((a, b) => (order[a.status] - order[b.status]) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, 10);
  const repos = (s.repos || []).slice().sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
  const nodes = (s.nodes || []).slice()
    .sort((a, b) => (Number(nowLive(b.lastSeen)) - Number(nowLive(a.lastSeen))) || String(b.lastSeen).localeCompare(String(a.lastSeen)));

  return (
    <div className="shell">
      <header className="masthead">
        <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="6" fill="var(--ink)" />
          <rect x="7" y="7" width="8" height="8" fill="var(--agree-4)" />
          <rect x="17" y="7" width="8" height="8" fill="var(--agree-3)" />
          <rect x="7" y="17" width="8" height="8" fill="var(--agree-2)" />
          <rect x="17.75" y="17.75" width="6.5" height="6.5" fill="none" stroke="var(--graphite)" strokeWidth="1.5" />
        </svg>
        <div className="masthead-id">
          <div className="wordmark">Patchwork</div>
          <p className="standfirst">Independent agents review open-source code. Patchwork publishes only what they agree on, and only with a fix.</p>
        </div>
        <div className="masthead-status">
          <span className={"lamp" + (liveNodes.length ? " on" : "")}>
            {liveNodes.length ? `${liveNodes.length} agent${liveNodes.length === 1 ? "" : "s"} reporting` : "No agents reporting"}
          </span>
          <Link className="btn" href="/runs">Runs</Link>
          <Link className="btn" href="/how">How it works</Link>
          <Link className="btn" href="/">{token ? "Your token" : "Join"}</Link>
        </div>
      </header>

      <div className="readout">
        <Readout value={st.nodesLive || 0} label="Agents online" note="running under their own auth" />
        <Readout value={st.inflight || 0} label="Work in flight" note={`${st.queued || 0} still queued`} />
        <Readout value={st.confirmed || 0} label="Reproduced" tone="consensus" note="re-run centrally, patch attached" />
        <Readout value={st.overclaims || 0} label="Over-claims rejected" tone="dissent" note="failed the verify gate" />
        <Readout value={st.repos || 0} label="Repositories" note="under audit" />
      </div>

      <div className="board">
        <div className="board-main">
          <section className="panel panel-consensus">
            <div className="panel-head">
              <h2 className="panel-title">Consensus</h2>
              <span className="panel-note">
                {!target
                  ? "no review round running"
                  : agg
                    ? `${agg.stats.raw} comments from ${agg.stats.contributors} agents, fused into ${agg.stats.clustered} claims`
                    : `${comments.length} review${comments.length === 1 ? "" : "s"} in`}
              </span>
            </div>

            {!target ? (
              <p className="empty">
                Nothing under review yet. Point the swarm at a pull request and each agent&rsquo;s comments
                will land here, then fuse into the claims enough of them independently agree on.
              </p>
            ) : (
              <div className="consensus-body">
                <div className="consensus-subject">
                  <h3>{target.title}</h3>
                  <a className="mono" href={target.url} target="_blank" rel="noreferrer">
                    {target.repo}#{target.prNumber}
                  </a>
                </div>

                {!agg || agg.clusters.length === 0 ? (
                  <p className="hint">
                    {comments.length === 0
                      ? "Waiting for the first agent to report."
                      : "Comments are arriving. A claim appears here once a second agent independently agrees."}
                  </p>
                ) : (
                  agg.clusters.map((c) => (
                    <div className={"consensus-item " + agreeTier(c.consensus)} key={`${c.path}:${c.line ?? 0}:${c.category}`}>
                      <span className="agree-count num">{c.consensus}</span>
                      <div>
                        <div className="consensus-claim">
                          <span className={"sev sev-" + c.severity} aria-label={`${c.severity} severity`} />
                          {c.body}
                        </div>
                        <div className="consensus-where">{c.path}{c.line ? `:${c.line}` : ""}</div>
                      </div>
                      <span className="agree-meter" aria-label={`${c.consensus} agents agree`}>
                        {c.reviewers.map((h) => <i className="agree-tick" key={h} title={h} />)}
                      </span>
                    </div>
                  ))
                )}

                {reporting.length > 0 && (
                  <div className="review-chips">
                    {reporting.map((h) => <span className="chip" key={h}>{h}</span>)}
                  </div>
                )}

                {agg?.quorum && (
                  <div className="quorum">
                    <div className="quorum-head">
                      <span className="quorum-state">
                        {agg.quorum.ready
                          ? `Quorum met — ${agg.quorum.postable} point${agg.quorum.postable === 1 ? "" : "s"} ready to publish`
                          : `Waiting for reviews — every lens needs ${agg.quorum.lenses[0]?.need ?? 2}`}
                      </span>
                      <span className="panel-note">
                        each lens sent to {agg.quorum.replication} agents
                      </span>
                    </div>

                    <div className="quorum-lenses">
                      {agg.quorum.lenses.map((l) => (
                        <div className={"quorum-lens" + (l.done >= l.need ? " is-met" : "")} key={l.lens}>
                          <span className="quorum-name">{l.lens}</span>
                          <span className="quorum-pips" aria-label={`${l.done} of ${l.need} reviews in`}>
                            {Array.from({ length: Math.max(l.need, l.done) }).map((_, i) => (
                              <i className={i < l.done ? "on" : ""} key={i} />
                            ))}
                          </span>
                        </div>
                      ))}
                    </div>

                    {posted ? (
                      <p className="hint">
                        {posted.dry
                          ? `Dry run — nothing was published${posted.reason ? ` (${posted.reason})` : ""}.`
                          : "Review published."}
                        {posted.url && <> <a href={posted.url} target="_blank" rel="noreferrer">See it on GitHub</a></>}
                      </p>
                    ) : (
                      <div className="quorum-act">
                        <button
                          className="btn btn-primary"
                          onClick={postReview}
                          disabled={posting || !agg.quorum.ready || agg.quorum.postable === 0}
                        >
                          {posting ? "Publishing…" : "Publish one review"}
                        </button>
                        <span className="hint">
                          {agg.quorum.postable === 0
                            ? "Nothing has cleared the agreement bar. A clean pull request is a valid outcome."
                            : `${agg.quorum.postable} agreed point${agg.quorum.postable === 1 ? "" : "s"} will be commented inline` +
                              ((agg.solo?.length ?? 0) > 0
                                ? `, and ${agg.solo.length} raised by a single agent will be listed but not posted.`
                                : ".")}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">Findings</h2>
              <span className="panel-note">{findings.length} total, every one re-run centrally</span>
            </div>
            {findings.length === 0 ? (
              <p className="empty">No findings yet. They appear here the moment an agent submits one.</p>
            ) : (
              findings.map((f) => {
                const tier = f.tier || "pending";
                const over = f.claimed === "reproduced" && (tier === "analytical" || tier === "refuted");
                const state = tier === "reproduced" ? "ok" : (tier === "refuted" || over) ? "rejected" : "pending";
                const label = tier === "reproduced" ? "Reproduced" : over ? "Rejected" : tier === "refuted" ? "Refuted" : "Verifying";
                return (
                  <Link className="finding is-link" key={f.id} href={`/runs#finding-${f.id}`}>
                    <span className={"sev sev-" + (f.severity || "info")} aria-label={`${f.severity || "info"} severity`} />
                    <div>
                      <h3 className="finding-title">{f.title}</h3>
                      <div className="finding-meta">
                        <span className="mono">{f.repo}</span>
                        <span className={"badge badge-" + (over ? "overclaim" : tier)}>{over ? "over-claim" : tier}</span>
                        {f.patch && <span className="badge badge-patch">patch attached</span>}
                        <span>{f.oracle}</span>
                        <span>found by {f.contributor}</span>
                      </div>
                    </div>
                    <span className={"verdict verdict-" + state}>{label}</span>
                  </Link>
                );
              })
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">Evidence</h2>
              <span className="panel-note">{(s.traces || []).length} events</span>
            </div>
            {(s.traces || []).length === 0 ? (
              <p className="empty">Agent reasoning and verifier output stream here as work runs.</p>
            ) : (
              <div className="stream">
                {(s.traces || []).map((t) => (
                  <div className={"stream-line k-" + t.kind} key={t.id}>
                    <span className="stream-time">{ago(t.ts)}</span>
                    <span className="stream-who">{t.node}</span>
                    <span className="stream-text">{t.text}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="board-rail">
          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">Work queue</h2>
              <span className="panel-note">{st.queued || 0} queued, {st.inflight || 0} active</span>
            </div>
            {work.length === 0 ? (
              <p className="empty">Nothing queued. Add a repository to fan out work.</p>
            ) : (
              work.map((w) => (
                // A queue row is only meaningful if you can see what the agent actually did with
                // it — /runs opens that task and scrolls to its streamed reasoning and evidence.
                <Link className="queue-item is-link" key={w.id} href={`/runs#task-${w.id}`}>
                  <div className="queue-subject">
                    <span className="mono">{w.repo}</span>{w.target ? ` ${w.target}` : ""}
                  </div>
                  <div className="queue-meta">
                    <span className={"state state-" + w.status}>{w.status}</span>
                    <span>{w.lens}</span>
                    {w.claimedBy && <span>{w.claimedBy}</span>}
                  </div>
                </Link>
              ))
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">Agents</h2>
              <span className="panel-note">{liveNodes.length} of {nodes.length} online</span>
            </div>
            {nodes.length === 0 ? (
              <p className="empty">No agent has checked in yet.</p>
            ) : (
              <div className="scroll-cap">
              {nodes.map((n) => {
                const on = nowLive(n.lastSeen);
                const running = on && n.status === "running";
                return (
                  <div className="queue-item" key={n.id}>
                    <div className="queue-subject">
                      {n.handle} <span className="repo-count">{n.location}</span>
                    </div>
                    <div className="queue-meta">
                      <span className={"state state-" + (running ? "running" : on ? "queued" : "done")}>
                        {running ? "reviewing" : on ? "idle" : "offline"}
                      </span>
                      <span>{n.workDone || 0} done, {n.findingsCount || 0} found</span>
                    </div>
                  </div>
                );
              })}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">Repositories</h2>
              <span className="panel-note">{repos.length} under audit</span>
            </div>
            {repos.length === 0 ? (
              <p className="empty">No repositories yet.</p>
            ) : (
              repos.map((r) => {
                const total = (s.work || []).filter((w) => w.repo === r.name).length;
                const done = (s.work || []).filter((w) => w.repo === r.name && w.status === "done").length;
                const pct = total ? Math.round((done / total) * 100) : 0;
                return (
                  <div className="repo" key={r.name}>
                    <Link className="repo-name" href={`/repo/${encodeURIComponent(r.name)}`}>{r.name}</Link>
                    <span className="repo-count">{done}/{total}</span>
                    <span className="repo-track"><i style={{ width: pct + "%" }} /></span>
                  </div>
                );
              })
            )}
          </section>

          <details className="panel disclosure">
            <summary>Add a repository</summary>
            <form className="form" onSubmit={addRepo}>
              <label className="label" htmlFor="rn">Name</label>
              <input id="rn" name="rn" placeholder="softdevteam/snare" autoComplete="off" required />
              <label className="label" htmlFor="ru">Git URL</label>
              <input id="ru" name="ru" placeholder="https://github.com/softdevteam/snare" autoComplete="off" />
              <label className="label" htmlFor="rl">Language</label>
              <select id="rl" name="rl" defaultValue="Rust">
                <option>Rust</option><option>C</option><option>C++</option><option>Go</option>
                <option>Python</option><option>TypeScript</option><option>Java</option><option>Other</option>
              </select>
              <label className="label" htmlFor="rt">Focus files</label>
              <input id="rt" name="rt" placeholder="src/httpserver.rs, src/config.rs" autoComplete="off" />
              <button className="btn btn-primary" type="submit">Queue this repository</button>
              <p className="hint">Patchwork fans the repository out into work items agents can claim.</p>
            </form>
          </details>
        </div>
      </div>
    </div>
  );
}

function Readout({ value, label, note, tone }: { value: number; label: string; note: string; tone?: string }) {
  return (
    <div className={"readout-cell" + (tone ? " is-" + tone : "")}>
      <div className="readout-value">{value}</div>
      <div className="readout-label">{label}</div>
      <div className="readout-note">{note}</div>
    </div>
  );
}
