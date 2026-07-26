"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type {
  MeshData,
  ModelDocument,
  SelectionMode,
  SplitOperation,
  SplitResult,
} from "../lib/model-types";

interface ModelViewportProps {
  model: ModelDocument | null;
  split: SplitResult | null;
  selectionMode: SelectionMode;
  selectedIds: Set<number>;
  onPick: (id: number) => void;
  onWebglError: () => void;
  resetSignal: number;
  splitInPlace: boolean;
  splitKind: SplitOperation["kind"];
  operationPreview: SplitOperation | null;
}

interface ViewportRuntime {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  content: THREE.Group;
  grid: THREE.GridHelper;
  raycaster: THREE.Raycaster;
  pointer: THREE.Vector2;
  animationFrame: number;
  resizeObserver: ResizeObserver;
  frameKey: string;
}

function threeColor(hex: string): THREE.Color {
  try {
    return new THREE.Color(hex);
  } catch {
    return new THREE.Color("#B9B4A9");
  }
}

function transformedVertex(
  positions: Float32Array,
  index: number,
  offsetX = 0,
): [number, number, number] {
  const source = index * 3;
  return [
    positions[source] + offsetX,
    positions[source + 2],
    -positions[source + 1],
  ];
}

function buildMesh(
  source: MeshData,
  model: ModelDocument,
  selectedIds: Set<number>,
  selectionMode: SelectionMode,
  offsetX = 0,
  pickingEnabled = true,
): THREE.Group {
  const faceCount = source.indices.length / 3;
  const positions = new Float32Array(faceCount * 9);
  const colors = new Float32Array(faceCount * 9);
  const selectedColor = new THREE.Color("#FFCF3F");
  const palette = model.materials.map((material) => threeColor(material.color));

  for (let face = 0; face < faceCount; face += 1) {
    const materialId = source.faceMaterials[face] ?? 0;
    const partId = source.faceParts[face] ?? 0;
    for (let corner = 0; corner < 3; corner += 1) {
      const cornerMaterial =
        source.faceVertexMaterials?.[face * 3 + corner] ?? materialId;
      const selectionId =
        selectionMode === "color"
          ? source.faceColorRegions?.[face] ?? materialId
          : partId;
      const color = selectedIds.has(selectionId)
        ? selectedColor
        : palette[cornerMaterial] ?? new THREE.Color("#B9B4A9");
      const target = face * 9 + corner * 3;
      const vertex = transformedVertex(
        source.positions,
        source.indices[face * 3 + corner],
        offsetX,
      );
      positions.set(vertex, target);
      colors[target] = color.r;
      colors[target + 1] = color.g;
      colors[target + 2] = color.b;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.72,
    metalness: 0.04,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.pickingEnabled = pickingEnabled;
  mesh.userData.source = source;
  const group = new THREE.Group();
  group.add(mesh);

  if (faceCount < 60_000) {
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry, 28),
      new THREE.LineBasicMaterial({
        color: "#1f2724",
        transparent: true,
        opacity: 0.14,
      }),
    );
    group.add(edges);
  }
  return group;
}

function disposeGroup(group: THREE.Group): void {
  group.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      for (const material of materials) material.dispose();
    }
  });
  group.clear();
}

