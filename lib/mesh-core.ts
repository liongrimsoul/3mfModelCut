import earcut from "earcut";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";
import type {
  ColorCutMethod,
  ColorRegionInfo,
  ConnectorSettings,
  MaterialInfo,
  MeshData,
  ModelDocument,
  ModelStats,
  PieceTransform,
  SplitOperation,
  RegionInfo,
  SelectionState,
  SplitResult,
  ValidationReport,
} from "./model-types";

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 250 * 1024 * 1024;
export const MAX_TRIANGLES = 1_500_000;
export const WARNING_FILE_BYTES = 25 * 1024 * 1024;
export const WARNING_TRIANGLES = 750_000;

type Vec3 = [number, number, number];
type Face = [number, number, number];
type XmlRecord = Record<string, unknown>;

interface MutableModel {
  name: string;
  unit: string;
  unitScaleToMillimeter: number;
  positions: number[];
  faces: Face[];
  faceMaterials: number[];
  faceVertexMaterials: number[];
  materials: Array<{ name: string; color: string }>;
  warnings: string[];
}

interface InternalSplit {
  public: SplitResult;
  selected: MeshData;
  remaining: MeshData;
}

const DEFAULT_COLOR = "#B9B4A9";

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function safeNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asXmlRecord(value: unknown): XmlRecord {
  return value != null && typeof value === "object"
    ? (value as XmlRecord)
    : {};
}

function normalizeHex(value: unknown, fallback = DEFAULT_COLOR): string {
  const text = String(value ?? "").trim();
  const match = text.match(/^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i);
  return match ? `#${match[1].toUpperCase()}` : fallback;
}

function vertexAt(positions: Float32Array | number[], index: number): Vec3 {
  const offset = index * 3;
  return [
    Number(positions[offset]),
    Number(positions[offset + 1]),
    Number(positions[offset + 2]),
  ];
}

function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function subtract3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale3(value: Vec3, scale: number): Vec3 {
  return [value[0] * scale, value[1] * scale, value[2] * scale];
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize3(value: Vec3): Vec3 {
  const length = Math.hypot(value[0], value[1], value[2]);
  return length > 1e-12 ? scale3(value, 1 / length) : [0, 0, 1];
}

function mix3(a: Vec3, b: Vec3, amount: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * amount,
    a[1] + (b[1] - a[1]) * amount,
    a[2] + (b[2] - a[2]) * amount,
  ];
}

function triangleNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return normalize3(cross3(subtract3(b, a), subtract3(c, a)));
}

function triangleArea(a: Vec3, b: Vec3, c: Vec3): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const acx = c[0] - a[0];
  const acy = c[1] - a[1];
  const acz = c[2] - a[2];
  const x = aby * acz - abz * acy;
  const y = abz * acx - abx * acz;
  const z = abx * acy - aby * acx;
  return Math.hypot(x, y, z) * 0.5;
}

