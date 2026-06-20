import ts from 'typescript';
import path from 'node:path';

export interface PreciseImportInput {
  /** Repo-relative path of the importing file. */
  rel: string;
  /** Absolute path of the importing file. */
  abs: string;
  /** Raw module specifiers from its import/export-from statements. */
  specifiers: string[];
}

export interface PreciseEdge {
  from: string;
  to: string;
}

/**
 * Resolve import specifiers via the TS compiler's real module resolution (tsconfig `paths`/`baseUrl`/
 * extensions/index files, ADR-15) — captures aliased couplings the relative resolver misses → `Refs` edges (ADR-06).
 */
export function resolvePreciseImports(
  repoPath: string,
  files: PreciseImportInput[],
  fileSet: ReadonlySet<string>,
): PreciseEdge[] {
  const configPath = ts.findConfigFile(repoPath, ts.sys.fileExists, 'tsconfig.json');
  let options: ts.CompilerOptions = {
    allowJs: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  if (configPath) {
    const cfg = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!cfg.error) {
      const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, path.dirname(configPath));
      options = { ...parsed.options, allowJs: true };
    }
  }

  const host = ts.createCompilerHost(options);
  const edges: PreciseEdge[] = [];
  const seen = new Set<string>();

  for (const f of files) {
    for (const spec of f.specifiers) {
      const resolved = ts.resolveModuleName(spec, f.abs, options, host).resolvedModule?.resolvedFileName;
      if (!resolved || resolved.includes('node_modules')) continue;
      const relTarget = path.relative(repoPath, resolved).split(path.sep).join('/');
      if (!fileSet.has(relTarget) || relTarget === f.rel) continue;
      const key = `${f.rel}\t${relTarget}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: f.rel, to: relTarget });
    }
  }
  return edges;
}
