import { describe, it, expect } from 'vitest';
import { renderAppHtml } from './ui';

describe('renderAppHtml', () => {
  it('is a self-contained page with the SRI-pinned Cytoscape and the graph tabs', () => {
    const html = renderAppHtml('9.9.9');
    expect(html).toContain('<title>Plex — data explorer</title>');
    expect(html).toContain('integrity="sha384-IWROdLKRsN1UuJywMlWl7/blXQ8GEooN2n7dzTxfEPd7ybYIKCUJ2Ol/1Gpf3YV4"');
    expect(html).toContain('crossorigin="anonymous"');
    expect(html).toContain('data-graph="code"');
    expect(html).toContain('data-graph="brain"');
    expect(html).toContain('data-graph="knowledge"');
    expect(html).toContain('data-graph="lineage"');
    expect(html).toContain('9.9.9');
  });

  it('escapes the version so it cannot break out of the markup', () => {
    const html = renderAppHtml('</script><img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;');
  });
});
