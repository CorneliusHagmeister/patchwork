// Streams verifier progress lines to the platform so the dashboard's live conversation
// stream shows sandbox setup and the PoV run as they happen, not as one blob at the end.
// Posts are serialised (order matters on screen) and never throw — streaming is cosmetic,
// a broken pipe must not fail a verification.
export function streamTo(url, code) {
  const base = String(url || "").replace(/\/$/, "");
  let chain = Promise.resolve();
  return (line) => {
    if (!base) return;
    chain = chain.then(() =>
      fetch(base + "/api/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ line, code }),
      }).catch(() => {}),
    );
  };
}
