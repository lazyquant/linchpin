/**
 * What the page remembers between two drawings: per explorer its focus, steps, layers, opened groups and trail;
 * the open drawer; the colours. `reduce` is pure. None of it is evidence; it only says what to show.
 */
import type { Selection } from "./surfaces";
import { LAYERS } from "./strings";

export const TRAIL_LENGTH = 6;
export type Theme = "auto" | "light" | "dark";

export interface ExplorerState { focus: string; steps: number; layers: string[]; expanded: string[]; trail: string[] }
export interface PageState {
  explorers: Record<string, ExplorerState>;
  drawer: Selection | null;
  theme: Theme;
}

export type Action =
  | { type: "open"; key: string; focus: string; steps: number; layers?: string[] }
  | { type: "focus"; key: string; focus: string }
  | { type: "steps"; key: string; steps: number }
  | { type: "layer"; key: string; layer: string }
  | { type: "expand"; key: string; group: string }
  | { type: "drawer"; selection: Selection | null }
  | { type: "theme"; theme: Theme };

export const initialState = (): PageState => ({ explorers: {}, drawer: null, theme: "auto" });

function update(state: PageState, key: string, change: (explorer: ExplorerState) => ExplorerState): PageState {
  const explorer = state.explorers[key];
  return explorer ? { ...state, explorers: { ...state.explorers, [key]: change(explorer) } } : state;
}

export function reduce(state: PageState, action: Action): PageState {
  switch (action.type) {
    case "open":
      if (state.explorers[action.key]) return state;
      return { ...state, explorers: { ...state.explorers, [action.key]: { focus: action.focus, steps: action.steps, layers: action.layers ?? LAYERS.map((layer) => layer.name), expanded: [], trail: [] } } };
    case "focus":
      // The earlier focus goes on the trail, which keeps the last six. Opened groups belong to the earlier focus.
      return update(state, action.key, (explorer) => (explorer.focus === action.focus ? explorer : {
        ...explorer, focus: action.focus, expanded: [], trail: [...explorer.trail, explorer.focus].slice(-TRAIL_LENGTH),
      }));
    case "steps":
      return action.steps === 1 || action.steps === 2 || action.steps === 3 ? update(state, action.key, (explorer) => ({ ...explorer, steps: action.steps })) : state;
    case "layer":
      return update(state, action.key, (explorer) => ({
        ...explorer, layers: explorer.layers.includes(action.layer) ? explorer.layers.filter((layer) => layer !== action.layer) : LAYERS.map((layer) => layer.name).filter((layer) => layer === action.layer || explorer.layers.includes(layer)),
      }));
    case "expand":
      return update(state, action.key, (explorer) => (explorer.expanded.includes(action.group) ? explorer : { ...explorer, expanded: [...explorer.expanded, action.group] }));
    case "drawer":
      return { ...state, drawer: action.selection };
    case "theme":
      return { ...state, theme: action.theme };
    default:
      return state;
  }
}
