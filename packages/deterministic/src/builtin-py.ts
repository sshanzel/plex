import { parsePython, type Node } from '@plex/lang-python';
import type { RawFinding } from './builtin';

/** Rule ids owned by the Python analyzer — 1:1 per language (never shared with TS) so per-language
 *  prevalence denominators and `pattern-repo` waivers stay honest in mixed repos. */
export const PY_RULES: ReadonlySet<string> = new Set([
  'no-breakpoint',
  'mutable-default-arg',
  'no-return-in-finally',
  'no-bare-except',
  'no-silent-except',
  'use-is-none',
  'no-print',
]);

const DEBUGGER_MODULES = new Set(['pdb', 'ipdb']);
const MUTABLE_LITERALS = new Set([
  'list',
  'dictionary',
  'set',
  'list_comprehension',
  'dictionary_comprehension',
  'set_comprehension',
]);
const MUTABLE_CTORS = new Set(['list', 'dict', 'set']);

/**
 * The nearest enclosing named declaration (ADR-48) — methods qualify as `Class.method` (innermost
 * class), deliberately diverging from the TS analyzer's unqualified name: Python dunders
 * (`__init__` in every class) would otherwise collide within a file and make symbol-scoped
 * suppression wrongly broad. Matches the graph extractor's naming, so code-path memory keys align.
 */
function enclosingSymbol(node: Node): string | undefined {
  for (let n: Node | null = node.parent; n; n = n.parent) {
    if (n.type === 'function_definition') {
      const name = n.childForFieldName('name')?.text;
      if (!name) continue;
      // A direct class member (possibly decorator-wrapped) is a method → qualify by the class.
      let holder: Node | null = n.parent;
      if (holder?.type === 'decorated_definition') holder = holder.parent;
      if (holder?.type === 'block' && holder.parent?.type === 'class_definition') {
        const cls = holder.parent.childForFieldName('name')?.text;
        if (cls) return `${cls}.${name}`;
      }
      return name;
    }
    if (n.type === 'class_definition') {
      const name = n.childForFieldName('name')?.text;
      if (name) return name;
    }
    if (n.type === 'lambda' && n.parent?.type === 'assignment') {
      const left = n.parent.childForFieldName('left');
      if (left?.type === 'identifier') return left.text;
    }
  }
  return undefined;
}

function isPassOnly(block: Node | null): boolean {
  if (!block) return false;
  const stmts = block.namedChildren;
  if (stmts.length === 0) return false;
  return stmts.every(
    (s) =>
      s.type === 'pass_statement' ||
      (s.type === 'expression_statement' && s.namedChildren.length === 1 && s.namedChildren[0]!.type === 'ellipsis'),
  );
}

/** `return` inside `finally`: the nearest of {finally_clause, function_definition, lambda} decides. */
function inFinally(node: Node): boolean {
  for (let n: Node | null = node.parent; n; n = n.parent) {
    if (n.type === 'finally_clause') return true;
    if (n.type === 'function_definition' || n.type === 'lambda') return false;
  }
  return false;
}

function comparesNone(node: Node): boolean {
  // Fire only when a `none` operand sits ADJACENT to an ==/!= operator (`a == b is None` must not fire on ==).
  const children: Node[] = [];
  for (let i = 0; i < node.childCount; i++) children.push(node.child(i)!);
  for (let i = 0; i < children.length; i++) {
    const c = children[i]!;
    if (c.isNamed || (c.text !== '==' && c.text !== '!=')) continue;
    const prev = children.slice(0, i).findLast((x) => x.isNamed);
    const next = children.slice(i + 1).find((x) => x.isNamed);
    if (prev?.type === 'none' || next?.type === 'none') return true;
  }
  return false;
}

