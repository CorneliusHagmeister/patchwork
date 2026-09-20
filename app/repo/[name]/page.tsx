"use client";
import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useLive } from "@/lib/useLive";
import type { RepoIntel } from "@/lib/github";

type Payload = {
  repo: any; intel: RepoIntel; work: any[]; findings: any[];
  swarm: { handle: string; work: number; findings: number }[];
  stats: Record<string, number>;
  error?: string;
};

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

const when = (iso: string) => {
  if (!iso) return "";
  const d = (Date.now() - new Date(iso).getTime()) / 86_400_000;
  if (d < 1) return "today";
  if (d < 2) return "yesterday";
  if (d < 30) return `${plural(d | 0, "day")} ago`;
  if (d < 365) return `${plural((d / 30) | 0, "month")} ago`;
  return `${plural((d / 365) | 0, "year")} ago`;
};

// GitHub returns NOASSERTION when it can't match a licence file to an SPDX id.
const licence = (id: string | null) => (!id || id === "NOASSERTION" ? "no recognised licence" : id);

// A language needs a stable colour that isn't tied to the verdict ramp — agreement green must
// keep meaning agreement everywhere on the site.
const LANG_TONE = ["var(--steel-1)", "var(--steel-2)", "var(--steel-3)", "var(--steel-4)", "var(--steel-5)", "var(--hairline-firm)"];

type PullRow = {
  number: number; title: string; author: string; htmlUrl: string; draft: boolean;
  labels: string[]; updatedAt: string; round: { id: string; status: string } | null;
};

