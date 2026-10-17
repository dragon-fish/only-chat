export const MAX_IMAGE_EDGE = 2048
/**
 * A generation with no stream part for this long, and no server tool running, is stuck and is
 * aborted. Time inside a tool is not idle: each tool owns its own timeout.
 */
export const GENERATION_IDLE_TIMEOUT_MS = 5 * 60 * 1000
/** Ceiling on one generation's wall time, however steadily it progresses. */
export const GENERATION_MAX_MS = 60 * 60 * 1000
export const INFLIGHT_FLUSH_INTERVAL_MS = 1000
/**
 * Ceiling on model steps in one generation. Tools that execute need more than the SDK's default of
 * one; this is a runaway guard, not a budget — a tool that should call itself less says so itself.
 *
 * Keep real headroom above the sum of every tool's per-turn budget. A turn that spends its whole
 * search and extract allowance, has a couple of over-budget calls refused, and then answers already
 * costs eight steps; sitting at that number truncates the answer the work was for.
 */
export const TOOL_MAX_STEPS = 16
