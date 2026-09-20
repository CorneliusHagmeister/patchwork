import type { Trace, WorkItem } from "./types";

/**
 * A single node's pass at a single work item: the claim, plus every trace that node
 * emitted while it held that claim.
 *
 * No schema change is needed to reconstruct this. A work item records `claimedBy`
 * (handle) and `claimedAt`, and each trace records `node` (handle) and `ts` — so a
 * trace belongs to whichever claim that handle was inside when it fired. A handle's
 * next claim closes the previous run.
 */
export interface Run {
  workItem: WorkItem;
  traces: Trace[];          // oldest → newest, as the node emitted them
  startedAt: string;
  endedAt?: string;         // when this handle claimed something else; open if undefined
  thoughts: number;         // counts per kind, for a summary line without re-scanning
  tools: number;
  findings: number;
}

/**
 * Group a flat trace stream into per-node, per-task runs.
 *
 * `traces` may arrive in any order (the API serves newest-first); both inputs are
 * treated as read-only. Runs come back newest-claim-first to match the dashboard.
 * Traces with no owning claim — verifier lines, traces predating the retention
 * window's oldest claim — are returned separately rather than silently dropped.
 */
export function groupTracesIntoRuns(
  traces: Trace[],
  work: WorkItem[],
): { runs: Run[]; ungrouped: Trace[] } {
  const claims = work
    .filter((w): w is WorkItem & { claimedBy: string; claimedAt: string } => !!w.claimedBy && !!w.claimedAt)
    .sort((a, b) => a.claimedAt.localeCompare(b.claimedAt));

  // Per handle, a claim's window ends where that handle's next claim begins.
  const endOf = new Map<string, string>();
  const lastSeen = new Map<string, WorkItem & { claimedAt: string }>();
  for (const c of claims) {
    const prev = lastSeen.get(c.claimedBy);
    if (prev) endOf.set(prev.id, c.claimedAt);
    lastSeen.set(c.claimedBy, c);
  }

  const runs: Run[] = claims.map((c) => ({
    workItem: c, traces: [], startedAt: c.claimedAt, endedAt: endOf.get(c.id),
    thoughts: 0, tools: 0, findings: 0,
  }));
  const byHandle = new Map<string, Run[]>();
  for (const r of runs) {
    const list = byHandle.get(r.workItem.claimedBy!) || [];
    list.push(r);
    byHandle.set(r.workItem.claimedBy!, list);
  }

  const ungrouped: Trace[] = [];
  for (const t of [...traces].sort((a, b) => a.ts.localeCompare(b.ts))) {
    const owner = (byHandle.get(t.node) || []).find(
      (r) => t.ts >= r.startedAt && (!r.endedAt || t.ts < r.endedAt),
    );
    if (!owner) { ungrouped.push(t); continue; }
    owner.traces.push(t);
    if (t.kind === "thought") owner.thoughts++;
    else if (t.kind === "tool") owner.tools++;
    else if (t.kind === "finding") owner.findings++;
  }

  return { runs: runs.reverse(), ungrouped };
}