function faceArea(mesh: MeshData, faceIndex: number): number {
  const offset = faceIndex * 3;
  return triangleArea(
    vertexAt(mesh.positions, mesh.indices[offset]),
    vertexAt(mesh.positions, mesh.indices[offset + 1]),
    vertexAt(mesh.positions, mesh.indices[offset + 2]),
  );
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function colorName(hex: string, index: number): string {
  const known: Record<string, string> = {
    "#F04E23": "Signal orange",
    "#087F79": "Deep teal",
    "#F0E6D2": "Warm ivory",
    "#202421": "Charcoal",
    "#B9B4A9": "Stone",
  };
  return known[hex.toUpperCase()] ?? `Material ${index + 1}`;
}

function computeConnectivity(
  positions: Float32Array,
  indices: Uint32Array,
): Uint32Array {
  const faceCount = Math.floor(indices.length / 3);
  const edges = new Map<string, number[]>();
  for (let face = 0; face < faceCount; face += 1) {
    const offset = face * 3;
    const tri = [
      indices[offset],
      indices[offset + 1],
      indices[offset + 2],
    ];
    for (let edge = 0; edge < 3; edge += 1) {
      const key = edgeKey(tri[edge], tri[(edge + 1) % 3]);
      const list = edges.get(key);
      if (list) list.push(face);
      else edges.set(key, [face]);
    }
  }

  const adjacency: number[][] = Array.from({ length: faceCount }, () => []);
  for (const faces of edges.values()) {
    for (let i = 0; i < faces.length; i += 1) {
      for (let j = i + 1; j < faces.length; j += 1) {
        adjacency[faces[i]].push(faces[j]);
        adjacency[faces[j]].push(faces[i]);
      }
    }
  }

  const parts = new Uint32Array(faceCount);
  parts.fill(0xffffffff);
  let partId = 0;
  for (let start = 0; start < faceCount; start += 1) {
    if (parts[start] !== 0xffffffff) continue;
    const stack = [start];
    parts[start] = partId;
    while (stack.length) {
      const face = stack.pop()!;
      for (const neighbor of adjacency[face]) {
        if (parts[neighbor] === 0xffffffff) {
          parts[neighbor] = partId;
          stack.push(neighbor);
        }
      }
    }
    partId += 1;
  }
  return parts;
}

function computeColorConnectivity(
  indices: Uint32Array,
  faceMaterials: Uint16Array,
): Uint32Array {
  const faceCount = Math.floor(indices.length / 3);
  const parents = new Uint32Array(faceCount);
  const ranks = new Uint8Array(faceCount);
  const edges = new Map<string, number[]>();

  for (let face = 0; face < faceCount; face += 1) {
    parents[face] = face;
    const offset = face * 3;
    for (let edge = 0; edge < 3; edge += 1) {
      const key = edgeKey(
        indices[offset + edge],
        indices[offset + ((edge + 1) % 3)],
      );
      const owners = edges.get(key);
      if (owners) owners.push(face);
      else edges.set(key, [face]);
    }
  }

  const root = (face: number): number => {
    let current = face;
    while (parents[current] !== current) current = parents[current];
    let cursor = face;
    while (parents[cursor] !== cursor) {
      const next = parents[cursor];
      parents[cursor] = current;
      cursor = next;
    }
    return current;
  };
  const unite = (left: number, right: number): void => {
    let leftRoot = root(left);
    let rightRoot = root(right);
    if (leftRoot === rightRoot) return;
    if (ranks[leftRoot] < ranks[rightRoot]) {
      [leftRoot, rightRoot] = [rightRoot, leftRoot];
    }
    parents[rightRoot] = leftRoot;
    if (ranks[leftRoot] === ranks[rightRoot]) ranks[leftRoot] += 1;
  };

  for (const owners of edges.values()) {
    for (let left = 0; left < owners.length; left += 1) {
      for (let right = left + 1; right < owners.length; right += 1) {
        if (
          faceMaterials[owners[left]] === faceMaterials[owners[right]]
        ) {
          unite(owners[left], owners[right]);
        }
      }
    }
  }

  const regionForRoot = new Map<number, number>();
  const regions = new Uint32Array(faceCount);
  for (let face = 0; face < faceCount; face += 1) {
    const faceRoot = root(face);
    let region = regionForRoot.get(faceRoot);
    if (region == null) {
      region = regionForRoot.size;
      regionForRoot.set(faceRoot, region);
    }
    regions[face] = region;
  }
  return regions;
}

function meshStats(mesh: MeshData): {
  openEdges: number;
  nonManifoldEdges: number;
  degenerateFaces: number;
  surfaceArea: number;
  volume: number;
  inconsistentEdges: number;
} {
  const edgeCounts = new Map<string, { count: number; direction: number }>();
  let degenerateFaces = 0;
  let surfaceArea = 0;
  let volume = 0;

  for (let face = 0; face < mesh.indices.length / 3; face += 1) {
    const offset = face * 3;
    const tri: Face = [
      mesh.indices[offset],
      mesh.indices[offset + 1],
      mesh.indices[offset + 2],
    ];
    const a = vertexAt(mesh.positions, tri[0]);
    const b = vertexAt(mesh.positions, tri[1]);
    const c = vertexAt(mesh.positions, tri[2]);
    const area = triangleArea(a, b, c);
    surfaceArea += area;
    if (area <= 1e-9) degenerateFaces += 1;
    volume +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;

    for (let edge = 0; edge < 3; edge += 1) {
      const from = tri[edge];
      const to = tri[(edge + 1) % 3];
      const key = edgeKey(from, to);
      const entry = edgeCounts.get(key) ?? { count: 0, direction: 0 };
      entry.count += 1;
      entry.direction += from < to ? 1 : -1;
      edgeCounts.set(key, entry);
    }
  }

  let openEdges = 0;
  let nonManifoldEdges = 0;
  let inconsistentEdges = 0;
  for (const entry of edgeCounts.values()) {
    if (entry.count === 1) openEdges += 1;
    if (entry.count > 2) nonManifoldEdges += 1;
    if (entry.count === 2 && entry.direction !== 0) inconsistentEdges += 1;
  }
  return {
    openEdges,
    nonManifoldEdges,
    degenerateFaces,
    surfaceArea,
    volume,
    inconsistentEdges,
  };
}

export function validateMesh(mesh: MeshData): ValidationReport {
  const stats = meshStats(mesh);
  const issues: string[] = [];
  const warnings: string[] = [];
  if (!mesh.indices.length) issues.push("This piece contains no triangles.");
  if (stats.openEdges)
    issues.push(`${stats.openEdges.toLocaleString()} boundary edges remain open.`);
  if (stats.nonManifoldEdges)
    issues.push(
      `${stats.nonManifoldEdges.toLocaleString()} edges are shared by more than two faces.`,
    );
  if (stats.inconsistentEdges)
    issues.push(
      `${stats.inconsistentEdges.toLocaleString()} shared edges have inconsistent face direction.`,
    );
  if (stats.degenerateFaces)
    warnings.push(
      `${stats.degenerateFaces.toLocaleString()} microscopic or zero-area triangles were retained from the source model.`,
    );
  if (Math.abs(stats.volume) <= 1e-8 && mesh.indices.length)
    issues.push("The calculated volume is too small to form a printable solid.");
  return {
    ok: issues.length === 0,
    issues,
    warnings,
    openEdges: stats.openEdges,
    nonManifoldEdges: stats.nonManifoldEdges,
    degenerateFaces: stats.degenerateFaces,
    volume: stats.volume,
  };
}

function finalizeModel(source: MutableModel): ModelDocument {
  if (!source.faces.length)
    throw new Error("No printable triangles were found in this file.");
  if (source.faces.length > MAX_TRIANGLES)
    throw new Error(
      `This model contains more than ${MAX_TRIANGLES.toLocaleString()} triangles.`,
    );

  const positions = new Float32Array(source.positions);
  const indices = new Uint32Array(source.faces.length * 3);
  source.faces.forEach((face, index) => indices.set(face, index * 3));
  const faceMaterials = new Uint16Array(source.faceMaterials);
  const faceVertexMaterials =
    source.faceVertexMaterials.length === source.faces.length * 3
      ? new Uint16Array(source.faceVertexMaterials)
      : new Uint16Array(source.faces.length * 3);
  if (source.faceVertexMaterials.length !== source.faces.length * 3) {
    for (let face = 0; face < source.faces.length; face += 1) {
      faceVertexMaterials.fill(faceMaterials[face] ?? 0, face * 3, face * 3 + 3);
    }
  }
  const faceParts = computeConnectivity(positions, indices);
  const faceColorRegions = computeColorConnectivity(indices, faceMaterials);
  const mesh: MeshData = {
    positions,
    indices,
    faceMaterials,
    faceVertexMaterials,
    faceColorRegions,
    faceParts,
  };

  let highestMaterial = 0;
  for (const material of faceMaterials) {
    if (material > highestMaterial) highestMaterial = material;
  }
  for (const material of faceVertexMaterials) {
    if (material > highestMaterial) highestMaterial = material;
  }
  const materialCount = Math.max(
    source.materials.length,
    faceMaterials.length ? highestMaterial + 1 : 1,
  );
  while (source.materials.length < materialCount) {
    source.materials.push({
      name: `Material ${source.materials.length + 1}`,
      color: DEFAULT_COLOR,
    });
  }

  const materialFaces = new Array<number>(materialCount).fill(0);
  const materialAreas = new Array<number>(materialCount).fill(0);
  let highestPart = 0;
  for (const part of faceParts) {
    if (part > highestPart) highestPart = part;
  }
  const partCount = faceParts.length ? highestPart + 1 : 0;
  const partFaces = new Array<number>(partCount).fill(0);
  const partAreas = new Array<number>(partCount).fill(0);
  let highestColorRegion = 0;
  for (const region of faceColorRegions) {
    if (region > highestColorRegion) highestColorRegion = region;
  }
  const colorRegionCount = faceColorRegions.length
    ? highestColorRegion + 1
    : 0;
  const colorRegionFaces = new Array<number>(colorRegionCount).fill(0);
  const colorRegionAreas = new Array<number>(colorRegionCount).fill(0);
  const colorRegionMaterials = new Array<number>(colorRegionCount).fill(0);

  for (let face = 0; face < source.faces.length; face += 1) {
    const area = faceArea(mesh, face);
    const part = faceParts[face] ?? 0;
    const colorRegion = faceColorRegions[face] ?? 0;
    const cornerCounts = new Map<number, number>();
    for (let corner = 0; corner < 3; corner += 1) {
      const material =
        faceVertexMaterials[face * 3 + corner] ?? faceMaterials[face] ?? 0;
      cornerCounts.set(material, (cornerCounts.get(material) ?? 0) + 1);
    }
    for (const [material, count] of cornerCounts) {
      materialFaces[material] += 1;
      materialAreas[material] += area * (count / 3);
    }
    partFaces[part] += 1;
    partAreas[part] += area;
    colorRegionFaces[colorRegion] += 1;
    colorRegionAreas[colorRegion] += area;
    colorRegionMaterials[colorRegion] = faceMaterials[face] ?? 0;
  }

  const materials: MaterialInfo[] = source.materials.map((material, id) => ({
    id,
    name: material.name || colorName(material.color, id),
    color: normalizeHex(material.color),
    faceCount: materialFaces[id] ?? 0,
    area: materialAreas[id] ?? 0,
  }));
  const regionsPerMaterial = new Map<number, number>();
  for (const materialId of colorRegionMaterials) {
    regionsPerMaterial.set(
      materialId,
      (regionsPerMaterial.get(materialId) ?? 0) + 1,
    );
  }
  const nextRegionNumber = new Map<number, number>();
  const colorRegions: ColorRegionInfo[] = colorRegionFaces.map(
    (faceCount, id) => {
      const materialId = colorRegionMaterials[id] ?? 0;
      const material = materials[materialId] ?? materials[0];
      const regionNumber = (nextRegionNumber.get(materialId) ?? 0) + 1;
      nextRegionNumber.set(materialId, regionNumber);
      const repeated = (regionsPerMaterial.get(materialId) ?? 0) > 1;
      return {
        id,
        materialId,
        name: repeated
          ? `${material?.name ?? `Material ${materialId + 1}`} · Region ${regionNumber}`
          : material?.name ?? `Material ${materialId + 1}`,
        color: material?.color ?? DEFAULT_COLOR,
        faceCount,
        area: colorRegionAreas[id],
      };
    },
  );
  const palette = ["#F04E23", "#087F79", "#F0E6D2", "#546C68", "#C39B64"];
  const parts: RegionInfo[] = partFaces.map((faceCount, id) => ({
    id,
    name: `Part ${String(id + 1).padStart(2, "0")}`,
    color: palette[id % palette.length],
    faceCount,
    area: partAreas[id],
  }));
  const geometryStats = meshStats(mesh);
  if (source.faces.length > WARNING_TRIANGLES) {
    source.warnings.push(
      "This is a detailed model; selection and splitting may take longer.",
    );
  }
  if (geometryStats.openEdges) {
    source.warnings.push(
      `The source model has ${geometryStats.openEdges.toLocaleString()} open edges. Unsafe split exports will be blocked.`,
    );
  }

  const stats: ModelStats = {
    vertexCount: positions.length / 3,
    faceCount: source.faces.length,
    partCount,
    materialCount: materials.filter((material) => material.faceCount > 0).length,
    surfaceArea: geometryStats.surfaceArea,
    openEdges: geometryStats.openEdges,
    nonManifoldEdges: geometryStats.nonManifoldEdges,
  };
  return {
    id: `model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: source.name,
    unit: source.unit,
    unitScaleToMillimeter: source.unitScaleToMillimeter,
    mesh,
    materials,
    colorRegions,
    parts,
    stats,
    warnings: source.warnings,
  };
}

function addBox(
  target: MutableModel,
  center: Vec3,
  size: Vec3,
  material: number,
): void {
  const [cx, cy, cz] = center;
  const [sx, sy, sz] = size.map((value) => value * 0.5) as Vec3;
  const base = target.positions.length / 3;
  const vertices: Vec3[] = [
    [cx - sx, cy - sy, cz - sz],
    [cx + sx, cy - sy, cz - sz],
    [cx + sx, cy + sy, cz - sz],
    [cx - sx, cy + sy, cz - sz],
    [cx - sx, cy - sy, cz + sz],
    [cx + sx, cy - sy, cz + sz],
    [cx + sx, cy + sy, cz + sz],
    [cx - sx, cy + sy, cz + sz],
  ];
  for (const vertex of vertices) target.positions.push(...vertex);
  const faces: Face[] = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [1, 2, 6],
    [1, 6, 5],
    [2, 3, 7],
    [2, 7, 6],
    [3, 0, 4],
    [3, 4, 7],
  ];
  for (const face of faces) {
    target.faces.push([
      base + face[0],
      base + face[1],
      base + face[2],
    ]);
    target.faceMaterials.push(material);
  }
}

function addCylinder(
  target: MutableModel,
  center: Vec3,
  radius: number,
  height: number,
  material: number,
  segments = 24,
): void {
  const base = target.positions.length / 3;
  for (let side = 0; side < 2; side += 1) {
    const z = center[2] + (side ? height * 0.5 : -height * 0.5);
    for (let i = 0; i < segments; i += 1) {
      const angle = (Math.PI * 2 * i) / segments;
      target.positions.push(
        center[0] + Math.cos(angle) * radius,
        center[1] + Math.sin(angle) * radius,
        z,
      );
    }
  }
  const bottomCenter = target.positions.length / 3;
  target.positions.push(center[0], center[1], center[2] - height * 0.5);
  const topCenter = target.positions.length / 3;
  target.positions.push(center[0], center[1], center[2] + height * 0.5);

  for (let i = 0; i < segments; i += 1) {
    const next = (i + 1) % segments;
    const b0 = base + i;
    const b1 = base + next;
    const t0 = base + segments + i;
    const t1 = base + segments + next;
    target.faces.push([b0, b1, t1], [b0, t1, t0]);
    target.faceMaterials.push(material, material);
    target.faces.push([bottomCenter, b1, b0], [topCenter, t0, t1]);
    target.faceMaterials.push(material, material);
  }
}

export function createDemoModel(): ModelDocument {
  const mutable: MutableModel = {
    name: "ModelCut demo",
    unit: "millimeter",
    unitScaleToMillimeter: 1,
    positions: [],
    faces: [],
    faceMaterials: [],
    faceVertexMaterials: [],
    materials: [
      { name: "Signal orange", color: "#F04E23" },
      { name: "Deep teal", color: "#087F79" },
      { name: "Warm ivory", color: "#F0E6D2" },
    ],
    warnings: [],
  };
  addBox(mutable, [-17, 0, 7], [15, 15, 14], 0);
  addCylinder(mutable, [0, 0, 8], 8.5, 16, 1, 28);
  addBox(mutable, [18, 0, 5], [16, 16, 10], 2);
  return finalizeModel(mutable);
}

function dedupeVertex(
  positions: number[],
  map: Map<string, number>,
  vertex: Vec3,
): number {
  const key = vertex.map((value) => Math.round(value * 1e6)).join("|");
  const existing = map.get(key);
  if (existing != null) return existing;
  const index = positions.length / 3;
  positions.push(...vertex);
  map.set(key, index);
  return index;
}

export function parseStl(bytes: Uint8Array, fileName: string): ModelDocument {
  const mutable: MutableModel = {
    name: fileName.replace(/\.stl$/i, "") || "STL model",
    unit: "millimeter",
    unitScaleToMillimeter: 1,
    positions: [],
    faces: [],
    faceMaterials: [],
    faceVertexMaterials: [],
    materials: [{ name: "STL surface", color: DEFAULT_COLOR }],
    warnings: ["STL files do not contain units; millimetres were assumed."],
  };
  const vertexMap = new Map<string, number>();
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let parsedBinary = false;

  if (bytes.byteLength >= 84) {
    const faceCount = data.getUint32(80, true);
    const expected = 84 + faceCount * 50;
    if (faceCount > 0 && expected <= bytes.byteLength) {
      parsedBinary = true;
      let offset = 84;
      for (let face = 0; face < faceCount; face += 1) {
        offset += 12;
        const tri: number[] = [];
        const vertices: Vec3[] = [];
        for (let vertex = 0; vertex < 3; vertex += 1) {
          const point: Vec3 = [
            data.getFloat32(offset, true),
            data.getFloat32(offset + 4, true),
            data.getFloat32(offset + 8, true),
          ];
          offset += 12;
          vertices.push(point);
          tri.push(dedupeVertex(mutable.positions, vertexMap, point));
        }
        offset += 2;
        if (
          vertices.every((point) => point.every(Number.isFinite)) &&
          new Set(tri).size === 3 &&
          triangleArea(vertices[0], vertices[1], vertices[2]) > 1e-9
        ) {
          mutable.faces.push(tri as Face);
          mutable.faceMaterials.push(0);
        }
      }
    }
  }

  if (!parsedBinary) {
    const text = new TextDecoder().decode(bytes);
    const number = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?";
    const vertexPattern = new RegExp(
      `vertex\\s+(${number})\\s+(${number})\\s+(${number})`,
      "gi",
    );
    const facets = text.match(/facet\b[\s\S]*?endfacet/gi) ?? [];
    const groups = facets.length ? facets : [text];
    for (const group of groups) {
      const vertices = [...group.matchAll(vertexPattern)].map(
        (match) =>
          [
            Number.parseFloat(match[1]),
            Number.parseFloat(match[2]),
            Number.parseFloat(match[3]),
          ] as Vec3,
      );
      for (let index = 0; index + 2 < vertices.length; index += 3) {
        const triangle = vertices.slice(index, index + 3);
        const face = triangle.map((point) =>
          dedupeVertex(mutable.positions, vertexMap, point),
        ) as Face;
        if (
          new Set(face).size === 3 &&
          triangleArea(triangle[0], triangle[1], triangle[2]) > 1e-9
        ) {
          mutable.faces.push(face);
          mutable.faceMaterials.push(0);
        }
      }
    }
  }
  return finalizeModel(mutable);
}

const UNIT_TO_MM: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

function parseTransform(value: unknown): number[] {
  const numbers = String(value ?? "")
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter(Number.isFinite);
  if (numbers.length !== 12)
    return [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  return numbers;
}

function identityTransform(): number[] {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
}

function applyTransform(point: Vec3, matrix: number[]): Vec3 {
  return [
    point[0] * matrix[0] +
      point[1] * matrix[3] +
      point[2] * matrix[6] +
      matrix[9],
    point[0] * matrix[1] +
      point[1] * matrix[4] +
      point[2] * matrix[7] +
      matrix[10],
    point[0] * matrix[2] +
      point[1] * matrix[5] +
      point[2] * matrix[8] +
      matrix[11],
  ];
}

function composeTransform(parent: number[], child: number[]): number[] {
  const basis = (matrix: number[], column: number): Vec3 => [
    matrix[column * 3],
    matrix[column * 3 + 1],
    matrix[column * 3 + 2],
  ];
  const childX = applyTransform(basis(child, 0), [
    parent[0],
    parent[1],
    parent[2],
    parent[3],
    parent[4],
    parent[5],
    parent[6],
    parent[7],
    parent[8],
    0,
    0,
    0,
  ]);
  const childY = applyTransform(basis(child, 1), [
    parent[0],
    parent[1],
    parent[2],
    parent[3],
    parent[4],
    parent[5],
    parent[6],
    parent[7],
    parent[8],
    0,
    0,
    0,
  ]);
  const childZ = applyTransform(basis(child, 2), [
    parent[0],
    parent[1],
    parent[2],
    parent[3],
    parent[4],
    parent[5],
    parent[6],
    parent[7],
    parent[8],
    0,
    0,
    0,
  ]);
  const translation = applyTransform(
    [child[9], child[10], child[11]],
    parent,
  );
  return [
    childX[0],
    childX[1],
    childX[2],
    childY[0],
    childY[1],
    childY[2],
    childZ[0],
    childZ[1],
    childZ[2],
    translation[0],
    translation[1],
    translation[2],
  ];
}

interface ThreeMfPart {
  path: string;
  model: XmlRecord;
  resources: XmlRecord;
  objects: Map<string, XmlRecord>;
  propertyMaps: Map<string, Array<{ name: string; color: string }>>;
  scale: number;
}

function normalizeArchivePath(path: string): string {
  const segments: string[] = [];
  for (const segment of decodeURIComponent(path).replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

function resolveArchivePath(fromPath: string, target: unknown): string {
  const text = String(target ?? "");
  if (text.startsWith("/")) return normalizeArchivePath(text);
  const base = fromPath.includes("/")
    ? fromPath.slice(0, fromPath.lastIndexOf("/") + 1)
    : "";
  return normalizeArchivePath(`${base}${text}`);
}

function hexChannels(color: string): [number, number, number] {
  const normalized = normalizeHex(color);
  return [
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16),
  ];
}

function mixMaterialColors(
  entries: Array<{ name: string; color: string }>,
  weights: number[],
): string {
  if (!entries.length) return DEFAULT_COLOR;
  const safeWeights = entries.map((_, index) =>
    Math.max(0, Number.isFinite(weights[index]) ? weights[index] : 0),
  );
  let total = safeWeights.reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    safeWeights.fill(1);
    total = safeWeights.length;
  }
  const channels = [0, 0, 0];
  entries.forEach((entry, index) => {
    const rgb = hexChannels(entry.color);
    for (let channel = 0; channel < 3; channel += 1) {
      channels[channel] += rgb[channel] * (safeWeights[index] / total);
    }
  });
  return `#${channels
    .map((value) => Math.round(value).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

function decodeBambuPaintIndex(value: unknown): number | null {
  const code = String(value ?? "").trim().toUpperCase();
  if (code === "4") return 0;
  if (code === "8") return 1;
  const simple = code.match(/^([0-9A-F])C$/);
  return simple ? Number.parseInt(simple[1], 16) + 2 : null;
}

function mostCommonMaterial(materials: number[]): number {
  const counts = new Map<number, number>();
  let winner = materials[0] ?? 0;
  let winnerCount = 0;
  for (const material of materials) {
    const count = (counts.get(material) ?? 0) + 1;
    counts.set(material, count);
    if (count > winnerCount) {
      winner = material;
      winnerCount = count;
    }
  }
  return winner;
}

export function parse3mf(bytes: Uint8Array, fileName: string): ModelDocument {
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes);
  } catch {
    throw new Error("This 3MF archive could not be opened.");
  }
  const expandedBytes = Object.values(archive).reduce(
    (total, entry) => total + entry.byteLength,
    0,
  );
  if (expandedBytes > MAX_EXPANDED_BYTES) {
    throw new Error("This 3MF expands beyond the 250 MB safety limit.");
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    removeNSPrefix: true,
    parseAttributeValue: false,
    trimValues: true,
  });
  const archiveNames = new Map(
    Object.keys(archive).map((path) => [normalizeArchivePath(path).toLowerCase(), path]),
  );
  const archiveEntry = (path: string): Uint8Array | undefined => {
    const actual = archiveNames.get(normalizeArchivePath(path).toLowerCase());
    return actual ? archive[actual] : undefined;
  };

  let rootPath = "";
  const relationshipsBytes = archiveEntry("_rels/.rels");
  if (relationshipsBytes) {
    const relationshipsXml = strFromU8(relationshipsBytes);
    if (/<!DOCTYPE|<!ENTITY/i.test(relationshipsXml)) {
      throw new Error("DTD and entity declarations are not supported.");
    }
    const relationshipDocument = parser.parse(relationshipsXml) as XmlRecord;
    const relationshipRoot = asXmlRecord(
      relationshipDocument.Relationships ?? relationshipDocument.relationships,
    );
    const relationships = toArray(
      relationshipRoot.Relationship ?? relationshipRoot.relationship,
    );
    const startPart = relationships
      .map(asXmlRecord)
      .find((entry) => /\/3dmodel$/i.test(String(entry.Type ?? entry.type ?? "")));
    if (startPart) {
      rootPath = resolveArchivePath(
        "",
        startPart.Target ?? startPart.target,
      );
    }
  }
  if (!rootPath || !archiveEntry(rootPath)) {
    rootPath =
      Object.keys(archive).find((path) => /(^|\/)3d\/3dmodel\.model$/i.test(path)) ??
      Object.keys(archive).find((path) => /(^|\/)3d\/.+\.model$/i.test(path)) ??
      "";
  }
  if (!rootPath || !archiveEntry(rootPath)) {
    throw new Error("The 3MF model payload is missing.");
  }
  rootPath = normalizeArchivePath(rootPath);

  const partCache = new Map<string, ThreeMfPart>();
  const loadPart = (requestedPath: string): ThreeMfPart => {
    const path = normalizeArchivePath(requestedPath);
    const cached = partCache.get(path.toLowerCase());
    if (cached) return cached;
    const payload = archiveEntry(path);
    if (!payload) {
      throw new Error(`A referenced 3MF model part is missing: ${path}`);
    }
    const xml = strFromU8(payload);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
      throw new Error("DTD and entity declarations are not supported.");
    }
    const parsed = parser.parse(xml) as XmlRecord;
    const model = asXmlRecord(parsed.model);
    if (!Object.keys(model).length) {
      throw new Error(`The 3MF model XML is invalid: ${path}`);
    }
    const resources = asXmlRecord(model.resources);
    const propertyMaps = new Map<
      string,
      Array<{ name: string; color: string }>
    >();
    for (const groupValue of toArray(resources.basematerials)) {
      const group = asXmlRecord(groupValue);
      const id = String(group.id);
      const entries = toArray(group.base).map((entryValue, index) => {
        const entry = asXmlRecord(entryValue);
        return {
          name: String(entry.name || `Material ${index + 1}`),
          color: normalizeHex(entry.displaycolor),
        };
      });
      propertyMaps.set(id, entries);
    }
    for (const groupValue of toArray(resources.colorgroup)) {
      const group = asXmlRecord(groupValue);
      const id = String(group.id);
      const entries = toArray(group.color).map((entryValue, index) => {
        const entry = asXmlRecord(entryValue);
        const color = normalizeHex(entry.color);
        return { name: colorName(color, index), color };
      });
      propertyMaps.set(id, entries);
    }
    for (const groupValue of toArray(resources.compositematerials)) {
      const group = asXmlRecord(groupValue);
      const source = propertyMaps.get(String(group.matid)) ?? [];
      const indices = String(group.matindices ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((value) => Math.max(0, safeNumber(value, 0)));
      const constituents = indices
        .map((index) => source[index])
        .filter((entry): entry is { name: string; color: string } => Boolean(entry));
      const entries = toArray(group.composite).map((entryValue, index) => {
        const entry = asXmlRecord(entryValue);
        const weights = String(entry.values ?? "")
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((value) => safeNumber(value, 0));
        return {
          name: `Composite ${index + 1}`,
          color: mixMaterialColors(constituents, weights),
        };
      });
      propertyMaps.set(String(group.id), entries);
    }
    for (const groupValue of toArray(resources.multiproperties)) {
      const group = asXmlRecord(groupValue);
      const pids = String(group.pids ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const entries = toArray(group.multi).map((entryValue, index) => {
        const entry = asXmlRecord(entryValue);
        const pindices = String(entry.pindices ?? "")
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((value) => Math.max(0, safeNumber(value, 0)));
        const layers = pids
          .map((pid, layer) => propertyMaps.get(pid)?.[pindices[layer] ?? 0])
          .filter(
            (candidate): candidate is { name: string; color: string } =>
              Boolean(candidate),
          );
        return layers.at(-1) ?? {
          name: `Multi-property ${index + 1}`,
          color: DEFAULT_COLOR,
        };
      });
      propertyMaps.set(String(group.id), entries);
    }

    const objects = new Map<string, XmlRecord>();
    for (const objectValue of toArray(resources.object)) {
      const object = asXmlRecord(objectValue);
      if (object.id != null) objects.set(String(object.id), object);
    }
    const unit = String(model.unit || "millimeter").toLowerCase();
    const part: ThreeMfPart = {
      path,
      model,
      resources,
      objects,
      propertyMaps,
      scale: UNIT_TO_MM[unit] ?? 1,
    };
    partCache.set(path.toLowerCase(), part);
    return part;
  };

  const rootPart = loadPart(rootPath);
  const rootUnit = String(rootPart.model.unit || "millimeter").toLowerCase();
  const mutable: MutableModel = {
    name: fileName.replace(/\.3mf$/i, "") || "3MF model",
    unit: UNIT_TO_MM[rootUnit] ? rootUnit : "millimeter",
    unitScaleToMillimeter: UNIT_TO_MM[rootUnit] ?? 1,
    positions: [],
    faces: [],
    faceMaterials: [],
    faceVertexMaterials: [],
    materials: [],
    warnings: [],
  };
  if (!UNIT_TO_MM[rootUnit]) {
    mutable.warnings.push(
      `Unknown unit “${rootUnit}”; millimetres were assumed.`,
    );
  }

  const materialIndex = new Map<string, number>();
  const registerMaterial = (
    key: string,
    entry: { name: string; color: string },
  ): number => {
    const existing = materialIndex.get(key);
    if (existing != null) return existing;
    const index = mutable.materials.length;
    mutable.materials.push({
      name: entry.name,
      color: normalizeHex(entry.color),
    });
    materialIndex.set(key, index);
    return index;
  };
  const resolveMaterial = (
    part: ThreeMfPart,
    propertyId: unknown,
    propertyIndex: unknown,
  ): number => {
    const pid = String(propertyId ?? "");
    const pindex = Math.max(0, safeNumber(propertyIndex, 0));
    const key = `3mf:${part.path.toLowerCase()}:${pid}:${pindex}`;
    return registerMaterial(
      key,
      part.propertyMaps.get(pid)?.[pindex] ?? {
        name: mutable.materials.length ? "Unassigned" : "Default material",
        color: DEFAULT_COLOR,
      },
    );
  };

  const projectSettingsPath = Object.keys(archive).find((path) =>
    /(^|\/)metadata\/project_settings\.config$/i.test(path),
  );
  let filamentColors: string[] = [];
  let filamentTypes: string[] = [];
  if (projectSettingsPath) {
    try {
      const settings = JSON.parse(strFromU8(archive[projectSettingsPath])) as {
        filament_colour?: unknown;
        extruder_colour?: unknown;
        default_filament_colour?: unknown;
        filament_type?: unknown;
      };
      const colorCandidates = [
        settings.filament_colour,
        settings.extruder_colour,
        settings.default_filament_colour,
      ];
      const selectedColors = colorCandidates.find(
        (candidate) =>
          Array.isArray(candidate) &&
          candidate.some((color) => normalizeHex(color, "") !== ""),
      );
      filamentColors = Array.isArray(selectedColors)
        ? selectedColors.map((color) => normalizeHex(color))
        : [];
      filamentTypes = Array.isArray(settings.filament_type)
        ? settings.filament_type.map((type) => String(type || "Filament"))
        : [];
    } catch {
      mutable.warnings.push(
        "The slicer filament palette could not be read; standard 3MF colors were used.",
      );
    }
  }
  const bambuMaterials = filamentColors.map((color, index) =>
    registerMaterial(`bambu:${index}`, {
      name: `${filamentTypes[index] || "Filament"} ${index + 1}`,
      color,
    }),
  );

  const bambuDefaultByObject = new Map<string, number>();
  const modelSettingsPath = Object.keys(archive).find((path) =>
    /(^|\/)metadata\/model_settings\.config$/i.test(path),
  );
  if (modelSettingsPath) {
    try {
      const settingsDocument = parser.parse(
        strFromU8(archive[modelSettingsPath]),
      ) as XmlRecord;
      const config = asXmlRecord(settingsDocument.config);
      for (const objectValue of toArray(config.object)) {
        const object = asXmlRecord(objectValue);
        const objectId = String(object.id ?? "");
        const objectMetadata = toArray(object.metadata).map(asXmlRecord);
        const objectExtruder = objectMetadata.find(
          (entry) => String(entry.key) === "extruder",
        );
        if (objectId && objectExtruder) {
          bambuDefaultByObject.set(
            objectId,
            Math.max(0, safeNumber(objectExtruder.value, 1) - 1),
          );
        }
        for (const partValue of toArray(object.part)) {
          const part = asXmlRecord(partValue);
          const partId = String(part.id ?? "");
          const partMetadata = toArray(part.metadata).map(asXmlRecord);
          const extruder = partMetadata.find(
            (entry) => String(entry.key) === "extruder",
          );
          if (partId && extruder) {
            bambuDefaultByObject.set(
              partId,
              Math.max(0, safeNumber(extruder.value, 1) - 1),
            );
          }
        }
      }
    } catch {
      mutable.warnings.push(
        "The slicer object palette could not be read; the first filament was used as a fallback.",
      );
    }
  }

  const defaultMaterial = (): number =>
    bambuMaterials[0] ??
    registerMaterial("default", {
      name: "Default material",
      color: DEFAULT_COLOR,
    });
  const recursionLimit = 128;
  const expandObject = (
    partPath: string,
    objectId: string,
    transform: number[],
    stack: string[],
  ): void => {
    const part = loadPart(partPath);
    const stackKey = `${part.path.toLowerCase()}#${objectId}`;
    if (stack.length > recursionLimit) {
      throw new Error("The 3MF component hierarchy is too deep.");
    }
    if (stack.includes(stackKey)) {
      throw new Error("The 3MF contains a cyclic component reference.");
    }
    const object = part.objects.get(objectId);
    if (!object) {
      throw new Error(
        `A referenced 3MF object is missing: ${part.path}#${objectId}`,
      );
    }
    const nextStack = [...stack, stackKey];
    const mesh = asXmlRecord(object.mesh);
    const vertexCollection = asXmlRecord(mesh.vertices);
    const triangleCollection = asXmlRecord(mesh.triangles);
    if (
      Object.keys(vertexCollection).length &&
      Object.keys(triangleCollection).length
    ) {
      const vertices = toArray(vertexCollection.vertex).map((vertexValue) => {
        const vertex = asXmlRecord(vertexValue);
        return [
          safeNumber(vertex.x) * part.scale,
          safeNumber(vertex.y) * part.scale,
          safeNumber(vertex.z) * part.scale,
        ] as Vec3;
      });
      const base = mutable.positions.length / 3;
      for (const vertex of vertices) {
        mutable.positions.push(...applyTransform(vertex, transform));
      }
      const objectPid = object.pid;
      const objectPindex = object.pindex;
      const objectFallback = (): number =>
        bambuMaterials[bambuDefaultByObject.get(objectId) ?? 0] ??
        (objectPid != null
          ? resolveMaterial(part, objectPid, objectPindex ?? 0)
          : defaultMaterial());
      for (const triangleValue of toArray(triangleCollection.triangle)) {
        const triangle = asXmlRecord(triangleValue);
        const v1 = safeNumber(triangle.v1, -1);
        const v2 = safeNumber(triangle.v2, -1);
        const v3 = safeNumber(triangle.v3, -1);
        if (
          v1 < 0 ||
          v2 < 0 ||
          v3 < 0 ||
          v1 >= vertices.length ||
          v2 >= vertices.length ||
          v3 >= vertices.length
        ) {
          continue;
        }
        mutable.faces.push([base + v1, base + v2, base + v3]);
        const paintIndex = decodeBambuPaintIndex(
          triangle.paint_color ?? triangle.mmu_segmentation,
        );
        let corners: number[];
        if (paintIndex != null && bambuMaterials[paintIndex] != null) {
          corners = [
            bambuMaterials[paintIndex],
            bambuMaterials[paintIndex],
            bambuMaterials[paintIndex],
          ];
        } else if (triangle.pid != null || objectPid != null) {
          const pid = triangle.pid ?? objectPid;
          const p1 = triangle.p1 ?? objectPindex ?? 0;
          const p2 = triangle.p2 ?? p1;
          const p3 = triangle.p3 ?? p1;
          corners = [
            resolveMaterial(part, pid, p1),
            resolveMaterial(part, pid, p2),
            resolveMaterial(part, pid, p3),
          ];
        } else {
          const fallback = objectFallback();
          corners = [fallback, fallback, fallback];
        }
        mutable.faceMaterials.push(mostCommonMaterial(corners));
        mutable.faceVertexMaterials.push(...corners);
      }
    }
    const components = asXmlRecord(object.components);
    for (const componentValue of toArray(components.component)) {
      const component = asXmlRecord(componentValue);
      const childId = String(component.objectid ?? "");
      if (!childId) continue;
      const childPath =
        component.path != null
          ? resolveArchivePath(part.path, component.path)
          : part.path;
      expandObject(
        childPath,
        childId,
        composeTransform(transform, parseTransform(component.transform)),
        nextStack,
      );
    }
  };

  const build = asXmlRecord(rootPart.model.build);
  const buildItems = toArray(build.item);
  if (buildItems.length) {
    for (const itemValue of buildItems) {
      const item = asXmlRecord(itemValue);
      const itemPath =
        item.path != null
          ? resolveArchivePath(rootPart.path, item.path)
          : rootPart.path;
      expandObject(
        itemPath,
        String(item.objectid ?? ""),
        parseTransform(item.transform),
        [],
      );
    }
  } else {
    for (const [id, object] of rootPart.objects) {
      if (object.mesh) {
        expandObject(rootPart.path, id, identityTransform(), []);
      }
    }
  }

  if (!mutable.materials.length) defaultMaterial();
  if (Object.keys(archive).some((path) => /texture|metadata\//i.test(path))) {
    mutable.warnings.push(
      "Model colors, thumbnails, and slicer package settings are preserved in ModelCut 3MF exports.",
    );
  }
  return finalizeModel(mutable);
}

export function parseModelFile(
  bytes: Uint8Array,
  fileName: string,
): ModelDocument {
  if (bytes.byteLength > MAX_FILE_BYTES)
    throw new Error("Files larger than 50 MB are not supported in this release.");
  if (/\.stl$/i.test(fileName)) return parseStl(bytes, fileName);
  if (/\.3mf$/i.test(fileName)) return parse3mf(bytes, fileName);
  throw new Error("Choose a .3mf or .stl model file.");
}

export function createModelFromMesh(
  source: ModelDocument,
  mesh: MeshData,
  name: string,
): ModelDocument {
  const faces: Face[] = [];
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    faces.push([
      mesh.indices[offset],
      mesh.indices[offset + 1],
      mesh.indices[offset + 2],
    ]);
  }
  return finalizeModel({
    name,
    unit: source.unit,
    unitScaleToMillimeter: source.unitScaleToMillimeter,
    positions: Array.from(mesh.positions),
    faces,
    faceMaterials: Array.from(mesh.faceMaterials),
    faceVertexMaterials: mesh.faceVertexMaterials
      ? Array.from(mesh.faceVertexMaterials)
      : [],
    materials: source.materials.map((material) => ({
      name: material.name,
      color: material.color,
    })),
    warnings: source.warnings.filter(
      (warning) => !warning.startsWith("The source model has "),
    ),
  });
}

function selectedFacesFor(
  model: ModelDocument,
  selection: SelectionState,
): Set<number> {
  const ids = new Set(selection.ids);
  const selected = new Set<number>();
  if (selection.mode === "color") {
    for (let face = 0; face < model.mesh.faceMaterials.length; face += 1) {
      const region =
        model.mesh.faceColorRegions?.[face] ?? model.mesh.faceMaterials[face];
      if (ids.has(region)) selected.add(face);
    }
    return selected;
  }
  for (let face = 0; face < model.mesh.faceParts.length; face += 1) {
    if (ids.has(model.mesh.faceParts[face])) selected.add(face);
  }
  return selected;
}

function directedEdge(face: Face, a: number, b: number): [number, number] {
  for (let index = 0; index < 3; index += 1) {
    const from = face[index];
    const to = face[(index + 1) % 3];
    if ((from === a && to === b) || (from === b && to === a)) return [from, to];
  }
  return [a, b];
}

function boundaryLoops(
  mesh: MeshData,
  selectedFaces: Set<number>,
): Array<{
  vertices: number[];
  selectedMaterial: number;
  remainingMaterial: number;
}> {
  const edgeFaces = new Map<string, number[]>();
  const faces: Face[] = [];
  for (let faceIndex = 0; faceIndex < mesh.indices.length / 3; faceIndex += 1) {
    const offset = faceIndex * 3;
    const face: Face = [
      mesh.indices[offset],
      mesh.indices[offset + 1],
      mesh.indices[offset + 2],
    ];
    faces.push(face);
    for (let edge = 0; edge < 3; edge += 1) {
      const key = edgeKey(face[edge], face[(edge + 1) % 3]);
      const list = edgeFaces.get(key);
      if (list) list.push(faceIndex);
      else edgeFaces.set(key, [faceIndex]);
    }
  }

  interface BoundaryEdge {
    id: number;
    from: number;
    to: number;
    selectedFace: number;
    selectedMaterial: number;
    remainingMaterial: number;
  }
  const boundaryEdges: BoundaryEdge[] = [];
  const outgoing = new Map<number, number[]>();
  const boundaryByDirection = new Map<string, number>();
  for (const [key, owners] of edgeFaces) {
    if (owners.length !== 2) continue;
    const [left, right] = owners;
    if (selectedFaces.has(left) === selectedFaces.has(right)) continue;
    const selectedFace = selectedFaces.has(left) ? left : right;
    const remainingFace = selectedFace === left ? right : left;
    const [a, b] = key.split("|").map(Number);
    const [from, to] = directedEdge(faces[selectedFace], a, b);
    const id = boundaryEdges.length;
    boundaryEdges.push({
      id,
      from,
      to,
      selectedFace,
      selectedMaterial: mesh.faceMaterials[selectedFace],
      remainingMaterial: mesh.faceMaterials[remainingFace],
    });
    boundaryByDirection.set(`${from}>${to}`, id);
    const list = outgoing.get(from) ?? [];
    list.push(id);
    outgoing.set(from, list);
  }

  const edgeTotal = boundaryEdges.length;
  if (!edgeTotal) return [];

  const used = new Set<number>();
  const loops: Array<{
    vertices: number[];
    selectedMaterial: number;
    remainingMaterial: number;
  }> = [];
  const chooseContinuation = (
    incoming: BoundaryEdge,
  ): BoundaryEdge | undefined => {
    const current = incoming.to;
    let faceIndex = incoming.selectedFace;
    let guard = 0;
    while (guard <= faces.length) {
      guard += 1;
      const face = faces[faceIndex];
      const corner = face.indexOf(current);
      if (corner < 0) return undefined;
      const nextVertex = face[(corner + 1) % 3];
      const boundaryId = boundaryByDirection.get(`${current}>${nextVertex}`);
      if (boundaryId != null) {
        return used.has(boundaryId) ? undefined : boundaryEdges[boundaryId];
      }
      const owners = edgeFaces.get(edgeKey(current, nextVertex)) ?? [];
      const adjacent = owners.find(
        (owner) => owner !== faceIndex && selectedFaces.has(owner),
      );
      if (adjacent == null) return undefined;
      faceIndex = adjacent;
    }
    return undefined;
  };

  for (const first of boundaryEdges) {
    if (used.has(first.id)) continue;
    const start = first.from;
    const vertices = [start];
    const selectedMaterials: number[] = [];
    const remainingMaterials: number[] = [];
    let incoming = first;
    let current = first.to;
    used.add(first.id);
    selectedMaterials.push(first.selectedMaterial);
    remainingMaterials.push(first.remainingMaterial);
    if (current !== start) vertices.push(current);
    let guard = 0;
    while (current !== start && guard <= edgeTotal + 1) {
      guard += 1;
      const next = chooseContinuation(incoming);
      if (!next)
        throw new Error("A selected boundary is open and cannot be capped.");
      used.add(next.id);
      selectedMaterials.push(next.selectedMaterial);
      remainingMaterials.push(next.remainingMaterial);
      incoming = next;
      current = next.to;
      if (current === start) break;
      vertices.push(current);
    }
    if (current !== start || vertices.length < 3)
      throw new Error("A selected boundary could not be closed.");
    const mostCommon = (values: number[]): number => {
      const counts = new Map<number, number>();
      for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
    };
    loops.push({
      vertices,
      selectedMaterial: mostCommon(selectedMaterials),
      remainingMaterial: mostCommon(remainingMaterials),
    });
  }
  return loops;
}

interface FaceSet {
  faces: Face[];
  materials: number[];
  vertexMaterials: number[];
}

class GeometryWorkspace {
  positions: number[];
  private readonly pointMap = new Map<string, number[]>();

  constructor(
    source: Float32Array | number[],
    private readonly generatedTolerance = 0.0001,
  ) {
    this.positions = Array.from(source);
  }

  private key(point: Vec3): string {
    return point
      .map((value) => Math.floor(value / this.generatedTolerance))
      .join("|");
  }

  addPoint(point: Vec3): number {
    const stable = point.map((value) => Math.fround(value)) as Vec3;
    const cells = stable.map((value) =>
      Math.floor(value / this.generatedTolerance),
    );
    for (let x = -1; x <= 1; x += 1) {
      for (let y = -1; y <= 1; y += 1) {
        for (let z = -1; z <= 1; z += 1) {
          const candidates =
            this.pointMap.get(
              `${cells[0] + x}|${cells[1] + y}|${cells[2] + z}`,
            ) ?? [];
          for (const existing of candidates) {
            const delta = subtract3(
              vertexAt(this.positions, existing),
              stable,
            );
            if (
              dot3(delta, delta) <=
              this.generatedTolerance * this.generatedTolerance
            ) {
              return existing;
            }
          }
        }
      }
    }
    const index = this.positions.length / 3;
    this.positions.push(...stable);
    const key = this.key(stable);
    const candidates = this.pointMap.get(key) ?? [];
    candidates.push(index);
    this.pointMap.set(key, candidates);
    return index;
  }

  addUniquePoint(point: Vec3): number {
    const stable = point.map((value) => Math.fround(value)) as Vec3;
    const index = this.positions.length / 3;
    this.positions.push(...stable);
    return index;
  }
}

function addFace(
  target: FaceSet,
  face: Face,
  material: number,
  cornerMaterials: [number, number, number] = [
    material,
    material,
    material,
  ],
): void {
  target.faces.push(face);
  target.materials.push(material);
  target.vertexMaterials.push(...cornerMaterials);
}

function addFaces(
  target: FaceSet,
  faces: Face[],
  material: number,
): void {
  for (const face of faces) addFace(target, face, material);
}

function flipFaces(faces: Face[]): void {
  for (const face of faces) {
    [face[1], face[2]] = [face[2], face[1]];
  }
}

function loopFrame(
  positions: Float32Array | number[],
  loop: number[],
): {
  center: Vec3;
  normal: Vec3;
  u: Vec3;
  v: Vec3;
  flat: Array<[number, number]>;
  area: number;
} {
  const points = loop.map((index) => vertexAt(positions, index));
  const center = scale3(
    points.reduce((sum, point) => add3(sum, point), [0, 0, 0] as Vec3),
    1 / Math.max(points.length, 1),
  );
  let normal: Vec3 = [0, 0, 0];
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    normal = add3(normal, [
      (current[1] - next[1]) * (current[2] + next[2]),
      (current[2] - next[2]) * (current[0] + next[0]),
      (current[0] - next[0]) * (current[1] + next[1]),
    ]);
  }
  normal = normalize3(normal);
  const helper: Vec3 =
    Math.abs(normal[2]) < 0.85 ? [0, 0, 1] : [0, 1, 0];
  const u = normalize3(cross3(helper, normal));
  const v = normalize3(cross3(normal, u));
  const flat = points.map((point) => {
    const relative = subtract3(point, center);
    return [dot3(relative, u), dot3(relative, v)] as [number, number];
  });
  let signedArea = 0;
  for (let index = 0; index < flat.length; index += 1) {
    const current = flat[index];
    const next = flat[(index + 1) % flat.length];
    signedArea += current[0] * next[1] - next[0] * current[1];
  }
  return {
    center,
    normal,
    u,
    v,
    flat,
    area: Math.abs(signedArea) * 0.5,
  };
}

function repairDegenerateCapFaces(
  positions: Float32Array | number[],
  faces: Face[],
): void {
  let guard = 0;
  while (guard < faces.length * 2) {
    guard += 1;
    let repair:
      | {
          degenerateIndex: number;
          neighborIndex: number;
          start: number;
          end: number;
          middle: number;
        }
      | undefined;
    for (let degenerateIndex = 0; degenerateIndex < faces.length; degenerateIndex += 1) {
      const degenerate = faces[degenerateIndex];
      if (
        triangleArea(
          vertexAt(positions, degenerate[0]),
          vertexAt(positions, degenerate[1]),
          vertexAt(positions, degenerate[2]),
        ) > 1e-9
      ) {
        continue;
      }
      const edges = [
        [degenerate[0], degenerate[1]],
        [degenerate[1], degenerate[2]],
        [degenerate[2], degenerate[0]],
      ] as Array<[number, number]>;
      edges.sort((left, right) => {
        const distance = ([a, b]: [number, number]) => {
          const delta = subtract3(
            vertexAt(positions, a),
            vertexAt(positions, b),
          );
          return dot3(delta, delta);
        };
        return distance(right) - distance(left);
      });
      const [start, end] = edges[0];
      const middle = degenerate.find(
        (vertex) => vertex !== start && vertex !== end,
      );
      const neighborIndex = faces.findIndex(
        (face, index) =>
          index !== degenerateIndex &&
          face.includes(start) &&
          face.includes(end) &&
          triangleArea(
            vertexAt(positions, face[0]),
            vertexAt(positions, face[1]),
            vertexAt(positions, face[2]),
          ) > 1e-9,
      );
      if (middle != null && neighborIndex >= 0) {
        repair = {
          degenerateIndex,
          neighborIndex,
          start,
          end,
          middle,
        };
        break;
      }
    }
    if (!repair) return;
    const { degenerateIndex, neighborIndex, start, end, middle } = repair;
    const neighbor = faces[neighborIndex];
    const opposite = neighbor.find(
      (vertex) => vertex !== start && vertex !== end,
    );
    if (opposite == null) return;
    const normal = triangleNormal(
      vertexAt(positions, neighbor[0]),
      vertexAt(positions, neighbor[1]),
      vertexAt(positions, neighbor[2]),
    );
    const repaired: Face[] = [
      [start, middle, opposite],
      [middle, end, opposite],
    ];
    orientFacesToNormal(positions, repaired, normal);
    faces[degenerateIndex] = repaired[0];
    faces[neighborIndex] = repaired[1];
  }
}

function restoreCollinearBoundaryVertices(
  positions: Float32Array | number[],
  faces: Face[],
  loops: number[][],
): void {
  const hasEdge = (a: number, b: number) =>
    faces.some((face) => face.includes(a) && face.includes(b));
  for (const loop of loops) {
    for (let pass = 0; pass < 3; pass += 1) {
      let changed = false;
      for (let index = 0; index < loop.length; index += 1) {
        const previous = loop[(index - 1 + loop.length) % loop.length];
        const middle = loop[index];
        const next = loop[(index + 1) % loop.length];
        if (hasEdge(previous, middle) && hasEdge(middle, next)) continue;
        const start = vertexAt(positions, previous);
        const point = vertexAt(positions, middle);
        const end = vertexAt(positions, next);
        const line = subtract3(end, start);
        const lineLengthSquared = dot3(line, line);
        if (lineLengthSquared <= 1e-12) continue;
        const amount = Math.max(
          0,
          Math.min(1, dot3(subtract3(point, start), line) / lineLengthSquared),
        );
        const projected = add3(start, scale3(line, amount));
        if (
          Math.hypot(...subtract3(point, projected)) >
          Math.max(Math.sqrt(lineLengthSquared) * 1e-5, 0.003)
        ) {
          continue;
        }
        const faceIndex = faces.findIndex(
          (face) => face.includes(previous) && face.includes(next),
        );
        if (faceIndex < 0) continue;
        const face = faces[faceIndex];
        const opposite = face.find(
          (vertex) => vertex !== previous && vertex !== next,
        );
        if (opposite == null) continue;
        const normal = triangleNormal(
          vertexAt(positions, face[0]),
          vertexAt(positions, face[1]),
          vertexAt(positions, face[2]),
        );
        const replacement: Face[] = [
          [previous, middle, opposite],
          [middle, next, opposite],
        ];
        orientFacesToNormal(positions, replacement, normal);
        faces[faceIndex] = replacement[0];
        faces.push(replacement[1]);
        changed = true;
      }
      if (!changed) break;
    }
  }
}

function restoreCapBoundary(
  positions: Float32Array | number[],
  faces: Face[],
  loops: number[][],
): void {
  const desired = new Set<string>();
  for (const loop of loops) {
    for (let index = 0; index < loop.length; index += 1) {
      desired.add(edgeKey(loop[index], loop[(index + 1) % loop.length]));
    }
  }
  const pathLength = (path: number[]) => {
    let total = 0;
    for (let index = 1; index < path.length; index += 1) {
      total += Math.hypot(
        ...subtract3(
          vertexAt(positions, path[index]),
          vertexAt(positions, path[index - 1]),
        ),
      );
    }
    return total;
  };
  const pathDeviation = (path: number[]) => {
    const start = vertexAt(positions, path[0]);
    const end = vertexAt(positions, path.at(-1)!);
    const line = subtract3(end, start);
    const lengthSquared = dot3(line, line);
    if (lengthSquared <= 1e-12) return Infinity;
    let maximum = 0;
    for (const vertex of path.slice(1, -1)) {
      const point = vertexAt(positions, vertex);
      const amount = Math.max(
        0,
        Math.min(
          1,
          dot3(subtract3(point, start), line) / lengthSquared,
        ),
      );
      maximum = Math.max(
        maximum,
        Math.hypot(
          ...subtract3(point, add3(start, scale3(line, amount))),
        ),
      );
    }
    return maximum;
  };
  const pathBetween = (
    loop: number[],
    start: number,
    end: number,
  ): number[] => {
    const path = [start];
    let index = loop.indexOf(start);
    let guard = 0;
    while (path.at(-1) !== end && guard <= loop.length) {
      guard += 1;
      index = (index + 1) % loop.length;
      path.push(loop[index]);
    }
    return path;
  };

  for (let pass = 0; pass < 8; pass += 1) {
    const counts = new Map<string, { count: number; a: number; b: number }>();
    for (const face of faces) {
      for (let edge = 0; edge < 3; edge += 1) {
        const a = face[edge];
        const b = face[(edge + 1) % 3];
        const key = edgeKey(a, b);
        const entry = counts.get(key) ?? { count: 0, a, b };
        entry.count += 1;
        counts.set(key, entry);
      }
    }
    const replacementEdge = [...counts.entries()].find(
      ([key, entry]) => entry.count === 1 && !desired.has(key),
    );
    if (!replacementEdge) return;
    const [, { a, b }] = replacementEdge;
    const loop = loops.find(
      (candidate) => candidate.includes(a) && candidate.includes(b),
    );
    if (!loop) return;
    const forward = pathBetween(loop, a, b);
    const backward = pathBetween(loop, b, a).reverse();
    const candidates = [forward, backward]
      .map((path) => ({
        path,
        deviation: pathDeviation(path),
        length: pathLength(path),
      }))
      .sort(
        (left, right) =>
          left.deviation - right.deviation || left.length - right.length,
      );
    const path = candidates[0].path;
    const chordLength = Math.hypot(
      ...subtract3(vertexAt(positions, a), vertexAt(positions, b)),
    );
    if (
      candidates[0].deviation >
      Math.max(chordLength * 1e-5, 0.003)
    )
      return;
    if (path.length < 3) return;
    const faceIndex = faces.findIndex(
      (face) => face.includes(a) && face.includes(b),
    );
    if (faceIndex < 0) return;
    const face = faces[faceIndex];
    const opposite = face.find((vertex) => vertex !== a && vertex !== b);
    if (opposite == null) return;
    const normal = triangleNormal(
      vertexAt(positions, face[0]),
      vertexAt(positions, face[1]),
      vertexAt(positions, face[2]),
    );
    const replacements: Face[] = [];
    for (let index = 0; index < path.length - 1; index += 1) {
      replacements.push([path[index], path[index + 1], opposite]);
    }
    orientFacesToNormal(positions, replacements, normal);
    faces[faceIndex] = replacements[0];
    faces.push(...replacements.slice(1));
  }
}

function triangulateCapWithHoles(
  positions: Float32Array | number[],
  outer: number[],
  holes: number[][] = [],
): Face[] {
  const frame = loopFrame(positions, outer);
  const flat: number[] = [];
  const indices: number[] = [];
  const holeStarts: number[] = [];
  const appendLoop = (loop: number[], isHole: boolean) => {
    if (isHole) holeStarts.push(indices.length);
    for (const index of loop) {
      const relative = subtract3(vertexAt(positions, index), frame.center);
      flat.push(dot3(relative, frame.u), dot3(relative, frame.v));
      indices.push(index);
    }
  };
  appendLoop(outer, false);
  for (const hole of holes) appendLoop(hole, true);
  if (holes.length) {
    const coordinates = flat.filter(Number.isFinite);
    const span = Math.max(
      Math.max(...coordinates) - Math.min(...coordinates),
      1,
    );
    const epsilon = span * 1e-5;
    for (let index = 0; index < indices.length; index += 1) {
      flat[index * 2] += Math.sin(index * 2.399963) * epsilon;
      flat[index * 2 + 1] += Math.cos(index * 2.399963) * epsilon;
    }
  }
  const triangles = earcut(flat, holeStarts, 2);
  if (!triangles.length || triangles.length % 3) {
    throw new Error("A cut boundary could not be triangulated safely.");
  }
  const faces: Face[] = [];
  for (let index = 0; index < triangles.length; index += 3) {
    faces.push([
      indices[triangles[index]],
      indices[triangles[index + 1]],
      indices[triangles[index + 2]],
    ]);
  }
  repairDegenerateCapFaces(positions, faces);
  restoreCollinearBoundaryVertices(positions, faces, [outer, ...holes]);
  restoreCapBoundary(positions, faces, [outer, ...holes]);
  return faces;
}

function orientFacesToNormal(
  positions: Float32Array | number[],
  faces: Face[],
  desiredNormal: Vec3,
): void {
  const face = faces.find(
    (candidate) =>
      triangleArea(
        vertexAt(positions, candidate[0]),
        vertexAt(positions, candidate[1]),
        vertexAt(positions, candidate[2]),
      ) > 1e-9,
  );
  if (!face) return;
  const normal = triangleNormal(
    vertexAt(positions, face[0]),
    vertexAt(positions, face[1]),
    vertexAt(positions, face[2]),
  );
  if (dot3(normal, desiredNormal) < 0) flipFaces(faces);
}

function orientFacesAgainstBoundary(faces: Face[], boundary: number[]): void {
  const first = boundary[0];
  const second = boundary[1];
  const touching = faces.find(
    (face) => face.includes(first) && face.includes(second),
  );
  if (!touching) return;
  const direction = directedEdge(touching, first, second);
  if (direction[0] === first && direction[1] === second) flipFaces(faces);
}

function pointInPolygon(
  point: [number, number],
  polygon: Array<[number, number]>,
): boolean {
  let inside = false;
  for (
    let current = 0, previous = polygon.length - 1;
    current < polygon.length;
    previous = current++
  ) {
    const a = polygon[current];
    const b = polygon[previous];
    const intersects =
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] <
        ((b[0] - a[0]) * (point[1] - a[1])) /
          (b[1] - a[1] || Number.EPSILON) +
          a[0];
    if (intersects) inside = !inside;
  }
  return inside;
}

