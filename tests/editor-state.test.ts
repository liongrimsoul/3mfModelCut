import assert from "node:assert/strict";
import test from "node:test";
import { createEditorTimeline, createRootPiece, commitSnapshot, redoSnapshot, replacePieceWithSplit, resetPiecePositions, undoSnapshot, updatePiecePosition } from "../lib/editor-state";
import { createDemoModel, createModelFromMesh, splitWithOperation } from "../lib/mesh-core";
import type { ModelPiece, PieceSplitResult, SplitOperation } from "../lib/model-types";

const noConnector: SplitOperation["connector"] = {
  method: "none",
  side: "selected",
  count: 1,
  areaPercent: 8,
  depth: 4,
  tolerance: 0.2,
};

function splitPiece(
  piece: ModelPiece,
  operation: SplitOperation,
): PieceSplitResult {
  const result = splitWithOperation(piece.model, operation);
  return {
    id: result.public.id,
    selected: createModelFromMesh(
      piece.model,
      result.selected,
      `${piece.model.name} selected`,
    ),
    remaining: createModelFromMesh(
      piece.model,
      result.remaining,
      `${piece.model.name} remaining`,
    ),
    selectedValidation: result.public.selectedValidation,
    remainingValidation: result.public.remainingValidation,
    capCount: result.public.capCount,
    selectedFaceCount: result.public.selectedFaceCount,
    remainingFaceCount: result.public.remainingFaceCount,
  };
}

function plane(axis: "x" | "y" | "z"): SplitOperation {
  return {
    kind: "plane",
    axis,
    position: 0.5,
    tilt: 0,
    connector: noConnector,
  };
}

test("replaces only the selected piece and permits another closed cut", () => {
  const root = createRootPiece(createDemoModel());
  const untouched = createRootPiece(createDemoModel());
  const firstSplit = splitPiece(root, plane("x"));
  const afterFirst = replacePieceWithSplit([root, untouched], root.id, firstSplit, false);

  assert.equal(afterFirst.length, 3);
  assert.strictEqual(afterFirst[2], untouched);
  assert.notEqual(afterFirst[0].id, afterFirst[1].id);
  assert.equal(afterFirst[0].parentId, root.id);
  assert.equal(afterFirst[0].validation?.ok, true);
  assert.equal(afterFirst[1].validation?.ok, true);

  const parent = afterFirst[0];
  const secondSplit = splitPiece(parent, plane("y"));
  const afterSecond = replacePieceWithSplit(afterFirst, parent.id, secondSplit, false);

  assert.equal(afterSecond.length, 4);
  assert.strictEqual(afterSecond[3], untouched);
  assert.equal(afterSecond[0].parentId, parent.id);
  assert.equal(afterSecond[1].parentId, parent.id);
  assert.equal(afterSecond[0].validation?.ok, true);
  assert.equal(afterSecond[1].validation?.ok, true);
});

test("piece transforms are isolated and reset to the cut layout", () => {
  const root = createRootPiece(createDemoModel());
  const split = splitPiece(root, plane("x"));
  const pieces = replacePieceWithSplit([root], root.id, split, true);
  const selected = pieces[0];
  const other = pieces[1];
  assert.notEqual(selected.position.x, other.position.x);

  const moved = updatePiecePosition(pieces, selected.id, {
    x: selected.position.x + 12,
    y: 7,
    z: -3,
  });
  assert.deepEqual(moved[0].position, {
    x: selected.position.x + 12,
    y: 7,
    z: -3,
  });
  assert.strictEqual(moved[1], other);

  const reset = resetPiecePositions(moved);
  assert.deepEqual(reset.map((piece) => piece.position), pieces.map((piece) => piece.homePosition));
  assert.deepEqual(pieces[0].position, pieces[0].homePosition);

  const movedParent = updatePiecePosition([root], root.id, {
    x: 15,
    y: 4,
    z: -2,
  })[0];
  const descendantSplit = splitPiece(movedParent, plane("x"));
  const descendants = replacePieceWithSplit(
    [movedParent],
    movedParent.id,
    descendantSplit,
    true,
  );
  const resetDescendants = resetPiecePositions(descendants);
  assert.deepEqual(
    resetDescendants.map((piece) => piece.position),
    descendants.map((piece) => piece.homePosition),
  );
  assert.equal(resetDescendants[1].position.x, 0);

  assert.throws(
    () => updatePiecePosition(pieces, selected.id, { x: Infinity, y: 0, z: 0 }),
    /finite numbers/,
  );
});

test("a cut descendant remains compatible with color and sketch operations", () => {
  const root = createRootPiece(createDemoModel());
  const firstSplit = splitPiece(root, plane("x"));
  const pieces = replacePieceWithSplit([root], root.id, firstSplit, false);
  const selected = pieces[0];
  const colorRegion = selected.model.colorRegions.find(
    (region) => region.faceCount > 0 && region.faceCount < selected.model.stats.faceCount,
  );
  assert.ok(colorRegion);
  const colorSplit = splitPiece(selected, {
    kind: "color",
    selection: { mode: "color", ids: [colorRegion.id] },
    cutMethod: "patch",
    connector: noConnector,
  });
  assert.equal(colorSplit.selectedValidation.ok, true);
  assert.equal(colorSplit.remainingValidation.ok, true);

  const sketchSplit = splitPiece(pieces[1], {
    kind: "sketch",
    viewAxis: "z",
    start: [0.2, 0.42],
    end: [0.8, 0.58],
    connector: noConnector,
  });
  assert.equal(sketchSplit.selectedValidation.ok, true);
  assert.equal(sketchSplit.remainingValidation.ok, true);
});

test("cut and transform snapshots support undo and redo", () => {
  const root = createRootPiece(createDemoModel());
  const initial = createEditorTimeline([root]);
  const split = splitPiece(root, plane("x"));
  const cutPieces = replacePieceWithSplit([root], root.id, split, false);
  const afterCut = commitSnapshot(initial, {
    ...initial.present,
    pieces: cutPieces,
    selectedPieceId: cutPieces[0].id,
  });
  const movedPieces = updatePiecePosition(cutPieces, cutPieces[0].id, {
    x: 5,
    y: 0,
    z: 0,
  });
  const afterMove = commitSnapshot(afterCut, {
    ...afterCut.present,
    pieces: movedPieces,
  });

  const undoneMove = undoSnapshot(afterMove);
  assert.deepEqual(undoneMove.present.pieces[0].position, cutPieces[0].position);
  const undoneCut = undoSnapshot(undoneMove);
  assert.deepEqual(undoneCut.present.pieces.map((piece) => piece.id), [root.id]);
  const redoneCut = redoSnapshot(undoneCut);
  assert.deepEqual(redoneCut.present.pieces.map((piece) => piece.id), cutPieces.map((piece) => piece.id));
  const redoneMove = redoSnapshot(redoneCut);
  assert.equal(redoneMove.present.pieces[0].position.x, 5);
});