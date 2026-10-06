import registry from '../../packs/marinade/registry.json';
import type { BundleResponse, GraphData } from '../tokenomics/api';

type Node = GraphData['subgraph']['nodes'][number];
const controlEdges = new Set(['CAN_CHANGE', 'VOTES_IN', 'CONTROLLED_BY', 'MEMBER_OF']);
const priority = (n: Node) => ['PathNode', 'Controller', 'Governance', 'HolderGroup', 'Member', 'Authority', 'Parameter'].indexOf(n.type);
const compare = (a: Node, b: Node) => (priority(a) < 0 ? 99 : priority(a)) - (priority(b) < 0 ? 99 : priority(b)) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id);

/** Select from the same complete captured index used for local and verified Aura results. */
export function selectTokenomicsPicture(g: GraphData, type = 'all', query = '', bundle?: BundleResponse) {
  const q = query.trim().toLowerCase();
  const matched = g.subgraph.nodes.filter(n => (type === 'all' || n.type === type) && (!q || `${n.label} ${n.id} ${graphNodeAddress(n, bundle) ?? ''}`.toLowerCase().includes(q)));
  let nodes: Node[];
  if (type !== 'all' || q) nodes = [...matched].sort(compare).slice(0, 60);
  else {
    const selected = new Set(g.subgraph.nodes.filter(n => n.type === 'PathNode').map(n => n.id));
    // First attach the path's controllers, then their immediate governance,
    // membership and authority dependencies. Never fill with unrelated nodes.
    for (let hop = 0; hop < 2; hop++) {
      const adjacent = new Set<string>();
      for (const edge of g.subgraph.edges) if (controlEdges.has(edge.type)) {
        if (selected.has(edge.from)) adjacent.add(edge.to);
        if (selected.has(edge.to)) adjacent.add(edge.from);
      }
      const groups = new Map<string, Node[]>();
      for (const n of g.subgraph.nodes.filter(n => adjacent.has(n.id) && !selected.has(n.id)).sort(compare))
        groups.set(n.type, [...(groups.get(n.type) ?? []), n]);
      // Balance the one-hop context so a large council membership or authority
      // inventory cannot crowd every other kind of dependency out of the cap.
      while (selected.size < 60 && [...groups.values()].some(group => group.length)) {
        for (const group of groups.values()) {
          const n = group.shift();
          if (n && selected.size < 60) selected.add(n.id);
        }
      }
    }
    nodes = g.subgraph.nodes.filter(n => selected.has(n.id)).sort(compare).slice(0, 60);
  }
  const ids = new Set(nodes.map(n => n.id));
  return { nodes, edges: g.subgraph.edges.filter(e => ids.has(e.from) && ids.has(e.to)), matched: matched.length };
}

/** Addresses stay out of the public GraphData contract; resolve them from the bundle. */
export function graphNodeAddress(n: Node, bundle?: BundleResponse): string | undefined {
  if (n.type === 'PathNode') return bundle?.path.data?.nodes.find(p => `path:${p.id}` === n.id)?.address
    ?? n.id.split(':').find(part => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(part));
  if (n.type === 'Controller') return bundle?.control.data?.controllers.find(c => c.id === n.id)?.address
    ?? n.id.split(':').find(part => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(part));
  if (n.type === 'Mint') {
    const mint = registry.mints.find(m => `mint:${m.id}` === n.id);
    if (mint) return mint.address;
  }
  if (n.type === 'Program') return bundle?.programs.data?.rows.find(p => `program:${p.id}` === n.id)?.address;
  return n.id.split(':').find(part => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(part));
}

/** Compact layers keep controls above the value path and other dependencies below. */
export function layoutTokenomicsPicture(nodes: Node[]) {
  const groups = [nodes.filter(n => ['Controller', 'Governance'].includes(n.type)), nodes.filter(n => n.type === 'PathNode'), nodes.filter(n => !['Controller', 'Governance', 'PathNode'].includes(n.type))];
  const positions = new Map<string, { x: number; y: number }>();
  const columns = 4, width = 1180, nodeWidth = 235, nodeHeight = 76, pitch = 290;
  let y = 35;
  for (const group of groups) {
    group.forEach((n, i) => positions.set(n.id, { x: 30 + i % columns * pitch, y: y + Math.floor(i / columns) * 150 }));
    if (group.length) y += Math.ceil(group.length / columns) * 150 + 45;
  }
  return { positions, width, height: Math.max(150, y), nodeWidth, nodeHeight };
}
