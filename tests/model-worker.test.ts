import assert from "node:assert/strict";
import test from "node:test";
import { unzipSync } from "fflate";
import type { ModelDocument, WorkerRequest, WorkerResponse } from "../lib/model-types";

test("worker preserves cuttable pieces and exports requested piece sets", async () => {
  const messages: WorkerResponse[] = [];
  let onMessage: ((event: MessageEvent<WorkerRequest>) => void) | undefined;
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: {
      addEventListener(type: string, listener: typeof onMessage) {
        if (type === "message") onMessage = listener;
      },
      postMessage(message: WorkerResponse, transfer: Transferable[] = []) {
        messages.push(structuredClone(message, { transfer }));
      },
    },
  });

  try {
    await import("../workers/model.worker");
    assert.ok(onMessage);
    const dispatch = async (request: WorkerRequest) => {
      const start = messages.length;
      onMessage!({ data: request } as MessageEvent<WorkerRequest>);
      await Promise.resolve();
      return messages.slice(start);
    };
    const lastResult = async (request: WorkerRequest) => {
      const responses = await dispatch(request);
      const response = responses.find((entry) => entry.type === "result");
      assert.ok(response && response.type === "result");
      return response;
    };

    const demoResponse = await lastResult({ id: "demo", type: "demo" });
    assert.equal(demoResponse.type, "result");
    const source = demoResponse.result as ModelDocument;
    const connector = {
      method: "none" as const,
      side: "selected" as const,
      count: 1,
      areaPercent: 8,
      depth: 4,
      tolerance: 0.2,
    };
    const firstResponse = await lastResult({
      id: "split-one",
      type: "split",
      modelId: source.id,
      operation: { kind: "plane", axis: "x", position: 0.5, tilt: 0, connector },
    });
    const firstSplit = firstResponse.result as {
      id: string;
      selected: ModelDocument;
      remaining: ModelDocument;
      selectedValidation: { ok: boolean };
      remainingValidation: { ok: boolean };
    };
    assert.equal(firstSplit.selectedValidation.ok, true);
    assert.equal(firstSplit.remainingValidation.ok, true);

    const secondResponse = await lastResult({
      id: "split-two",
      type: "split",
      modelId: firstSplit.selected.id,
      operation: { kind: "plane", axis: "y", position: 0.5, tilt: 0, connector },
    });
    const secondSplit = secondResponse.result as {
      selected: ModelDocument;
      remaining: ModelDocument;
      selectedValidation: { ok: boolean };
      remainingValidation: { ok: boolean };
    };
    assert.equal(secondSplit.selectedValidation.ok, true);
    assert.equal(secondSplit.remainingValidation.ok, true);

    const exportPieces = [
      {
        modelId: secondSplit.selected.id,
        name: "nested selected",
        position: { x: 11, y: 0, z: 0 },
      },
      {
        modelId: secondSplit.remaining.id,
        name: "nested remaining",
        position: { x: 0, y: 0, z: 0 },
      },
      {
        modelId: firstSplit.remaining.id,
        name: "untouched sibling",
        position: { x: 0, y: 0, z: 0 },
      },
    ];
    const single = await lastResult({
      id: "export-one",
      type: "export-piece-stl",
      modelId: secondSplit.selected.id,
      piece: exportPieces[0],
      includeTransforms: false,
    });
    assert.ok(single.result instanceof ArrayBuffer);
    assert.ok(
      single.fileName?.includes(
        `${secondSplit.selected.id.slice(-6)}.stl`,
      ),
    );
    const zip = await lastResult({
      id: "export-zip",
      type: "export-pieces-stl-zip",
      modelId: source.id,
      pieces: exportPieces,
      includeTransforms: false,
    });
    assert.ok(zip.result instanceof ArrayBuffer);
    assert.equal(Object.keys(unzipSync(new Uint8Array(zip.result))).length, 3);

    const threeMf = await lastResult({
      id: "export-3mf",
      type: "export-pieces-3mf",
      modelId: source.id,
      pieces: exportPieces,
      includeTransforms: true,
    });
    assert.ok(threeMf.result instanceof ArrayBuffer);
    const threeMfXml = new TextDecoder().decode(
      unzipSync(new Uint8Array(threeMf.result))["3D/3dmodel.model"],
    );
    assert.equal((threeMfXml.match(/<item objectid=/g) ?? []).length, 3);
    assert.match(threeMfXml, /transform="1 0 0 0 1 0 0 0 1 11 0 0"/);

    const errorResponses = await dispatch({
      id: "missing-piece",
      type: "export-piece-stl",
      modelId: "missing-model",
      piece: { modelId: "missing-model", name: "missing", position: { x: 0, y: 0, z: 0 } },
      includeTransforms: false,
    });
    assert.ok(errorResponses.some((response) => response.type === "error"));
  } finally {
    if (previousSelf) Object.defineProperty(globalThis, "self", previousSelf);
    else Reflect.deleteProperty(globalThis, "self");
  }
});