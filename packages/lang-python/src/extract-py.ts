import type { ExtractedFile, ExtractedSymbol } from '@plex/core';
import type { Node } from 'web-tree-sitter';
import { parsePython } from './parser';

const DOTTED = /^[A-Za-z0-9_.]+$/;

/** Compound statements a def can sit under while still being module-level API (see `visit`). */
const MODULE_LEVEL_COMPOUNDS = new Set([
  'if_statement',
  'elif_clause',
  'else_clause',
  'try_statement',
  'except_clause',
  'finally_clause',
  'block',
]);

/** Literal module-level `__all__ = [...]` (list/tuple of plain strings); undefined when absent.
 *  `__all__ +=`/`.extend()` are deliberately ignored (literal-only). */
function readDunderAll(module: Node): Set<string> | undefined {
  for (const stmt of module.namedChildren) {
    if (stmt.type !== 'expression_statement') continue;
    const assign = stmt.namedChildren.find((c) => c.type === 'assignment');
    if (!assign) continue;
    const left = assign.childForFieldName('left');
    const right = assign.childForFieldName('right');
    if (left?.type !== 'identifier' || left.text !== '__all__') continue;
    if (right?.type !== 'list' && right?.type !== 'tuple') continue;
    const names = new Set<string>();
    // Comments are NAMED list children in tree-sitter (same gotcha as except-block bodies) — a
    // section-header comment inside a literal __all__ must not discard the whole list.
    for (const el of right.namedChildren.filter((c) => c.type !== 'comment')) {
      if (el.type !== 'string') return undefined; // non-literal entry — can't trust the list
      const content = el.namedChildren.filter((c) => c.type === 'string_content');
      if (content.length !== 1) return undefined;
      names.add(content[0]!.text);
    }
    return names;
  }
  return undefined;
}

function importedName(node: Node): string | null {
  if (node.type === 'dotted_name') return node.text;
  if (node.type === 'aliased_import') {
    const inner = node.namedChildren.find((c) => c.type === 'dotted_name');
    return inner ? inner.text : null;
  }
  return null;
}

/** `from <prefix> import <name>` → one canonical dotted specifier, leading dots preserved. */
function joinSpec(prefix: string, name: string): string {
  return prefix.endsWith('.') ? prefix + name : `${prefix}.${name}`;
}

/**
 * Structural extraction for Python (ADR-52) — the TS extractor's mirror: symbols (functions,
 * classes, `Class.method` methods, module-level lambda consts, PEP 695 type aliases) + raw import
 * specifiers in Python's own dotted form. Pure; sync after `initPython()`.
 */
