export const MAX_IMAGE_EDGE = 2048
export const GENERATION_TIMEOUT_MS = 10 * 60 * 1000
export const INFLIGHT_FLUSH_INTERVAL_MS = 1000
/**
 * Ceiling on model steps in one generation. Tools that execute need more than the SDK's default of
 * one; this is a runaway guard, not a budget — a tool that should call itself less says so itself.
 */
export const TOOL_MAX_STEPS = 8