function polygonCentroid(
  polygon: Array<[number, number]>,
): [number, number] {
  let area = 0;
  let x = 0;
  let y = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const cross = current[0] * next[1] - next[0] * current[1];
    area += cross;
    x += (current[0] + next[0]) * cross;
    y += (current[1] + next[1]) * cross;
  }
  if (Math.abs(area) <= 1e-9) {
    const total = polygon.reduce(
      (sum, point) => [sum[0] + point[0], sum[1] + point[1]],
      [0, 0],
    );
    return [
      total[0] / Math.max(polygon.length, 1),
      total[1] / Math.max(polygon.length, 1),
    ];
  }
  return [x / (3 * area), y / (3 * area)];
}

function connectorOutline(
  method: ConnectorSettings["method"],
  center: Vec3,
  frame: ReturnType<typeof loopFrame>,
  radius: number,
): Vec3[] {
  const segments =
    method === "cylinder" ? 24 : method === "triangle" ? 3 : 4;
  const points: Vec3[] = [];
  for (let index = 0; index < segments; index += 1) {
    const angle =
      method === "rectangle"
        ? Math.PI * 0.25 + (Math.PI * 2 * index) / segments
        : -Math.PI * 0.5 + (Math.PI * 2 * index) / segments;
    const stretch = method === "rectangle" ? 1.12 : 1;
    points.push(
      add3(
        center,
        add3(
          scale3(frame.u, Math.cos(angle) * radius * stretch),
          scale3(frame.v, Math.sin(angle) * radius),
        ),
      ),
    );
  }
  return points;
}

