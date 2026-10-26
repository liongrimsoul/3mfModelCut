import assert from "node:assert/strict";
import { createElement, act } from "react";
import { JSDOM } from "jsdom";
import test from "node:test";
import Home from "../app/page";

test("hydrates the server-rendered home page without recoverable errors", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/",
  });
  const browserGlobals = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLSelectElement",
    "HTMLTextAreaElement",
    "Worker",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const previousGlobals = new Map(
    browserGlobals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  let root: import("react-dom/client").Root | undefined;

  class TestWorker {
    addEventListener(): void {}
    removeEventListener(): void {}
    terminate(): void {}
    postMessage(): void {}
  }

  try {
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: dom.window },
      document: { configurable: true, value: dom.window.document },
      navigator: { configurable: true, value: dom.window.navigator },
      HTMLElement: { configurable: true, value: dom.window.HTMLElement },
      HTMLInputElement: { configurable: true, value: dom.window.HTMLInputElement },
      HTMLSelectElement: { configurable: true, value: dom.window.HTMLSelectElement },
      HTMLTextAreaElement: { configurable: true, value: dom.window.HTMLTextAreaElement },
      Worker: { configurable: true, value: TestWorker },
      IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    });
    Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => null,
    });

    const [{ renderToString }, { hydrateRoot }] = await Promise.all([
      import("react-dom/server"),
      import("react-dom/client"),
    ]);
    const serverHtml = renderToString(createElement(Home));
    const container = dom.window.document.getElementById("root");
    assert.ok(container);
    container.innerHTML = serverHtml;
    assert.match(serverHtml, /class="modelcut-shell"/);
    assert.ok(container.querySelector("main.modelcut-shell"));

    const recoverableErrors: unknown[] = [];
    await act(async () => {
      root = hydrateRoot(container, createElement(Home), {
        onRecoverableError(error) {
          recoverableErrors.push(error);
        },
      });
    });

    assert.deepEqual(recoverableErrors, []);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    for (const key of browserGlobals) {
      const descriptor = previousGlobals.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});