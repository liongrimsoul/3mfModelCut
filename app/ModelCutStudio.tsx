"use client";

import {
  Box,
  Check,
  ChevronDown,
  Download,
  FileArchive,
  FolderOpen,
  HelpCircle,
  Info,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  MousePointer2,
  Palette,
  PenLine,
  Redo2,
  RotateCcw,
  Scissors,
  ShieldCheck,
  Sparkles,
  Split,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type React from "react";
import type {
  ColorCutMethod,
  ConnectorMethod,
  ConnectorSettings,
  CutAxis,
  ModelDocument,
  ModelPiece,
  PieceExportRequest,
  PieceSplitResult,
  PieceTransform,
  SelectionMode,
  SplitOperation,
  WorkerRequest,
  WorkerResponse,
} from "../lib/model-types";
import {
  commitSnapshot,
  createEditorTimeline,
  createRootPiece,
  redoSnapshot,
  replacePieceWithSplit,
  resetPiecePositions,
  undoSnapshot,
  updatePiecePosition,
} from "../lib/editor-state";
import type { EditorSnapshot, EditorTimeline } from "../lib/editor-state";
import { ModelViewport } from "./ModelViewport";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const WARNING_FILE_BYTES = 25 * 1024 * 1024;

type RequestWithoutId = WorkerRequest extends infer Request
  ? Request extends { id: string }
    ? Omit<Request, "id">
    : never
  : never;

interface WorkerResultEnvelope {
  result: unknown;
  fileName?: string;
  mimeType?: string;
}

interface PendingRequest {
  resolve: (value: WorkerResultEnvelope) => void;
  reject: (error: Error & { details?: string[] }) => void;
}

type CutMode = SplitOperation["kind"];

function formatNumber(value: number, maximumFractionDigits = 0): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
  }).format(value);
}

function formatArea(value: number): string {
  if (value >= 1000) return `${formatNumber(value, 1)} mm²`;
  return `${formatNumber(value, 2)} mm²`;
}