function connectorCenters(
  frame: ReturnType<typeof loopFrame>,
  settings: ConnectorSettings,
): { centers: Vec3[]; radius: number } {
  const count = Math.max(1, Math.min(4, Math.round(settings.count)));
  const radiusByArea = Math.sqrt(
    Math.max(frame.area * (settings.areaPercent / 100) / count, 1) / Math.PI,
  );
  const xs = frame.flat.map((point) => point[0]);
  const ys = frame.flat.map((point) => point[1]);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  const minimumRadius = Math.max(Math.min(width, height) * 0.04, 0.05);
  const radius = Math.max(
    minimumRadius,
    Math.min(
      radiusByArea,
      Math.max(Math.min(width, height) * 0.16, minimumRadius),
    ),
  );
  const center2d = polygonCentroid(frame.flat);
  const spreadAxis = width >= height ? frame.u : frame.v;
  const spreadSize = width >= height ? width : height;
  const spacing = Math.min(radius * 2.8, spreadSize / Math.max(count + 1, 2));
  const centers: Vec3[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = (index - (count - 1) / 2) * spacing;
    const base = add3(
      frame.center,
      add3(
        scale3(frame.u, center2d[0]),
        scale3(frame.v, center2d[1]),
      ),
    );
    const candidate = add3(base, scale3(spreadAxis, offset));
    const relative = subtract3(candidate, frame.center);
    const flat: [number, number] = [
      dot3(relative, frame.u),
      dot3(relative, frame.v),
    ];
    if (pointInPolygon(flat, frame.flat)) centers.push(candidate);
  }
  return { centers: centers.length ? centers : [frame.center], radius };
}

