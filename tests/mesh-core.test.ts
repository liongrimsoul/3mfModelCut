import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  createDemoModel,
  exportPieceStl,
  exportPieces3mf,
  exportPiecesStlZip,
  export3mf,
  exportStlZip,
  parse3mf,
  parseStl,
  splitByPlane,
  splitModel,
  validateMesh,
} from "../lib/mesh-core";
import type { MeshData, ModelDocument } from "../lib/model-types";

function tetrahedronStl(): Uint8Array {
  const vertices = [
    [[0, 0, 0], [0, 1, 0], [1, 0, 0]],
    [[0, 0, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  ];
  const facets = vertices
    .map(
      (triangle) =>
        `facet normal 0 0 0\nouter loop\n${triangle
          .map((point) => `vertex ${point.join(" ")}`)
          .join("\n")}\nendloop\nendfacet`,
    )
    .join("\n");
  return new TextEncoder().encode(`solid tetra\n${facets}\nendsolid tetra`);
}

function component3mf(): Uint8Array {
  const model = `<?xml version="1.0" encoding="UTF-8"?>
  <model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
    <resources>
      <basematerials id="5"><base name="Teal" displaycolor="#087F79FF"/></basematerials>
      <object id="1" type="model" pid="5" pindex="0">
        <mesh>
          <vertices>
            <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/>
            <vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/>
          </vertices>
          <triangles>
            <triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>
            <triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/>
          </triangles>
        </mesh>
      </object>
      <object id="2" type="model">
        <components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 10 20 30"/></components>
      </object>
    </resources>
    <build><item objectid="2"/></build>
  </model>`;
  return zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "_rels/.rels": strToU8("<Relationships/>"),
    "3D/3dmodel.model": strToU8(model),
  });
}

function disconnectedColor3mf(): Uint8Array {
  const model = `<?xml version="1.0" encoding="UTF-8"?>
  <model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
    <resources>
      <basematerials id="5"><base name="Black" displaycolor="#000000FF"/></basematerials>
      <object id="1" type="model" pid="5" pindex="0">
        <mesh>
          <vertices>
            <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/>
            <vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/>
          </vertices>
          <triangles>
            <triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>
            <triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/>
          </triangles>
        </mesh>
      </object>
    </resources>
    <build>
      <item objectid="1"/>
      <item objectid="1" transform="1 0 0 0 1 0 0 0 1 4 0 0"/>
    </build>
  </model>`;
  return zipSync({ "3D/3dmodel.model": strToU8(model) });
}

function paintedTetra3mf(): Uint8Array {
  const model = `<?xml version="1.0" encoding="UTF-8"?>
  <model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
    <resources>
      <basematerials id="5">
        <base name="White" displaycolor="#FFFFFFFF"/>
        <base name="Black" displaycolor="#000000FF"/>
      </basematerials>
      <object id="1" type="model" pid="5" pindex="0">
        <mesh>
          <vertices>
            <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/>
            <vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/>
          </vertices>
          <triangles>
            <triangle v1="0" v2="2" v3="1" p1="1"/>
            <triangle v1="0" v2="1" v3="3"/>
            <triangle v1="0" v2="3" v3="2"/>
            <triangle v1="1" v2="2" v3="3"/>
          </triangles>
        </mesh>
      </object>
    </resources>
    <build><item objectid="1"/></build>
  </model>`;
  return zipSync({ "3D/3dmodel.model": strToU8(model) });
}

function cyclic3mf(): Uint8Array {
  const model = `<?xml version="1.0" encoding="UTF-8"?>
  <model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
    <resources>
      <object id="1" type="model"><components><component objectid="2"/></components></object>
      <object id="2" type="model"><components><component objectid="1"/></components></object>
    </resources>
    <build><item objectid="1"/></build>
  </model>`;
  return zipSync({ "3D/3dmodel.model": strToU8(model) });
}

