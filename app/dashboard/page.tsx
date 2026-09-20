"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useLive } from "@/lib/useLive";

type State = { repos: any[]; work: any[]; findings: any[]; nodes: any[]; traces: any[]; stats: any };
const EMPTY: State = { repos: [], work: [], findings: [], nodes: [], traces: [], stats: {} };
const nowLive = (iso?: string) => !!iso && Date.now() - new Date(iso).getTime() < 90_000;
const cvar = (n: string) => (typeof window !== "undefined" ? getComputedStyle(document.documentElement).getPropertyValue(n).trim() : "");
function hashA(id: string) { let h = 2166136261; for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 3600) / 3600 * Math.PI * 2; }
function ago(iso: string) { const d = (Date.now() - new Date(iso).getTime()) / 1000; if (d < 60) return (d | 0) + "s"; if (d < 3600) return (d / 60 | 0) + "m"; return (d / 3600 | 0) + "h"; }

export default function Dashboard() {
  const [s, setS] = useState<State>(EMPTY);
  const [token, setToken] = useState<string | null>(null);
  const nodesRef = useRef<any[]>([]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const consoleRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { setToken(localStorage.getItem("pw_token")); }, []);

  // Live push from the fly.io relay: any frame = one immediate /api/state fetch.
  // /api/state stays the single source of truth; the relay only signals "something changed".
  const tickRef = useRef<() => void>(() => {});
  const { connected } = useLive((msg) => {
    if (msg.type === "state" || msg.type === "trace") tickRef.current();
  });

  // poll state (always-on fallback; slows to 5s while the relay is connected)
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try { const r = await fetch("/api/state", { cache: "no-store" }); const d = await r.json(); if (alive) { setS(d); nodesRef.current = d.nodes || []; } } catch {}
    };
    tickRef.current = tick;
    tick(); const iv = setInterval(tick, connected ? 5000 : 1500);
    return () => { alive = false; clearInterval(iv); };
  }, [connected]);

  // radar
  useEffect(() => {
    const cv = canvasRef.current; if (!cv) return;
    const cx = cv.getContext("2d"); if (!cx) return;
    let raf = 0, W = 0, H = 0;
    const reduce = matchMedia("(prefers-reduced-motion:reduce)").matches;
    const size = () => { const dpr = devicePixelRatio || 1, r = cv.getBoundingClientRect(); W = r.width; H = r.height; cv.width = W * dpr; cv.height = H * dpr; cx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    const ro = new ResizeObserver(size); ro.observe(cv); size();
    const draw = (t: number) => {
      if (!W) { raf = requestAnimationFrame(draw); return; }
      const cxp = W / 2, cyp = H / 2, R = Math.min(W, H) / 2 - 16;
      const ink = cvar("--radar-ink"), line = cvar("--radar-line"), accent = cvar("--accent"), ok = cvar("--ok"), faint = cvar("--faint");
      cx.clearRect(0, 0, W, H);
      cx.strokeStyle = line; cx.lineWidth = 1;
      for (let i = 1; i <= 4; i++) { cx.beginPath(); cx.arc(cxp, cyp, R * i / 4, 0, Math.PI * 2); cx.stroke(); }
      cx.beginPath(); cx.moveTo(cxp - R, cyp); cx.lineTo(cxp + R, cyp); cx.moveTo(cxp, cyp - R); cx.lineTo(cxp, cyp + R); cx.stroke();
      const ang = reduce ? -Math.PI / 2 : (t / 3400) % (Math.PI * 2);
      for (let k = 0; k < 34; k++) { const a = ang - k * 0.02, al = (1 - k / 34) * 0.22; cx.strokeStyle = `rgba(${ink},${al})`; cx.lineWidth = 2; cx.beginPath(); cx.moveTo(cxp, cyp); cx.lineTo(cxp + Math.cos(a) * R, cyp + Math.sin(a) * R); cx.stroke(); }
      cx.fillStyle = accent; cx.beginPath(); cx.arc(cxp, cyp, 3.5, 0, Math.PI * 2); cx.fill();
      for (const n of nodesRef.current) {
        const on = nowLive(n.lastSeen), run = on && n.status === "running";
        const a = hashA(n.id || n.handle || "x"), rad = R * (on ? (run ? 0.5 : 0.68) : 0.9);
        const x = cxp + Math.cos(a) * rad, y = cyp + Math.sin(a) * rad, col = run ? accent : (on ? ok : faint);
        if (on) { const p = reduce ? 0 : (Math.sin(t / 500 + a * 3) * 0.5 + 0.5); cx.fillStyle = col; cx.globalAlpha = 0.18 + 0.14 * p; cx.beginPath(); cx.arc(x, y, 7 + 5 * p, 0, Math.PI * 2); cx.fill(); cx.globalAlpha = 1; }
        cx.fillStyle = col; cx.beginPath(); cx.arc(x, y, on ? 4 : 3, 0, Math.PI * 2); cx.fill();
        if (on) { cx.fillStyle = `rgba(${ink},.72)`; cx.font = "10px ui-monospace,Menlo,monospace"; cx.textAlign = x > cxp ? "start" : "end"; cx.fillText(String(n.handle || n.id), x + (x > cxp ? 8 : -8), y + 3.5); }
      }
      if (!reduce) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  // autoscroll console to top (newest first) — traces come newest-first already
  const st = s.stats || {};
  const liveNodes = (s.nodes || []).filter((n) => nowLive(n.lastSeen));

  async function addRepo(e: React.FormEvent) {
    e.preventDefault();
    if (!token) { alert("Join first to add repos (top-right)."); return; }
    const f = e.target as any;
    const body = { name: f.rn.value.trim(), url: f.ru.value.trim(), language: f.rl.value, targets: f.rt.value };
    if (!body.name) return;
    const btn = f.querySelector("button"); btn.disabled = true; btn.textContent = "Queuing…";
    try {
      const r = await fetch("/api/repos", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify(body) });
      const d = await r.json();
      if (d.error) alert(d.error); else { f.reset(); }
    } finally { btn.disabled = false; btn.textContent = "Queue it for the swarm"; }
  }

  const findings = (s.findings || []).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const order: any = { running: 0, claimed: 1, queued: 2, done: 3 };
  const work = (s.work || []).slice().sort((a, b) => (order[a.status] - order[b.status]) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).slice(0, 14);
  const repos = (s.repos || []).slice().sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
  const nodes = (s.nodes || []).slice().sort((a, b) => (Number(nowLive(b.lastSeen)) - Number(nowLive(a.lastSeen))) || String(b.lastSeen).localeCompare(String(a.lastSeen)));

  return (
    <div className="wrap">
      <div className="rail" />
      <div className="topbar">
        <div className="brand">
          <div className="beacon"><i /><i /><i /></div>
          <div><div className="wm">PATCH<b>WORK</b></div><div className="tag">Live swarm telemetry — every bug ships with a fix.</div></div>
        </div>
        <div className="topbar-right">
          <span className="uplink"><span className={"dot" + (liveNodes.length ? "" : " idle")} />{liveNodes.length ? `UPLINK · ${liveNodes.length} LIVE` : "IDLE"}</span>
          <Link className="btn primary" href="/">{token ? "Joined ✓" : "Join →"}</Link>
        </div>
      </div>

      <div className="kpis">
        <Kpi cls="accent" label="Nodes live" u="RT" val={st.nodesLive || 0} sub="contributor agents online" />
        <Kpi label="Work in flight" u="QUE" val={st.inflight || 0} sub={`${st.queued || 0} queued`} />
        <Kpi cls="ok" label="Confirmed" u="PoV+FIX" val={st.confirmed || 0} sub="reproduced & patched" />
        <Kpi cls="crit" label="Over-claims killed" u="GATE" val={st.overclaims || 0} sub="rejected by verifier" />
        <Kpi label="Repos" u="SRC" val={st.repos || 0} sub="under audit" />
      </div>

      <div className="grid">
        <div className="col">
          <div className="card">
            <div className="head"><h2><span className={"dot" + (liveNodes.length ? "" : " idle")} style={{ width: 7, height: 7 }} />Swarm — live node telemetry</h2><span className="count">{liveNodes.length} live · {nodes.length} total</span></div>
            <div className="radar-wrap"><canvas ref={canvasRef} className="radar" /></div>
            <div className="radar-legend">
              <span><i className="lg-d" style={{ background: "var(--accent)" }} /> running</span>
              <span><i className="lg-d" style={{ background: "var(--ok)" }} /> live · idle</span>
              <span><i className="lg-d" style={{ background: "var(--faint)" }} /> offline</span>
            </div>
            <div className="nodes">
              {nodes.length === 0 && <div className="empty">Waiting for contributor agents to check in…</div>}
              {nodes.map((n) => {
                const on = nowLive(n.lastSeen), run = on && n.status === "running";
                return (
                  <div key={n.id} className={"node" + (run ? " running" : "")}>
                    <div className="n-top"><span className={"dot" + (on ? "" : " idle")} style={{ width: 7, height: 7, animation: run ? undefined : "none" }} /><span className="n-handle">{n.handle}</span><span className="n-loc">{n.location}</span></div>
                    <div className="n-work">{run ? (n.currentWork || "claiming work…") : (n.currentWork ? "last: " + n.currentWork : "—")}</div>
                    <div className="n-stat"><span>{on ? (run ? "● running" : "live · idle") : "offline"}</span><span className="tnum">{n.workDone || 0} done · {n.findingsCount || 0} found</span></div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card">
            <div className="head"><h2><span className="dot" style={{ width: 7, height: 7 }} />Live conversation stream</h2><span className="count">{(s.traces || []).length} events</span></div>
            <div className="console" ref={consoleRef}>
              {(s.traces || []).length === 0 && <div className="empty">Agent reasoning will stream here as work runs.</div>}
              {(s.traces || []).map((t) => (
                <div key={t.id} className={"tline k-" + t.kind}>
                  <span className="tt">{ago(t.ts)}</span>
                  <span className="tnode">@{t.node}</span>
                  <span className="ttxt">{t.text}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="head"><h2>Findings</h2><span className="count"><span className="gate">CENTRAL VERIFY GATE</span> &nbsp;{findings.length} total</span></div>
            <div className="rows">
              {findings.length === 0 && <div className="empty">No findings yet.</div>}
              {findings.map((f) => {
                const tier = f.tier || "pending";
                const oc = f.claimed === "reproduced" && (tier === "analytical" || tier === "refuted");
                const vstate = tier === "reproduced" ? "ok" : ((tier === "refuted" || oc) ? "rejected" : "pending");
                const vlabel = tier === "reproduced" ? "✓ verified" : (oc ? "✗ rejected" : (tier === "refuted" ? "✗ refuted" : "◴ verifying"));
                return (
                  <div className="row" key={f.id}>
                    <span className={"stripe " + (f.severity || "info")} />
                    <div className="main">
                      <div className="title">{f.title}</div>
                      <div className="meta">
                        <span>{f.repo}</span><span className="sep">·</span><span>{f.oracle}</span>
                        <span className={"badge b-" + (oc ? "overclaim" : tier)}>{oc ? "over-claim" : tier}</span>
                        {f.patch && <span className="badge b-patch">patch ✓</span>}
                        <span className="sep">·</span><span>@{f.contributor}</span>
                      </div>
                    </div>
                    <span className={"verify " + vstate}>{vlabel}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="col">
          <div className="card">
            <div className="head"><h2>Work queue</h2><span className="count">{st.queued || 0} queued · {st.inflight || 0} active</span></div>
            <div className="rows">
              {work.length === 0 && <div className="empty">No work items yet.</div>}
              {work.map((w) => (
                <div className="row" key={w.id}>
                  <div className="main">
                    <div className="title">{w.repo}{w.target ? " · " + w.target : ""}</div>
                    <div className="meta"><span className={"wpill w-" + w.status}>{w.status}</span><span>{w.lens}</span>{w.claimedBy && <><span className="sep">·</span><span>@{w.claimedBy}</span></>}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="head"><h2>Add a repo</h2></div>
            <form className="stack" onSubmit={addRepo}>
              <label htmlFor="rn">Name (owner/repo)</label>
              <input id="rn" name="rn" placeholder="softdevteam/snare" autoComplete="off" required />
              <label htmlFor="ru">Git URL</label>
              <input id="ru" name="ru" placeholder="https://github.com/softdevteam/snare" autoComplete="off" />
              <label htmlFor="rl">Language</label>
              <select id="rl" name="rl" defaultValue="Rust"><option>Rust</option><option>C</option><option>C++</option><option>Go</option><option>Python</option><option>TypeScript</option><option>Java</option><option>Other</option></select>
              <label htmlFor="rt">Focus files (optional, comma-separated)</label>
              <input id="rt" name="rt" placeholder="src/httpserver.rs, src/config.rs" autoComplete="off" />
              <button className="btn primary" type="submit">Queue it for the swarm</button>
              <div className="hint">Fans out hunting lenses as work items the swarm can claim.</div>
            </form>
          </div>

          <div className="card">
            <div className="head"><h2>Repos under audit</h2><span className="count">{repos.length}</span></div>
            <div className="repolist">
              {repos.length === 0 && <div className="empty">No repos yet — add one.</div>}
              {repos.map((r) => {
                const tot = (s.work || []).filter((w) => w.repo === r.name).length;
                const done = (s.work || []).filter((w) => w.repo === r.name && w.status === "done").length;
                const pct = tot ? Math.round(done / tot * 100) : 0;
                return (
                  <div className="repo" key={r.name}>
                    <span className="r-name">{r.name}</span>
                    <span className="track"><i style={{ width: pct + "%" }} /></span>
                    <span className="r-count tnum">{done}/{tot}</span>
                    <span className="r-lang">{r.language}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Kpi({ cls = "", label, u, val, sub }: { cls?: string; label: string; u: string; val: number; sub: string }) {
  return (
    <div className={"kpi " + cls}>
      <div className="cap"><span className="k-label">{label}</span><span className="u">{u}</span></div>
      <div className="k-val tnum">{val}</div>
      <div className="k-sub">{sub}</div>
      <div className="bar" />
    </div>
  );
}
