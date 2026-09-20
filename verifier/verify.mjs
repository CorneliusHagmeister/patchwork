// Patchwork central verifier — re-runs a submitted PoV in an ephemeral sandbox and
// decides the confirmed tier. Trust anchor: nothing a contributor claims is trusted;
// only what reproduces here counts. Backends: docker (local) | e2b (cloud) | none.
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);

const CRASH = ["memory-safety", "panic-dos"];

export async function verifyPov(finding, opts = {}) {
  const pov = finding.pov || {};
  const backend = opts.backend || process.env.PW_SANDBOX || (process.env.E2B_API_KEY ? "e2b" : "docker");
  const log = [];
  const say = (s) => { log.push(s); opts.onLog?.(s); };
  say(`verifier: ${finding.id} — oracle=${finding.oracle}, claimed=${finding.claimed}, backend=${backend}`);

  let result = null;
  if (pov.cmd && backend !== "none") {
    try {
      result = backend === "e2b" ? await runE2B(pov, say) : await runDocker(pov, say);
      say(`exit=${result.exitCode}${result.signal ? " signal=" + result.signal : ""} dur=${result.durationMs}ms oom=${result.oom}`);
      say("---- output tail ----\n" + (result.stdout + "\n" + result.stderr).slice(-1200));
    } catch (e) {
      say("sandbox error: " + (e?.message || e));
    }
  } else if (!pov.cmd) {
    say("no PoV command attached — cannot execute; relying on judge/heuristic only");
  }

  let tier = result ? decideTier(finding, pov, result, say) : "analytical";

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const j = await judge(finding, pov, result, say);
      if (j?.verdict) {
        say(`judge: ${j.verdict} — ${j.reason || ""}`);
        // The judge can confirm or downgrade; it can only CONFIRM 'reproduced' when the sandbox ran.
        if (j.verdict === "reproduced" && result) tier = "reproduced";
        else if (j.verdict === "refuted") tier = "refuted";
        else if (j.verdict === "analytical" && tier !== "reproduced") tier = "analytical";
      }
    } catch (e) { say("judge skipped: " + (e?.message || e)); }
  }

  say(`VERDICT: ${tier}`);
  return { tier, log: log.join("\n") };
}

function decideTier(finding, pov, result, say) {
  const out = (result.stdout + result.stderr);
  const crashy = /AddressSanitizer|LeakSanitizer|SIGSEGV|panicked at|thread '.*' panicked|runtime error:|core dumped/i.test(out);
  const markerHit = pov.marker ? out.includes(pov.marker) : null;
  if (markerHit === true) { say("✓ success marker present"); return "reproduced"; }
  if (CRASH.includes(finding.oracle) && (crashy || (result.exitCode ?? 0) > 128 || result.signal)) { say("✓ crash/panic signal"); return "reproduced"; }
  if (finding.oracle === "resource-exhaustion" && result.oom) { say("✓ OOM under cap"); return "reproduced"; }
  if (markerHit === false) { say("✗ expected marker absent"); return "refuted"; }
  say("ran, no decisive signal → analytical");
  return "analytical";
}

async function runDocker(pov, say) {
  const dir = await mkdtemp(join(tmpdir(), "pw-"));
  try {
    if (pov.repoUrl) {
      say(`cloning ${pov.repoUrl}${pov.repoRef ? "@" + pov.repoRef : ""}`);
      try { await exec("git", ["clone", "--depth", "1", ...(pov.repoRef ? ["--branch", pov.repoRef] : []), pov.repoUrl, dir], { timeout: 120000 }); }
      catch { await exec("git", ["clone", pov.repoUrl, dir]); if (pov.repoRef) await exec("git", ["-C", dir, "checkout", pov.repoRef]); }
    }
    for (const f of pov.files || []) { const p = join(dir, f.path); await mkdir(dirname(p), { recursive: true }); await writeFile(p, f.content); say(`wrote ${f.path}`); }
    const image = pov.image || process.env.PW_IMAGE || "rust:1-slim";
    const mem = pov.memMb || 512, to = pov.timeoutSec || 180;
    say(`docker run ${image} (mem ${mem}m, --network=none, ${to}s)`);
    const args = ["run", "--rm", "--network=none", `--memory=${mem}m`, `--memory-swap=${mem}m`, "-v", `${dir}:/work`, "-w", "/work", image, "bash", "-lc", pov.cmd];
    const start = Date.now();
    try {
      const { stdout, stderr } = await exec("docker", args, { timeout: to * 1000, maxBuffer: 8 * 1024 * 1024 });
      return { exitCode: 0, stdout, stderr, durationMs: Date.now() - start, oom: false };
    } catch (e) {
      const stdout = e.stdout || "", stderr = (e.stderr || "") + (e.killed ? " [killed/timeout]" : "");
      const oom = e.code === 137 || /out of memory|Killed/i.test(stdout + stderr);
      return { exitCode: e.code ?? 1, signal: e.signal, stdout, stderr, durationMs: Date.now() - start, oom };
    }
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

async function runE2B(pov, say) {
  const { Sandbox } = await import("@e2b/code-interpreter"); // needs E2B_API_KEY
  const to = (pov.timeoutSec || 180) * 1000;
  const sbx = await Sandbox.create({ timeoutMs: to });
  try {
    const base = pov.repoUrl ? "repo" : ".";
    if (pov.repoUrl) { say(`cloning ${pov.repoUrl}${pov.repoRef ? "@" + pov.repoRef : ""}`); await sbx.commands.run(`git clone ${pov.repoUrl} repo && ${pov.repoRef ? `cd repo && git checkout ${pov.repoRef}` : "true"}`, { timeoutMs: to }); }
    for (const f of pov.files || []) { await sbx.files.write(`${base}/${f.path}`, f.content); say(`wrote ${f.path}`); }
    say(`e2b run: ${pov.cmd}`);
    const start = Date.now();
    const r = await sbx.commands.run(`cd ${base} && ${pov.cmd}`, { timeoutMs: to }).catch((e) => e.result || e);
    return { exitCode: r.exitCode ?? (r.error ? 1 : 0), stdout: r.stdout || "", stderr: (r.stderr || "") + (r.error ? ` [${r.error}]` : ""), durationMs: Date.now() - start, oom: false };
  } finally { await sbx.kill?.().catch(() => {}); }
}

async function judge(finding, pov, result, say) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const out = result ? (result.stdout + "\n" + result.stderr).slice(-4000) : "(not executed)";
  const system =
    "You are the central verifier for a vulnerability-hunting platform. Given a claimed finding, its oracle " +
    "(bug class), the reproducer, and the sandbox output, decide whether the vulnerability was ACTUALLY reproduced. " +
    "'reproduced' only if the output demonstrates the bug triggering per the oracle; 'refuted' if it clearly did not; " +
    "'analytical' if plausible but not demonstrated. Reply with ONLY JSON: {\"verdict\":\"reproduced|refuted|analytical\",\"reason\":\"one sentence\"}.";
  const user = `oracle: ${finding.oracle}\ntitle: ${finding.title}\nclaimed: ${finding.claimed}\npov.cmd: ${pov.cmd || "(none)"}\npov.marker: ${pov.marker || "(none)"}\nnotes: ${pov.notes || ""}\n--- sandbox output tail ---\n${out}`;
  const msg = await client.messages.create({
    model: process.env.PW_JUDGE_MODEL || "claude-sonnet-5",
    max_tokens: 400, system, messages: [{ role: "user", content: user }],
  });
  const text = (msg.content || []).map((b) => b.text || "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}
