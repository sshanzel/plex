import { describe, it, expect } from 'vitest';
import type { Finding, Severity, FindingSource } from '@plex/core';
import { normalizeTitle, dedupeKey, dedupeFindings } from './dedupe';

// Complements rank.test.ts (which covers the headline cross-source merge): this file pins
// normalizeTitle/dedupeKey and the merge details — severity ranking incl. `awareness`,
// max-blast, evidence concat, pitfallId/prevalence carry, and same-source de-duplication.
let n = 0;
const mk = (over: Partial<Finding> & { severity?: Severity; source?: FindingSource } = {}): Finding => {
  n++;
  return {
    id: over.id ?? `f${n}`,
    title: over.title ?? `finding ${n}`,
    body: '',
    severity: over.severity ?? 'bug',
    confidence: over.confidence ?? 0.8,
    source: over.source ?? 'first-principles',
    location: over.location ?? { repo: 'r', file: 'src/a.ts', startLine: 10, endLine: 12 },
    ...over,
  };
};

describe('normalizeTitle', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normalizeTitle('Null  Deref, on USER!!')).toBe('null deref on user');
  });
  it('drops non-ascii entirely (no partial tokens left behind)', () => {
    expect(normalizeTitle('café — venue_opened')).toBe('caf venueopened');
  });
  it('returns empty string for punctuation-only titles', () => {
    expect(normalizeTitle('!!! ??? ---')).toBe('');
  });
});

describe('dedupeKey', () => {
  it('keys on file + startLine + normalized title', () => {
    expect(dedupeKey(mk({ title: 'A B', location: { repo: 'r', file: 'x.ts', startLine: 5, endLine: 9 } })))
      .toBe('x.ts:5:a b');
  });
  it('same issue, different wording/case → same key', () => {
    const a = dedupeKey(mk({ title: 'Null deref!', location: { repo: 'r', file: 'x.ts', startLine: 5, endLine: 5 } }));
    const b = dedupeKey(mk({ title: 'null   DEREF', location: { repo: 'r', file: 'x.ts', startLine: 5, endLine: 9 } }));
    expect(a).toBe(b);
  });
  it('different startLine → different key (line drift is a different instance here)', () => {
    const a = dedupeKey(mk({ title: 't', location: { repo: 'r', file: 'x.ts', startLine: 5, endLine: 5 } }));
    const b = dedupeKey(mk({ title: 't', location: { repo: 'r', file: 'x.ts', startLine: 6, endLine: 6 } }));
    expect(a).not.toBe(b);
  });
});

describe('dedupeFindings merge', () => {
  const loc = { repo: 'r', file: 'x.ts', startLine: 1, endLine: 1 };

  it('keeps the highest severity, with awareness ranked LOWEST (never wins over a real defect)', () => {
    const merged = dedupeFindings([
      mk({ title: 'dup', severity: 'awareness', source: 'first-principles', location: loc }),
      mk({ title: 'dup', severity: 'bug', source: 'deterministic', location: loc }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.severity).toBe('bug');
  });

  it('awareness only survives when it is the only severity present', () => {
    const merged = dedupeFindings([
      mk({ title: 'dup', severity: 'awareness', source: 'first-principles', location: loc }),
      mk({ title: 'dup', severity: 'awareness', source: 'knowledge', location: loc }),
    ]);
    expect(merged[0]!.severity).toBe('awareness');
  });

  it('takes the MAX blast radius and concatenates evidence across sources', () => {
    const merged = dedupeFindings([
      mk({ title: 'dup', blastRadius: 0.3, evidence: ['e1'], location: loc }),
      mk({ title: 'dup', blastRadius: 0.9, evidence: ['e2', 'e3'], source: 'deterministic', location: loc }),
    ]);
    expect(merged[0]!.blastRadius).toBe(0.9);
    expect(merged[0]!.evidence).toEqual(['e1', 'e2', 'e3']);
  });

  it('does not double-count agreedSources when the SAME source repeats', () => {
    const merged = dedupeFindings([
      mk({ title: 'dup', source: 'first-principles', location: loc }),
      mk({ title: 'dup', source: 'first-principles', location: loc }),
    ]);
    expect(merged[0]!.agreedSources).toEqual(['first-principles']);
    expect(merged[0]!.confidence).toBeCloseTo(1 - 0.2 * 0.2, 10); // still noisy-OR'd
  });

  it('adopts a pitfallId from a later finding when the first lacked one', () => {
    const merged = dedupeFindings([
      mk({ title: 'dup', location: loc }),
      mk({ title: 'dup', source: 'knowledge', pitfallId: 'pf-1', location: loc }),
    ]);
    expect(merged[0]!.pitfallId).toBe('pf-1');
  });

  it('carries prevalence from whichever finding first defined it', () => {
    const merged = dedupeFindings([
      mk({ title: 'dup', location: loc }), // no prevalence
      mk({ title: 'dup', source: 'deterministic', prevalence: 0.7, location: loc }),
    ]);
    expect(merged[0]!.prevalence).toBe(0.7);
  });

  it('leaves genuinely distinct findings unmerged and preserves their order', () => {
    const out = dedupeFindings([
      mk({ id: 'a', title: 'one', location: { repo: 'r', file: 'a.ts', startLine: 1, endLine: 1 } }),
      mk({ id: 'b', title: 'two', location: { repo: 'r', file: 'b.ts', startLine: 1, endLine: 1 } }),
    ]);
    expect(out.map((f) => f.id)).toEqual(['a', 'b']);
  });
});
