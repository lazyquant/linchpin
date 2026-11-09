export type {
  FlowchartBasis,
  FlowchartVerification,
  FlowchartSource,
  FlowchartSequence,
  FlowchartNode,
  FlowchartEdge,
  FlowchartStep,
  FlowchartModel,
  FlowchartInput,
  FlowchartProblemCode,
  FlowchartProblem,
  FlowchartSelection,
  FlowchartViewState,
  FlowchartViewAction,
  FlowchartMark,
  FlowchartPresentation,
  FlowchartViewerCore,
} from "./types";
export { FlowchartError } from "./types";
export { FLOWCHART_VIEWER_JS, FLOWCHART_STYLE_CSS } from "./assets";
export { loadFlowchartViewerCore } from "./viewer";
export { hashFlowchartModel, toFlowchartModel } from "./model";
export { renderFlowchartHtml } from "./render";
export { validateFlowchartHtml } from "./validate";

import { toFlowchartModel } from "./model";
import { renderFlowchartHtml } from "./render";
import { FlowchartError } from "./types";
import type { FlowchartInput, FlowchartModel } from "./types";
import { validateFlowchartHtml } from "./validate";

export function generateFlowchartHtml(
  input: FlowchartInput,
  title: string,
  options?: { render?: (model: FlowchartModel) => string },
): string {
  const model = toFlowchartModel(input, title);
  const html = (options?.render ?? renderFlowchartHtml)(model);
  const problems = validateFlowchartHtml(html, input);
  if (problems.length > 0) throw new FlowchartError(problems);
  return html;
}

export { loadFlowchartPlaybackCore } from "./viewer";
export type { FlowchartPlaybackState, FlowchartPlaybackAction, FlowchartPlaybackCore } from "./types";
