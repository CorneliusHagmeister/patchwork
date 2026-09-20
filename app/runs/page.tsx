"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useLive } from "@/lib/useLive";
import { groupTracesIntoRuns, type Run } from "@/lib/runs";

/**
 * Task drill-down: every executed task, and the reasoning the agent streamed while
 * it worked on it. The dashboard's Evidence panel is a single live firehose across
 * all nodes; this is the same trace data partitioned back into the task it belonged to.
 */
type State = { work: any[]; traces: any[]; findings: any[] };
const EMPTY: State = { work: [], traces: [], findings: [] };

const ago = (iso: string) => {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  return d < 60 ? `${d | 0}s` : d < 3600 ? `${(d / 60) | 0}m` : `${(d / 3600) | 0}h`;
};
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export default function Runs() {
  const [s, setS] = useState<State>(EMPTY);
  const [open, setOpen] = useState<string | null>(null);

  const tick = async () => {
    try {
      const r = await fetch("/api/state", { cache: "no-store" });
      if (r.ok) setS(await r.json());
    } catch { /* polling is best-effort; the next tick retries */ }
  };
  useEffect(() => { tick(); const i = setInterval(tick, 4000); return () => clearInterval(i); }, []);
  useLive(() => { tick(); });

  const { runs, ungrouped } = groupTracesIntoRuns(s.traces || [], s.work || []);
  // A run with no traces is normal, not an error: trace retention is bounded, so an
  // older task outlives the reasoning it emitted. Surface it rather than hide it.
  const findingFor = (r: Run) => (s.findings || []).find((f) => f.id === r.workItem.findingId);

  return (
    <main className="shell">
      <div className="panel-head">
        <h1 className="panel-title">Executed tasks</h1>
        <span className="panel-note">
          <Link href="/dashboard">← dashboard</Link> &nbsp; {runs.length} runs · {ungrouped.length} unattributed events
        </span>
      </div>

      <div className="panel">
        {runs.length === 0 && <div className="empty">No tasks have been claimed yet.</div>}
        {runs.map((r) => {
          const w = r.workItem;
          const f = findingFor(r);
          const id = w.id;
          const isOpen = open === id;
          return (
            <div key={id} className="panel" style={{ marginBottom: "0.5rem" }}>
              <div
                className="panel-head"
                style={{ cursor: "pointer" }}
                onClick={() => setOpen(isOpen ? null : id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setOpen(isOpen ? null : id); }}
              >
                <span className="panel-title">
                  {isOpen ? "▾" : "▸"} {w.claimedBy} · {w.repo}{w.target ? "/" + w.target : ""}
                </span>
                <span className="panel-note">
                  <span className="badge">{w.lens}</span>{" "}
                  <span className="badge">{w.oracle}</span>{" "}
                  {f && <span className={"badge badge-" + f.tier}>{f.tier}</span>}{" "}
                  {r.thoughts}t · {r.tools} tool{r.findings ? ` · ${r.findings} finding` : ""} · {ago(r.startedAt)} ago
                </span>
              </div>

              {isOpen && (
                <div className="stream">
                  {r.traces.length === 0 && (
                    <div className="empty">
                      No reasoning retained for this task — trace history is bounded, so older runs
                      keep their record here but lose their stream.
                    </div>
                  )}
                  {r.traces.map((t) => (
                    <div className={"stream-line k-" + t.kind} key={t.id}>
                      <span className="stream-time">{hhmm(t.ts)}</span>
                      <span className="stream-who">{t.kind}</span>
                      <span className="stream-text">{t.text}</span>
                    </div>
                  ))}
                  {f?.verifyLog && (
                    <>
                      <div className="stream-line k-status" style={{ marginTop: "0.6rem" }}>
                        <span className="stream-time" />
                        <span className="stream-who">verifier</span>
                        <span className="stream-text" style={{ opacity: 0.7 }}>— independent re-run —</span>
                      </div>
                      <div className="stream-line k-tool">
                        <span className="stream-time" />
                        <span className="stream-who" />
                        <span className="stream-text">{f.verifyLog}</span>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="panel-head" style={{ marginTop: "1.5rem" }}>
        <h2 className="panel-title">Found issues</h2>
        <span className="panel-note">{(s.findings || []).length} findings · click for the evidence</span>
      </div>

      <div className="panel">
        {(s.findings || []).length === 0 && <div className="empty">Nothing found yet.</div>}
        {(s.findings || []).map((f: any) => {
          const id = "f:" + f.id;
          const isOpen = open === id;
          // An over-claim is the interesting case: the contributor asserted reproduced
          // and the independent re-run disagreed. Surface it rather than bury it.
          const over = f.claimed === "reproduced" && (f.tier === "analytical" || f.tier === "refuted");
          return (
            <div key={f.id} className="panel" style={{ marginBottom: "0.5rem" }}>
              <div
                className="panel-head"
                style={{ cursor: "pointer" }}
                onClick={() => setOpen(isOpen ? null : id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setOpen(isOpen ? null : id); }}
              >
                <span className="panel-title">{isOpen ? "▾" : "▸"} {f.title}</span>
                <span className="panel-note">
                  <span className="badge">{f.repo}</span>{" "}
                  <span className="badge">{f.severity}</span>{" "}
                  <span className={"badge badge-" + (over ? "overclaim" : f.tier)}>{over ? "over-claim" : f.tier}</span>{" "}
                  {f.patch && <span className="badge badge-patch">patch</span>}{" "}
                  by {f.contributor}
                </span>
              </div>

              {isOpen && (
                <div className="stream">
                  <div className="stream-line k-status">
                    <span className="stream-time" />
                    <span className="stream-who">claim</span>
                    <span className="stream-text">
                      contributor claimed <b>{f.claimed}</b> · verifier confirmed <b>{f.tier}</b>
                      {over ? " — downgraded on independent re-run" : ""}
                    </span>
                  </div>
                  <div className="stream-line k-status">
                    <span className="stream-time" />
                    <span className="stream-who">oracle</span>
                    <span className="stream-text">{f.oracle}</span>
                  </div>
                  {f.pov?.cmd && (
                    <div className="stream-line k-tool">
                      <span className="stream-time" />
                      <span className="stream-who">pov</span>
                      <span className="stream-text">
                        {f.pov.repoUrl ? f.pov.repoUrl + (f.pov.repoRef ? "@" + f.pov.repoRef : "") + "\n" : ""}
                        $ {f.pov.cmd}{f.pov.marker ? `\nexpect marker: ${f.pov.marker}` : ""}
                      </span>
                    </div>
                  )}
                  {f.verifyLog ? (
                    <div className="stream-line k-tool">
                      <span className="stream-time" />
                      <span className="stream-who">re-run</span>
                      <span className="stream-text">{f.verifyLog}</span>
                    </div>
                  ) : (
                    <div className="empty">No verifier transcript retained for this finding.</div>
                  )}
                  {f.patchDiff && (
                    <div className="stream-line k-finding">
                      <span className="stream-time" />
                      <span className="stream-who">fix</span>
                      <span className="stream-text">{f.patchDiff}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </main>
  );
}
