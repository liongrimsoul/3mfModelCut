export type SelectionMode = "color" | "part";

export interface MaterialInfo {
  id: number;
  name: string;
  color: string;
  faceCount: number;
  area: number;
}

export interface RegionInfo {
  id: number;
  name: string;
  color: string;
  faceCount: number;
  area: number;
}

export interface ColorRegionInfo extends RegionInfo {
  materialId: number;
}

export interface MeshData {
  positions: Float32Array;
  indices: Uint32Array;
  faceMaterials: Uint16Array;
  faceVertexMaterials?: Uint16Array;
  faceColorRegions?: Uint32Array;
  faceParts: Uint32Array;
}

export interface ModelStats {
  vertexCount: number;
  faceCount: number;
  partCount: number;
  materialCount: number;
  surfaceArea: number;
  openEdges: number;
  nonManifoldEdges: number;
}

export interface ModelDocument {
  id: string;
  name: string;
  unit: string;
  unitScaleToMillimeter: number;
  mesh: MeshData;
  materials: MaterialInfo[];
  colorRegions: ColorRegionInfo[];
  parts: RegionInfo[];
  stats: ModelStats;
  warnings: string[];
}

export interface ValidationReport {
  ok: boolean;
  issues: string[];
  warnings: string[];
  openEdges: number;
  nonManifoldEdges: number;
  degenerateFaces: number;
  volume: number;
}

export interface SplitResult {
  id: string;
  selected: MeshData;
  remaining: MeshData;
  selectedValidation: ValidationReport;
  remainingValidation: ValidationReport;
  capCount: number;
  selectedFaceCount: number;
  remainingFaceCount: number;
}

export interface PieceTransform {
  x: number;
  y: number;
  z: number;
}

export interface ModelPiece {
  id: string;
  parentId: string | null;
  model: ModelDocument;
  homePosition: PieceTransform;
  position: PieceTransform;
  validation: ValidationReport | null;
  capCount: number;
}

export interface PieceSplitResult {
  id: string;
  selected: ModelDocument;
  remaining: ModelDocument;
  selectedValidation: ValidationReport;
  remainingValidation: ValidationReport;
  capCount: number;
  selectedFaceCount: number;
  remainingFaceCount: number;
}

export interface PieceExportRequest {
  modelId: string;
  name: string;
  position: PieceTransform;
}

export interface SelectionState {
  mode: SelectionMode;
  ids: number[];
}

export type CutAxis = "x" | "y" | "z";
export type ConnectorMethod =
  | "none"
  | "triangle"
  | "cylinder"
  | "rectangle";
export type ColorCutMethod = "patch" | "interlocking";

export interface ConnectorSettings {
  method: ConnectorMethod;
  side: "selected" | "remaining";
  count: number;
  areaPercent: number;
  depth: number;
  tolerance: number;
}

export type SplitOperation =
  | {
      kind: "color";
      selection: SelectionState;
      cutMethod: ColorCutMethod;
      connector: ConnectorSettings;
    }
  | {
      kind: "plane";
      axis: CutAxis;
      position: number;
      tilt: number;
      connector: ConnectorSettings;
    }
  | {
      kind: "sketch";
      viewAxis: CutAxis;
      start: [number, number];
      end: [number, number];
      connector: ConnectorSettings;
    };

export type WorkerRequest =
  | { id: string; type: "demo" }
  | { id: string; type: "parse"; fileName: string; bytes: ArrayBuffer }
  | { id: string; type: "analyze"; modelId: string }
  | {
      id: string;
      type: "split";
      modelId: string;
      operation: SplitOperation;
    }
  | {
      id: string;
      type: "export-piece-stl";
      modelId: string;
      piece: PieceExportRequest;
      includeTransforms: boolean;
    }
  | {
      id: string;
      type: "export-pieces-stl-zip";
      modelId: string;
      pieces: PieceExportRequest[];
      includeTransforms: boolean;
    }
  | {
      id: string;
      type: "export-pieces-3mf";
      modelId: string;
      pieces: PieceExportRequest[];
      includeTransforms: boolean;
    }
  | { id: string; type: "export-3mf"; modelId: string; splitId: string }
  | { id: string; type: "export-stl-zip"; modelId: string; splitId: string };

export type WorkerResponse =
  | {
      id: string;
      type: "progress";
      progress: number;
      message: string;
    }
  | {
      id: string;
      type: "result";
      result:
        | ModelDocument
        | SplitResult
        | PieceSplitResult
        | ValidationReport
        | ArrayBuffer;
      fileName?: string;
      mimeType?: string;
    }
  | {
      id: string;
      type: "error";
      error: {
        code: string;
        message: string;
        details?: string[];
      };
    };
