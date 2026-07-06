import { languageOf } from '@plex/core';
import { analyzeSource, type RawFinding } from './builtin';
import { analyzePySource, PY_RULES } from './builtin-py';

export type Analyzer = (file: string, text: string) => RawFinding[];

const ANALYZERS: Record<string, Analyzer> = { ts: analyzeSource, py: analyzePySource };

/** Per-language capability map — the ONLY dispatch point. A file whose language has no analyzer is skipped. */
export function analyzerFor(file: string): Analyzer | undefined {
  const lang = languageOf(file);
  return lang ? ANALYZERS[lang] : undefined;
}

/** Back-compat allowlist alias: "some analyzer can handle this file". */
export function isSupportedSource(file: string): boolean {
  return analyzerFor(file) != null;
}

/** Which language owns a rule id — rule ids are 1:1 per language, so prevalence denominators stay honest. */
export function ruleLanguage(rule: string): 'ts' | 'py' {
  return PY_RULES.has(rule) ? 'py' : 'ts';
}
