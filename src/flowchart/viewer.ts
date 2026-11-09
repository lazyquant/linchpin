import { FLOWCHART_VIEWER_JS } from "./assets";
import type { FlowchartModel, FlowchartPresentation, FlowchartViewAction, FlowchartViewState, FlowchartViewerCore } from "./types";

type CoreFunctions = {
  reduce(model: FlowchartModel, state: FlowchartViewState, action: FlowchartViewAction): FlowchartViewState;
  present(model: FlowchartModel, state: FlowchartViewState): FlowchartPresentation;
};

type CoreFactory = (document: undefined, window: undefined, globalThis: undefined) => CoreFunctions;

export function loadFlowchartViewerCore(): FlowchartViewerCore {
  const factory = new Function(
    "document",
    "window",
    "globalThis",
    `${FLOWCHART_VIEWER_JS}\nreturn { reduce: linchpinFlowchartReduce, present: linchpinFlowchartPresent };`,
  ) as CoreFactory;
  const core = factory(undefined, undefined, undefined);
  return { reduce: core.reduce, present: core.present };
}

export function loadFlowchartPlaybackCore(): import("./types").FlowchartPlaybackCore {
  return new Function("document", "window", "globalThis", `${FLOWCHART_VIEWER_JS}\nreturn { reducePlayback: linchpinFlowchartReducePlayback, presentPlayback: linchpinFlowchartPresentPlayback };`)(undefined, undefined, undefined);
}
