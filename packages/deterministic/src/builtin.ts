import ts from 'typescript';
import path from 'node:path';
import type { Severity } from '@plex/core';

export interface RawFinding {
  rule: string;
  startLine: number;
  endLine: number;
  title: string;
  body: string;
  severity: Severity;
  confidence: number;
  /**
   * Nearest enclosing named declaration → `Finding.location.symbol` so a dismissal is anchored to the
   * SYMBOL it concerned (ADR-48): suppressing one `console.log` scopes to its function, not the whole rule.
   */
  symbol?: string;
}

const TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
export function isSupportedSource(file: string): boolean {
  return TS_EXTS.has(path.extname(file));
}

function scriptKind(file: string): ts.ScriptKind {
  const ext = path.extname(file);
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isNullish(node: ts.Expression): boolean {
  return (
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === 'undefined')
  );
}

/**
 * The nearest enclosing named declaration of `node` — the symbol a finding lives in (ADR-48). Walks up
 * to the closest function/method/accessor/class, or a `const name = () => …` function binding; undefined at top level.
 */
function enclosingSymbol(node: ts.Node): string | undefined {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (
      (ts.isFunctionDeclaration(n) ||
        ts.isMethodDeclaration(n) ||
        ts.isGetAccessorDeclaration(n) ||
        ts.isSetAccessorDeclaration(n) ||
        ts.isClassDeclaration(n)) &&
      n.name &&
      ts.isIdentifier(n.name)
    ) {
      return n.name.text;
    }
    if (
      (ts.isVariableDeclaration(n) || ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n)) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      // `const f = () => …`, `{ handler: () => … }`, or a class field — scope like a named method.
      return n.name.text;
    }
  }
  return undefined;
}

/** Deterministic checks over one source file via the TS AST (ADR-03) — the always-on structural layer, pure. */
export function analyzeSource(file: string, text: string): RawFinding[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const out: RawFinding[] = [];
  const start = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const end = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1;
  const add = (n: ts.Node, r: Omit<RawFinding, 'startLine' | 'endLine' | 'symbol'>): void => {
    out.push({ ...r, startLine: start(n), endLine: end(n), symbol: enclosingSymbol(n) });
  };

  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.DebuggerStatement) {
      add(node, { rule: 'no-debugger', title: 'Leftover `debugger` statement', body: 'A debugger statement will halt execution in dev tools and must not ship.', severity: 'bug', confidence: 0.95 });
    } else if (node.kind === ts.SyntaxKind.AnyKeyword) {
      add(node, { rule: 'no-explicit-any', title: 'Explicit `any` defeats type checking', body: 'Prefer a precise type or `unknown`.', severity: 'nit', confidence: 0.7 });
    } else if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken) &&
      !isNullish(node.left) &&
      !isNullish(node.right)
    ) {
      add(node, { rule: 'no-loose-equality', title: 'Loose equality (`==`/`!=`)', body: 'Use `===`/`!==` to avoid coercion surprises (`== null` is fine and exempt).', severity: 'nit', confidence: 0.9 });
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'console'
    ) {
      add(node, { rule: 'no-console', title: 'Leftover `console` call', body: 'Remove debug logging or route through a logger.', severity: 'nit', confidence: 0.6 });
    } else if (ts.isCatchClause(node) && node.block.statements.length === 0) {
      add(node, { rule: 'no-empty-catch', title: 'Empty catch swallows errors', body: 'Silently swallowing errors hides failures — handle, rethrow, or log.', severity: 'improvement', confidence: 0.85 });
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return out;
}