function vertexColor3mf(): Uint8Array {
  const model = `<?xml version="1.0" encoding="UTF-8"?>
  <model unit="millimeter"
    xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
    xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
    <resources>
      <m:colorgroup id="5">
        <m:color color="#FFCF3FFF"/>
        <m:color color="#151515FF"/>
        <m:color color="#FFFFFFFF"/>
      </m:colorgroup>
      <object id="1" type="model">
        <mesh>
          <vertices>
            <vertex x="0" y="0" z="0"/>
            <vertex x="1" y="0" z="0"/>
            <vertex x="0" y="1" z="0"/>
          </vertices>
          <triangles>
            <triangle v1="0" v2="1" v3="2" pid="5" p1="0" p2="1" p3="2"/>
          </triangles>
        </mesh>
      </object>
    </resources>
    <build><item objectid="1"/></build>
  </model>`;
  return zipSync({ "3D/3dmodel.model": strToU8(model) });
}

function slicerPaint3mf(): Uint8Array {
  const rootModel = `<?xml version="1.0" encoding="UTF-8"?>
  <model unit="millimeter"
    xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
    xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
    <resources>
      <object id="2" type="model">
        <components><component objectid="1" p:path="/3D/Objects/object_1.model"/></components>
      </object>
    </resources>
    <build><item objectid="2"/></build>
  </model>`;
  const objectModel = `<?xml version="1.0" encoding="UTF-8"?>
  <model unit="millimeter"
    xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
    <resources>
      <object id="1" type="model">
        <mesh>
          <vertices>
            <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/>
            <vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/>
          </vertices>
          <triangles>
            <triangle v1="0" v2="2" v3="1" paint_color="8"/>
            <triangle v1="0" v2="1" v3="3" paint_color="0C"/>
            <triangle v1="0" v2="3" v3="2" paint_color="1C"/>
            <triangle v1="1" v2="2" v3="3"/>
          </triangles>
        </mesh>
      </object>
    </resources>
  </model>`;
  const relationships = `<?xml version="1.0" encoding="UTF-8"?>
  <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Target="/3D/3dmodel.model"
      Id="rel0"
      Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
  </Relationships>`;
  const modelSettings = `<config><object id="1"><part id="1">
    <metadata key="extruder" value="1"/>
  </part></object></config>`;
  return zipSync({
    "_rels/.rels": strToU8(relationships),
    "3D/3dmodel.model": strToU8(rootModel),
    "3D/Objects/object_1.model": strToU8(objectModel),
    "Metadata/project_settings.config": strToU8(
      JSON.stringify({
        filament_colour: ["#43DEFA", "#FFCF3F", "#FFFFFF", "#151515"],
        filament_type: ["PLA", "PLA", "PLA", "PLA"],
      }),
    ),
    "Metadata/model_settings.config": strToU8(modelSettings),
  });
}

