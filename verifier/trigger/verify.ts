// Cloud path: a trigger.dev v3 task that runs the verifier per finding.
// Deploy with the trigger.dev CLI; enqueue from the Next app on finding submission
// (see verifier/README.md → "Cloud path"). Uses e2b for the sandbox when E2B_API_KEY is set.
import { task } from "@trigger.dev/sdk/v3";
// @ts-ignore - plain ESM sibling module
import { verifyPov } from "../verify.mjs";

export const verifyFinding = task({
  id: "verify-finding",
  maxDuration: 600,
  run: async (payload: { finding: any; url: string; code: string }) => {
    const { tier, log } = await verifyPov(payload.finding);
    await fetch(payload.url.replace(/\/$/, "") + "/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: payload.finding.id, tier, log, code: payload.code }),
    });
    return { id: payload.finding.id, tier };
  },
});
