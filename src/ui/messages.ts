/** A2UI v0.9.1 message builders, JSON pointers, and the reading of a message list into one surface state. */
import { CATALOG } from "./catalog";
import type { A2uiComponent, A2uiMessage } from "./types";

export const A2UI_VERSION = "v0.9.1" as const;
export const MESSAGE_KEYS = ["createSurface", "updateDataModel", "updateComponents", "deleteSurface"] as const;

export function createSurface(surfaceId: string): A2uiMessage {
  return { version: A2UI_VERSION, createSurface: { surfaceId, catalogId: CATALOG.id } };
}
export function updateDataModel(surfaceId: string, path: string, value: unknown): A2uiMessage {
  return { version: A2UI_VERSION, updateDataModel: { surfaceId, path, value } };
}
export function updateComponents(surfaceId: string, components: A2uiComponent[]): A2uiMessage {
  return { version: A2UI_VERSION, updateComponents: { surfaceId, components } };
}
export function deleteSurface(surfaceId: string): A2uiMessage {
  return { version: A2UI_VERSION, deleteSurface: { surfaceId } };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(holder: unknown, key: string): unknown {
  if (Array.isArray(holder)) return /^(0|[1-9][0-9]*)$/.test(key) ? holder[Number(key)] : undefined;
  if (isRecord(holder) && Object.prototype.hasOwnProperty.call(holder, key)) return holder[key];
  return undefined;
}

/** The reference tokens of a JSON pointer; `null` when the text is not one. `/` and the empty pointer name the whole document. */
export function pointerTokens(path: unknown): string[] | null {
  if (typeof path !== "string") return null;
  if (path === "" || path === "/") return [];
  if (!path.startsWith("/")) return null;
  return path.slice(1).split("/").map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** Reads a JSON pointer from a data model. Returns `undefined` when the path names nothing. Own properties only. */
export function pointerGet(model: unknown, path: string): unknown {
  const tokens = pointerTokens(path);
  if (tokens === null) return undefined;
  let at: unknown = model;
  for (const token of tokens) {
    at = own(at, token);
    if (at === undefined) return undefined;
  }
  return at;
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Returns a model with `value` at `tokens`. Objects on the way are copied, so the caller's values are never changed. */
function pointerSet(model: unknown, tokens: string[], value: unknown): unknown {
  if (tokens.length === 0) return value;
  const [head, ...rest] = tokens;
  if (UNSAFE_KEYS.has(head)) return model;
  if (Array.isArray(model)) {
    if (!/^(0|[1-9][0-9]*)$/.test(head) || Number(head) > model.length) return model;
    const copy = [...model];
    copy[Number(head)] = pointerSet(model[Number(head)], rest, value);
    return copy;
  }
  const base: Record<string, unknown> = isRecord(model) ? { ...model } : {};
  base[head] = pointerSet(own(model, head), rest, value);
  return base;
}

/** What a message list says about its surface after every message is applied in order. */
export interface SurfaceState {
  surfaceId: string | null;
  surfaceIds: string[];
  created: boolean;
  deleted: boolean;
  model: unknown;
  /** Components by id, later messages replacing earlier ones. */
  components: Map<string, A2uiComponent>;
  /** Ids that appear twice inside one `updateComponents` list. */
  duplicateIds: string[];
}

/**
 * Applies the messages in order and never throws. A malformed message is skipped: judging it is the validator's
 * work, drawing what remains is the renderer's.
 */
export function readSurface(messages: unknown): SurfaceState {
  const state: SurfaceState = { surfaceId: null, surfaceIds: [], created: false, deleted: false, model: undefined, components: new Map(), duplicateIds: [] };
  if (!Array.isArray(messages)) return state;
  const seen = (body: Record<string, unknown>): void => {
    if (typeof body.surfaceId !== "string") return;
    if (!state.surfaceIds.includes(body.surfaceId)) state.surfaceIds.push(body.surfaceId);
    if (state.surfaceId === null) state.surfaceId = body.surfaceId;
  };
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (isRecord(message.createSurface)) {
      seen(message.createSurface);
      state.created = true;
      state.deleted = false;
    } else if (isRecord(message.updateDataModel)) {
      seen(message.updateDataModel);
      const tokens = pointerTokens(message.updateDataModel.path);
      if (tokens !== null) state.model = pointerSet(state.model, tokens, message.updateDataModel.value);
    } else if (isRecord(message.updateComponents)) {
      seen(message.updateComponents);
      const list = message.updateComponents.components;
      if (!Array.isArray(list)) continue;
      const inThisList = new Set<string>();
      for (const component of list) {
        if (!isRecord(component) || typeof component.id !== "string" || typeof component.component !== "string") continue;
        if (inThisList.has(component.id) && !state.duplicateIds.includes(component.id)) state.duplicateIds.push(component.id);
        inThisList.add(component.id);
        state.components.set(component.id, component as A2uiComponent);
      }
    } else if (isRecord(message.deleteSurface)) {
      seen(message.deleteSurface);
      state.deleted = true;
      state.model = undefined;
      state.components = new Map();
    }
  }
  return state;
}
