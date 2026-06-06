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
 * Deterministic, codifiable checks over a single source file via the TS AST (ADR-03,
 * tier: codifiable). These are the "promote a fuzzy lesson to a rule" target (M5). Pure.
 */
export function analyzeSource(file: string, text: string): RawFinding[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const out: RawFinding[] = [];
  const start = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const end = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1;
  const add = (n: ts.Node, r: Omit<RawFinding, 'startLine' | 'endLine'>): void => {
    out.push({ ...r, startLine: start(n), endLine: end(n) });
  };

  const visit = (node: ts.Node, inLoop: boolean): void => {
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
    } else if (ts.isAwaitExpression(node) && inLoop) {
      add(node, { rule: 'no-await-in-loop', title: '`await` inside a loop', body: 'Sequential awaits in a loop are often a perf bug — consider Promise.all if independent.', severity: 'improvement', confidence: 0.55 });
    }

    const entersFunction =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node);
    const entersLoop =
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node);
    const childInLoop = entersFunction ? false : entersLoop ? true : inLoop;
    ts.forEachChild(node, (c) => visit(c, childInLoop));
  };

  visit(sf, false);
  return out;
}
