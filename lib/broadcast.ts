// Server-side, fire-and-forget push helper.
//
// Call this from API routes after a successful mutation to nudge the relay,
// which fans the event out to connected dashboards for sub-second updates.
//
// It is intentionally best-effort: if RELAY_URL is unset it no-ops, and it
// swallows every error (timeouts, network, non-2xx) so it can NEVER break the
// API request it is called from. Polling remains the always-on fallback.

export async function broadcast(type: string, data: any): Promise<void> {
  const url = process.env.RELAY_URL;
  if (!url) return; // relay not configured — silently skip

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);

  try {
    await fetch(`${url.replace(/\/$/, "")}/emit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-relay-secret": process.env.RELAY_SECRET || "",
      },
      body: JSON.stringify({ type, data }),
      signal: controller.signal,
      // Don't let Next cache or dedupe this.
      cache: "no-store",
    });
  } catch {
    // Deliberately ignored — push is an enhancement, never a hard dependency.
  } finally {
    clearTimeout(timer);
  }
}