function addConnectorExtrusion(
  target: FaceSet,
  workspace: GeometryWorkspace,
  capFaces: Face[],
  baseRing: number[],
  direction: Vec3,
  material: number,
  cavity: boolean,
): number {
  const tipRing = baseRing.map((index) =>
    workspace.addPoint(add3(vertexAt(workspace.positions, index), direction)),
  );
  let added = 0;
  for (let index = 0; index < baseRing.length; index += 1) {
    const a = baseRing[index];
    const b = baseRing[(index + 1) % baseRing.length];
    const capFace = capFaces.find((face) => face.includes(a) && face.includes(b));
    const capDirection = capFace ? directedEdge(capFace, a, b) : ([a, b] as [
      number,
      number,
    ]);
    const from = capDirection[1];
    const to = capDirection[0];
    const fromTip = tipRing[baseRing.indexOf(from)];
    const toTip = tipRing[baseRing.indexOf(to)];
    addFace(target, [from, to, toTip], material);
    addFace(target, [from, toTip, fromTip], material);
    added += 2;
  }
  const tipFaces = triangulateCapWithHoles(
    workspace.positions,
    tipRing,
  );
  orientFacesToNormal(
    workspace.positions,
    tipFaces,
    cavity ? scale3(direction, -1) : direction,
  );
  addFaces(target, tipFaces, material);
  return added + tipFaces.length;
}

function capLoopPair(
  workspace: GeometryWorkspace,
  selectedTarget: FaceSet,
  remainingTarget: FaceSet,
  outer: number[],
  selectedMaterial: number,
  remainingMaterial: number,
  connector?: ConnectorSettings,
  selectedNormalHint?: Vec3,
): number {
  if (!connector || connector.method === "none") {
    const selectedFaces = triangulateCapWithHoles(
      workspace.positions,
      outer,
    );
    if (selectedNormalHint) {
      orientFacesToNormal(
        workspace.positions,
        selectedFaces,
        selectedNormalHint,
      );
    } else {
      orientFacesAgainstBoundary(selectedFaces, outer);
    }
    const remainingFaces = selectedFaces.map(
      (face) => [face[0], face[2], face[1]] as Face,
    );
    addFaces(selectedTarget, selectedFaces, selectedMaterial);
    addFaces(remainingTarget, remainingFaces, remainingMaterial);
    return selectedFaces.length * 2;
  }

  const frame = loopFrame(workspace.positions, outer);
  const { centers, radius } = connectorCenters(frame, connector);
  const selectedIsPlug = connector.side === "selected";
  const selectedRings: number[][] = [];
  const remainingRings: number[][] = [];
  for (const center of centers) {
    const selectedRadius = Math.max(
      0.03,
      radius + (selectedIsPlug ? 0 : connector.tolerance),
    );
    const remainingRadius = Math.max(
      0.03,
      radius + (selectedIsPlug ? connector.tolerance : 0),
    );
    selectedRings.push(
      connectorOutline(
        connector.method,
        center,
        frame,
        selectedRadius,
      ).map((point) => workspace.addPoint(point)),
    );
    remainingRings.push(
      connectorOutline(
        connector.method,
        center,
        frame,
        remainingRadius,
      ).map((point) => workspace.addPoint(point)),
    );
  }

  const selectedCaps = triangulateCapWithHoles(
    workspace.positions,
    outer,
    selectedRings,
  );
  if (selectedNormalHint) {
    orientFacesToNormal(
      workspace.positions,
      selectedCaps,
      selectedNormalHint,
    );
  } else {
    orientFacesAgainstBoundary(selectedCaps, outer);
  }
  const selectedNormal = triangleNormal(
    vertexAt(workspace.positions, selectedCaps[0][0]),
    vertexAt(workspace.positions, selectedCaps[0][1]),
    vertexAt(workspace.positions, selectedCaps[0][2]),
  );
  const remainingCaps = triangulateCapWithHoles(
    workspace.positions,
    outer,
    remainingRings,
  );
  if (selectedNormalHint) {
    orientFacesToNormal(
      workspace.positions,
      remainingCaps,
      selectedNormalHint,
    );
  } else {
    orientFacesAgainstBoundary(remainingCaps, outer);
  }
  flipFaces(remainingCaps);
  addFaces(selectedTarget, selectedCaps, selectedMaterial);
  addFaces(remainingTarget, remainingCaps, remainingMaterial);

  const depth = Math.max(0.05, connector.depth);
  let count = selectedCaps.length + remainingCaps.length;
  selectedRings.forEach((ring) => {
    const direction = scale3(
      selectedNormal,
      selectedIsPlug ? depth : -depth,
    );
    count += addConnectorExtrusion(
      selectedTarget,
      workspace,
      selectedCaps,
      ring,
      direction,
      selectedMaterial,
      !selectedIsPlug,
    );
  });
  remainingRings.forEach((ring) => {
    const remainingNormal = scale3(selectedNormal, -1);
    const remainingIsPlug = !selectedIsPlug;
    const direction = scale3(
      remainingNormal,
      remainingIsPlug ? depth : -depth,
    );
    count += addConnectorExtrusion(
      remainingTarget,
      workspace,
      remainingCaps,
      ring,
      direction,
      remainingMaterial,
      !remainingIsPlug,
    );
  });
  return count;
}

function compactMesh(
  source: MeshData,
  faces: Face[],
  materials: number[],
  vertexMaterials: number[],
): MeshData {
  const used = new Map<number, number>();
  const positions: number[] = [];
  const indices = new Uint32Array(faces.length * 3);
  faces.forEach((face, faceIndex) => {
    face.forEach((vertex, corner) => {
      let compact = used.get(vertex);
      if (compact == null) {
        compact = used.size;
        used.set(vertex, compact);
        positions.push(...vertexAt(source.positions, vertex));
      }
      indices[faceIndex * 3 + corner] = compact;
    });
  });
  const mesh: MeshData = {
    positions: new Float32Array(positions),
    indices,
    faceMaterials: new Uint16Array(materials),
    faceVertexMaterials: new Uint16Array(vertexMaterials),
    faceParts: new Uint32Array(faces.length),
  };
  mesh.faceParts = computeConnectivity(mesh.positions, mesh.indices);
  return mesh;
}

