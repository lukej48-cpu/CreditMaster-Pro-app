/**
 * 3-bureau report import: parse a saved IdentityIQ / MyScoreIQ / SmartCredit
 * HTML report, then compare bureaus to produce dispute leads.
 */
export * from "./types";
export {
  parseThreeBureauHtml,
  looksLikeThreeBureauReport,
  detectReportSource,
  ReportParseError,
} from "./three-bureau-html-parser";
export { analyzeCrossBureau, LEGAL } from "./cross-bureau-analyzer";
export { toBureauSlices, summarizeImport } from "./persistence";
