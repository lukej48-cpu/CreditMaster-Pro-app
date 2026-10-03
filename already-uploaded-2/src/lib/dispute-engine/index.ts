/**
 * FUNDED UP dispute engine: confirmed items → Round 1/2/3 letters (bureaus,
 * furnishers, collectors) → outcomes → funding readiness for underwriting.
 */
export * from "./types";
export { METRO2, metro2For, describeField } from "./metro2";
export { buildDisputeItems, leadId, type ClientClaim } from "./items";
export { BUREAU_ADDRESSES, ENCLOSURES_DEFAULT, bureauLetter, furnisherLetter, formatDate } from "./letters";
export { planRound, roundTimeline, recordOutcomes, markMailed, escalationCandidates, type PlanOptions } from "./planner";
export { computeReadiness, DEFAULT_THRESHOLDS, type Readiness, type Gate, type ReadinessThresholds } from "./readiness";
