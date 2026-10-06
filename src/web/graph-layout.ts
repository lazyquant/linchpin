import type { CannedResult } from './graph';

export type PathNode = { id: string; column: number; x: number; y: number };
export type PathEdge = { from: string; to: string; bases: string[] };

/** The realm paths are layered by remaining hops, with shared entities and hops merged. */
export function layoutRealmPaths(rows: CannedResult['rows']) {
  const distances = new Map<string, number>();
  const edges = new Map<string, PathEdge>();
  for (const row of rows) {
    const ids = String(row.path ?? '').split(' → ').filter(Boolean);
    const bases = String(row.bases ?? '').split(',').map(s => s.trim());
    ids.forEach((id, i) => {
      const distance = ids.length - i - 1;
      // A node cannot have two distances in a strictly layered diagram.
      if (distances.has(id) && distances.get(id) !== distance) throw new Error('Realm paths have inconsistent hop distances');
      distances.set(id, distance);
      if (!i) return;
      const from = ids[i - 1], key = JSON.stringify([from, id]);
      const edge = edges.get(key) ?? { from, to: id, bases: [] };
      const basis = bases[i - 1] || 'unknown';
      if (!edge.bases.includes(basis)) edge.bases.push(basis);
      edges.set(key, edge);
    });
  }
  const lastColumn = Math.max(0, ...distances.values());
  const columns = Array.from({ length: lastColumn + 1 }, (_, column) =>
    [...distances].filter(([, distance]) => lastColumn - distance === column).map(([id]) => id));
  const nodeWidth = 132, nodeHeight = 52, gap = 36, margin = 12, pitch = 76;
  const height = Math.max(1, ...columns.map(c => c.length)) * pitch + margin * 2;
  const nodes: PathNode[] = columns.flatMap((ids, column) => ids.map((id, i) => ({
    id, column, x: margin + column * (nodeWidth + gap),
    y: margin + (height - margin * 2 - ids.length * pitch) / 2 + i * pitch + (pitch - nodeHeight) / 2,
  })));
  return { nodes, edges: [...edges.values()], lastColumn, nodeWidth, nodeHeight,
    width: margin * 2 + columns.length * nodeWidth + lastColumn * gap, height };
}