function cutGuide(
  model: ModelDocument,
  operation: SplitOperation,
): THREE.Group | null {
  if (operation.kind === "color") return null;
  const minimum = new THREE.Vector3(Infinity, Infinity, Infinity);
  const maximum = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let index = 0; index < model.mesh.positions.length; index += 3) {
    minimum.min(
      new THREE.Vector3(
        model.mesh.positions[index],
        model.mesh.positions[index + 1],
        model.mesh.positions[index + 2],
      ),
    );
    maximum.max(
      new THREE.Vector3(
        model.mesh.positions[index],
        model.mesh.positions[index + 1],
        model.mesh.positions[index + 2],
      ),
    );
  }
  const center = minimum.clone().add(maximum).multiplyScalar(0.5);
  const size = maximum.clone().sub(minimum);
  const normal = new THREE.Vector3();
  const point = center.clone();
  if (operation.kind === "plane") {
    const angle = THREE.MathUtils.degToRad(operation.tilt);
    if (operation.axis === "x") {
      normal.set(Math.cos(angle), Math.sin(angle), 0);
      point.x = minimum.x + size.x * operation.position;
    } else if (operation.axis === "y") {
      normal.set(Math.sin(angle), Math.cos(angle), 0);
      point.y = minimum.y + size.y * operation.position;
    } else {
      normal.set(Math.sin(angle), 0, Math.cos(angle));
      point.z = minimum.z + size.z * operation.position;
    }
  } else {
    const viewIndex = { x: 0, y: 1, z: 2 }[operation.viewAxis];
    const padAxes = [0, 1, 2].filter((axis) => axis !== viewIndex);
    const toPoint = (value: [number, number]) => {
      const result = center.clone();
      result.setComponent(
        padAxes[0],
        minimum.getComponent(padAxes[0]) +
          size.getComponent(padAxes[0]) * value[0],
      );
      result.setComponent(
        padAxes[1],
        maximum.getComponent(padAxes[1]) -
          size.getComponent(padAxes[1]) * value[1],
      );
      return result;
    };
    const start = toPoint(operation.start);
    const end = toPoint(operation.end);
    const extrusion =
      operation.viewAxis === "x"
        ? new THREE.Vector3(1, 0, 0)
        : operation.viewAxis === "y"
          ? new THREE.Vector3(0, 1, 0)
          : new THREE.Vector3(0, 0, 1);
    normal.copy(end.clone().sub(start).cross(extrusion).normalize());
    point.copy(start.add(end).multiplyScalar(0.5));
  }
  const guideSize = Math.max(size.x, size.y, size.z, 10) * 1.45;
  const geometry = new THREE.PlaneGeometry(guideSize, guideSize);
  const material = new THREE.MeshBasicMaterial({
    color: "#FFCF3F",
    transparent: true,
    opacity: 0.22,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const plane = new THREE.Mesh(geometry, material);
  const viewNormal = new THREE.Vector3(normal.x, normal.z, -normal.y).normalize();
  plane.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    viewNormal,
  );
  plane.position.set(point.x, point.z, -point.y);
  plane.renderOrder = 2;
  plane.userData.pickingEnabled = false;
  const edge = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({
      color: "#151515",
      transparent: true,
      opacity: 0.78,
    }),
  );
  plane.add(edge);
  const group = new THREE.Group();
  group.add(plane);
  return group;
}

function frameContent(runtime: ViewportRuntime): void {
  const box = new THREE.Box3().setFromObject(runtime.content);
  if (box.isEmpty()) {
    runtime.camera.position.set(48, 38, 58);
    runtime.controls.target.set(0, 0, 0);
    runtime.controls.maxDistance = 900;
    runtime.controls.update();
    return;
  }
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 10);
  runtime.controls.target.copy(center);
  runtime.camera.position.set(
    center.x + radius * 1.35,
    center.y + radius * 0.95,
    center.z + radius * 1.55,
  );
  runtime.camera.near = Math.max(radius / 1000, 0.01);
  runtime.camera.far = Math.max(radius * 120, 5000);
  runtime.controls.maxDistance = Math.max(radius * 40, 1200);
  runtime.camera.updateProjectionMatrix();
  runtime.controls.update();
}