function modelBounds(mesh: MeshData): { min: Vec3; max: Vec3; size: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < mesh.positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], mesh.positions[index + axis]);
      max[axis] = Math.max(max[axis], mesh.positions[index + axis]);
    }
  }
  return {
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

function cuttingPlane(
  model: ModelDocument,
  operation: Extract<SplitOperation, { kind: "plane" | "sketch" }>,
): { normal: Vec3; constant: number } {
  const bounds = modelBounds(model.mesh);
  const center: Vec3 = [
    (bounds.min[0] + bounds.max[0]) * 0.5,
    (bounds.min[1] + bounds.max[1]) * 0.5,
    (bounds.min[2] + bounds.max[2]) * 0.5,
  ];
  const axisIndex = { x: 0, y: 1, z: 2 } as const;
  if (operation.kind === "plane") {
    const axis = axisIndex[operation.axis];
    const angle = (operation.tilt * Math.PI) / 180;
    const normal: Vec3 =
      operation.axis === "x"
        ? normalize3([Math.cos(angle), Math.sin(angle), 0])
        : operation.axis === "y"
          ? normalize3([Math.sin(angle), Math.cos(angle), 0])
          : normalize3([Math.sin(angle), 0, Math.cos(angle)]);
    const point = [...center] as Vec3;
    point[axis] =
      bounds.min[axis] +
      Math.max(0.01, Math.min(0.99, operation.position)) * bounds.size[axis];
    return { normal, constant: dot3(point, normal) };
  }

  const view = axisIndex[operation.viewAxis];
  const padAxes = [0, 1, 2].filter((axis) => axis !== view);
  const toPoint = (value: [number, number]): Vec3 => {
    const point = [...center] as Vec3;
    point[padAxes[0]] =
      bounds.min[padAxes[0]] +
      Math.max(0, Math.min(1, value[0])) * bounds.size[padAxes[0]];
    point[padAxes[1]] =
      bounds.max[padAxes[1]] -
      Math.max(0, Math.min(1, value[1])) * bounds.size[padAxes[1]];
    return point;
  };
  const start = toPoint(operation.start);
  const end = toPoint(operation.end);
  const line = subtract3(end, start);
  if (Math.hypot(...line) <= 1e-6) {
    throw new Error("Draw a longer sketch line before cutting.");
  }
  const extrusion: Vec3 =
    view === 0 ? [1, 0, 0] : view === 1 ? [0, 1, 0] : [0, 0, 1];
  const normal = normalize3(cross3(line, extrusion));
  const point = mix3(start, end, 0.5);
  return { normal, constant: dot3(point, normal) };
}

interface ClipVertex {
  point: Vec3;
  material: number;
  sourceIndex?: number;
}

function clipPolygonToPlane(
  polygon: ClipVertex[],
  normal: Vec3,
  constant: number,
  keepPositive: boolean,
): ClipVertex[] {
  const result: ClipVertex[] = [];
  const distance = (vertex: ClipVertex) => dot3(vertex.point, normal) - constant;
  const inside = (value: number) =>
    keepPositive ? value >= -1e-7 : value <= 1e-7;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const currentDistance = distance(current);
    const nextDistance = distance(next);
    const currentInside = inside(currentDistance);
    const nextInside = inside(nextDistance);
    if (currentInside) result.push(current);
    if (currentInside !== nextInside) {
      const amount =
        currentDistance / (currentDistance - nextDistance || Number.EPSILON);
      result.push({
        point: mix3(current.point, next.point, amount),
        material: amount < 0.5 ? current.material : next.material,
      });
    }
  }
  return result;
}

function addClippedPolygon(
  target: FaceSet,
  workspace: GeometryWorkspace,
  polygon: ClipVertex[],
): void {
  if (polygon.length < 3) return;
  const retainsSourceTriangle =
    polygon.length === 3 &&
    polygon.every((vertex) => vertex.sourceIndex != null);
  const cleaned: Array<ClipVertex & { index: number }> = [];
  for (const vertex of polygon) {
    const index = vertex.sourceIndex ?? workspace.addPoint(vertex.point);
    if (cleaned.at(-1)?.index !== index) cleaned.push({ ...vertex, index });
  }
  if (cleaned.length > 1 && cleaned[0].index === cleaned.at(-1)?.index) {
    cleaned.pop();
  }
  if (cleaned.length < 3) return;
  for (let index = 1; index < cleaned.length - 1; index += 1) {
    if (
      cleaned[0].index === cleaned[index].index ||
      cleaned[0].index === cleaned[index + 1].index ||
      cleaned[index].index === cleaned[index + 1].index
    ) {
      continue;
    }
    if (
      triangleArea(
        vertexAt(workspace.positions, cleaned[0].index),
        vertexAt(workspace.positions, cleaned[index].index),
        vertexAt(workspace.positions, cleaned[index + 1].index),
      ) <= 1e-9 &&
      !retainsSourceTriangle
    ) {
      continue;
    }
    const cornerMaterials: [number, number, number] = [
      cleaned[0].material,
      cleaned[index].material,
      cleaned[index + 1].material,
    ];
    addFace(
      target,
      [cleaned[0].index, cleaned[index].index, cleaned[index + 1].index],
      mostCommonMaterial(cornerMaterials),
      cornerMaterials,
    );
  }
}

function collapseTinyCutEdges(
  positions: Float32Array | number[],
  targets: FaceSet[],
  loops: Array<{ vertices: number[] }>,
  tolerance = 0.002,
): void {
  const parent = new Map<number, number>();
  const find = (vertex: number): number => {
    const next = parent.get(vertex);
    if (next == null || next === vertex) return vertex;
    const root = find(next);
    parent.set(vertex, root);
    return root;
  };
  const merge = (left: number, right: number) => {
    const a = find(left);
    const b = find(right);
    if (a === b) return;
    parent.set(Math.max(a, b), Math.min(a, b));
  };
  for (const loop of loops) {
    for (let index = 0; index < loop.vertices.length; index += 1) {
      const a = loop.vertices[index];
      const b = loop.vertices[(index + 1) % loop.vertices.length];
      if (
        Math.hypot(
          ...subtract3(vertexAt(positions, a), vertexAt(positions, b)),
        ) <= tolerance
      ) {
        merge(a, b);
      }
    }
  }
  if (!parent.size) return;

  for (const target of targets) {
    const faces: Face[] = [];
    const materials: number[] = [];
    const vertexMaterials: number[] = [];
    target.faces.forEach((face, faceIndex) => {
      const remapped = face.map((vertex) => find(vertex)) as Face;
      if (new Set(remapped).size < 3) return;
      faces.push(remapped);
      materials.push(target.materials[faceIndex]);
      vertexMaterials.push(
        ...target.vertexMaterials.slice(faceIndex * 3, faceIndex * 3 + 3),
      );
    });
    target.faces = faces;
    target.materials = materials;
    target.vertexMaterials = vertexMaterials;
  }

  for (const loop of loops) {
    const remapped: number[] = [];
    for (const vertex of loop.vertices) {
      const stable = find(vertex);
      if (remapped.at(-1) !== stable) remapped.push(stable);
    }
    if (remapped.length > 1 && remapped[0] === remapped.at(-1)) remapped.pop();
    loop.vertices.splice(0, loop.vertices.length, ...remapped);
  }
}

function boundaryLoopsFromSegments(
  segments: Array<{ a: number; b: number; material: number }>,
): Array<{ vertices: number[]; material: number }> {
  const adjacency = new Map<
    number,
    Array<{ vertex: number; material: number }>
  >();
  const unique = new Map<string, { a: number; b: number; material: number }>();
  for (const segment of segments) {
    if (segment.a === segment.b) continue;
    unique.set(edgeKey(segment.a, segment.b), segment);
  }
  for (const segment of unique.values()) {
    const a = adjacency.get(segment.a) ?? [];
    const b = adjacency.get(segment.b) ?? [];
    a.push({ vertex: segment.b, material: segment.material });
    b.push({ vertex: segment.a, material: segment.material });
    adjacency.set(segment.a, a);
    adjacency.set(segment.b, b);
  }
  for (const [vertex, neighbors] of adjacency) {
    if (neighbors.length !== 2) {
      throw new Error(
        `The cut crosses an open or non-manifold boundary near vertex ${vertex} (${neighbors.length} connected segments).`,
      );
    }
  }
  const used = new Set<string>();
  const loops: Array<{ vertices: number[]; material: number }> = [];
  for (const segment of unique.values()) {
    const firstKey = edgeKey(segment.a, segment.b);
    if (used.has(firstKey)) continue;
    const vertices = [segment.a];
    const materials: number[] = [];
    let previous = segment.a;
    let current = segment.b;
    used.add(firstKey);
    materials.push(segment.material);
    let guard = 0;
    while (current !== vertices[0] && guard <= unique.size + 1) {
      guard += 1;
      vertices.push(current);
      const choices = adjacency.get(current) ?? [];
      const next =
        choices.find(
          (choice) =>
            choice.vertex !== previous &&
            !used.has(edgeKey(current, choice.vertex)),
        ) ??
        choices.find((choice) => choice.vertex === vertices[0]);
      if (!next) {
        throw new Error("The plane cut produced an open boundary.");
      }
      used.add(edgeKey(current, next.vertex));
      materials.push(next.material);
      previous = current;
      current = next.vertex;
    }
    if (current !== vertices[0] || vertices.length < 3) {
      throw new Error("The plane cut boundary could not be closed.");
    }
    loops.push({
      vertices,
      material: mostCommonMaterial(materials),
    });
  }
  return loops;
}

