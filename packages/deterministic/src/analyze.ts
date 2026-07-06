import { languageOf } from '@plex/core';
import { analyzeSource, type RawFinding } from './builtin';

export type Analyzer = (file: string, text: string) => RawFinding[];

/** Per-language capability map — the ONLY dispatch point. A file whose language has no analyzer is skipped. */
export function analyzerFor(file: string): Analyzer | undefined {
  return languageOf(file) === 'ts' ? analyzeSource : undefined;
}

/** Back-compat allowlist alias: "some analyzer can handle this file". */
export function isSupportedSource(file: string): boolean {
  return analyzerFor(file) != null;
}
