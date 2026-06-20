import ts from 'typescript';
import path from 'node:path';

export interface ExtractedSymbol {
  name: string;
  kind: 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'const';
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface ExtractedFile {
  /** Raw module specifiers from import / export-from statements. */
  imports: string[];
  symbols: ExtractedSymbol[];
}

const TS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

export function isSupportedSource(file: string): boolean {
  return TS_EXTS.includes(path.extname(file));
}

function scriptKindFor(file: string): ts.ScriptKind {
  switch (path.extname(file)) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function isExported(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

/** Structural extraction via the TS compiler API (ADR-15) — a single SourceFile parse, no type checker. */
export function extractFromSource(fileName: string, text: string): ExtractedFile {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  const symbols: ExtractedSymbol[] = [];
  const imports: string[] = [];

  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const push = (name: string, kind: ExtractedSymbol['kind'], node: ts.Node, exported: boolean) => {
    symbols.push({ name, kind, startLine: lineOf(node.getStart(sf)), endLine: lineOf(node.getEnd()), exported });
  };

  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      push(node.name.text, 'function', node, isExported(node));
    } else if (ts.isClassDeclaration(node) && node.name) {
      const exported = isExported(node);
      push(node.name.text, 'class', node, exported);
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          push(`${node.name.text}.${member.name.text}`, 'method', member, exported);
        }
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      push(node.name.text, 'interface', node, isExported(node));
    } else if (ts.isTypeAliasDeclaration(node)) {
      push(node.name.text, 'type', node, isExported(node));
    } else if (ts.isEnumDeclaration(node)) {
      push(node.name.text, 'enum', node, isExported(node));
    } else if (ts.isVariableStatement(node)) {
      const exported = isExported(node);
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) ||
            ts.isFunctionExpression(decl.initializer) ||
            ts.isClassExpression(decl.initializer))
        ) {
          push(decl.name.text, 'const', node, exported);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return { imports: [...new Set(imports)], symbols };
}

/** Resolve a relative import specifier to a repo-relative path in `fileSet`; null for bare/external/unresolved (aliases → precise layer). */
export function resolveRelativeImport(
  fromFile: string,
  spec: string,
  fileSet: ReadonlySet<string>,
): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.join(path.posix.dirname(fromFile), spec);
  const candidates = [
    base,
    ...TS_EXTS.map((e) => base + e),
    ...TS_EXTS.map((e) => path.posix.join(base, 'index' + e)),
  ];
  for (const c of candidates) {
    const normalized = c.replace(/^\.\//, '');
    if (fileSet.has(normalized)) return normalized;
  }
  return null;
}
