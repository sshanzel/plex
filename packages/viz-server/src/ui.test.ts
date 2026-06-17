import { describe, it, expect } from 'vitest';
import { renderAppHtml } from './ui';

describe('renderAppHtml', () => {
  it('is a self-contained page with the SRI-pinned Cytoscape and the graph tabs', () => {
    const html = renderAppHtml('9.9.9');
    expect(html).toContain('<title>Plex — data explorer</title>');
    expect(html).toContain('integrity="sha384-IWROdLKRsN1UuJywMlWl7/blXQ8GEooN2n7dzTxfEPd7ybYIKCUJ2Ol/1Gpf3YV4"');
    expect(html).toContain('crossorigin="anonymous"');
    expect(html).toContain('data-graph="code"');
    expect(html).toContain('data-graph="knowledge"');
    expect(html).toContain('data-graph="lineage"');
    expect(html).toContain('9.9.9');
  });

  it('drops the standalone PR-brain tab (folded into Review history / Lineage) and offers a global knowledge view', () => {
    const html = renderAppHtml('9.9.9');
    expect(html).not.toContain('data-graph="brain"'); // brain is a subset of lineage — no separate tab
    expect(html).toContain('>Review history<'); // the lineage tab, renamed
    expect(html).toContain('All repos (global)'); // knowledge no longer hidden behind a repo scope
  });

  it('ships the outcome/sentinel legibility encoding (border styles + panel summary + legend key)', () => {
    const html = renderAppHtml('9.9.9');
    expect(html).toContain('outcomeClass'); // outcome lifted onto element data + styled
    expect(html).toContain("node[?sentinel]"); // the regression-sentinel ring style
    expect(html).toContain('summaryFor'); // the detail-panel one-line story header
    expect(html).toContain('prior fix (regression risk)'); // the legend key
  });

  it('clusters the knowledge graph — compound parent style + a deterministic box grid (ADR-45)', () => {
    const html = renderAppHtml('9.9.9');
    expect(html).toContain("selector:':parent'"); // pitfall/suppression renders as a container box
    expect(html).toContain('function knowledgeGrid'); // lesson-boxes laid in a deterministic grid
    expect(html).toContain('isParent()'); // a box = a parent (pitfall) + its nested incidents
    expect(html).toContain('d.parent = n.parent'); // incident nested via Cytoscape compound parent
  });

  it('code-graph search reaches files beyond the landing set (server-backed)', () => {
    const html = renderAppHtml('9.9.9');
    expect(html).toContain('function fetchSearch'); // debounced server search
    expect(html).toContain('/api/search?repo='); // loads matching files not in the landing set
  });

  it('renders a cold-start empty state (centered CTA) instead of a black void', () => {
    const html = renderAppHtml('9.9.9');
    expect(html).toContain('id="empty"'); // the centered overlay element
    expect(html).toContain('function showEmptyState'); // toggled on a 0-node payload
    expect(html).toContain('plex analyze'); // the knowledge CTA points at the seed path
  });

  it('escapes the version so it cannot break out of the markup', () => {
    const html = renderAppHtml('</script><img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;');
  });
});