function finishSplit(
  selectedMesh: MeshData,
  remainingMesh: MeshData,
  capCount: number,
): InternalSplit {
  const selectedValidation = validateMesh(selectedMesh);
  const remainingValidation = validateMesh(remainingMesh);
  if (!selectedValidation.ok || !remainingValidation.ok) {
    const details = [
      ...selectedValidation.issues.map((issue) => `Selected piece: ${issue}`),
      ...remainingValidation.issues.map((issue) => `Remaining piece: ${issue}`),
    ];
    const error = new Error(
      "The split could not be validated as two safe printable solids.",
    );
    (error as Error & { details?: string[] }).details = details;
    throw error;
  }
  const publicResult: SplitResult = {
    id: `split-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    selected: selectedMesh,
    remaining: remainingMesh,
    selectedValidation,
    remainingValidation,
    capCount,
    selectedFaceCount: selectedMesh.indices.length / 3,
    remainingFaceCount: remainingMesh.indices.length / 3,
  };
  return {
    public: publicResult,
    selected: selectedMesh,
    remaining: remainingMesh,
  };
}

export function splitByPlane(
  model: ModelDocument,
  operation: Extract<SplitOperation, { kind: "plane" | "sketch" }>,
): InternalSplit {
  const plane = cuttingPlane(model, operation);
  const bounds = modelBounds(model.mesh);
  plane.constant += Math.max(...bounds.size, 1) * 1e-4;
  const workspace = new GeometryWorkspace(model.mesh.positions);
  const selectedTarget: FaceSet = {
    faces: [],
    materials: [],
    vertexMaterials: [],
  };
  const remainingTarget: FaceSet = {
    faces: [],
    materials: [],
    vertexMaterials: [],
  };
  const segments: Array<{ a: number; b: number; material: number }> = [];
  const totalFaces = model.mesh.indices.length / 3;
  for (let face = 0; face < totalFaces; face += 1) {
    const offset = face * 3;
    const material = model.mesh.faceMaterials[face] ?? 0;
    const polygon: ClipVertex[] = [0, 1, 2].map((corner) => ({
      point: vertexAt(model.mesh.positions, model.mesh.indices[offset + corner]),
      material:
        model.mesh.faceVertexMaterials?.[offset + corner] ?? material,
      sourceIndex: model.mesh.indices[offset + corner],
    }));
    const distances = polygon.map(
      (vertex) => dot3(vertex.point, plane.normal) - plane.constant,
    );
    const positiveCount = distances.filter((distance) => distance > 1e-7).length;
    const negativeCount = distances.filter((distance) => distance < -1e-7).length;
    if (!positiveCount && !negativeCount) {
      const normal = triangleNormal(
        polygon[0].point,
        polygon[1].point,
        polygon[2].point,
      );
      addClippedPolygon(
        dot3(normal, plane.normal) >= 0 ? selectedTarget : remainingTarget,
        workspace,
        polygon,
      );
      continue;
    }
    addClippedPolygon(
      selectedTarget,
      workspace,
      clipPolygonToPlane(polygon, plane.normal, plane.constant, true),
    );
    addClippedPolygon(
      remainingTarget,
      workspace,
      clipPolygonToPlane(polygon, plane.normal, plane.constant, false),
    );
    if (positiveCount && negativeCount) {
      const intersections: Array<{ point: Vec3; sourceIndex?: number }> = [];
      for (let edge = 0; edge < 3; edge += 1) {
        const next = (edge + 1) % 3;
        const a = distances[edge];
        const b = distances[next];
        if ((a > 1e-7 && b < -1e-7) || (a < -1e-7 && b > 1e-7)) {
          intersections.push({
            point: mix3(
              polygon[edge].point,
              polygon[next].point,
              a / (a - b),
            ),
          });
        } else if (Math.abs(a) <= 1e-7) {
          intersections.push({
            point: polygon[edge].point,
            sourceIndex: polygon[edge].sourceIndex,
          });
        }
      }
      const uniquePoints = new Map<
        string,
        { point: Vec3; sourceIndex?: number }
      >();
      for (const intersection of intersections) {
        uniquePoints.set(
          intersection.point
            .map((value) => Math.round(value * 1e6))
            .join("|"),
          intersection,
        );
      }
      const points = [...uniquePoints.values()];
      if (points.length === 2) {
        segments.push({
          a:
            points[0].sourceIndex ??
            workspace.addPoint(points[0].point),
          b:
            points[1].sourceIndex ??
            workspace.addPoint(points[1].point),
          material,
        });
      }
    }
  }
  if (!selectedTarget.faces.length || !remainingTarget.faces.length) {
    throw new Error("Move the cut so it crosses the model.");
  }
  const loops = boundaryLoopsFromSegments(segments);
  if (!loops.length) {
    throw new Error("The plane did not create a closed cut boundary.");
  }
  collapseTinyCutEdges(
    workspace.positions,
    [selectedTarget, remainingTarget],
    loops,
  );
  const connectorLoop =
    operation.connector.method !== "none"
      ? loops
          .map((loop, index) => ({
            index,
            area: loopFrame(workspace.positions, loop.vertices).area,
          }))
          .sort((a, b) => b.area - a.area)[0]?.index
      : -1;
  let capCount = 0;
  loops.forEach((loop, index) => {
    const added = capLoopPair(
      workspace,
      selectedTarget,
      remainingTarget,
      loop.vertices,
      loop.material,
      loop.material,
      index === connectorLoop ? operation.connector : undefined,
      scale3(plane.normal, -1),
    );
    capCount += Math.round(added / 2);
  });
  const source: MeshData = {
    ...model.mesh,
    positions: new Float32Array(workspace.positions),
  };
  const selectedMesh = compactMesh(
    source,
    selectedTarget.faces,
    selectedTarget.materials,
    selectedTarget.vertexMaterials,
  );
  const remainingMesh = compactMesh(
    source,
    remainingTarget.faces,
    remainingTarget.materials,
    remainingTarget.vertexMaterials,
  );
  return finishSplit(selectedMesh, remainingMesh, capCount);
}

export function splitWithOperation(
  model: ModelDocument,
  operation: SplitOperation,
): InternalSplit {
  if (operation.kind === "color") {
    return splitModel(
      model,
      operation.selection,
      operation.connector,
      operation.cutMethod,
    );
  }
  return splitByPlane(model, operation);
}

function patchConnectorShapeContains(
  method: ConnectorSettings["method"],
  x: number,
  y: number,
  radius: number,
): boolean {
  if (method === "cylinder") {
    return x * x + y * y <= radius * radius;
  }
  if (method === "rectangle") {
    return Math.abs(x) <= radius * 1.12 && Math.abs(y) <= radius * 0.82;
  }
  if (method === "triangle") {
    const vertical = (y + radius) / (radius * 1.8);
    return (
      vertical >= 0 &&
      vertical <= 1 &&
      Math.abs(x) <= radius * vertical
    );
  }
  return false;
}

function patchConnectorFaces(
  component: number[],
  faces: Face[],
  positions: Float32Array | number[],
  offsets: Map<number, number>,
  boundaryVertices: Set<number>,
  normal: Vec3,
  settings: ConnectorSettings,
  radiusAdjustment = 0,
  expandForTolerance = false,
): Set<number> {
  if (settings.method === "none") return new Set();
  const axis: Vec3 =
    Math.abs(normal[2]) < 0.88 ? [0, 0, 1] : [0, 1, 0];
  const u = normalize3(cross3(axis, normal));
  const v = normalize3(cross3(normal, u));
  const candidates = component
    .map((faceIndex) => {
      const face = faces[faceIndex];
      const points = face.map((vertex) =>
        vertexAt(positions, offsets.get(vertex)!),
      ) as [Vec3, Vec3, Vec3];
      const center = scale3(
        add3(add3(points[0], points[1]), points[2]),
        1 / 3,
      );
      return {
        faceIndex,
        face,
        center,
        area: triangleArea(points[0], points[1], points[2]),
        safe: face.every((vertex) => !boundaryVertices.has(vertex)),
      };
    })
    .filter((candidate) => candidate.area > 1e-9);
  const safe = candidates.filter((candidate) => candidate.safe);
  const usable = safe.length ? safe : candidates;
  if (!usable.length) return new Set();

  const totalArea = usable.reduce(
    (total, candidate) => total + candidate.area,
    0,
  );
  const center = usable.reduce(
    (sum, candidate) =>
      add3(sum, scale3(candidate.center, candidate.area / totalArea)),
    [0, 0, 0] as Vec3,
  );
  const projected = usable.map((candidate) => {
    const relative = subtract3(candidate.center, center);
    return {
      ...candidate,
      x: dot3(relative, u),
      y: dot3(relative, v),
    };
  });
  const xs = projected.map((candidate) => candidate.x);
  const ys = projected.map((candidate) => candidate.y);
  const width = Math.max(Math.max(...xs) - Math.min(...xs), 0.01);
  const height = Math.max(Math.max(...ys) - Math.min(...ys), 0.01);
  const count = Math.max(1, Math.min(4, Math.round(settings.count)));
  const averageFaceRadius = Math.sqrt(
    totalArea / Math.max(usable.length, 1) / Math.PI,
  );
  const requestedRadius = Math.sqrt(
    Math.max(totalArea * (settings.areaPercent / 100) / count, 1e-6) /
      Math.PI,
  );
  const radius =
    Math.max(
      averageFaceRadius * 1.5,
      Math.min(requestedRadius, Math.min(width, height) * 0.28),
    ) + radiusAdjustment;
  const spreadOnX = width >= height;
  const spread = spreadOnX ? width : height;
  const spacing = Math.min(radius * 2.8, spread / Math.max(count + 1, 2));
  const connectorCenters: Array<[number, number]> = [];
  for (let index = 0; index < count; index += 1) {
    const offset = (index - (count - 1) / 2) * spacing;
    connectorCenters.push(spreadOnX ? [offset, 0] : [0, offset]);
  }

  const selected = new Set<number>();
  for (const connectorCenter of connectorCenters) {
    const inside = projected.filter((candidate) =>
      patchConnectorShapeContains(
        settings.method,
        candidate.x - connectorCenter[0],
        candidate.y - connectorCenter[1],
        radius,
      ),
    );
    if (inside.length) {
      inside.forEach((candidate) => selected.add(candidate.faceIndex));
      continue;
    }
    const nearest = projected
      .map((candidate) => ({
        faceIndex: candidate.faceIndex,
        distance: Math.hypot(
          candidate.x - connectorCenter[0],
          candidate.y - connectorCenter[1],
        ),
      }))
      .sort((left, right) => left.distance - right.distance)[0];
    if (nearest) selected.add(nearest.faceIndex);
  }

  if (expandForTolerance && selected.size) {
    const owners = new Map<string, number[]>();
    for (const faceIndex of component) {
      const face = faces[faceIndex];
      for (let edge = 0; edge < 3; edge += 1) {
        const key = edgeKey(face[edge], face[(edge + 1) % 3]);
        const edgeOwners = owners.get(key) ?? [];
        edgeOwners.push(faceIndex);
        owners.set(key, edgeOwners);
      }
    }
    const expanded = new Set(selected);
    for (const edgeOwners of owners.values()) {
      if (!edgeOwners.some((face) => selected.has(face))) continue;
      for (const face of edgeOwners) {
        if (
          faces[face].every((vertex) => !boundaryVertices.has(vertex))
        ) {
          expanded.add(face);
        }
      }
    }
    return expanded;
  }
  return selected;
}

function addPatchInterface(
  target: FaceSet,
  workspace: GeometryWorkspace,
  component: number[],
  faces: Face[],
  offsets: Map<number, number>,
  featureFaces: Set<number>,
  featureDirection: Vec3,
  material: number,
  selectedPiece: boolean,
): number {
  const innerFace = (faceIndex: number, tip?: Map<number, number>): Face => {
    const mapped = faces[faceIndex].map((vertex) => {
      const inner = offsets.get(vertex)!;
      return tip?.get(inner) ?? inner;
    }) as Face;
    return selectedPiece
      ? [mapped[2], mapped[1], mapped[0]]
      : mapped;
  };
  if (!featureFaces.size) {
    for (const faceIndex of component) {
      addFace(target, innerFace(faceIndex), material);
    }
    return 0;
  }

  const tipByInner = new Map<number, number>();
  for (const faceIndex of featureFaces) {
    for (const vertex of faces[faceIndex]) {
      const inner = offsets.get(vertex)!;
      if (!tipByInner.has(inner)) {
        tipByInner.set(
          inner,
          workspace.addUniquePoint(
            add3(vertexAt(workspace.positions, inner), featureDirection),
          ),
        );
      }
    }
  }
  for (const faceIndex of component) {
    addFace(
      target,
      innerFace(
        faceIndex,
        featureFaces.has(faceIndex) ? tipByInner : undefined,
      ),
      material,
    );
  }

  const owners = new Map<string, number[]>();
  for (const faceIndex of component) {
    const face = faces[faceIndex];
    for (let edge = 0; edge < 3; edge += 1) {
      const key = edgeKey(face[edge], face[(edge + 1) % 3]);
      const edgeOwners = owners.get(key) ?? [];
      edgeOwners.push(faceIndex);
      owners.set(key, edgeOwners);
    }
  }
  let sidewallFaces = 0;
  for (const [key, edgeOwners] of owners) {
    const featured = edgeOwners.filter((face) => featureFaces.has(face));
    if (featured.length !== 1) continue;
    const [a, b] = key.split("|").map(Number);
    const innerA = offsets.get(a);
    const innerB = offsets.get(b);
    if (innerA == null || innerB == null) continue;
    const oriented = innerFace(featured[0]);
    const [from, to] = directedEdge(oriented, innerA, innerB);
    const fromTip = tipByInner.get(from);
    const toTip = tipByInner.get(to);
    if (fromTip == null || toTip == null) continue;
    addFace(target, [from, to, toTip], material);
    addFace(target, [from, toTip, fromTip], material);
    sidewallFaces += 2;
  }
  return sidewallFaces;
}

function splitAsPatch(
  model: ModelDocument,
  selectedFaces: Set<number>,
  connector?: ConnectorSettings,
  cutMethod: ColorCutMethod = "patch",
): InternalSplit {
  const totalFaces = model.mesh.indices.length / 3;
  if (selectedFaces.size > totalFaces / 2) {
    const complement = new Set<number>();
    for (let face = 0; face < totalFaces; face += 1) {
      if (!selectedFaces.has(face)) complement.add(face);
    }
    const inverse = splitAsPatch(
      model,
      complement,
      connector
        ? {
            ...connector,
            side:
              connector.side === "selected" ? "remaining" : "selected",
          }
        : undefined,
      cutMethod,
    );
    return {
      public: {
        ...inverse.public,
        id: `split-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        selected: inverse.public.remaining,
        remaining: inverse.public.selected,
        selectedValidation: inverse.public.remainingValidation,
        remainingValidation: inverse.public.selectedValidation,
        selectedFaceCount: inverse.public.remainingFaceCount,
        remainingFaceCount: inverse.public.selectedFaceCount,
      },
      selected: inverse.remaining,
      remaining: inverse.selected,
    };
  }
  const faces: Face[] = [];
  const edgeFaces = new Map<string, number[]>();
  for (let faceIndex = 0; faceIndex < totalFaces; faceIndex += 1) {
    const offset = faceIndex * 3;
    const face: Face = [
      model.mesh.indices[offset],
      model.mesh.indices[offset + 1],
      model.mesh.indices[offset + 2],
    ];
    faces.push(face);
    for (let edge = 0; edge < 3; edge += 1) {
      const key = edgeKey(face[edge], face[(edge + 1) % 3]);
      const owners = edgeFaces.get(key) ?? [];
      owners.push(faceIndex);
      edgeFaces.set(key, owners);
    }
  }

  const selectedNeighbors = new Map<number, number[]>();
  for (const owners of edgeFaces.values()) {
    if (
      owners.length === 2 &&
      selectedFaces.has(owners[0]) &&
      selectedFaces.has(owners[1])
    ) {
      const left = selectedNeighbors.get(owners[0]) ?? [];
      const right = selectedNeighbors.get(owners[1]) ?? [];
      left.push(owners[1]);
      right.push(owners[0]);
      selectedNeighbors.set(owners[0], left);
      selectedNeighbors.set(owners[1], right);
    }
  }

  const components: number[][] = [];
  const componentForFace = new Map<number, number>();
  for (const start of selectedFaces) {
    if (componentForFace.has(start)) continue;
    const componentIndex = components.length;
    const component: number[] = [];
    const stack = [start];
    componentForFace.set(start, componentIndex);
    while (stack.length) {
      const face = stack.pop()!;
      component.push(face);
      for (const neighbor of selectedNeighbors.get(face) ?? []) {
        if (!componentForFace.has(neighbor)) {
          componentForFace.set(neighbor, componentIndex);
          stack.push(neighbor);
        }
      }
    }
    components.push(component);
  }

  const workspace = new GeometryWorkspace(model.mesh.positions);
  const selectedTarget: FaceSet = {
    faces: [],
    materials: [],
    vertexMaterials: [],
  };
  const remainingTarget: FaceSet = {
    faces: [],
    materials: [],
    vertexMaterials: [],
  };
  for (let faceIndex = 0; faceIndex < totalFaces; faceIndex += 1) {
    const offset = faceIndex * 3;
    const material = model.mesh.faceMaterials[faceIndex] ?? 0;
    const corners: [number, number, number] = [
      model.mesh.faceVertexMaterials?.[offset] ?? material,
      model.mesh.faceVertexMaterials?.[offset + 1] ?? material,
      model.mesh.faceVertexMaterials?.[offset + 2] ?? material,
    ];
    addFace(
      selectedFaces.has(faceIndex) ? selectedTarget : remainingTarget,
      faces[faceIndex],
      material,
      corners,
    );
  }

  const bounds = modelBounds(model.mesh);
  const modelSpan = Math.max(...bounds.size, 1);
  const baseThickness = Math.max(
    0.08,
    Math.min(2.4, modelSpan * 0.014),
  );
  let thickness =
    cutMethod === "interlocking" ? baseThickness * 1.35 : baseThickness;
  if (
    connector?.method &&
    connector.method !== "none" &&
    connector.side === "remaining"
  ) {
    thickness = Math.max(
      thickness,
      Math.min(connector.depth + 0.6, modelSpan * 0.12),
    );
  }
  const orientation = meshStats(model.mesh).volume >= 0 ? 1 : -1;
  const offsetMaps: Array<Map<number, number>> = [];
  let connectorSidewallFaces = 0;

  components.forEach((component) => {
    const neighboringMaterials: number[] = [];
    const boundaryVertices = new Set<number>();
    for (const faceIndex of component) {
      const face = faces[faceIndex];
      for (let edge = 0; edge < 3; edge += 1) {
        const owners =
          edgeFaces.get(edgeKey(face[edge], face[(edge + 1) % 3])) ?? [];
        for (const owner of owners) {
          if (!selectedFaces.has(owner)) {
            neighboringMaterials.push(
              model.mesh.faceMaterials[owner] ?? 0,
            );
            boundaryVertices.add(face[edge]);
            boundaryVertices.add(face[(edge + 1) % 3]);
          }
        }
      }
    }
    const remainingInterfaceMaterial = neighboringMaterials.length
      ? mostCommonMaterial(neighboringMaterials)
      : model.mesh.faceMaterials[component[0]] ?? 0;
    const selectedInterfaceMaterial = mostCommonMaterial(
      component.map((face) => model.mesh.faceMaterials[face] ?? 0),
    );
    const normals = new Map<number, Vec3>();
    let componentNormal: Vec3 = [0, 0, 0];
    for (const faceIndex of component) {
      const face = faces[faceIndex];
      const a = vertexAt(model.mesh.positions, face[0]);
      const b = vertexAt(model.mesh.positions, face[1]);
      const c = vertexAt(model.mesh.positions, face[2]);
      const weighted = scale3(
        cross3(subtract3(b, a), subtract3(c, a)),
        orientation,
      );
      componentNormal = add3(componentNormal, weighted);
      for (const vertex of face) {
        normals.set(
          vertex,
          add3(normals.get(vertex) ?? [0, 0, 0], weighted),
        );
      }
    }
    const nearBoundary = new Set<number>();
    if (cutMethod === "interlocking") {
      for (const faceIndex of component) {
        const face = faces[faceIndex];
        if (face.some((vertex) => boundaryVertices.has(vertex))) {
          face.forEach((vertex) => nearBoundary.add(vertex));
        }
      }
    }
    const offsets = new Map<number, number>();
    for (const [vertex, normal] of normals) {
      const point = vertexAt(model.mesh.positions, vertex);
      const vertexDepth =
        cutMethod === "interlocking"
          ? boundaryVertices.has(vertex)
            ? thickness * 0.48
            : nearBoundary.has(vertex)
              ? thickness * 0.74
              : thickness
          : thickness;
      offsets.set(
        vertex,
        workspace.addUniquePoint(
          subtract3(point, scale3(normalize3(normal), vertexDepth)),
        ),
      );
    }
    offsetMaps.push(offsets);

    const averageNormal = normalize3(componentNormal);
    let selectedConnectorFaces = new Set<number>();
    let remainingConnectorFaces = new Set<number>();
    let connectorDirection: Vec3 = [0, 0, 0];
    if (connector?.method && connector.method !== "none") {
      const tolerance = Math.max(0, connector.tolerance);
      if (connector.side === "selected") {
        selectedConnectorFaces = patchConnectorFaces(
          component,
          faces,
          workspace.positions,
          offsets,
          boundaryVertices,
          averageNormal,
          connector,
        );
        remainingConnectorFaces = patchConnectorFaces(
          component,
          faces,
          workspace.positions,
          offsets,
          boundaryVertices,
          averageNormal,
          connector,
          tolerance,
          tolerance > 0,
        );
        connectorDirection = scale3(
          averageNormal,
          -Math.max(0.05, connector.depth),
        );
      } else {
        selectedConnectorFaces = patchConnectorFaces(
          component,
          faces,
          workspace.positions,
          offsets,
          boundaryVertices,
          averageNormal,
          connector,
          tolerance,
          tolerance > 0,
        );
        remainingConnectorFaces = patchConnectorFaces(
          component,
          faces,
          workspace.positions,
          offsets,
          boundaryVertices,
          averageNormal,
          connector,
        );
        connectorDirection = scale3(
          averageNormal,
          Math.max(0.05, connector.depth),
        );
      }
      if (!selectedConnectorFaces.size || !remainingConnectorFaces.size) {
        throw new Error(
          "This painted region is too small for the selected connector.",
        );
      }
    }
    connectorSidewallFaces += addPatchInterface(
      selectedTarget,
      workspace,
      component,
      faces,
      offsets,
      selectedConnectorFaces,
      connectorDirection,
      selectedInterfaceMaterial,
      true,
    );
    connectorSidewallFaces += addPatchInterface(
      remainingTarget,
      workspace,
      component,
      faces,
      offsets,
      remainingConnectorFaces,
      connectorDirection,
      remainingInterfaceMaterial,
      false,
    );
  });

  let sidewallFaces = 0;
  for (const [key, owners] of edgeFaces) {
    if (owners.length !== 2) continue;
    const [left, right] = owners;
    if (selectedFaces.has(left) === selectedFaces.has(right)) continue;
    const selectedFace = selectedFaces.has(left) ? left : right;
    const remainingFace = selectedFace === left ? right : left;
    const component = componentForFace.get(selectedFace);
    if (component == null) continue;
    const offsets = offsetMaps[component];
    const [a, b] = key.split("|").map(Number);
    const [from, to] = directedEdge(faces[selectedFace], a, b);
    const offsetFrom = offsets.get(from);
    const offsetTo = offsets.get(to);
    if (offsetFrom == null || offsetTo == null) continue;
    const selectedMaterial = model.mesh.faceMaterials[selectedFace] ?? 0;
    const remainingMaterial = model.mesh.faceMaterials[remainingFace] ?? 0;
    addFace(
      selectedTarget,
      [to, from, offsetFrom],
      selectedMaterial,
      [selectedMaterial, selectedMaterial, selectedMaterial],
    );
    addFace(
      selectedTarget,
      [to, offsetFrom, offsetTo],
      selectedMaterial,
      [selectedMaterial, selectedMaterial, selectedMaterial],
    );
    addFace(
      remainingTarget,
      [from, to, offsetTo],
      remainingMaterial,
      [remainingMaterial, remainingMaterial, remainingMaterial],
    );
    addFace(
      remainingTarget,
      [from, offsetTo, offsetFrom],
      remainingMaterial,
      [remainingMaterial, remainingMaterial, remainingMaterial],
    );
    sidewallFaces += 2;
  }

  const sourceWithGeneratedPositions: MeshData = {
    ...model.mesh,
    positions: new Float32Array(workspace.positions),
  };
  return finishSplit(
    compactMesh(
      sourceWithGeneratedPositions,
      selectedTarget.faces,
      selectedTarget.materials,
      selectedTarget.vertexMaterials,
    ),
    compactMesh(
      sourceWithGeneratedPositions,
      remainingTarget.faces,
      remainingTarget.materials,
      remainingTarget.vertexMaterials,
    ),
    components.reduce((total, component) => total + component.length, 0) +
      sidewallFaces +
      connectorSidewallFaces,
  );
}

