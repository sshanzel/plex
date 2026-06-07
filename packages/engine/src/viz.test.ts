import { describe, it, expect } from 'vitest';
import type { ReviewContext } from './review';
import { reviewContextToHtml } from './viz';

// reviewContextToHtml is a pure string builder; `import type { ReviewContext }` is erased
// so this never loads Kùzu (vitest-safe). Pin the element shaping (hub, changed-file
// de-dup, neighbor score/provenance) and the header counts.
const ctx = {
  repo: 'plex',
  baseRef: 'main',
  changed: [{ file: 'a.ts' }, { file: 'a.ts' }, { file: 'b.ts' }], // a.ts twice (two hunks)
  blastRadius: [{ node: { props: { path: 'c.ts' } }, score: 0.42, via: ['co-change', 'import'] }],
} as unknown as ReviewContext;

describe('reviewContextToHtml', () => {
  const html = reviewContextToHtml(ctx);

  it('renders the header with the RAW changed count and coupled count', () => {
    expect(html).toContain('base main · 3 changed · 1 coupled');
  });

  it('de-dups changed files into one node each (a.ts appears once despite two hunks)', () => {
    expect(html.match(/"id":"c:a\.ts"/g)).toHaveLength(1);
    expect(html).toContain('"id":"c:b.ts"');
  });

  it('emits a hub node and a hub→changed edge', () => {
    expect(html).toContain('"id":"hub"');
    expect(html).toContain('"id":"e:c:a.ts"');
  });

  it('emits a neighbor node with score label and an edge labeled by provenance', () => {
    expect(html).toContain('"id":"n:c.ts"');
    expect(html).toContain('c.ts\\n0.42'); // label is `<path>\n<score.toFixed(2)>`
    expect(html).toContain('co-change,import'); // via joined onto the edge label
  });
});
