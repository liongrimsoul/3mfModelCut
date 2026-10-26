import type {
  ModelDocument,
  ModelPiece,
  PieceSplitResult,
  PieceTransform,
  SelectionMode,
} from "./model-types";

export interface EditorSnapshot {
  mode: SelectionMode;
  ids: number[];
  pieces: ModelPiece[];
  selectedPieceId: string | null;
}

export interface EditorTimeline {
  past: EditorSnapshot[];
  present: EditorSnapshot;
  future: EditorSnapshot[];
}

export function createEditorTimeline(
  pieces: ModelPiece[] = [],
): EditorTimeline {
  return {
    past: [],
    present: {
      mode: "color",
      ids: [],
      pieces,
      selectedPieceId: pieces[0]?.id ?? null,
    },
    future: [],
  };
}

export function createRootPiece(model: ModelDocument): ModelPiece {
  return {
    id: `piece-${model.id}`,
    parentId: null,
    model,
    homePosition: { x: 0, y: 0, z: 0 },
    position: { x: 0, y: 0, z: 0 },
    validation: null,
    capCount: 0,
  };
}

export function replacePieceWithSplit(
  pieces: ModelPiece[],
  pieceId: string,
  split: PieceSplitResult,
  separate: boolean,
): ModelPiece[] {
  const index = pieces.findIndex((piece) => piece.id === pieceId);
  if (index < 0) throw new Error("The selected piece is no longer available.");
  const parent = pieces[index];
  const selectedId = `piece-${split.id}-selected`;
  const remainingId = `piece-${split.id}-remaining`;
  const existingIds = new Set(
    pieces.filter((piece) => piece.id !== pieceId).map((piece) => piece.id),
  );
  if (existingIds.has(selectedId) || existingIds.has(remainingId)) {
    throw new Error("The split produced piece identifiers that already exist.");
  }

  const children: ModelPiece[] = [
    {
      id: selectedId,
      parentId: parent.id,
      model: split.selected,
      homePosition: { ...parent.homePosition },
      position: { ...parent.position },
      validation: split.selectedValidation,
      capCount: parent.capCount + split.capCount,
    },
    {
      id: remainingId,
      parentId: parent.id,
      model: split.remaining,
      homePosition: { ...parent.homePosition },
      position: { ...parent.position },
      validation: split.remainingValidation,
      capCount: 0,
    },
  ];
  if (separate) {
    const xBounds = (positions: Float32Array) => {
      let min = Infinity;
      let max = -Infinity;
      for (let index = 0; index < positions.length; index += 3) {
        min = Math.min(min, positions[index]);
        max = Math.max(max, positions[index]);
      }
      return { min, max };
    };
    const selectedBounds = xBounds(split.selected.mesh.positions);
    const remainingBounds = xBounds(split.remaining.mesh.positions);
    const gap = Math.max(
      selectedBounds.max - selectedBounds.min,
      remainingBounds.max - remainingBounds.min,
      10,
    ) * 0.08;
    const selectedOffsetX = remainingBounds.min - gap - selectedBounds.max;
    children[0].position.x += selectedOffsetX;
    children[0].homePosition.x += selectedOffsetX;
  }
  return [...pieces.slice(0, index), ...children, ...pieces.slice(index + 1)];
}

export function updatePiecePosition(
  pieces: ModelPiece[],
  pieceId: string,
  position: PieceTransform,
): ModelPiece[] {
  if (!Object.values(position).every(Number.isFinite)) {
    throw new Error("Piece positions must be finite numbers.");
  }
  let found = false;
  const next = pieces.map((piece) => {
    if (piece.id !== pieceId) return piece;
    found = true;
    return { ...piece, position: { ...position } };
  });
  if (!found) throw new Error("The selected piece is no longer available.");
  return next;
}

export function resetPiecePositions(pieces: ModelPiece[]): ModelPiece[] {
  return pieces.map((piece) => ({
    ...piece,
    position: { ...piece.homePosition },
  }));
}

export function commitSnapshot(
  timeline: EditorTimeline,
  present: EditorSnapshot,
): EditorTimeline {
  return {
    past: [...timeline.past.slice(-39), timeline.present],
    present,
    future: [],
  };
}

export function undoSnapshot(timeline: EditorTimeline): EditorTimeline {
  if (!timeline.past.length) return timeline;
  return {
    past: timeline.past.slice(0, -1),
    present: timeline.past[timeline.past.length - 1],
    future: [timeline.present, ...timeline.future].slice(0, 40),
  };
}

export function redoSnapshot(timeline: EditorTimeline): EditorTimeline {
  if (!timeline.future.length) return timeline;
  const [present, ...future] = timeline.future;
  return {
    past: [...timeline.past.slice(-39), timeline.present],
    present,
    future,
  };
}