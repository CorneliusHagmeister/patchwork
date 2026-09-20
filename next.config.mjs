/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Several Claude sessions work this tree at once (see TASKS.md). Next writes its build output
  // to one directory, so two `next dev`/`next build` runs in the same checkout clobber each
  // other's chunks — the symptom is "Cannot find module './chunks/vendor-chunks/next.js'" in a
  // server that was working a minute ago. Set NEXT_DIST_DIR to give a session its own output:
  //
  //   NEXT_DIST_DIR=.next-3042 npx next dev -p 3042
  //
  // Unset, this is exactly the old behaviour.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};
export default nextConfig;