export function splitModel(
  model: ModelDocument,
  selection: SelectionState,
  connector?: ConnectorSettings,
  colorCutMethod: ColorCutMethod = "patch",
): InternalSplit {
  const selectedFaces = selectedFacesFor(model, selection);
  const totalFaces = model.mesh.indices.length / 3;
  if (!selectedFaces.size)
    throw new Error("Select at least one color or part before splitting.");
  if (selectedFaces.size === totalFaces)
    throw new Error("Keep at least one face in the remaining piece.");

  const loops = boundaryLoops(model.mesh, selectedFaces);
  if (selection.mode === "color" && loops.length) {
    return splitAsPatch(
      model,
      selectedFaces,
      connector,
      colorCutMethod,
    );
  }
  const workspace = new GeometryWorkspace(model.mesh.positions);
  const selectedTarget: FaceSet = {
    faces: [],
    materials: [],
    vertexMaterials: [],
  };
  const remainingTarget: FaceSet = {
    faces: [],
    materials: [],
    vertexMaterials: [],
  };
  for (let faceIndex = 0; faceIndex < totalFaces; faceIndex += 1) {
    const offset = faceIndex * 3;
    const face: Face = [
      model.mesh.indices[offset],
      model.mesh.indices[offset + 1],
      model.mesh.indices[offset + 2],
    ];
    const material = model.mesh.faceMaterials[faceIndex];
    const cornerMaterials: [number, number, number] = [
      model.mesh.faceVertexMaterials?.[offset] ?? material,
      model.mesh.faceVertexMaterials?.[offset + 1] ?? material,
      model.mesh.faceVertexMaterials?.[offset + 2] ?? material,
    ];
    if (selectedFaces.has(faceIndex)) {
      addFace(selectedTarget, face, material, cornerMaterials);
    } else {
      addFace(remainingTarget, face, material, cornerMaterials);
    }
  }

  let capCount = 0;
  const connectorLoop =
    connector?.method && connector.method !== "none"
      ? loops
          .map((loop, index) => ({
            index,
            area: loopFrame(model.mesh.positions, loop.vertices).area,
          }))
          .sort((a, b) => b.area - a.area)[0]?.index
      : -1;
  loops.forEach((loop, index) => {
    const added = capLoopPair(
      workspace,
      selectedTarget,
      remainingTarget,
      loop.vertices,
      loop.selectedMaterial,
      loop.remainingMaterial,
      index === connectorLoop ? connector : undefined,
    );
    capCount += Math.round(added / 2);
  });
  const sourceWithGeneratedPositions: MeshData = {
    ...model.mesh,
    positions: new Float32Array(workspace.positions),
  };
  const selectedMesh = compactMesh(
    sourceWithGeneratedPositions,
    selectedTarget.faces,
    selectedTarget.materials,
    selectedTarget.vertexMaterials,
  );
  const remainingMesh = compactMesh(
    sourceWithGeneratedPositions,
    remainingTarget.faces,
    remainingTarget.materials,
    remainingTarget.vertexMaterials,
  );
  try {
    return finishSplit(selectedMesh, remainingMesh, capCount);
  } catch (error) {
    if (selection.mode === "color") {
      return splitAsPatch(
        model,
        selectedFaces,
        connector,
        colorCutMethod,
      );
    }
    throw error;
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function meshXml(
  mesh: MeshData,
  objectId: number,
  name: string,
  unitScale: number,
): string {
  const vertices: string[] = [];
  for (let index = 0; index < mesh.positions.length; index += 3) {
    vertices.push(
      `<vertex x="${mesh.positions[index] / unitScale}" y="${mesh.positions[index + 1] / unitScale}" z="${mesh.positions[index + 2] / unitScale}"/>`,
    );
  }
  const triangles: string[] = [];
  for (let face = 0; face < mesh.indices.length / 3; face += 1) {
    const offset = face * 3;
    const material = mesh.faceMaterials[face];
    const p1 = mesh.faceVertexMaterials?.[offset] ?? material;
    const p2 = mesh.faceVertexMaterials?.[offset + 1] ?? material;
    const p3 = mesh.faceVertexMaterials?.[offset + 2] ?? material;
    const properties =
      p1 === p2 && p2 === p3
        ? `p1="${p1}"`
        : `p1="${p1}" p2="${p2}" p3="${p3}"`;
    triangles.push(
      `<triangle v1="${mesh.indices[offset]}" v2="${mesh.indices[offset + 1]}" v3="${mesh.indices[offset + 2]}" pid="5" ${properties}/>`,
    );
  }
  return `<object id="${objectId}" type="model" name="${xmlEscape(name)}"><mesh><vertices>${vertices.join("")}</vertices><triangles>${triangles.join("")}</triangles></mesh></object>`;
}

export function export3mf(
  model: ModelDocument,
  split: InternalSplit,
  sourcePackage?: Uint8Array,
): Uint8Array {
  const materials = [...model.materials];
  if (!materials.length) {
    materials.push({
      id: 0,
      name: "Default material",
      color: DEFAULT_COLOR,
      area: 0,
      faceCount: 0,
    });
  }
  const baseMaterials = materials
    .map(
      (material) =>
        `<base name="${xmlEscape(material.name)}" displaycolor="${normalizeHex(material.color)}FF"/>`,
    )
    .join("");
  const unit = UNIT_TO_MM[model.unit] ? model.unit : "millimeter";
  const scale = UNIT_TO_MM[unit] ?? 1;
  const modelXml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<model unit="${unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<metadata name="Title">${xmlEscape(model.name)} split</metadata>` +
    `<metadata name="Application">ModelCut Studio</metadata>` +
    `<resources><basematerials id="5">${baseMaterials}</basematerials>` +
    meshXml(split.selected, 1, `${model.name} selected`, scale) +
    meshXml(split.remaining, 2, `${model.name} remaining`, scale) +
    `</resources><build><item objectid="1"/><item objectid="2"/></build></model>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>` +
    `</Types>`;
  const relationships =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>` +
    `</Relationships>`;
  let preservedEntries: Record<string, Uint8Array> = {};
  if (sourcePackage) {
    try {
      preservedEntries = unzipSync(sourcePackage);
    } catch {
      preservedEntries = {};
    }
  }
  return zipSync(
    {
      ...preservedEntries,
      "[Content_Types].xml":
        preservedEntries["[Content_Types].xml"] ?? strToU8(contentTypes),
      "_rels/.rels": strToU8(relationships),
      "3D/3dmodel.model": strToU8(modelXml),
    },
    { level: 6 },
  );
}

function binaryStl(mesh: MeshData, label: string): Uint8Array {
  const faceCount = mesh.indices.length / 3;
  const bytes = new Uint8Array(84 + faceCount * 50);
  const header = strToU8(`ModelCut Studio — ${label}`.slice(0, 80));
  bytes.set(header, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, faceCount, true);
  let offset = 84;
  for (let face = 0; face < faceCount; face += 1) {
    const index = face * 3;
    const a = vertexAt(mesh.positions, mesh.indices[index]);
    const b = vertexAt(mesh.positions, mesh.indices[index + 1]);
    const c = vertexAt(mesh.positions, mesh.indices[index + 2]);
    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const normal: Vec3 = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const length = Math.hypot(...normal) || 1;
    normal.forEach((value, component) =>
      view.setFloat32(offset + component * 4, value / length, true),
    );
    offset += 12;
    for (const vertex of [a, b, c]) {
      for (let component = 0; component < 3; component += 1) {
        view.setFloat32(offset, vertex[component], true);
        offset += 4;
      }
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  return bytes;
}

function safeBaseName(name: string): string {
  return (
    name
      .replace(/\.(3mf|stl)$/i, "")
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "model"
  );
}

export function exportStlZip(
  model: ModelDocument,
  split: InternalSplit,
): Uint8Array {
  const base = safeBaseName(model.name);
  return zipSync(
    {
      [`${base}-selected.stl`]: binaryStl(
        split.selected,
        `${base} selected`,
      ),
      [`${base}-remaining.stl`]: binaryStl(
        split.remaining,
        `${base} remaining`,
      ),
    },
    { level: 0 },
  );
}

export interface ExportPiece {
  id: string;
  name: string;
  mesh: MeshData;
  position: PieceTransform;
}

function translatedMesh(
  mesh: MeshData,
  position: PieceTransform,
  includeTransform: boolean,
): MeshData {
  if (!includeTransform) return mesh;
  const positions = mesh.positions.slice();
  for (let index = 0; index < positions.length; index += 3) {
    positions[index] += position.x;
    positions[index + 1] += position.y;
    positions[index + 2] += position.z;
  }
  return { ...mesh, positions };
}

export function exportPieceStl(
  piece: ExportPiece,
  includeTransform = false,
): Uint8Array {
  return binaryStl(
    translatedMesh(piece.mesh, piece.position, includeTransform),
    piece.name,
  );
}

export function exportPiecesStlZip(
  pieces: ExportPiece[],
  includeTransforms = false,
): Uint8Array {
  if (!pieces.length) throw new Error("There are no pieces to export.");
  const entries: Record<string, Uint8Array> = {};
  pieces.forEach((piece, index) => {
    const name = safeBaseName(piece.name);
    const id = safeBaseName(piece.id);
    entries[`${String(index + 1).padStart(2, "0")}-${name}-${id}.stl`] =
      exportPieceStl(piece, includeTransforms);
  });
  return zipSync(entries, { level: 0 });
}

export function exportPieces3mf(
  source: ModelDocument,
  pieces: ExportPiece[],
  includeTransforms = false,
  sourcePackage?: Uint8Array,
): Uint8Array {
  if (!pieces.length) throw new Error("There are no pieces to export.");
  const materials = [...source.materials];
  if (!materials.length) {
    materials.push({
      id: 0,
      name: "Default material",
      color: DEFAULT_COLOR,
      area: 0,
      faceCount: 0,
    });
  }
  const baseMaterials = materials
    .map(
      (material) =>
        `<base name="${xmlEscape(material.name)}" displaycolor="${normalizeHex(material.color)}FF"/>`,
    )
    .join("");
  const unit = UNIT_TO_MM[source.unit] ? source.unit : "millimeter";
  const scale = UNIT_TO_MM[unit] ?? 1;
  const objects = pieces
    .map((piece, index) => meshXml(piece.mesh, index + 1, piece.name, scale))
    .join("");
  const buildItems = pieces
    .map((piece, index) => {
      const transform = includeTransforms
        ? ` transform="1 0 0 0 1 0 0 0 1 ${piece.position.x / scale} ${piece.position.y / scale} ${piece.position.z / scale}"`
        : "";
      return `<item objectid="${index + 1}"${transform}/>`;
    })
    .join("");
  const modelXml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<model unit="${unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<metadata name="Title">${xmlEscape(source.name)} cut pieces</metadata>` +
    `<metadata name="Application">ModelCut Studio</metadata>` +
    `<resources><basematerials id="5">${baseMaterials}</basematerials>${objects}</resources>` +
    `<build>${buildItems}</build></model>`;
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>` +
    `</Types>`;
  const relationships =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>` +
    `</Relationships>`;
  let preservedEntries: Record<string, Uint8Array> = {};
  if (sourcePackage) {
    try {
      preservedEntries = unzipSync(sourcePackage);
    } catch {
      preservedEntries = {};
    }
  }
  return zipSync(
    {
      ...preservedEntries,
      "[Content_Types].xml":
        preservedEntries["[Content_Types].xml"] ?? strToU8(contentTypes),
      "_rels/.rels": strToU8(relationships),
      "3D/3dmodel.model": strToU8(modelXml),
    },
    { level: 6 },
  );
}

export function downloadBaseName(name: string): string {
  return safeBaseName(name);
}

export type { InternalSplit };
