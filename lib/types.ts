export type Tier = "pending" | "reproduced" | "analytical" | "plausible" | "refuted";
export type WorkStatus = "queued" | "claimed" | "running" | "done";

export interface Repo {
  name: string; url: string; language: string; targets: string[];
  addedBy: string; addedAt: string; status: string;
}
export interface WorkItem {
  id: string; repo: string; target: string; lens: string; oracle: string;
  status: WorkStatus; claimedBy?: string; claimedAt?: string; findingId?: string; updatedAt: string;
}
export interface Pov {
  repoUrl?: string;              // where to clone from
  repoRef?: string;             // pinned commit/branch the PoV was written against
  files?: { path: string; content: string }[]; // reproducer files dropped into the clone
  cmd?: string;                 // shell command run in the repo root that reproduces
  marker?: string;              // string expected in output on success (oracle-appropriate)
  timeoutSec?: number;          // hard cap (default 180)
  memMb?: number;               // memory cap for the sandbox (default 512)
  notes?: string;               // free-text the judge can read
}
export interface Finding {
  id: string; repo: string; workItem?: string; title: string; oracle: string;
  severity: "high" | "medium" | "low" | "info";
  claimed: Tier;   // what the contributor's agent asserted
  tier: Tier;      // what the central verifier confirmed
  patch: boolean; contributor: string; createdAt: string;
  pov?: Pov;       // the reproducer the central verifier re-runs
  patchDiff?: string; // proposed fix
  verifyLog?: string; // what the verifier observed
}
export interface Node {
  id: string; handle: string; location: string; status: "idle" | "running";
  currentWork?: string; workDone: number; findingsCount: number; lastSeen: string;
}
export interface Trace { id: string; node: string; kind: "status" | "thought" | "tool" | "finding"; text: string; ts: string; }

export const LENSES: { lens: string; oracle: string }[] = [
  { lens: "sink-first", oracle: "logic-authz" },
  { lens: "cwe-similarity", oracle: "memory-safety" },
  { lens: "taint-pair", oracle: "logic-authz" },
  { lens: "recency-diff", oracle: "resource-exhaustion" },
  { lens: "fuzz-lane", oracle: "panic-dos" },
];