export function ModelViewport({
  model,
  split,
  selectionMode,
  selectedIds,
  onPick,
  onWebglError,
  resetSignal,
  splitInPlace,
  splitKind,
  operationPreview,
}: ModelViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<ViewportRuntime | null>(null);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const onPickRef = useRef(onPick);
  const onWebglErrorRef = useRef(onWebglError);
  const selectionModeRef = useRef(selectionMode);

  useEffect(() => {
    onPickRef.current = onPick;
    onWebglErrorRef.current = onWebglError;
    selectionModeRef.current = selectionMode;
  }, [onPick, onWebglError, selectionMode]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
      });
    } catch {
      onWebglErrorRef.current();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor("#F7F3EA");
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.domElement.className = "modelcut-canvas";
    renderer.domElement.setAttribute(
      "aria-label",
      "Interactive 3D model viewport",
    );
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 3000);
    camera.position.set(48, 38, 58);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.minDistance = 8;
    controls.maxDistance = 900;
    controls.target.set(0, 6, 0);

    scene.add(new THREE.HemisphereLight("#FFFFFF", "#D6CEC1", 2.5));
    const key = new THREE.DirectionalLight("#FFF8EC", 4.2);
    key.position.set(65, 90, 45);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    scene.add(key);
    const fill = new THREE.DirectionalLight("#FFE897", 1.35);
    fill.position.set(-50, 35, -40);
    scene.add(fill);

    const grid = new THREE.GridHelper(180, 24, "#C9BC9F", "#E5DCCB");
    grid.position.y = -0.05;
    const gridMaterials = Array.isArray(grid.material)
      ? grid.material
      : [grid.material];
    for (const material of gridMaterials) {
      material.transparent = true;
      material.opacity = 0.72;
    }
    scene.add(grid);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(180, 180),
      new THREE.ShadowMaterial({ color: "#9A8268", opacity: 0.12 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.08;
    ground.receiveShadow = true;
    scene.add(ground);

    const content = new THREE.Group();
    scene.add(content);
    const runtime: ViewportRuntime = {
      renderer,
      scene,
      camera,
      controls,
      content,
      grid,
      raycaster: new THREE.Raycaster(),
      pointer: new THREE.Vector2(),
      animationFrame: 0,
      resizeObserver: new ResizeObserver(() => {
        const width = Math.max(host.clientWidth, 1);
        const height = Math.max(host.clientHeight, 1);
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      }),
      frameKey: "",
    };
    runtimeRef.current = runtime;
    runtime.resizeObserver.observe(host);

    const animate = () => {
      runtime.animationFrame = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const handlePointerDown = (event: PointerEvent) => {
      pointerStart.current = { x: event.clientX, y: event.clientY };
    };
    const handlePointerUp = (event: PointerEvent) => {
      const start = pointerStart.current;
      pointerStart.current = null;
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5)
        return;
      const rect = renderer.domElement.getBoundingClientRect();
      runtime.pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      runtime.raycaster.setFromCamera(runtime.pointer, camera);
      const hits = runtime.raycaster
        .intersectObjects(content.children, true)
        .filter(
          (hit) =>
            hit.object instanceof THREE.Mesh &&
            hit.object.userData.pickingEnabled &&
            hit.faceIndex != null,
        );
      const hit = hits[0];
      if (!hit || hit.faceIndex == null) return;
      const source = hit.object.userData.source as MeshData;
      const id =
        selectionModeRef.current === "color"
          ? source.faceColorRegions?.[hit.faceIndex] ??
            source.faceMaterials[hit.faceIndex]
          : source.faceParts[hit.faceIndex];
      onPickRef.current(id);
    };
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);

    return () => {
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      runtime.resizeObserver.disconnect();
      cancelAnimationFrame(runtime.animationFrame);
      controls.dispose();
      disposeGroup(content);
      ground.geometry.dispose();
      (ground.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.domElement.remove();
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    disposeGroup(runtime.content);
    if (!model) {
      runtime.frameKey = "";
      frameContent(runtime);
      return;
    }

    if (split) {
      const selectedGroup = buildMesh(
        split.selected,
        model,
        new Set(),
        selectionMode,
        0,
        false,
      );
      const remainingGroup = buildMesh(
        split.remaining,
        model,
        new Set(),
        selectionMode,
        0,
        false,
      );
      if (!splitInPlace) {
        const selectedBox = new THREE.Box3().setFromObject(selectedGroup);
        const remainingBox = new THREE.Box3().setFromObject(remainingGroup);
        const selectedSize = selectedBox.getSize(new THREE.Vector3());
        const remainingSize = remainingBox.getSize(new THREE.Vector3());
        const selectedCenter = selectedBox.getCenter(new THREE.Vector3());
        const remainingCenter = remainingBox.getCenter(new THREE.Vector3());
        const gap = Math.max(
          Math.max(...selectedSize.toArray(), ...remainingSize.toArray()) * 0.08,
          4,
        );
        if (splitKind === "color") {
          selectedGroup.position.x =
            remainingBox.min.x - gap - selectedBox.max.x;
          selectedGroup.position.y =
            remainingBox.min.y + 0.2 - selectedBox.min.y;
          selectedGroup.position.z =
            remainingBox.max.z + gap - selectedBox.min.z;
        } else {
          selectedGroup.position.x =
            remainingBox.min.x - gap - selectedBox.max.x;
          selectedGroup.position.y = remainingCenter.y - selectedCenter.y;
        }
      }
      runtime.content.add(selectedGroup, remainingGroup);
    } else {
      runtime.content.add(
        buildMesh(
          model.mesh,
          model,
          selectedIds,
          selectionMode,
          0,
          true,
        ),
      );
      if (operationPreview) {
        const guide = cutGuide(model, operationPreview);
        if (guide) runtime.content.add(guide);
      }
    }

    const frameKey = `${model.id}:${split?.id ?? "source"}:${splitInPlace ? "in-place" : "apart"}:${splitKind}`;
    if (runtime.frameKey !== frameKey) {
      runtime.frameKey = frameKey;
      frameContent(runtime);
    }
  }, [
    model,
    operationPreview,
    selectedIds,
    selectionMode,
    split,
    splitInPlace,
    splitKind,
  ]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (runtime) frameContent(runtime);
  }, [resetSignal]);

  return <div className="modelcut-viewport-host" ref={hostRef} />;
}