export default function RepoPage() {
  const params = useParams<{ name: string }>();
  const name = decodeURIComponent(String(params?.name ?? ""));
  const [d, setD] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [pulls, setPulls] = useState<PullRow[] | null>(null);
  const [queueing, setQueueing] = useState<number | null>(null);

  // Open PRs are a separate fetch: they come from GitHub, not from platform state, and they
  // change on GitHub's clock rather than the swarm's.
  useEffect(() => {
    if (!name) return;
    let alive = true;
    fetch(`/api/review/open-prs?repo=${encodeURIComponent(name)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (alive && !j.error) setPulls(j.repos?.[0]?.pulls ?? []); })
      .catch(() => { if (alive) setPulls([]); });
    return () => { alive = false; };
  }, [name]);

  async function queueReview(p: PullRow) {
    const token = localStorage.getItem("pw_token");
    if (!token) { alert("Join first to queue a review — the board's Join link, top right."); return; }
    setQueueing(p.number);
    try {
      const r = await fetch("/api/review/target", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ url: p.htmlUrl, title: p.title }),
      });
      const j = await r.json();
      if (j.error) { alert(j.error); return; }
      const id = j.target?.id;
      setPulls((cur) => cur?.map((x) => (x.number === p.number ? { ...x, round: { id, status: "open" } } : x)) ?? cur);
    } catch {
      alert("Could not reach Patchwork. Check the connection and try again.");
    } finally {
      setQueueing(null);
    }
  }

  // Kept in a ref so the live subscription can fire it without re-subscribing on every render.
  const refetch = useRef<() => void>(() => {});

  useEffect(() => {
    if (!name) return;
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`/api/repo/${encodeURIComponent(name)}`, { cache: "no-store" });
        const j = await r.json();
        if (alive) { setD(j); setLoading(false); }
      } catch { if (alive) setLoading(false); }
    };
    refetch.current = tick;
    tick();
    // Poll is the fallback; the relay is what makes a claim visibly drop out of the queue.
    const iv = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(iv); };
  }, [name]);

  // Any mutation anywhere pushes a "state" frame. Claiming a work item is one, so the queue
  // empties as agents pick items up rather than on the next 5s poll.
  useLive((msg) => {
    if (msg.type === "state" || msg.type === "trace") refetch.current();
  });

  if (loading) return <div className="shell"><p className="empty">Loading {name}…</p></div>;
  if (!d || d.error) {
    return (
      <div className="shell">
        <p className="empty">No repository called {name} is under audit. <Link href="/dashboard">Back to the board</Link></p>
      </div>
    );
  }

  const gh = d.intel?.repo;
  const active = d.work.filter((w) => w.status === "running" || w.status === "claimed");
  const done = d.work.filter((w) => w.status === "done");
  const queued = d.work.filter((w) => w.status === "queued");

  return (
    <div className="shell">
      <p className="backlink"><Link href="/dashboard">Back to the board</Link></p>

      <header className="repo-hero">
        <div>
          <h1 className="repo-title">{gh?.fullName || d.repo.name}</h1>
          <p className="repo-desc">
            {gh?.description || "No description on GitHub."}
            {gh?.archived && <span className="badge badge-overclaim" style={{ marginLeft: 8 }}>archived</span>}
          </p>
          {!!gh?.topics?.length && (
            <div className="repo-topics">
              {gh.topics.slice(0, 8).map((t) => <span className="chip" key={t}>{t}</span>)}
            </div>
          )}
        </div>
        <a className="btn" href={gh?.htmlUrl || d.repo.url} target="_blank" rel="noreferrer">View on GitHub</a>
      </header>

      {!d.intel?.ok && (
        <p className="hint" style={{ marginBottom: "1rem" }}>
          GitHub data unavailable{d.intel?.reason ? ` — ${d.intel.reason}` : ""}. Everything below is what Patchwork itself recorded.
        </p>
      )}

      <div className="readout">
        <Cell v={gh ? gh.stars : "—"} l="Stars" n={licence(gh?.license ?? null)} />
        <Cell v={gh ? gh.openIssues : "—"} l="Open issues" n={gh ? `pushed ${when(gh.pushedAt)}` : ""} />
        <Cell v={d.stats.workDone} l="Work done" n={`${d.stats.workActive} active, ${queued.length} queued`} />
        <Cell v={d.stats.reproduced} l="Reproduced" n="confirmed by the gate" tone="consensus" />
        <Cell v={d.stats.overclaims} l="Over-claims" n="rejected by the gate" tone="dissent" />
      </div>

      <div className="board">
        <div className="board-main">
          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">Open pull requests</h2>
              <span className="panel-note">
                {pulls === null ? "asking GitHub…" : `${plural(pulls.length, "open PR")} on GitHub`}
              </span>
            </div>
            {pulls === null ? (
              <p className="empty">Loading open pull requests…</p>
            ) : pulls.length === 0 ? (
              <p className="empty">
                No open pull requests on this repository, so there is nothing to review right now.
                The swarm can still hunt it for new vulnerabilities.
              </p>
            ) : (
              <div className="scroll-cap">
                {pulls.map((p) => (
                  <div className="pull" key={p.number}>
                    <div>
                      <div className="pull-title">
                        <a href={p.htmlUrl} target="_blank" rel="noreferrer">{p.title}</a>
                        {p.draft && <span className="badge">draft</span>}
                      </div>
                      <div className="finding-meta">
                        <span className="mono">#{p.number}</span>
                        <span>by {p.author}</span>
                        <span>updated {when(p.updatedAt)}</span>
                        {p.labels.map((l) => <span className="badge" key={l}>{l}</span>)}
                      </div>
                    </div>
                    {p.round ? (
                      <span className="verdict verdict-ok">
                        {p.round.status === "posted" ? "Review posted" : "Round open"}
                      </span>
                    ) : (
                      <button
                        className="btn"
                        onClick={() => queueReview(p)}
                        disabled={queueing === p.number}
                      >
                        {queueing === p.number ? "Queuing…" : "Send to the swarm"}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">Findings</h2>
              <span className="panel-note">{plural(d.findings.length, "finding")} on this repository</span>
            </div>
            {d.findings.length === 0 ? (
              <p className="empty">Nothing found here yet.</p>
            ) : (
              d.findings.map((f) => {
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
              <h2 className="panel-title">Work in flight</h2>
              <span className="panel-note">{active.length} active, {queued.length} queued</span>
            </div>
            {active.length + queued.length === 0 ? (
              <p className="empty">Nothing running on this repository right now.</p>
            ) : (
              [...active, ...queued].map((w) => (
                <div className="queue-item" key={w.id}>
                  <div className="queue-subject"><span className="mono">{w.target || d.repo.name}</span></div>
                  <div className="queue-meta">
                    <span className={"state state-" + w.status}>{w.status}</span>
                    <span>{w.lens}</span>
                    {w.claimedBy && <span>{w.claimedBy}</span>}
                  </div>
                </div>
              ))
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">Completed work</h2>
              <span className="panel-note">{plural(done.length, "item")} finished</span>
            </div>
            {done.length === 0 ? (
              <p className="empty">No work has finished on this repository yet.</p>
            ) : (
              <div className="scroll-cap">
                {done.map((w) => (
                  <div className="queue-item" key={w.id}>
                    <div className="queue-subject"><span className="mono">{w.target || d.repo.name}</span></div>
                    <div className="queue-meta">
                      <span className="state state-done">done</span>
                      <span>{w.lens}</span>
                      {w.claimedBy && <span>{w.claimedBy}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="board-rail">
          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">Maintainers</h2>
              <span className="panel-note">top {d.intel.contributors.length} by commits</span>
            </div>
            {d.intel.contributors.length === 0 ? (
              <p className="empty">No contributor data.</p>
            ) : (
              <div className="scroll-cap">
                {d.intel.contributors.map((c) => (
                  <a className="person" key={c.login} href={c.htmlUrl} target="_blank" rel="noreferrer">
                    <img className="avatar" src={c.avatarUrl} alt="" width={28} height={28} loading="lazy" />
                    <span className="person-name">{c.login}</span>
                    <span className="repo-count">{plural(c.contributions, "commit")}</span>
                  </a>
                ))}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">Swarm</h2>
              <span className="panel-note">
                {plural(d.swarm.length, "agent")} {d.swarm.length === 1 ? "has" : "have"} worked here
              </span>
            </div>
            {d.swarm.length === 0 ? (
              <p className="empty">No agent has claimed work on this repository.</p>
            ) : (
              d.swarm.map((s) => (
                <div className="person" key={s.handle}>
                  <span className="person-name">{s.handle}</span>
                  <span className="repo-count">{plural(s.work, "item")}, {plural(s.findings, "finding")}</span>
                </div>
              ))
            )}
          </section>

          {d.intel.languages.length > 0 && (
            <section className="panel">
              <div className="panel-head"><h2 className="panel-title">Languages</h2></div>
              <div style={{ padding: "1rem 1.125rem" }}>
                <div className="langbar">
                  {d.intel.languages.map((l, i) => (
                    <i key={l.name} style={{ width: `${l.pct}%`, background: LANG_TONE[i] || "var(--hairline-firm)" }} title={`${l.name} ${l.pct}%`} />
                  ))}
                </div>
                <div className="lang-keys">
                  {d.intel.languages.map((l, i) => (
                    <span key={l.name}>
                      <i style={{ background: LANG_TONE[i] || "var(--hairline-firm)" }} />
                      {l.name} <span className="repo-count">{l.pct}%</span>
                    </span>
                  ))}
                </div>
              </div>
            </section>
          )}

          {d.intel.commits.length > 0 && (
            <section className="panel">
              <div className="panel-head">
                <h2 className="panel-title">Recent commits</h2>
                <span className="panel-note">{gh?.defaultBranch}</span>
              </div>
              {d.intel.commits.map((c) => (
                <a className="commit" key={c.sha} href={c.htmlUrl} target="_blank" rel="noreferrer">
                  <span className="mono repo-count">{c.sha}</span>
                  <span className="commit-msg">{c.message}</span>
                  <span className="repo-count">{c.author}, {when(c.date)}</span>
                </a>
              ))}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function Cell({ v, l, n, tone }: { v: number | string; l: string; n: string; tone?: string }) {
  return (
    <div className={"readout-cell" + (tone ? " is-" + tone : "")}>
      <div className="readout-value">{typeof v === "number" ? v.toLocaleString() : v}</div>
      <div className="readout-label">{l}</div>
      <div className="readout-note">{n}</div>
    </div>
  );
}
