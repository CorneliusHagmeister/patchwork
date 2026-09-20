import { defineConfig } from "@trigger.dev/sdk/v3";

// Cloud verification path. The task in verifier/trigger runs the SAME verifyPov()
// the local worker uses — but in trigger.dev's cloud, where Docker is not
// available, so it needs E2B_API_KEY set in the project's environment variables
// to select the e2b sandbox backend.
export default defineConfig({
  project: "proj_ypzitzsfqrtvjnyzbmov", // Patchwork (org: Salomo)
  runtime: "node",
  logLevel: "info",
  maxDuration: 600,
  dirs: ["./verifier/trigger"],
});
