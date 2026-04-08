// Dashboard module barrel — re-exports the public API
export type { BeadSnapshot, DashboardSnapshot, DashboardAlert } from "./types.js";
export { buildDashboardSnapshot, PHASE_EMOJI, PHASE_LABEL } from "./model.js";
export { renderDashboardLines, renderPhaseHeader, renderProgressBar, renderGoalLine, renderBeadTable, renderStaleBanner, renderTenderSection, renderAlerts } from "./render.js";
export { DashboardController } from "./controller.js";
export type { DashboardControllerOptions } from "./controller.js";