function downloadBlob(
  buffer: ArrayBuffer,
  fileName: string,
  mimeType: string,
): void {
  const url = URL.createObjectURL(new Blob([buffer], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function SketchPad({
  start,
  end,
  onChange,
}: {
  start: [number, number];
  end: [number, number];
  onChange: (start: [number, number], end: [number, number]) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const drawing = useRef(false);
  const startRef = useRef(start);
  const pointFor = (event: React.PointerEvent): [number, number] => {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return [0.5, 0.5];
    return [
      Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    ];
  };
  const dx = (end[0] - start[0]) * 100;
  const dy = (end[1] - start[1]) * 100;
  return (
    <div
      ref={hostRef}
      className="modelcut-sketch-pad"
      role="application"
      aria-label="Draw a cut line"
      onPointerDown={(event) => {
        drawing.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        const point = pointFor(event);
        startRef.current = point;
        onChange(point, point);
      }}
      onPointerMove={(event) => {
        if (drawing.current) onChange(startRef.current, pointFor(event));
      }}
      onPointerUp={(event) => {
        drawing.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    >
      <span className="modelcut-sketch-grid" aria-hidden="true" />
      <span
        className="modelcut-sketch-line"
        aria-hidden="true"
        style={{
          left: `${start[0] * 100}%`,
          top: `${start[1] * 100}%`,
          width: `${Math.hypot(dx, dy)}%`,
          transform: `rotate(${Math.atan2(dy, dx)}rad)`,
        }}
      />
      <span
        className="modelcut-sketch-handle"
        aria-hidden="true"
        style={{ left: `${start[0] * 100}%`, top: `${start[1] * 100}%` }}
      />
      <span
        className="modelcut-sketch-handle"
        aria-hidden="true"
        style={{ left: `${end[0] * 100}%`, top: `${end[1] * 100}%` }}
      />
      <small>Drag a line across the model view</small>
    </div>
  );
}

function PiecePositionControls({
  piece,
  disabled,
  onPositionChange,
  onReset,
}: {
  piece: ModelPiece;
  disabled: boolean;
  onPositionChange: (axis: keyof PieceTransform, value: number) => void;
  onReset: () => void;
}) {
  const [draft, setDraft] = useState({
    x: String(piece.position.x),
    y: String(piece.position.y),
    z: String(piece.position.z),
  });

  const commitAxis = (axis: keyof PieceTransform) => {
    const value = Number(draft[axis]);
    if (Number.isFinite(value)) onPositionChange(axis, value);
    else setDraft((current) => ({ ...current, [axis]: String(piece.position[axis]) }));
  };

  return (
    <div className="modelcut-piece-transform">
      <p className="modelcut-setting-label">Position · selected piece</p>
      <div className="modelcut-number-grid">
        {(["x", "y", "z"] as const).map((axis) => (
          <label key={axis}>
            {axis.toUpperCase()} mm
            <input
              type="number"
              step="0.1"
              value={draft[axis]}
              disabled={disabled}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  [axis]: event.target.value,
                }))
              }
              onBlur={() => commitAxis(axis)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </label>
        ))}
      </div>
      <button
        className="modelcut-text-button"
        type="button"
        disabled={disabled}
        onClick={onReset}
      >
        Restore original positions
      </button>
    </div>
  );
}

export function ModelCutStudio() {
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef(new Map<string, PendingRequest>());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [model, setModel] = useState<ModelDocument | null>(null);
  const [timeline, setTimeline] = useState<EditorTimeline>(() =>
    createEditorTimeline(),
  );
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState("");
  const [error, setError] = useState<{
    message: string;
    details?: string[];
  } | null>(null);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [includeTransformsInExport, setIncludeTransformsInExport] =
    useState(false);
  const [dragging, setDragging] = useState(false);
  const [webglFailed, setWebglFailed] = useState(false);
  const [resetSignal, setResetSignal] = useState(0);
  const [splitInPlace, setSplitInPlace] = useState(false);
  const [cutMode, setCutMode] = useState<CutMode>("color");
  const [colorCutMethod, setColorCutMethod] =
    useState<ColorCutMethod>("patch");
  const [planeAxis, setPlaneAxis] = useState<CutAxis>("x");
  const [planePosition, setPlanePosition] = useState(0.5);
  const [planeTilt, setPlaneTilt] = useState(0);
  const [sketchViewAxis, setSketchViewAxis] = useState<CutAxis>("z");
  const [sketchStart, setSketchStart] = useState<[number, number]>([0.18, 0.5]);
  const [sketchEnd, setSketchEnd] = useState<[number, number]>([0.82, 0.5]);
  const [connectorMethod, setConnectorMethod] =
    useState<ConnectorMethod>("none");
  const [connectorSide, setConnectorSide] =
    useState<ConnectorSettings["side"]>("selected");
  const [connectorCount, setConnectorCount] = useState(1);
  const [connectorArea, setConnectorArea] = useState(8);
  const [connectorDepth, setConnectorDepth] = useState(4);
  const [connectorTolerance, setConnectorTolerance] = useState(0.2);
  const dragDepth = useRef(0);

  const requestWorker = useCallback(
    (
      request: RequestWithoutId,
      transfer: Transferable[] = [],
    ): Promise<WorkerResultEnvelope> => {
      const worker = workerRef.current;
      if (!worker)
        return Promise.reject(new Error("The model engine is still starting."));
      const id = `request-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return new Promise((resolve, reject) => {
        pendingRef.current.set(id, { resolve, reject });
        worker.postMessage({ ...request, id } as WorkerRequest, transfer);
      });
    },
    [],
  );

  useEffect(() => {
    const pendingRequests = pendingRef.current;
    const worker = new Worker(
      new URL("../workers/model.worker.ts", import.meta.url),
      { type: "module", name: "modelcut-engine" },
    );
    workerRef.current = worker;
    const handleMessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "progress") {
        setProgress(message.progress);
        setProgressMessage(message.message);
        return;
      }
      const pending = pendingRequests.get(message.id);
      if (!pending) return;
      pendingRequests.delete(message.id);
      if (message.type === "error") {
        const requestError = Object.assign(new Error(message.error.message), {
          details: message.error.details,
        });
        pending.reject(requestError);
      } else {
        pending.resolve({
          result: message.result,
          fileName: message.fileName,
          mimeType: message.mimeType,
        });
      }
    };
    worker.addEventListener("message", handleMessage);
    return () => {
      worker.removeEventListener("message", handleMessage);
      worker.terminate();
      workerRef.current = null;
      for (const pending of pendingRequests.values()) {
        pending.reject(new Error("The model engine was closed."));
      }
      pendingRequests.clear();
    };
  }, []);

  const selectedIds = useMemo(
    () => new Set(timeline.present.ids),
    [timeline.present.ids],
  );
  const pieces = timeline.present.pieces;
  const selectedPiece =
    pieces.find((piece) => piece.id === timeline.present.selectedPieceId) ?? null;
  const activeModel = selectedPiece?.model ?? model;
  const hasSplit = pieces.length > 1;
  const validatedPieces = pieces.filter((piece) => piece.validation?.ok);
  const allPiecesValidated = hasSplit && validatedPieces.length === pieces.length;
  const capFaceCount = pieces.reduce((total, piece) => total + piece.capCount, 0);
  const mode = timeline.present.mode;
  const regions = useMemo(() => {
    if (!activeModel) return [];
    return mode === "color"
      ? activeModel.colorRegions.filter((region) => region.faceCount > 0)
      : activeModel.parts;
  }, [activeModel, mode]);
  const selectedRegions = useMemo(
    () => regions.filter((region) => selectedIds.has(region.id)),
    [regions, selectedIds],
  );
  const selectedFaceCount = selectedRegions.reduce(
    (total, region) => total + region.faceCount,
    0,
  );
  const connectorSettings = useMemo<ConnectorSettings>(
    () => ({
      method: connectorMethod,
      side: connectorSide,
      count: connectorCount,
      areaPercent: connectorArea,
      depth: connectorDepth,
      tolerance: connectorTolerance,
    }),
    [
      connectorArea,
      connectorCount,
      connectorDepth,
      connectorMethod,
      connectorSide,
      connectorTolerance,
    ],
  );
  const splitOperation = useMemo<SplitOperation>(() => {
    if (cutMode === "plane") {
      return {
        kind: "plane",
        axis: planeAxis,
        position: planePosition,
        tilt: planeTilt,
        connector: connectorSettings,
      };
    }
    if (cutMode === "sketch") {
      return {
        kind: "sketch",
        viewAxis: sketchViewAxis,
        start: sketchStart,
        end: sketchEnd,
        connector: connectorSettings,
      };
    }
    return {
      kind: "color",
      selection: { mode, ids: [...selectedIds] },
      cutMethod: colorCutMethod,
      connector: connectorSettings,
    };
  }, [
    colorCutMethod,
    connectorSettings,
    cutMode,
    mode,
    planeAxis,
    planePosition,
    planeTilt,
    selectedIds,
    sketchEnd,
    sketchStart,
    sketchViewAxis,
  ]);
  const canSplit =
    Boolean(selectedPiece) &&
    !busy &&
    (cutMode !== "color" || selectedIds.size > 0);

  const commit = useCallback((next: EditorSnapshot) => {
    setTimeline((current) => commitSnapshot(current, next));
  }, []);

  const undo = useCallback(() => {
    setTimeline(undoSnapshot);
    setDownloadOpen(false);
  }, []);

  const redo = useCallback(() => {
    setTimeline(redoSnapshot);
  }, []);

  const toggleSelection = useCallback(
    (id: number) => {
      if (!selectedPiece || busy || cutMode !== "color") return;
      const next = new Set(selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      commit({ ...timeline.present, mode, ids: [...next] });
      setError(null);
    },
    [busy, commit, cutMode, mode, selectedIds, selectedPiece, timeline.present],
  );

  const changeMode = useCallback(
    (nextMode: SelectionMode) => {
      if (nextMode === mode || busy) return;
      commit({ ...timeline.present, mode: nextMode, ids: [] });
      setError(null);
    },
    [busy, commit, mode, timeline.present],
  );

  const changeCutMode = useCallback(
    (nextMode: CutMode) => {
      if (nextMode === cutMode || busy) return;
      setCutMode(nextMode);
      setError(null);
    },
    [busy, cutMode],
  );

  const clearSelection = useCallback(() => {
    if (!selectedIds.size) return;
    commit({ ...timeline.present, mode, ids: [] });
    setError(null);
  }, [commit, mode, selectedIds.size, timeline.present]);

  const loadModel = useCallback(
    async (file: File) => {
      setError(null);
      if (!/\.(3mf|stl)$/i.test(file.name)) {
        setError({ message: "Choose a .3mf or .stl model file." });
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        setError({
          message: "This file is larger than the 50 MB safety limit.",
        });
        return;
      }
      setBusy(true);
      setProgress(0.03);
      setProgressMessage("Preparing your local model");
      try {
        const bytes = await file.arrayBuffer();
        const response = await requestWorker(
          { type: "parse", fileName: file.name, bytes },
          [bytes],
        );
        const loadedModel = response.result as ModelDocument;
        setModel(loadedModel);
        setTimeline(createEditorTimeline([createRootPiece(loadedModel)]));
        setResetSignal((value) => value + 1);
        if (file.size > WARNING_FILE_BYTES) {
          setError({
            message:
              "This is a large file. It loaded successfully, but selection may feel slower.",
          });
        }
      } catch (caught) {
        const typed = caught as Error & { details?: string[] };
        setError({ message: typed.message, details: typed.details });
      } finally {
        setBusy(false);
        setProgress(0);
        setProgressMessage("");
      }
    },
    [requestWorker],
  );

  const loadDemo = useCallback(async () => {
    setError(null);
    setBusy(true);
    setProgress(0.05);
    setProgressMessage("Building the original demo");
    try {
      const response = await requestWorker({ type: "demo" });
      const loadedModel = response.result as ModelDocument;
      setModel(loadedModel);
      setTimeline(createEditorTimeline([createRootPiece(loadedModel)]));
      setResetSignal((value) => value + 1);
    } catch (caught) {
      setError({ message: (caught as Error).message });
    } finally {
      setBusy(false);
      setProgress(0);
      setProgressMessage("");
    }
  }, [requestWorker]);

  const createSplit = useCallback(async () => {
    if (!selectedPiece || !canSplit) return;
    setError(null);
    setBusy(true);
    setProgress(0.05);
    setProgressMessage("Preparing the split");
    try {
      const response = await requestWorker({
        type: "split",
        modelId: selectedPiece.model.id,
        operation: splitOperation,
      });
      const split = response.result as PieceSplitResult;
      const nextPieces = replacePieceWithSplit(
        timeline.present.pieces,
        selectedPiece.id,
        split,
        !splitInPlace,
      );
      commit({
        ...timeline.present,
        pieces: nextPieces,
        selectedPieceId: `piece-${split.id}-selected`,
        ids: [],
      });
    } catch (caught) {
      const typed = caught as Error & { details?: string[] };
      setError({ message: typed.message, details: typed.details });
    } finally {
      setBusy(false);
      setProgress(0);
      setProgressMessage("");
    }
  }, [
    canSplit,
    commit,
    requestWorker,
    selectedPiece,
    splitInPlace,
    splitOperation,
    timeline.present,
  ]);

  const exportFile = useCallback(
    async (
      type: "export-piece-stl" | "export-pieces-3mf" | "export-pieces-stl-zip",
      onlyPiece?: ModelPiece,
    ) => {
      if (
        !model ||
        !hasSplit ||
        !pieces.length ||
        busy ||
        (type === "export-piece-stl" && !onlyPiece)
      )
        return;
      setDownloadOpen(false);
      setError(null);
      setBusy(true);
      setProgress(0.05);
      setProgressMessage("Preparing your download");
      try {
        const pieceRequests: PieceExportRequest[] = pieces.map((piece) => ({
          modelId: piece.model.id,
          name: piece.model.name,
          position: piece.position,
        }));
        const request: RequestWithoutId =
          type === "export-piece-stl" && onlyPiece
            ? {
                type,
                modelId: onlyPiece.model.id,
                piece: {
                  modelId: onlyPiece.model.id,
                  name: onlyPiece.model.name,
                  position: onlyPiece.position,
                },
                includeTransforms: includeTransformsInExport,
              }
            : type === "export-pieces-3mf"
              ? {
                  type,
                  modelId: model.id,
                  pieces: pieceRequests,
                  includeTransforms: includeTransformsInExport,
                }
              : {
                  type: "export-pieces-stl-zip",
                  modelId: model.id,
                  pieces: pieceRequests,
                  includeTransforms: includeTransformsInExport,
                };
        const response = await requestWorker(request);
        downloadBlob(
          response.result as ArrayBuffer,
          response.fileName ?? "modelcut-pieces.zip",
          response.mimeType ?? "application/octet-stream",
        );
      } catch (caught) {
        setError({ message: (caught as Error).message });
      } finally {
        setBusy(false);
        setProgress(0);
        setProgressMessage("");
      }
    },
    [busy, hasSplit, includeTransformsInExport, model, pieces, requestWorker],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (event.key === "Escape") {
        clearSelection();
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        void createSplit();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [clearSelection, createSplit, redo, undo]);

  const handleDragEnter = (event: React.DragEvent) => {
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const handleDragLeave = (event: React.DragEvent) => {
    event.preventDefault();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragging(false);
    }
  };
  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void loadModel(file);
  };

  const selectPiece = useCallback((pieceId: string) => {
    setTimeline((current) => ({
      ...current,
      present: {
        ...current.present,
        selectedPieceId: pieceId,
        ids: [],
      },
    }));
  }, []);

  const updateSelectedPosition = useCallback(
    (axis: keyof PieceTransform, value: number) => {
      if (!selectedPiece || !Number.isFinite(value)) return;
      const position = { ...selectedPiece.position, [axis]: value };
      const nextPieces = updatePiecePosition(pieces, selectedPiece.id, position);
      commit({ ...timeline.present, pieces: nextPieces });
    },
    [commit, pieces, selectedPiece, timeline.present],
  );

  const restorePiecePositions = useCallback(() => {
    if (
      !pieces.some(
        ({ homePosition, position }) =>
          position.x !== homePosition.x ||
          position.y !== homePosition.y ||
          position.z !== homePosition.z,
      )
    )
      return;
    commit({
      ...timeline.present,
      pieces: resetPiecePositions(pieces),
    });
  }, [commit, pieces, timeline.present]);

  const statusText = busy
    ? progressMessage || "Working locally"
    : allPiecesValidated
      ? `${pieces.length} closed pieces are ready to download.`
      : activeModel
        ? cutMode === "color"
          ? `${mode === "color" ? "Color" : "Part"} mode — click the model to select. Press Space to split.`
          : cutMode === "plane"
            ? "Plane cut — position the guide, then press Space to split."
            : "Sketch cut — draw the cut line, then press Space to split."
        : "Choose a local model or try the original demo.";

  return (
    <main
      className="modelcut-shell"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      <aside className="modelcut-sidebar">
        <header className="modelcut-brand">
          <span className="modelcut-mark" aria-hidden="true">
            MC
          </span>
          <span className="modelcut-wordmark">
            ModelCut
            <small>Studio</small>
          </span>
        </header>

        <div className="modelcut-sidebar-scroll">
          <section className="modelcut-upload-section">
            <input
              ref={fileInputRef}
              className="modelcut-file-input"
              type="file"
              accept=".3mf,.stl"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void loadModel(file);
                event.currentTarget.value = "";
              }}
            />
            <button
              className="modelcut-upload-card"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              type="button"
            >
              <Upload size={22} strokeWidth={1.8} />
              <strong>{model ? "Replace model" : "Upload 3MF or STL"}</strong>
              <span>Models stay on this device</span>
              <small>Maximum file size 50 MB</small>
            </button>
          </section>

          {hasSplit && (
            <section className="modelcut-panel">
              <div className="modelcut-section-heading">
                <div>
                  <span className="modelcut-eyebrow">Pieces</span>
                  <h2>Pieces</h2>
                </div>
                <span className="modelcut-count">{pieces.length}</span>
              </div>
              <div className="modelcut-piece-list">
                {pieces.map((piece, index) => (
                  <button
                    key={piece.id}
                    type="button"
                    className={
                      piece.id === selectedPiece?.id ? "is-active" : ""
                    }
                    aria-pressed={piece.id === selectedPiece?.id}
                    disabled={busy}
                    onClick={() => selectPiece(piece.id)}
                  >
                    <strong>Piece {index + 1}</strong>
                    <small>
                      {formatNumber(piece.model.stats.faceCount)} faces
                      {piece.validation?.ok ? " · Closed" : ""}
                    </small>
                  </button>
                ))}
              </div>
              {selectedPiece && (
                <PiecePositionControls
                  key={`${selectedPiece.id}:${selectedPiece.position.x}:${selectedPiece.position.y}:${selectedPiece.position.z}`}
                  piece={selectedPiece}
                  disabled={busy}
                  onPositionChange={updateSelectedPosition}
                  onReset={restorePiecePositions}
                />
              )}
            </section>
          )}

          <section className="modelcut-panel">
            <div className="modelcut-section-heading">
              <div>
                <span className="modelcut-eyebrow">01</span>
                <h2>Cut workflow</h2>
              </div>
              {cutMode === "color" && selectedIds.size > 0 && (
                <button
                  className="modelcut-text-button"
                  type="button"
                  onClick={clearSelection}
                >
                  Clear
                </button>
              )}
            </div>
            <p className="modelcut-section-copy">
              Extract painted regions, position a plane, or draw a custom cut.
            </p>
            <div className="modelcut-workflow-grid" role="group" aria-label="Cut workflow">
              <button
                type="button"
                className={cutMode === "color" ? "is-active" : ""}
                onClick={() => changeCutMode("color")}
                aria-pressed={cutMode === "color"}
                disabled={busy}
              >
                <Palette size={18} />
                <strong>Color</strong>
                <small>Painted regions</small>
              </button>
              <button
                type="button"
                className={cutMode === "plane" ? "is-active" : ""}
                onClick={() => changeCutMode("plane")}
                aria-pressed={cutMode === "plane"}
                disabled={busy}
              >
                <Scissors size={18} />
                <strong>Plane</strong>
                <small>Exact slice</small>
              </button>
              <button
                type="button"
                className={cutMode === "sketch" ? "is-active" : ""}
                onClick={() => changeCutMode("sketch")}
                aria-pressed={cutMode === "sketch"}
                disabled={busy}
              >
                <PenLine size={18} />
                <strong>Sketch</strong>
                <small>Draw a line</small>
              </button>
            </div>
            {cutMode === "color" && (
              <>
                <div
                  className="modelcut-mode-switch modelcut-region-mode"
                  role="group"
                  aria-label="Selection mode"
                >
                  <button
                    type="button"
                    className={mode === "color" ? "is-active" : ""}
                    onClick={() => changeMode("color")}
                    aria-pressed={mode === "color"}
                  >
                    <Layers3 size={16} />
                    Color
                  </button>
                  <button
                    type="button"
                    className={mode === "part" ? "is-active" : ""}
                    onClick={() => changeMode("part")}
                    aria-pressed={mode === "part"}
                  >
                    <Box size={16} />
                    Part
                  </button>
                </div>
                <div className="modelcut-mode-hint">
                  <MousePointer2 size={15} />
                  <span>
                    {model
                      ? `Click any ${mode} on the model`
                      : "Load a model to start selecting"}
                    </span>
                </div>
                {model && regions.length > 0 && (
                  <div className="modelcut-palette-list">
                    <p className="modelcut-setting-label">
                      Available {mode === "color" ? "painted regions" : "parts"}
                    </p>
                    <div>
                      {regions.map((region) => (
                        <button
                          key={`palette-${mode}-${region.id}`}
                          type="button"
                          className={
                            selectedIds.has(region.id) ? "is-active" : ""
                          }
                          aria-pressed={selectedIds.has(region.id)}
                          aria-label={`${selectedIds.has(region.id) ? "Remove" : "Select"} ${region.name}`}
                          disabled={busy}
                          onClick={() => toggleSelection(region.id)}
                        >
                          <span
                            style={{ backgroundColor: region.color }}
                            aria-hidden="true"
                          />
                          <strong>{region.name}</strong>
                          <small>{formatNumber(region.faceCount)} faces</small>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </section>

          <section className="modelcut-panel">
            <div className="modelcut-section-heading">
              <div>
                <span className="modelcut-eyebrow">02</span>
                <h2>Split settings</h2>
              </div>
              <span className="modelcut-live-label">Geometry ready</span>
            </div>
            {cutMode === "color" && (
              <>
                <p className="modelcut-setting-label">Cut method</p>
                <div
                  className="modelcut-setting-grid"
                  role="group"
                  aria-label="Color cut method"
                >
                  <button
                    className={`modelcut-setting-card ${
                      colorCutMethod === "patch" ? "is-active" : ""
                    }`}
                    type="button"
                    aria-pressed={colorCutMethod === "patch"}
                    disabled={busy}
                    onClick={() => setColorCutMethod("patch")}
                  >
                    <span className="modelcut-cut-symbol" aria-hidden="true" />
                    <strong>Patch</strong>
                    <small>Recessed fitted socket</small>
                  </button>
                  <button
                    className={`modelcut-setting-card ${
                      colorCutMethod === "interlocking" ? "is-active" : ""
                    }`}
                    type="button"
                    aria-pressed={colorCutMethod === "interlocking"}
                    disabled={busy}
                    onClick={() => setColorCutMethod("interlocking")}
                  >
                    <span
                      className="modelcut-cut-symbol is-interlock"
                      aria-hidden="true"
                    />
                    <strong>Interlocking</strong>
                    <small>Stepped fitted edge</small>
                  </button>
                </div>
                <div className="modelcut-setting-note">
                  <Palette size={16} />
                  <span>
                    <strong>True color extraction</strong>
                    The painted surface is removed from the body and rebuilt as
                    a separate solid. A recessed mating socket remains behind.
                  </span>
                </div>
              </>
            )}
            {cutMode === "plane" && (
              <div className="modelcut-cut-controls">
                <p className="modelcut-setting-label">Plane axis</p>
                <div className="modelcut-axis-switch" role="group" aria-label="Plane axis">
                  {(["x", "y", "z"] as CutAxis[]).map((axis) => (
                    <button
                      key={axis}
                      type="button"
                      className={planeAxis === axis ? "is-active" : ""}
                      aria-pressed={planeAxis === axis}
                      disabled={busy}
                      onClick={() => setPlaneAxis(axis)}
                    >
                      {axis.toUpperCase()}
                    </button>
                  ))}
                </div>
                <label className="modelcut-range-row">
                  <span>
                    Position <output>{Math.round(planePosition * 100)}%</output>
                  </span>
                  <input
                    type="range"
                    min="1"
                    max="99"
                    value={Math.round(planePosition * 100)}
                    disabled={busy}
                    onChange={(event) =>
                      setPlanePosition(Number(event.target.value) / 100)
                    }
                  />
                </label>
                <label className="modelcut-range-row">
                  <span>
                    Tilt <output>{planeTilt}°</output>
                  </span>
                  <input
                    type="range"
                    min="-45"
                    max="45"
                    value={planeTilt}
                    disabled={busy}
                    onChange={(event) => setPlaneTilt(Number(event.target.value))}
                  />
                </label>
              </div>
            )}
            {cutMode === "sketch" && (
              <div className="modelcut-cut-controls">
                <p className="modelcut-setting-label">Sketch view</p>
                <div className="modelcut-axis-switch" role="group" aria-label="Sketch view axis">
                  {(["x", "y", "z"] as CutAxis[]).map((axis) => (
                    <button
                      key={axis}
                      type="button"
                      className={sketchViewAxis === axis ? "is-active" : ""}
                      aria-pressed={sketchViewAxis === axis}
                      disabled={busy}
                      onClick={() => setSketchViewAxis(axis)}
                    >
                      {axis.toUpperCase()}
                    </button>
                  ))}
                </div>
                <SketchPad
                  start={sketchStart}
                  end={sketchEnd}
                  onChange={(start, end) => {
                    if (busy) return;
                    setSketchStart(start);
                    setSketchEnd(end);
                  }}
                />
              </div>
            )}

            <p className="modelcut-setting-label">Connector method</p>
            <div className="modelcut-connector-grid">
              <button
                className={connectorMethod === "none" ? "is-active" : ""}
                type="button"
                aria-pressed={connectorMethod === "none"}
                disabled={busy}
                onClick={() => setConnectorMethod("none")}
              >
                <span className="modelcut-connector-symbol is-none" aria-hidden="true" />
                <strong>None</strong>
              </button>
              <button
                className={connectorMethod === "triangle" ? "is-active" : ""}
                type="button"
                aria-pressed={connectorMethod === "triangle"}
                disabled={busy}
                onClick={() => setConnectorMethod("triangle")}
              >
                <span className="modelcut-connector-symbol is-triangle" aria-hidden="true" />
                <strong>Triangle</strong>
              </button>
              <button
                className={connectorMethod === "cylinder" ? "is-active" : ""}
                type="button"
                aria-pressed={connectorMethod === "cylinder"}
                disabled={busy}
                onClick={() => setConnectorMethod("cylinder")}
              >
                <span className="modelcut-connector-symbol is-cylinder" aria-hidden="true" />
                <strong>Cylinder</strong>
              </button>
              <button
                className={connectorMethod === "rectangle" ? "is-active" : ""}
                type="button"
                aria-pressed={connectorMethod === "rectangle"}
                disabled={busy}
                onClick={() => setConnectorMethod("rectangle")}
              >
                <span className="modelcut-connector-symbol is-rectangle" aria-hidden="true" />
                <strong>Rectangle</strong>
              </button>
            </div>
            {connectorMethod !== "none" && (
              <div className="modelcut-connector-settings">
                <p className="modelcut-setting-label">Plug side</p>
                <div className="modelcut-mode-switch" role="group" aria-label="Connector plug side">
                  <button
                    type="button"
                    className={connectorSide === "selected" ? "is-active" : ""}
                    aria-pressed={connectorSide === "selected"}
                    disabled={busy}
                    onClick={() => setConnectorSide("selected")}
                  >
                    Selected part
                  </button>
                  <button
                    type="button"
                    className={connectorSide === "remaining" ? "is-active" : ""}
                    aria-pressed={connectorSide === "remaining"}
                    disabled={busy}
                    onClick={() => setConnectorSide("remaining")}
                  >
                    Body
                  </button>
                </div>
                <div className="modelcut-number-grid">
                  <label>
                    Count
                    <input
                      type="number"
                      min="1"
                      max="4"
                      value={connectorCount}
                      disabled={busy}
                      onChange={(event) =>
                        setConnectorCount(
                          Math.max(1, Math.min(4, Number(event.target.value))),
                        )
                      }
                    />
                  </label>
                  <label>
                    Area %
                    <input
                      type="number"
                      min="1"
                      max="25"
                      value={connectorArea}
                      disabled={busy}
                      onChange={(event) =>
                        setConnectorArea(
                          Math.max(1, Math.min(25, Number(event.target.value))),
                        )
                      }
                    />
                  </label>
                  <label>
                    Depth mm
                    <input
                      type="number"
                      min="0.8"
                      max="30"
                      step="0.2"
                      value={connectorDepth}
                      disabled={busy}
                      onChange={(event) =>
                        setConnectorDepth(
                          Math.max(0.8, Math.min(30, Number(event.target.value))),
                        )
                      }
                    />
                  </label>
                  <label>
                    Tolerance
                    <input
                      type="number"
                      min="0"
                      max="1"
                      step="0.05"
                      value={connectorTolerance}
                      disabled={busy}
                      onChange={(event) =>
                        setConnectorTolerance(
                          Math.max(0, Math.min(1, Number(event.target.value))),
                        )
                      }
                    />
                  </label>
                </div>
              </div>
            )}

            <label className="modelcut-toggle-row">
              <span>
                <strong>Split in place</strong>
                <small>Keep both pieces in their original position</small>
              </span>
              <input
                type="checkbox"
                checked={splitInPlace}
                onChange={(event) => setSplitInPlace(event.target.checked)}
              />
              <i aria-hidden="true" />
            </label>
          </section>

          {cutMode === "color" && (
            <section className="modelcut-panel">
              <div className="modelcut-section-heading">
                <div>
                  <span className="modelcut-eyebrow">03</span>
                  <h2>Selected regions</h2>
                </div>
                <span className="modelcut-count">{selectedRegions.length}</span>
              </div>
              <div className="modelcut-region-list">
                {!selectedRegions.length && (
                  <div className="modelcut-empty-list">
                    <span className="modelcut-empty-dot" />
                    <p>Your selections will appear here.</p>
                  </div>
                )}
                {selectedRegions.map((region) => (
                  <article
                    className="modelcut-region-card"
                    key={`${mode}-${region.id}`}
                  >
                    <span
                      className="modelcut-swatch"
                      style={{ backgroundColor: region.color }}
                      aria-hidden="true"
                    />
                    <div>
                      <strong>{region.name}</strong>
                      <span>
                        {formatArea(region.area)} ·{" "}
                        {formatNumber(region.faceCount)} faces
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleSelection(region.id)}
                      aria-label={`Remove ${region.name}`}
                    >
                      <X size={15} />
                    </button>
                  </article>
                ))}
              </div>
            </section>
          )}

          <section className="modelcut-panel modelcut-split-panel">
            <div className="modelcut-section-heading">
              <div>
                <span className="modelcut-eyebrow">
                  {cutMode === "color" ? "04" : "03"}
                </span>
                <h2>Validate split</h2>
              </div>
              {hasSplit && (
                <div className="modelcut-validation-actions">
                  <Check className="modelcut-check" size={18} />
                  <button
                    type="button"
                    className="modelcut-text-button"
                    onClick={clearSelection}
                  >
                    Clear selection
                  </button>
                </div>
              )}
            </div>
            {hasSplit ? (
              <div className="modelcut-validation">
                {pieces.map((piece, index) => (
                  <div key={piece.id}>
                    {piece.validation?.ok ? <Check size={15} /> : <Info size={15} />}
                    Piece {index + 1}: {piece.validation?.ok ? "closed" : "not validated"}
                  </div>
                ))}
                <p>
                  {formatNumber(capFaceCount)} cap faces added ·{" "}
                  {formatNumber(
                    pieces.reduce(
                      (total, piece) => total + piece.model.stats.faceCount,
                      0,
                    ),
                  )} total faces
                </p>
              </div>
            ) : (
              <p className="modelcut-section-copy">
                Unsafe downloads are blocked automatically. Your source model is
                never changed.
              </p>
            )}
          </section>

          <section className="modelcut-privacy-note">
            <ShieldCheck size={18} />
            <div>
              <strong>Private by design</strong>
              <span>No upload, account, or cloud storage.</span>
            </div>
          </section>
        </div>

        <footer className="modelcut-sidebar-footer">
          <button
            type="button"
            className="modelcut-split-button"
            disabled={!canSplit}
            onClick={() => void createSplit()}
          >
            {busy ? (
              <LoaderCircle className="is-spinning" size={19} />
            ) : (
              <Split size={19} />
            )}
            {selectedPiece ? "Split selected piece" : "Split model"}
            <kbd>Space</kbd>
          </button>
          <p>
            {cutMode === "color"
              ? selectedFaceCount
                ? `${formatNumber(selectedFaceCount)} source faces selected`
                : "Select one or more painted regions"
              : cutMode === "plane"
                ? `${planeAxis.toUpperCase()} plane · ${Math.round(planePosition * 100)}% · ${planeTilt}°`
                : `${sketchViewAxis.toUpperCase()} view · custom sketch line`}
          </p>
        </footer>
      </aside>

      <section className="modelcut-main">
        <header className="modelcut-topbar">
          <p>
            <span
              className={`modelcut-status-dot ${busy ? "is-busy" : allPiecesValidated ? "is-ready" : ""}`}
            />
            {statusText}
          </p>
          <div className="modelcut-top-actions">
            {model && (
              <span className="modelcut-model-pill">
                <Box size={14} />
                {formatNumber(activeModel?.stats.faceCount ?? model.stats.faceCount)} faces
              </span>
            )}
            <button
              className="modelcut-icon-button"
              type="button"
              aria-label="About local processing"
              title="Your model never leaves this browser"
            >
              <LockKeyhole size={18} />
            </button>
            <div className="modelcut-download-wrap">
              <button
                type="button"
                className="modelcut-download-button"
                disabled={!hasSplit || busy}
                onClick={() => setDownloadOpen((open) => !open)}
                aria-expanded={downloadOpen}
              >
                <Download size={18} />
                Download
                <ChevronDown size={15} />
              </button>
              {downloadOpen && (
                <div className="modelcut-download-menu">
                  <button type="button" onClick={() => void exportFile("export-pieces-3mf")}>
                    <Box size={18} />
                    <span>
                      <strong>Color 3MF</strong>
                      <small>Colors and slicer settings preserved</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void exportFile("export-pieces-stl-zip")}
                  >
                    <FileArchive size={18} />
                    <span>
                      <strong>STL package</strong>
                      <small>Selected and remaining files</small>
                    </span>
                  </button>
                  {pieces.map((piece, index) => (
                    <button
                      key={`download-${piece.id}`}
                      type="button"
                      disabled={busy}
                      onClick={() => void exportFile("export-piece-stl", piece)}
                    >
                      <Download size={18} />
                      <span>
                        <strong>Piece {index + 1} STL</strong>
                        <small>{formatNumber(piece.model.stats.faceCount)} faces</small>
                      </span>
                    </button>
                  ))}
                  <label className="modelcut-export-transform">
                    <input
                      type="checkbox"
                      checked={includeTransformsInExport}
                      onChange={(event) =>
                        setIncludeTransformsInExport(event.target.checked)
                      }
                    />
                    Include working positions in exports
                  </label>
                </div>
              )}
            </div>
          </div>
        </header>

        <div className="modelcut-workspace">
          <div className="modelcut-history-tools">
            <button
              type="button"
              onClick={undo}
              disabled={!timeline.past.length || busy}
              aria-label="Undo"
              title="Undo"
            >
              <Undo2 size={19} />
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={!timeline.future.length || busy}
              aria-label="Redo"
              title="Redo"
            >
              <Redo2 size={19} />
            </button>
            <span />
            <button
              type="button"
              onClick={() => setResetSignal((value) => value + 1)}
              disabled={!pieces.length}
              aria-label="Reset camera"
              title="Reset camera"
            >
              <RotateCcw size={18} />
            </button>
          </div>

          <ModelViewport
            pieces={pieces}
            selectedPieceId={selectedPiece?.id ?? null}
            selectionMode={mode}
            selectedIds={selectedIds}
            onPick={(pieceId, regionId) => {
              if (pieceId !== selectedPiece?.id) {
                selectPiece(pieceId);
                return;
              }
              if (regionId != null && cutMode === "color") {
                toggleSelection(regionId);
              }
            }}
            onWebglError={() => setWebglFailed(true)}
            resetSignal={resetSignal}
            operationPreview={selectedPiece ? splitOperation : null}
          />

          {!model && !busy && !webglFailed && (
            <div className="modelcut-empty-viewport">
              <div className="modelcut-empty-icon">
                <Upload size={29} strokeWidth={1.7} />
              </div>
              <span className="modelcut-kicker">Local 3D workspace</span>
              <h1>Separate a model into<br />print-ready pieces.</h1>
              <p>
                Drop a 3MF or STL here. Select colors or connected parts, validate
                the split, and download—without uploading your model.
              </p>
              <div className="modelcut-empty-actions">
                <button type="button" onClick={() => fileInputRef.current?.click()}>
                  <FolderOpen size={18} />
                  Choose a model
                </button>
                <button type="button" onClick={() => void loadDemo()}>
                  <Sparkles size={18} />
                  Try the demo
                </button>
              </div>
              <div className="modelcut-format-row">
                <span>3MF</span>
                <i />
                <span>STL</span>
                <i />
                <span>Private processing</span>
              </div>
            </div>
          )}

          {webglFailed && (
            <div className="modelcut-webgl-error">
              <Info size={28} />
              <h2>3D graphics are unavailable</h2>
              <p>
                Enable WebGL2 or open ModelCut Studio in a current desktop browser.
              </p>
            </div>
          )}

          {busy && (
            <div className="modelcut-progress-card" role="status" aria-live="polite">
              <LoaderCircle className="is-spinning" size={22} />
              <div>
                <strong>{progressMessage || "Working locally"}</strong>
                <div className="modelcut-progress-track">
                  <span style={{ width: `${Math.max(progress * 100, 8)}%` }} />
                </div>
              </div>
              <span>{Math.round(progress * 100)}%</span>
            </div>
          )}

          {error && (
            <div className="modelcut-error-card" role="alert">
              <Info size={20} />
              <div>
                <strong>{error.message}</strong>
                {error.details?.length ? (
                  <ul>
                    {error.details.slice(0, 4).map((detail) => (
                      <li key={detail}>{detail}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => setError(null)}
                aria-label="Dismiss message"
              >
                <X size={17} />
              </button>
            </div>
          )}

          <div className="modelcut-help-pill">
            <HelpCircle size={15} />
            Drag to orbit · Scroll to zoom · Right-drag to pan
          </div>
        </div>
      </section>

      {dragging && (
        <div className="modelcut-drop-overlay">
          <div>
            <Upload size={36} />
            <strong>Drop your model here</strong>
            <span>3MF and STL files stay on this device</span>
          </div>
        </div>
      )}

      <section className="modelcut-mobile-gate">
        <span className="modelcut-mark" aria-hidden="true">
          MC
        </span>
        <h1>ModelCut Studio needs a larger screen</h1>
        <p>
          Open this private editor on a desktop or laptop with WebGL2 for accurate
          model selection and splitting.
        </p>
      </section>
    </main>
  );
}
