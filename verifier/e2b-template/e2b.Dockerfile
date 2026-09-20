# Sandbox image for Patchwork PoVs against the seeded Rust targets.
#
# Why this exists: the stock e2b 'base' template has no Rust toolchain, and every PoV
# runs with allowInternetAccess=false (see verifier/verify.mjs → runE2B), so a sandbox
# cannot rustup or `cargo fetch` its way out at run time. Anything that compiles has to
# find the toolchain AND its crate dependencies already in the image.
#
# Build + publish (needs `e2b auth login` first):
#   e2b template build -c "" --name patchwork-rust
# then set E2B_TEMPLATE_ID=patchwork-rust wherever the verifier runs.
FROM e2bdev/code-interpreter:latest

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config libssl-dev cmake git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# vibe-kanban is a Tauri desktop app: its crates link against the GTK/WebKit native
# toolkit, so without these `cargo build` dies on a missing gdk-3.0.pc. The other
# Rust targets are server-side and don't need any of it.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
      librsvg2-dev libsoup-3.0-dev clang libclang-dev \
    || apt-get install -y --no-install-recommends libgtk-3-dev librsvg2-dev clang libclang-dev \
    ; rm -rf /var/lib/apt/lists/*

USER user
ENV RUSTUP_HOME=/home/user/.rustup \
    CARGO_HOME=/home/user/.cargo \
    PATH=/home/user/.cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain stable

# Warm the crate cache for the seeded targets (lib/store.ts). `cargo fetch` populates
# $CARGO_HOME/registry, which an offline build in a fresh clone then resolves against —
# this is what makes `cargo build --offline` viable with networking off.
# Shared target dir so dependency artifacts survive into the run, not just the sources.
ENV CARGO_TARGET_DIR=/home/user/.cargo-target
RUN mkdir -p /home/user/prefetch && cd /home/user/prefetch && \
    for r in https://github.com/softdevteam/snare \
             https://github.com/ltratt/pizauth \
             https://github.com/whotargetsme/who-targets-me \
             https://github.com/BloopAI/vibe-kanban ; do \
      n=$(basename "$r"); \
      git clone --depth 1 "$r" "$n" 2>/dev/null || { echo "skip $n (clone failed)"; continue; }; \
      ( cd "$n" && cargo fetch 2>/dev/null || echo "skip $n (fetch failed)" ); \
    done && rm -rf /home/user/prefetch/*/.git

# who-targets-me is Node, not Rust (the seed in lib/store.ts mislabels it), so `cargo fetch`
# skips it above. Bake its node_modules instead — npm install can't reach the network at run
# time either. Non-fatal for the same reason as the cargo fetches.
RUN cd /home/user/prefetch/who-targets-me 2>/dev/null && \
    (npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund 2>/dev/null || echo "skip who-targets-me npm") \
    || echo "skip who-targets-me (not present)"

WORKDIR /home/user
