/**
 * Are two versions of a source file the same PROGRAM? (review plan, batch 1)
 *
 * A formatting pass must change spacing, line breaks, quotes, trailing commas,
 * semicolons and redundant parentheses — and nothing else. This compares the
 * two syntax trees with exactly those differences removed:
 *
 *   - comments, whitespace, semicolons and trailing commas are not in the tree;
 *   - a string is compared by its value, not its quotes; a number by its value;
 *   - JSX text is compared the way React reads it (lines trimmed, blank lines
 *     dropped, joined by one space), so re-flowed JSX text is the same text;
 *   - parentheses are compared by what they contain, so a redundant pair
 *     removed is no change — while parentheses that matter change the tree's
 *     SHAPE, which is compared.
 *
 * Anything else that differs makes the files different.
 */
import ts from "typescript";

// React's rule for JSX text (babel's cleanJSXElementLiteralChild): a line loses the
// whitespace on the sides that touch a line break — never the sides that touch a tag or an
// expression — whitespace-only lines are dropped, and the lines are joined by one space.
function jsxText(text) {
  const lines = text.split(/\r\n|\n|\r/);
  const kept = [];
  lines.forEach((line, index) => {
    let value = line.replace(/\t/g, " ");
    if (index > 0) value = value.replace(/^ +/, "");
    if (index < lines.length - 1) value = value.replace(/ +$/, "");
    if (value) kept.push(value);
  });
  return kept.join(" ");
}

// A JSX child that renders as plain text: text itself, or an expression that is a string
// literal — which is how Prettier keeps a space when it breaks a line: {" "}.
function textOf(child) {
  if (child.kind === ts.SyntaxKind.JsxText) return { text: child.text, raw: true };
  if (ts.isJsxExpression(child) && child.expression && ts.isStringLiteral(child.expression)) {
    return { text: child.expression.text, raw: false };
  }
  return null;
}

const NAMED = new Set([
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.EnumMember,
]);
function plainKey(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text.replace(/_/g, "")));
  return null;
}

/** The literal value a leaf contributes, or null for a node without one. */
function leafValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return JSON.stringify(node.text);
  }
  if (ts.isNumericLiteral(node)) return String(Number(node.text.replace(/_/g, "")));
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
    return JSON.stringify(node.text);
  }
  if (ts.isRegularExpressionLiteral(node)) return node.text;
  return null;
}

/** Adjacent text-like JSX children render as one run of text: emit the run, not its pieces. */
function emitChildren(node, out, visit) {
  let run = null;
  const flush = () => {
    if (run !== null && run.length) out.push("TEXT", JSON.stringify(run));
    run = null;
  };
  for (const child of node.children) {
    const piece = textOf(child);
    if (piece) {
      run = (run ?? "") + (piece.raw ? jsxText(piece.text) : piece.text);
    } else {
      flush();
      visit(child);
    }
  }
  flush();
}

function scriptKind(path) {
  if (/\.tsx$/.test(path)) return ts.ScriptKind.TSX;
  return /\.(mjs|js|cjs)$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

function canonical(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, scriptKind(path));
  const out = [];
  const visit = (node) => {
    // A key is the same key quoted or not ({"a": 1} is {a: 1}, {"1": x} is {1: x}):
    // Prettier's quoteProps removes quotes it does not need, so compare a key by its text.
    if (NAMED.has(node.kind) && node.name && plainKey(node.name) !== null) {
      out.push(node.kind, "(", "KEY", JSON.stringify(plainKey(node.name)));
      ts.forEachChild(node, (child) => {
        if (child !== node.name) visit(child);
      });
      out.push(")");
      return;
    }
    if (ts.isParenthesizedExpression(node) || ts.isParenthesizedTypeNode(node)) {
      visit(node.expression ?? node.type);
      return;
    }
    out.push(node.kind);
    const value = leafValue(node);
    if (value !== null) out.push(value);
    out.push("(");
    if (ts.isJsxElement(node)) {
      visit(node.openingElement);
      emitChildren(node, out, visit);
      visit(node.closingElement);
    } else if (ts.isJsxFragment(node)) {
      emitChildren(node, out, visit);
    } else {
      ts.forEachChild(node, visit);
    }
    out.push(")");
  };
  visit(source);
  return out.join(" ");
}

export function sameSyntax(path, before, after) {
  return canonical(path, before) === canonical(path, after);
}
