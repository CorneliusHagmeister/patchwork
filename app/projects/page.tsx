"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { Project, ProjectEvent } from "@/lib/types";

type Data = {
  projects: Project[];
  totals: { projects: number; contributions: number; reproduced: number; reviewsPosted: number; contributors: number };
  orchestrator?: { engine: string; model?: string };
};

const nowLive = (iso?: string) => !!iso && Date.now() - new Date(iso).getTime() < 90_000;
function ago(iso: string) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return (d | 0) + "s";
  if (d < 3600) return ((d / 60) | 0) + "m";
  if (d < 86400) return ((d / 3600) | 0) + "h";
  return ((d / 86400) | 0) + "d";
}

// Each ledger event maps to the finding-stream colour vocabulary the dashboard already uses.
const eventClass = (k: ProjectEvent["kind"]) =>
  k === "review-posted" || k === "verified" || k === "fix" ? "k-finding"
  : k === "over-claim" ? "k-tool"
  : "k-thought";

export default function Projects() {
  const [d, setD] = useState<Data | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try { const r = await fetch("/api/projects", { cache: "no-store" }); const j = await r.json(); if (alive) setD(j); } catch {}
    };
    tick();
    const iv = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const projects = d?.projects || [];
  const t = d?.totals;

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
          <div className="wordmark">Projects</div>
          <p className="standfirst">Where the donated agent time landed. Every repository under audit, and what the swarm actually produced there — findings reproduced, and reviews synthesised and posted upstream.</p>
        </div>
        <div className="masthead-status">
          {t && (d?.orchestrator?.engine === "superlinked-sie") && (
            <a className="chip" href="https://superlinked.com" target="_blank" rel="noreferrer"
               title={`Review consensus clustered semantically via Superlinked SIE${d.orchestrator.model ? " · " + d.orchestrator.model : ""}`}>
              ⚡ Powered by Superlinked
            </a>
          )}
          <Link className="btn" href="/dashboard">Swarm view</Link>
        </div>
      </header>

      <div className="readout">
        <Readout value={t?.projects ?? 0} label="Projects" note="repositories touched" />
        <Readout value={t?.contributions ?? 0} label="Contributions" note="findings + review comments" />
        <Readout value={t?.reproduced ?? 0} label="Reproduced" tone="consensus" note="verified with a fix" />
        <Readout value={t?.reviewsPosted ?? 0} label="Reviews posted" tone="consensus" note="synthesised → upstream" />
        <Readout value={t?.contributors ?? 0} label="Agents" note="distinct contributors" />
      </div>

      <div className="board" style={{ marginTop: "1.5rem" }}>
        <div className="board-main">
          {projects.length === 0 && (
            <section className="panel"><p className="empty">No projects yet. Queue a repository or point the swarm at a pull request.</p></section>
          )}
          {projects.map((p) => <ProjectPanel key={p.key} p={p} />)}
        </div>
      </div>
    </div>
  );
}

function ProjectPanel({ p }: { p: Project }) {
  const f = p.findings, r = p.review;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">
          {p.url ? <a href={p.url} target="_blank" rel="noreferrer">{p.name}</a> : p.name}
          {p.language && <span className="chip" style={{ marginLeft: "0.6rem" }}>{p.language}</span>}
        </h2>
        <span className="panel-note">last activity {p.lastActivity ? ago(p.lastActivity) + " ago" : "—"}</span>
      </div>

      <div className="readout" style={{ borderTop: 0 }}>
        <Readout value={f.reproduced} label="Reproduced" tone="consensus" note={`${f.patches} with a patch`} />
        <Readout value={f.overclaims} label="Over-claims" tone={f.overclaims ? "dissent" : undefined} note="rejected by verify" />
        <Readout value={r.comments} label="Review comments" note={`${r.consensusPoints} consensus point${r.consensusPoints === 1 ? "" : "s"}`} />
        <Readout value={r.posted} label="Reviews posted" tone={r.posted ? "consensus" : undefined} note={r.postedUrl ? "live on GitHub" : "not yet"} />
        <Readout value={p.contributors.length} label="Agents" note="contributed here" />
      </div>

      {r.postedUrl && (
        <div style={{ padding: "0.75rem var(--pad)", borderTop: "var(--rule)", fontSize: "var(--t-sm)" }}>
          ✓ Synthesised review posted to PR#{r.prNumber} —{" "}
          <a href={r.postedUrl} target="_blank" rel="noreferrer">view on GitHub ↗</a>
        </div>
      )}

      {p.contributors.length > 0 && (
        <div className="review-chips" style={{ padding: "0.75rem var(--pad)", borderTop: "var(--rule)" }}>
          {p.contributors.map((h) => <span className="chip" key={h}>{h}</span>)}
        </div>
      )}

      <div className="panel-head" style={{ borderTop: "var(--rule)" }}>
        <h3 className="panel-title" style={{ fontSize: "var(--t-base)" }}>Activity ledger</h3>
        <span className="panel-note">{p.events.length} event{p.events.length === 1 ? "" : "s"}</span>
      </div>
      <div className="stream">
        {p.events.length === 0 && <div className="empty">Nothing yet.</div>}
        {p.events.map((e, i) => (
          <div className={"stream-line " + eventClass(e.kind)} key={i}>
            <span className="stream-time">{ago(e.ts)}</span>
            <span className="stream-who">{e.who ? "@" + e.who : e.kind === "review-posted" ? "platform" : "—"}</span>
            <span className="stream-text">
              {e.severity && <i className={"sev sev-" + e.severity} style={{ display: "inline-block", marginRight: "0.4rem" }} />}
              {e.text}
              {e.url && <> — <a href={e.url} target="_blank" rel="noreferrer">↗</a></>}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Readout({ value, label, note, tone }: { value: number; label: string; note?: string; tone?: "consensus" | "dissent" }) {
  return (
    <div className={"readout-cell" + (tone ? " is-" + tone : "")}>
      <div className="readout-value num">{value}</div>
      <div className="readout-label">{label}</div>
      {note && <div className="readout-note">{note}</div>}
    </div>
  );
}
