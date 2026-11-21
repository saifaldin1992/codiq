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

function jsxText(text) {
  return text
    .split(/\r?\n/)
    .map((line, index, all) =>
      index === 0 ? line.trimEnd() : index === all.length - 1 ? line.trimStart() : line.trim()
    )
    .filter(line => line.length)
    .join(" ");
}

function canonical(path, text) {
  const kind = /\.tsx$/.test(path)
    ? ts.ScriptKind.TSX
    : /\.(mjs|js|cjs)$/.test(path)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind);
  const out = [];
  const visit = node => {
    if (ts.isParenthesizedExpression(node) || ts.isParenthesizedTypeNode(node)) {
      visit(node.expression ?? node.type);
      return;
    }
    out.push(node.kind);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      out.push(JSON.stringify(node.text));
    else if (ts.isNumericLiteral(node)) out.push(String(Number(node.text.replace(/_/g, ""))));
    else if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) out.push(node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      out.push(JSON.stringify(node.text));
    else if (ts.isRegularExpressionLiteral(node)) out.push(node.text);
    else if (node.kind === ts.SyntaxKind.JsxText) {
      const value = jsxText(node.text);
      if (!value) {
        out.pop();
        return;
      }
      out.push(JSON.stringify(value));
    }
    out.push("(");
    ts.forEachChild(node, visit);
    out.push(")");
  };
  visit(source);
  return out.join(" ");
}

export function sameSyntax(path, before, after) {
  return canonical(path, before) === canonical(path, after);
}
