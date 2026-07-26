import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html", host: "localhost" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the finished ModelCut Studio editor", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>ModelCut Studio — Private 3D Model Splitter<\/title>/i);
  assert.match(html, /Separate a model into/);
  assert.match(html, /Upload 3MF or STL/);
  assert.match(html, /Split settings/);
  assert.match(html, /Split in place/);
  assert.match(html, /True color extraction/);
  assert.match(html, /Cut method/);
  assert.match(html, /Interlocking/);
  assert.match(html, /Connector method/);
  assert.match(html, /draw a custom cut/i);
  assert.match(html, /Private by design/);
  assert.match(html, /needs a larger screen/);
  assert.match(html, /property="og:image"/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Split3MF/i);
});

test("keeps privacy, keyboard, and accessibility behavior in the editor", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/ModelCutStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/modelcut.css", import.meta.url), "utf8"),
  ]);
  assert.match(component, /Models stay on this device/);
  assert.match(component, /event\.code === "Space"/);
  assert.match(component, /metaKey \|\| event\.ctrlKey/);
  assert.match(component, /aria-live="polite"/);
  assert.match(styles, /max-width:\s*899px/);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
  assert.match(styles, /focus-visible/);
  assert.match(styles, /#ffcf3f/i);
  assert.match(styles, /#151515/i);
  assert.match(styles, /overflow-y:\s*scroll/);
  assert.match(styles, /overscroll-behavior-y:\s*contain/);
});