function dividedPrism(): ModelDocument {
  const points: Array<[number, number, number]> = [];
  const pointMap = new Map<string, number>();
  const point = (x: number, y: number, z: number): number => {
    const key = `${x}|${y}|${z}`;
    const found = pointMap.get(key);
    if (found != null) return found;
    const id = points.length;
    points.push([x, y, z]);
    pointMap.set(key, id);
    return id;
  };
  const faces: number[] = [];
  const materials: number[] = [];
  const quad = (
    corners: Array<[number, number, number]>,
    material: number,
  ) => {
    const ids = corners.map(([x, y, z]) => point(x, y, z));
    faces.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
    materials.push(material, material);
  };
  for (const [x0, x1, material] of [
    [0, 1, 0],
    [1, 2, 1],
  ] as const) {
    quad([[x0, 0, 0], [x0, 1, 0], [x1, 1, 0], [x1, 0, 0]], material);
    quad([[x0, 0, 1], [x1, 0, 1], [x1, 1, 1], [x0, 1, 1]], material);
    quad([[x0, 0, 0], [x1, 0, 0], [x1, 0, 1], [x0, 0, 1]], material);
    quad([[x0, 1, 0], [x0, 1, 1], [x1, 1, 1], [x1, 1, 0]], material);
  }
  quad([[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], 0);
  quad([[2, 0, 0], [2, 1, 0], [2, 1, 1], [2, 0, 1]], 1);
  const mesh: MeshData = {
    positions: new Float32Array(points.flat()),
    indices: new Uint32Array(faces),
    faceMaterials: new Uint16Array(materials),
    faceParts: new Uint32Array(materials.length),
  };
  return {
    id: "divided-prism",
    name: "divided-prism",
    unit: "millimeter",
    unitScaleToMillimeter: 1,
    mesh,
    materials: [
      { id: 0, name: "Left", color: "#F04E23", faceCount: 10, area: 5 },
      { id: 1, name: "Right", color: "#087F79", faceCount: 10, area: 5 },
    ],
    colorRegions: [
      {
        id: 0,
        materialId: 0,
        name: "Left",
        color: "#F04E23",
        faceCount: 10,
        area: 5,
      },
      {
        id: 1,
        materialId: 1,
        name: "Right",
        color: "#087F79",
        faceCount: 10,
        area: 5,
      },
    ],
    parts: [{ id: 0, name: "Part 01", color: "#F04E23", faceCount: 20, area: 10 }],
    stats: {
      vertexCount: points.length,
      faceCount: materials.length,
      partCount: 1,
      materialCount: 2,
      surfaceArea: 10,
      openEdges: 0,
      nonManifoldEdges: 0,
    },
    warnings: [],
  };
}

test("parses ASCII STL and validates a closed solid", () => {
  const model = parseStl(tetrahedronStl(), "tetra.stl");
  assert.equal(model.stats.faceCount, 4);
  assert.equal(model.unit, "millimeter");
  assert.equal(validateMesh(model.mesh).ok, true);
});

test("reads 3MF components, transforms, materials, and colors", () => {
  const model = parse3mf(component3mf(), "component.3mf");
  assert.equal(model.stats.faceCount, 4);
  assert.equal(model.materials[0].color, "#087F79");
  assert.equal(Math.min(...model.mesh.positions.filter((_, index) => index % 3 === 0)), 10);
  assert.equal(Math.min(...model.mesh.positions.filter((_, index) => index % 3 === 1)), 20);
  assert.equal(Math.min(...model.mesh.positions.filter((_, index) => index % 3 === 2)), 30);
});

test("treats disconnected surfaces with the same material as separate painted regions", () => {
  const model = parse3mf(disconnectedColor3mf(), "two-black-parts.3mf");
  assert.equal(model.colorRegions.length, 2);
  assert.deepEqual(
    model.colorRegions.map((region) => region.faceCount),
    [4, 4],
  );
  assert.deepEqual([...model.mesh.faceColorRegions!], [0, 0, 0, 0, 1, 1, 1, 1]);

  const split = splitModel(model, { mode: "color", ids: [0] });
  assert.equal(split.public.selectedFaceCount, 4);
  assert.equal(split.public.remainingFaceCount, 4);
  assert.equal(split.public.selectedValidation.ok, true);
  assert.equal(split.public.remainingValidation.ok, true);
});

test("repaints a removed curved patch interface from the surrounding body", () => {
  const model = parse3mf(paintedTetra3mf(), "painted-tetra.3mf");
  const blackRegion = model.colorRegions.find(
    (region) => region.materialId === 1,
  );
  assert.ok(blackRegion);
  const split = splitModel(model, {
    mode: "color",
    ids: [blackRegion.id],
  });
  assert.equal(split.public.selectedValidation.ok, true);
  assert.equal(split.public.remainingValidation.ok, true);
  assert.equal(
    [...split.public.remaining.faceMaterials].filter(
      (material) => material === 1,
    ).length,
    0,
  );
});

test("preserves standard 3MF colors assigned to individual triangle corners", () => {
  const model = parse3mf(vertexColor3mf(), "vertex-colors.3mf");
  assert.deepEqual(
    model.materials.map((material) => material.color),
    ["#FFCF3F", "#151515", "#FFFFFF"],
  );
  assert.deepEqual([...(model.mesh.faceVertexMaterials ?? [])], [0, 1, 2]);
});

test("reads production-extension parts and slicer painted-face colors", () => {
  const model = parse3mf(slicerPaint3mf(), "painted.3mf");
  assert.equal(model.stats.faceCount, 4);
  assert.deepEqual(
    model.materials.map((material) => material.color),
    ["#43DEFA", "#FFCF3F", "#FFFFFF", "#151515"],
  );
  assert.deepEqual([...model.mesh.faceMaterials], [1, 2, 3, 0]);
  assert.deepEqual(
    [...(model.mesh.faceVertexMaterials ?? [])],
    [1, 1, 1, 2, 2, 2, 3, 3, 3, 0, 0, 0],
  );
});

test("rejects malformed and cyclic 3MF packages", () => {
  assert.throws(() => parse3mf(strToU8("not a zip"), "broken.3mf"), /could not be opened/);
  assert.throws(() => parse3mf(cyclic3mf(), "cycle.3mf"), /cyclic component/);
});

test("splits a connected colored solid and creates matching caps", () => {
  const model = dividedPrism();
  const split = splitModel(model, { mode: "color", ids: [0] });
  assert.ok(split.public.capCount >= 18);
  assert.equal(split.public.selectedValidation.ok, true);
  assert.equal(split.public.remainingValidation.ok, true);
  assert.ok(Math.abs(split.public.selectedValidation.volume) > 0.01);
  assert.ok(Math.abs(split.public.remainingValidation.volume) > 0.9);
});

test("cuts with planes and sketched lines while keeping both solids closed", () => {
  const model = createDemoModel();
  const connector = {
    method: "none" as const,
    side: "selected" as const,
    count: 1,
    areaPercent: 8,
    depth: 4,
    tolerance: 0.2,
  };
  const plane = splitByPlane(model, {
    kind: "plane",
    axis: "x",
    position: 0.5,
    tilt: 8,
    connector,
  });
  assert.equal(plane.public.selectedValidation.ok, true);
  assert.equal(plane.public.remainingValidation.ok, true);

  const sketch = splitByPlane(model, {
    kind: "sketch",
    viewAxis: "z",
    start: [0.16, 0.45],
    end: [0.84, 0.56],
    connector,
  });
  assert.equal(sketch.public.selectedValidation.ok, true);
  assert.equal(sketch.public.remainingValidation.ok, true);
});

test("generates validated plug and socket connectors automatically", () => {
  const model = dividedPrism();
  for (const method of ["triangle", "cylinder", "rectangle"] as const) {
    const split = splitModel(
      model,
      { mode: "color", ids: [0] },
      {
        method,
        side: "selected",
        count: 1,
        areaPercent: 6,
        depth: 0.25,
        tolerance: 0.04,
      },
    );
    assert.equal(split.public.selectedValidation.ok, true);
    assert.equal(split.public.remainingValidation.ok, true);
    assert.ok(split.public.capCount > 2);
  }
});

test("builds a distinct watertight interlocking color interface", () => {
  const model = dividedPrism();
  const patch = splitModel(
    model,
    { mode: "color", ids: [0] },
    undefined,
    "patch",
  );
  const interlocking = splitModel(
    model,
    { mode: "color", ids: [0] },
    undefined,
    "interlocking",
  );
  assert.equal(interlocking.public.selectedValidation.ok, true);
  assert.equal(interlocking.public.remainingValidation.ok, true);
  assert.notDeepEqual(
    [...interlocking.public.selected.positions],
    [...patch.public.selected.positions],
  );
});

test("exports two STL files and a re-importable colored 3MF", () => {
  const model = createDemoModel();
  const split = splitModel(model, { mode: "part", ids: [0] });
  const stlArchive = unzipSync(exportStlZip(model, split));
  const names = Object.keys(stlArchive).sort();
  assert.deepEqual(names, [
    "ModelCut-demo-remaining.stl",
    "ModelCut-demo-selected.stl",
  ]);
  assert.equal(parseStl(stlArchive[names[0]], names[0]).stats.openEdges, 0);
  assert.equal(parseStl(stlArchive[names[1]], names[1]).stats.openEdges, 0);

  const roundTrip = parse3mf(export3mf(model, split), "roundtrip.3mf");
  assert.equal(roundTrip.stats.partCount, 3);
  assert.equal(roundTrip.stats.faceCount, model.stats.faceCount);
  assert.equal(roundTrip.materials[0].color, "#F04E23");
});

test("exports final pieces separately or together with opt-in work transforms", () => {
  const model = createDemoModel();
  const split = splitByPlane(model, {
    kind: "plane",
    axis: "x",
    position: 0.5,
    tilt: 0,
    connector: {
      method: "none",
      side: "selected",
      count: 1,
      areaPercent: 8,
      depth: 4,
      tolerance: 0.2,
    },
  });
  const pieces = [
    {
      id: "left",
      name: "left piece",
      mesh: split.selected,
      position: { x: 100, y: 0, z: 0 },
    },
    {
      id: "right",
      name: "right piece",
      mesh: split.remaining,
      position: { x: 0, y: 0, z: 0 },
    },
  ];

  const individual = parseStl(exportPieceStl(pieces[0]), "left.stl");
  const originalMinimum = Math.min(
    ...Array.from(pieces[0].mesh.positions).filter((_, index) => index % 3 === 0),
  );
  const exportedMinimum = Math.min(
    ...Array.from(individual.mesh.positions).filter((_, index) => index % 3 === 0),
  );
  assert.equal(exportedMinimum, originalMinimum);
  const movedIndividual = parseStl(
    exportPieceStl(pieces[0], true),
    "left-moved.stl",
  );
  assert.ok(
    Math.abs(
      Math.min(
        ...Array.from(movedIndividual.mesh.positions).filter((_, index) => index % 3 === 0),
      ) -
        (originalMinimum + 100),
    ) < 1e-4,
  );

  const archive = unzipSync(exportPiecesStlZip(pieces));
  assert.equal(Object.keys(archive).length, 2);
  assert.equal(parseStl(archive["01-left-piece-left.stl"], "left.stl").stats.openEdges, 0);
  assert.equal(parseStl(archive["02-right-piece-right.stl"], "right.stl").stats.openEdges, 0);

  const packageBytes = exportPieces3mf(model, pieces);
  const modelXml = strFromU8(unzipSync(packageBytes)["3D/3dmodel.model"]);
  assert.equal((modelXml.match(/<item objectid=/g) ?? []).length, 2);
  const reparsed = parse3mf(packageBytes, "pieces.3mf");
  assert.equal(
    reparsed.stats.faceCount,
    split.public.selectedFaceCount + split.public.remainingFaceCount,
  );
  assert.equal(reparsed.stats.openEdges, 0);

  const movedPackage = exportPieces3mf(model, pieces, true);
  const movedReparsed = parse3mf(movedPackage, "moved-pieces.3mf");
  assert.ok(
    Math.max(...Array.from(movedReparsed.mesh.positions).filter((_, index) => index % 3 === 0)) >
      Math.max(...Array.from(reparsed.mesh.positions).filter((_, index) => index % 3 === 0)),
  );
});

test("keeps source slicer settings alongside color-preserving 3MF geometry", () => {
  const model = createDemoModel();
  const split = splitModel(model, { mode: "part", ids: [0] });
  const projectSettings = strToU8('{"filament_colour":["#FFCF3F"]}');
  const sourcePackage = zipSync({
    "3D/3dmodel.model": strToU8("<model/>"),
    "Metadata/project_settings.config": projectSettings,
  });
  const archive = unzipSync(export3mf(model, split, sourcePackage));
  assert.deepEqual(
    archive["Metadata/project_settings.config"],
    projectSettings,
  );
  const roundTrip = parse3mf(
    zipSync({
      "[Content_Types].xml": archive["[Content_Types].xml"],
      "_rels/.rels": archive["_rels/.rels"],
      "3D/3dmodel.model": archive["3D/3dmodel.model"],
    }),
    "preserved.3mf",
  );
  assert.equal(roundTrip.materials[0].color, "#F04E23");
});

test("blocks a zero-volume selection and keeps the source unchanged", () => {
  const source = dividedPrism();
  const original = source.mesh.indices.slice();
  assert.throws(
    () => splitModel(source, { mode: "color", ids: [0, 1] }),
    /Keep at least one face/,
  );
  assert.deepEqual(source.mesh.indices, original);
});