/** Deterministic checks over one Python file via tree-sitter (ADR-52) — pure; sync after `initPython()`. */
export function analyzePySource(_file: string, text: string): RawFinding[] {
  const tree = parsePython(text);
  try {
    const out: RawFinding[] = [];
    const add = (n: Node, r: Omit<RawFinding, 'startLine' | 'endLine' | 'symbol'>): void => {
      out.push({
        ...r,
        startLine: n.startPosition.row + 1,
        endLine: n.endPosition.row + 1,
        symbol: enclosingSymbol(n),
      });
    };

    const visit = (node: Node): void => {
      if (node.type === 'ERROR') return; // error-tolerant parse: no phantom findings from broken regions
      if (node.type === 'call') {
        const fn = node.childForFieldName('function');
        if (fn?.type === 'identifier' && fn.text === 'breakpoint') {
          add(node, { rule: 'no-breakpoint', title: 'Leftover debugger breakpoint', body: 'A `breakpoint()` halts execution in a debugger and must not ship.', severity: 'bug', confidence: 0.95 });
        } else if (
          fn?.type === 'attribute' &&
          DEBUGGER_MODULES.has(fn.childForFieldName('object')?.text ?? '') &&
          fn.childForFieldName('attribute')?.text === 'set_trace'
        ) {
          add(node, { rule: 'no-breakpoint', title: 'Leftover debugger breakpoint', body: 'A `pdb.set_trace()` halts execution in a debugger and must not ship.', severity: 'bug', confidence: 0.95 });
        } else if (fn?.type === 'identifier' && fn.text === 'print') {
          add(node, { rule: 'no-print', title: 'Leftover `print` call', body: 'Remove debug output or route through `logging`.', severity: 'nit', confidence: 0.5 });
        }
      } else if (node.type === 'import_statement') {
        for (const n of node.childrenForFieldName('name')) {
          const mod = n.type === 'aliased_import' ? n.namedChildren.find((c) => c.type === 'dotted_name') : n;
          if (mod && DEBUGGER_MODULES.has(mod.text)) {
            add(node, { rule: 'no-breakpoint', title: 'Leftover debugger import', body: 'A `pdb`/`ipdb` import is debugging scaffolding and must not ship.', severity: 'bug', confidence: 0.95 });
            break;
          }
        }
      } else if (node.type === 'import_from_statement') {
        if (DEBUGGER_MODULES.has(node.childForFieldName('module_name')?.text ?? '')) {
          add(node, { rule: 'no-breakpoint', title: 'Leftover debugger import', body: 'A `pdb`/`ipdb` import is debugging scaffolding and must not ship.', severity: 'bug', confidence: 0.95 });
        }
      } else if (node.type === 'default_parameter' || node.type === 'typed_default_parameter') {
        const value = node.childForFieldName('value');
        const mutable =
          value != null &&
          (MUTABLE_LITERALS.has(value.type) ||
            (value.type === 'call' &&
              value.childForFieldName('function')?.type === 'identifier' &&
              MUTABLE_CTORS.has(value.childForFieldName('function')!.text)));
        if (mutable) {
          add(node, { rule: 'mutable-default-arg', title: 'Mutable default argument', body: 'Defaults evaluate once at definition time — a mutable default is shared across every call. Use `None` and initialize inside the function.', severity: 'bug', confidence: 0.9 });
        }
      } else if (node.type === 'return_statement' && inFinally(node)) {
        add(node, { rule: 'no-return-in-finally', title: '`return` in `finally` swallows exceptions', body: 'A `return` inside `finally` discards any in-flight exception and overrides the `try`/`except` return value. Move it out of `finally`.', severity: 'bug', confidence: 0.85 });
      } else if (node.type === 'except_clause') {
        // Priority: a pass-only body is the concrete harm (one finding per clause); bare-ness is secondary.
        if (isPassOnly(node.namedChildren.find((c) => c.type === 'block') ?? null)) {
          add(node, { rule: 'no-silent-except', title: 'Except clause silently swallows the error', body: 'Silently swallowing errors hides failures — handle, re-raise, or log.', severity: 'improvement', confidence: 0.85 });
        } else if (!node.childForFieldName('value')) {
          add(node, { rule: 'no-bare-except', title: 'Bare `except:` catches everything', body: 'A bare `except:` also swallows `KeyboardInterrupt`/`SystemExit`. Catch a specific exception, or at least `Exception`.', severity: 'improvement', confidence: 0.9 });
        }
      } else if (node.type === 'comparison_operator' && comparesNone(node)) {
        add(node, { rule: 'use-is-none', title: 'Comparison to `None` with `==`/`!=`', body: 'Use `is None`/`is not None` — `==` dispatches to `__eq__` and can be overridden.', severity: 'nit', confidence: 0.9 });
      }

      for (const child of node.namedChildren) visit(child);
    };

    visit(tree.rootNode);
    return out;
  } finally {
    tree.delete();
  }
}
