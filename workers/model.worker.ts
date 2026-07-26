/// <reference lib="webworker" />

import {
  createDemoModel,
  downloadBaseName,
  export3mf,
  exportStlZip,
  parseModelFile,
  splitWithOperation,
  validateMesh,
  type InternalSplit,
} from "../lib/mesh-core";
import type {
  MeshData,
  ModelDocument,
  SplitResult,
  WorkerRequest,
  WorkerResponse,
} from "../lib/model-types";

const models = new Map<string, ModelDocument>();
const splits = new Map<string, { modelId: string; split: InternalSplit }>();
const sourcePackages = new Map<string, Uint8Array>();

function cloneMesh(mesh: MeshData): MeshData {
  return {
    positions: mesh.positions.slice(),
    indices: mesh.indices.slice(),
    faceMaterials: mesh.faceMaterials.slice(),
    faceVertexMaterials: mesh.faceVertexMaterials?.slice(),
    faceColorRegions: mesh.faceColorRegions?.slice(),
    faceParts: mesh.faceParts.slice(),
  };
}

function cloneModel(model: ModelDocument): ModelDocument {
  return {
    ...model,
    mesh: cloneMesh(model.mesh),
    materials: model.materials.map((material) => ({ ...material })),
    colorRegions: model.colorRegions.map((region) => ({ ...region })),
    parts: model.parts.map((part) => ({ ...part })),
    stats: { ...model.stats },
    warnings: [...model.warnings],
  };
}

function cloneSplit(split: SplitResult): SplitResult {
  return {
    ...split,
    selected: cloneMesh(split.selected),
    remaining: cloneMesh(split.remaining),
    selectedValidation: {
      ...split.selectedValidation,
      issues: [...split.selectedValidation.issues],
      warnings: [...split.selectedValidation.warnings],
    },
    remainingValidation: {
      ...split.remainingValidation,
      issues: [...split.remainingValidation.issues],
      warnings: [...split.remainingValidation.warnings],
    },
  };
}

function buffersForMesh(mesh: MeshData): Transferable[] {
  const buffers: Transferable[] = [
    mesh.positions.buffer,
    mesh.indices.buffer,
    mesh.faceMaterials.buffer,
    mesh.faceParts.buffer,
  ];
  if (mesh.faceVertexMaterials) {
    buffers.push(mesh.faceVertexMaterials.buffer);
  }
  if (mesh.faceColorRegions) {
    buffers.push(mesh.faceColorRegions.buffer);
  }
  return buffers;
}

function post(response: WorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(response, transfer);
}

function progress(id: string, value: number, message: string): void {
  post({ id, type: "progress", progress: value, message });
}

function transferableBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function modelResult(id: string, model: ModelDocument): void {
  const result = cloneModel(model);
  post(
    { id, type: "result", result },
    buffersForMesh(result.mesh),
  );
}

function splitResult(id: string, split: SplitResult): void {
  const result = cloneSplit(split);
  post(
    { id, type: "result", result },
    [
      ...buffersForMesh(result.selected),
      ...buffersForMesh(result.remaining),
    ],
  );
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  void (async () => {
    try {
      if (request.type === "demo") {
        progress(request.id, 0.25, "Building the demo model");
        const model = createDemoModel();
        models.set(model.id, model);
        progress(request.id, 1, "Demo ready");
        modelResult(request.id, model);
        return;
      }

      if (request.type === "parse") {
        progress(request.id, 0.08, "Reading the local file");
        const sourceBytes = new Uint8Array(request.bytes);
        const model = parseModelFile(sourceBytes, request.fileName);
        progress(request.id, 0.72, "Finding colors and connected parts");
        models.set(model.id, model);
        if (/\.3mf$/i.test(request.fileName)) {
          sourcePackages.set(model.id, sourceBytes.slice());
        }
        progress(request.id, 1, "Model ready");
        modelResult(request.id, model);
        return;
      }

      const model = models.get(request.modelId);
      if (!model) throw new Error("The model is no longer available. Reload it.");

      if (request.type === "analyze") {
        post({
          id: request.id,
          type: "result",
          result: validateMesh(model.mesh),
        });
        return;
      }

      if (request.type === "split") {
        progress(
          request.id,
          0.12,
          request.operation.kind === "color"
            ? "Tracing the painted boundary"
            : request.operation.kind === "plane"
              ? "Slicing through the plane"
              : "Applying the sketched cut",
        );
        const split = splitWithOperation(model, request.operation);
        progress(request.id, 0.82, "Validating both printable pieces");
        splits.set(split.public.id, { modelId: model.id, split });
        progress(request.id, 1, "Split ready");
        splitResult(request.id, split.public);
        return;
      }

      const stored = splits.get(request.splitId);
      if (!stored || stored.modelId !== model.id)
        throw new Error("Create a validated split before downloading.");

      if (request.type === "export-3mf") {
        progress(request.id, 0.25, "Packaging the color 3MF");
        const bytes = export3mf(
          model,
          stored.split,
          sourcePackages.get(model.id),
        );
        const buffer = transferableBuffer(bytes);
        post(
          {
            id: request.id,
            type: "result",
            result: buffer,
            fileName: `${downloadBaseName(model.name)}-split.3mf`,
            mimeType: "model/3mf",
          },
          [buffer],
        );
        return;
      }

      if (request.type === "export-stl-zip") {
        progress(request.id, 0.25, "Packaging the STL files");
        const bytes = exportStlZip(model, stored.split);
        const buffer = transferableBuffer(bytes);
        post(
          {
            id: request.id,
            type: "result",
            result: buffer,
            fileName: `${downloadBaseName(model.name)}-split-stl.zip`,
            mimeType: "application/zip",
          },
          [buffer],
        );
      }
    } catch (error) {
      const typed = error as Error & { details?: string[]; code?: string };
      post({
        id: request.id,
        type: "error",
        error: {
          code: typed.code ?? "MODEL_ERROR",
          message: typed.message || "The model operation failed.",
          details: typed.details,
        },
      });
    }
  })();
});

export {};
