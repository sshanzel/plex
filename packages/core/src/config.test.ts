import { describe, it, expect } from 'vitest';
import { resolveConfig, defaultConfig } from './config';

// resolveConfig is a shallow merge with a hand-rolled deep-merge of the nested groups.
// The hazard it must avoid: a partial override of one nested group wiping its sibling
// defaults. Pin that, since every entry point (CLI, MCP, tests) funnels through it.
describe('resolveConfig', () => {
  it('returns the defaults verbatim with no overrides', () => {
    expect(resolveConfig()).toEqual(defaultConfig);
    expect(resolveConfig({})).toEqual(defaultConfig);
  });

  it('merges a partial nested override WITHOUT dropping that group\'s other defaults', () => {
    const cfg = resolveConfig({ coChange: { maxCommitFiles: 99 } as never });
    expect(cfg.coChange.maxCommitFiles).toBe(99); // overridden
    expect(cfg.coChange.halfLifeDays).toBe(defaultConfig.coChange.halfLifeDays); // preserved
    expect(cfg.coChange.minPairCount).toBe(defaultConfig.coChange.minPairCount);
  });

  it('partial embedding override keeps sibling defaults; provider can be changed alone', () => {
    const cfg = resolveConfig({ embedding: { provider: 'voyage' } });
    expect(cfg.embedding.provider).toBe('voyage');
    // a key/model set later via a different path must not be clobbered by the default 'none'
    const withKey = resolveConfig({ embedding: { provider: 'voyage', apiKey: 'k' } });
    expect(withKey.embedding.apiKey).toBe('k');
  });

  it('partial neighborhood / analyze overrides preserve sibling fields', () => {
    const cfg = resolveConfig({ neighborhood: { maxHops: 4 } as never, analyze: { minClusterSize: 3 } as never });
    expect(cfg.neighborhood.maxHops).toBe(4);
    expect(cfg.neighborhood.maxNeighbors).toBe(defaultConfig.neighborhood.maxNeighbors);
    expect(cfg.analyze.minClusterSize).toBe(3);
    expect(cfg.analyze.maxPrs).toBe(defaultConfig.analyze.maxPrs);
  });

  it('top-level scalars override directly (dataDir, knowledgeDir)', () => {
    const cfg = resolveConfig({ dataDir: '.plex', knowledgeDir: '/tmp/k' });
    expect(cfg.dataDir).toBe('.plex');
    expect(cfg.knowledgeDir).toBe('/tmp/k');
  });

  it('defaults to no embeddings and never the test-only fake embedder', () => {
    expect(resolveConfig().embedding.provider).toBe('none');
  });

  it('does not mutate the shared defaultConfig object', () => {
    resolveConfig({ coChange: { maxCommitFiles: 1 } as never });
    expect(defaultConfig.coChange.maxCommitFiles).toBe(25);
  });

  it('defaults clusterThreshold to 0.8 (tuned for real embeddings — guards the sink fix)', () => {
    // <~0.7 turns the running-mean centroid into a sink on anisotropic embeddings; see
    // cluster.test.ts and AnalyzeConfig. Pinned so a revert to 0.6 is caught.
    expect(resolveConfig().analyze.clusterThreshold).toBe(0.8);
  });
});
