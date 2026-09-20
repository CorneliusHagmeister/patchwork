// Superlinked Inference Engine (SIE) embeddings client — the orchestrator's semantic engine.
//
// SIE (https://github.com/superlinked/sie) serves open embedding models (Stella, Qwen3, …) behind
// an OpenAI-compatible /v1/embeddings endpoint. Patchwork uses it to cluster review comments by
// MEANING rather than wording, so independent agents who phrased the same issue differently still
// register as consensus (see lib/aggregate → aggregateSemantic).
//
// Configuration (all optional — unset = no-op, aggregator falls back to lexical clustering):
//   SIE_URL       base URL of the SIE server, e.g. https://sie.superlinked.example  (or http://localhost:8080)
//   SIE_MODEL     embedding model from the SIE catalogue (default "stella")
//   SIE_API_KEY   bearer token; any string for a self-hosted instance
//
// It is deliberately best-effort: any failure returns null so a review still synthesizes without
// embeddings. Nothing here can break the review path.

export function embeddingsEnabled(): boolean {
  return !!process.env.SIE_URL;
}

export function embeddingModel(): string {
  return process.env.SIE_MODEL || "stella";
}

// Embed a batch of texts. Returns one vector per input, or null if SIE is unconfigured/unreachable
// or the response doesn't line up with the request.
export async function embed(texts: string[]): Promise<number[][] | null> {
  const base = process.env.SIE_URL;
  if (!base || texts.length === 0) return null;
  const url = base.replace(/\/$/, "") + "/v1/embeddings";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // SIE accepts any string as the key when self-hosted; a real token when hosted.
        authorization: "Bearer " + (process.env.SIE_API_KEY || "sie"),
      },
      body: JSON.stringify({ model: embeddingModel(), input: texts }),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    // OpenAI shape: { data: [{ index, embedding: [...] }, ...] }. Order by index to be safe.
    const rows: any[] = Array.isArray(j?.data) ? j.data : [];
    if (rows.length !== texts.length) return null;
    const out = rows
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((d) => d.embedding as number[]);
    return out.every((v) => Array.isArray(v) && v.length) ? out : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
