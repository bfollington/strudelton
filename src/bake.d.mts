// Hand-written types for bake.mjs so the TS extension can import the canonical,
// already-tested JS module without duplicating it. Shape matches the SDK's
// NoteDescription (required fields only; the SDK's optional fields are accepted).

export interface BakedNote {
  pitch: number;
  startTime: number;
  duration: number;
  velocity: number;
  probability?: number; // from .prob()/.chance(); omitted when 1 (Live default)
}

export interface BakeConfig {
  beatsPerCycle?: number;
  defaultVelocity?: number;
}

export interface BakeResult {
  notes: BakedNote[];
  skipped: number;
  ignoredControls: string[];
}

/** Strudel Pattern (opaque here — we only call queryArc on it elsewhere). */
export interface StrudelPattern {
  queryArc(begin: number, end: number): unknown[];
}

export function loadStrudel(): Promise<unknown>;
export function evaluatePattern(code: string): Promise<{ pattern: StrudelPattern; meta: unknown }>;
export function hapsToNotes(haps: unknown[], baseCycle: number, cfg?: BakeConfig): BakeResult;
export function bakeCycles(
  pattern: StrudelPattern,
  baseCycle: number,
  count: number,
  cfg?: BakeConfig,
): BakeResult;