export function extractPythonSource(fileName: string, text: string): ExtractedFile {
  const tree = parsePython(text);
  try {
    const symbols: ExtractedSymbol[] = [];
    const imports: string[] = [];
    const root = tree.rootNode;
    const dunderAll = readDunderAll(root);
    const isPublic = (name: string): boolean =>
      dunderAll ? dunderAll.has(name) : !name.startsWith('_');

    const lines = (span: Node): { startLine: number; endLine: number } => ({
      startLine: span.startPosition.row + 1,
      endLine: span.endPosition.row + 1,
    });

    const collectImports = (node: Node): boolean => {
      if (node.type === 'future_import_statement') return true;
      if (node.type === 'import_statement') {
        for (const n of node.childrenForFieldName('name')) {
          const name = importedName(n);
          if (name) imports.push(name);
        }
        return true;
      }
      if (node.type === 'import_from_statement') {
        const moduleName = node.childForFieldName('module_name');
        if (!moduleName) return true;
        const prefix = moduleName.text;
        if (prefix === '__future__') return true;
        if (node.namedChildren.some((c) => c.type === 'wildcard_import')) {
          imports.push(prefix);
          return true;
        }
        for (const n of node.childrenForFieldName('name')) {
          const name = importedName(n);
          if (name) imports.push(joinSpec(prefix, name));
        }
        return true;
      }
      if (node.type === 'call') {
        // Literal-only dynamic imports: importlib.import_module("a.b") / __import__("a.b").
        const fn = node.childForFieldName('function');
        const isDynamic =
          (fn?.type === 'identifier' && fn.text === '__import__') ||
          (fn?.type === 'attribute' &&
            fn.childForFieldName('object')?.text === 'importlib' &&
            fn.childForFieldName('attribute')?.text === 'import_module');
        if (isDynamic) {
          const arg = node.childForFieldName('arguments')?.namedChildren[0];
          if (arg?.type === 'string') {
            const content = arg.namedChildren.filter((c) => c.type === 'string_content');
            if (content.length === 1 && DOTTED.test(content[0]!.text)) imports.push(content[0]!.text);
          }
        }
      }
      return false;
    };

    /** cls is set only when `def` is a DIRECT member of that class's body (methods, TS `Class.method` parity). */
    const handleDef = (
      def: Node,
      span: Node,
      atModuleLevel: boolean,
      cls?: { name: string; exported: boolean },
    ): void => {
      const nameNode = def.childForFieldName('name');
      if (!nameNode) return;
      const name = nameNode.text;
      if (def.type === 'class_definition') {
        const exported = atModuleLevel ? isPublic(name) : (cls?.exported ?? false);
        symbols.push({ name, kind: 'class', ...lines(span), exported });
        const body = def.childForFieldName('body');
        if (body) visitBlock(body, false, { name, exported });
        return;
      }
      // function_definition
      if (cls) {
        symbols.push({ name: `${cls.name}.${name}`, kind: 'method', ...lines(span), exported: cls.exported });
      } else {
        symbols.push({ name, kind: 'function', ...lines(span), exported: atModuleLevel ? isPublic(name) : false });
      }
      const body = def.childForFieldName('body');
      if (body) visitBlock(body, false);
    };

    /** Visit a statement list: `cls` marks its DIRECT definitions as members of that class. */
    const visitBlock = (block: Node, atModuleLevel: boolean, cls?: { name: string; exported: boolean }): void => {
      for (const stmt of block.namedChildren) visit(stmt, atModuleLevel, cls);
    };

    const visit = (node: Node, atModuleLevel: boolean, cls?: { name: string; exported: boolean }): void => {
      if (node.type === 'ERROR') return; // error-tolerant parse: never extract from broken subtrees
      if (collectImports(node)) return;
      if (node.type === 'decorated_definition') {
        const inner = node.namedChildren.find(
          (c) => c.type === 'function_definition' || c.type === 'class_definition',
        );
        if (inner) handleDef(inner, node, atModuleLevel, cls); // span includes the decorators
        return;
      }
      if (node.type === 'function_definition' || node.type === 'class_definition') {
        handleDef(node, node, atModuleLevel, cls);
        return;
      }
      if (node.type === 'type_alias_statement') {
        // The left `type` node's TEXT includes PEP 695 type params (`Alias[T]`); the symbol is the
        // bare identifier — anything else breaks __all__ matching and the ADR-47/48 file#name keys.
        const name = node.childForFieldName('left')?.descendantsOfType('identifier')[0]?.text;
        if (name && atModuleLevel) symbols.push({ name, kind: 'type', ...lines(node), exported: isPublic(name) });
        return;
      }
      if (atModuleLevel && node.type === 'expression_statement') {
        const assign = node.namedChildren.find((c) => c.type === 'assignment');
        const left = assign?.childForFieldName('left');
        const right = assign?.childForFieldName('right');
        if (left?.type === 'identifier' && right?.type === 'lambda') {
          symbols.push({ name: left.text, kind: 'const', ...lines(node), exported: isPublic(left.text) });
        }
      }
      // Recurse for anything else — imports/defs can live inside try/if/with/function bodies.
      // Module-levelness survives ONLY through the conditional-definition idioms (a version-guard
      // `if`/`else`, a `try/except ImportError` fallback): a def there is module-level public API,
      // so its exported flag must follow __all__/underscore like any top-level def. Loops/with and
      // function bodies still drop it (function bodies are visited via handleDef, never here).
      const childLevel = atModuleLevel && MODULE_LEVEL_COMPOUNDS.has(node.type);
      for (const child of node.namedChildren) visit(child, childLevel, undefined);
    };

    visitBlock(root, true);
    return { imports: [...new Set(imports)], symbols };
  } finally {
    tree.delete();
  }
}
