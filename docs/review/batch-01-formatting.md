# تقرير الدفعة ١ — التنسيق الآليّ على ١٠٠ حرف

## الخلاصة

**ما الذي حدث:** نُسّق كلّ ملفّ كود (٧٢٥ ملفّاً) على عرض ١٠٠ حرف. **لم يتغيّر أيّ منطق** — وهذا مُثبَت لا مُفترَض: شجرة صياغة كلّ ملفّ
قبل التنسيق وبعده **متطابقة في ٧٢٥ من ٧٢٥** (انظر «إثبات أنّ المنطق لم يتغيّر» في كومِت التنسيق أدناه).

**لا حذف ولا إصلاح في كود التطبيق** في هذه الدفعة — الحذف والإصلاح في الدفعات التالية.

### الكومِتات الأربعة، كلٌّ بغرض واحد

| الكومِت | ماذا | لماذا منفصل |
|---|---|---|
| `dc01a9c` | أداة الإثبات تقرأ JSX والمفاتيح كما يقرؤها التشغيل؛ Prettier يُبقي `(x) =>` | تعديل أداة، لا تنسيق |
| `a8ced5d` | خمسة حرّاس تقرأ الكود ببنيته لا بتخطيط أسطره | تعديل حرّاس، تحقّق على التخطيطين القديم والجديد |
| `1f32194` | حارس `checkout:payload` يقف عند المفتاح التالي لا عند `) =>` | تصحيح للكومِت السابق |
| `8b0956f` | **التنسيق نفسه** | لا شيء غيره فيه |
| `dfb90bd` | اختبار ق-١٩٦ يقرأ استدعاء حدّ المعدّل أيّاً كان التفاف معاملاته | وجده CI الكامل بعد التنسيق |

### ما تغيّر خارج التنسيق الآليّ (كلّه تعليقات)

خمسة تعليقات `eslint-disable-line` أنزلها التنسيق سطراً عن السطر الذي تحكمه؛ أُعيدت فوقه بصيغة `eslint-disable-next-line`:

| الملفّ | السطر الجديد |
|---|---|
| `client/src/components/PlatformMarketContentPanel.tsx` | 419 |
| `client/src/components/PlatformMarketContentPanel.tsx` | 734 |
| `client/src/components/PlatformMarketContentPanel.tsx` | 981 |
| `client/src/components/PlatformMarketContentPanel.tsx` | 1195 |
| `client/src/components/PlatformMarketSupportPanel.tsx` | 466 |

### ما وجدته هذه الدفعة في الحرّاس (لا في التطبيق)

- **`clock:guard`** كان يعدّ **الأسطر** التي فيها تاريخ لا **التواريخ**: في `list-cursor.unit.mjs` سبعة تواريخ لا خمسة (سطران في كلّ
  منهما تاريخان). لم يُضَف تاريخ؛ الوحدة كانت خاطئة.
- أربعة حرّاس أخرى (`list:guard`، `checkout:payload`، `platform:nav`، `screens:guard`) كانت تفترض أنّ الجملة على سطر واحد — كانت ستنكسر
  عند أوّل تنسيق، أو ستعمى عن كود مكتوب على أسطر.
- **اختبار ق-١٩٦** (`rate-limit-key.integration.mjs`) كان يبحث عن `limitStorefrontWriteWithAddressCeiling(request, "cart_write"` في سطر
  واحد. **والأخطر:** توأمه الذي يتأكّد أنّ المحدِّد **العاديّ** غير مستعمل في هذه المسارات كان سيمرّ بصمت بعد التنسيق — أعمى لا راضياً.
  صار النمطان يقبلان المسافات والأسطر بين المعاملات. وفُحصت بقيّة الفحوص التي تقرأ الكود نصّاً: ما يتحقّق منها من **غياب** شيءٍ
  يطابق كلمة واحدة (`settings.pass`، `main().catch`) لا يخفيها الالتفاف.

### الأرقام

| المقياس | قبل | بعد |
|---|---|---|
| أسطر أطول من ١٠٠ حرف | ١١٬١١٧ | **٢٬٥٨٤** (−٧٧٪) |
| ملفّات فوق حدّ الحجم | ٣٤ | ١١٣ \* |
| دوالّ أطول من ٦٠ سطراً | ٢٢٣ | ٤٤٢ \* |
| أسطر مكرّرة | ٢٬٤٢٨ | ٨٬٠١٨ \* |
| تحذيرات المدقّق | ٢١٨ | ٢١٨ |

\* **إعادة معايرة لا تراجع:** الكود نفسه، لكنّ السطر الطويل صار عدّة أسطر، فكبُرت الملفّات والدوالّ بالعدّ، وصارت نافذة الأسطر
الثمانية للتكرار تحمل كوداً أقلّ. هذه الأرقام هي نقطة البداية الحقيقيّة لدفعات التقسيم والحذف؛ ومنها لا يُقبل إلّا النزول.

**الأسطر الـ٢٬٥٨٤ الباقية فوق ١٠٠ حرف** نصوصٌ لا يقسمها المنسّق (رسائل عربيّة طويلة، وعناوين، وأصناف Tailwind في سلسلة واحدة).
تُقسَّم يدويّاً في دفعة كلّ ملفّ.

### التحقّق

فحص الأنواع (الواجهة والخادم)، والبناء، وكلّ الحرّاس، والمدقّق: ناجحة.

**CI كامل محلّيّاً (٢٠١ خطوة):** ٢٠٠ نجحت من أوّل تشغيل، وفشلت واحدة (ق-١٩٤، الاختبار أعلاه) — أُصلحت في `dfb90bd` وأُعيد
تشغيلها فنجحت. **الدفعة ١ مغلقة.**

---

**الكومِتات:** ٧ · **الملفّات:** ٧٣٣ · **أسطر أُضيفت:** ١٢٠٬٤٣٨ · **أسطر حُذفت:** ٢٧٬٤٩٧

المدى: `c1377de..dfb90bd` — أعيد توليده بـ `node tools/review-report.mjs --from c1377de --to dfb90bd …`

## dc01a9c — Review batch 1 (tooling): the syntax-tree proof reads JSX and keys as the runtime does; Prettier keeps (x) =>

التاريخ: 2026-11-21

> Running the formatting pass showed where tools/ast-same.mjs was stricter than
> the language: it is now exact about
> - JSX text, by babel's own rule (whitespace dropped only beside line breaks),
>   with adjacent text and {" "} compared as the one run of text React renders;
> - object, class and enum keys by their text ({"a": 1} is {a: 1}).
> Meaningful differences still differ (tested: parentheses that change
> precedence, changed text, a computed key).
> .prettierrc: arrowParens "always", which is how the code is written (fewer
> changed lines than "avoid"); .prettierignore: the generated OpenAPI document.

| الملفّ | التغيير | أُضيف | حُذف | الأسطر (قبل ← بعد) |
|---|---|---|---|---|
| `.prettierignore` | عُدّل | 1 | 0 | — ← 6 |
| `.prettierrc` | عُدّل | 1 | 1 | 10 ← 10 |
| `tools/ast-same.mjs` | عُدّل | 99 | 30 | — ← 20–22، 21–27 ← 24–96، 31–36 ← 100، 38 ← 102–112، 44–58 ← 118–119، 60 ← 121–129 |

<details><summary>كلّ سطر تغيّر (قبل/بعد)</summary>

```diff
diff --git a/.prettierignore b/.prettierignore
index 27a587d..d90be79 100644
--- a/.prettierignore
+++ b/.prettierignore
@@ -5 +5,2 @@ node_modules
 *.min.css
+phase1-backend/src/http/openapi.document.ts
diff --git a/.prettierrc b/.prettierrc
index b223cfc..b3f37c0 100644
--- a/.prettierrc
+++ b/.prettierrc
@@ -9,3 +9,3 @@
   "bracketSameLine": false,
-  "arrowParens": "avoid",
+  "arrowParens": "always",
   "endOfLine": "lf",
diff --git a/tools/ast-same.mjs b/tools/ast-same.mjs
index a125c64..3250f07 100644
--- a/tools/ast-same.mjs
+++ b/tools/ast-same.mjs
@@ -19,10 +19,79 @@ import ts from "typescript";
 
+// React's rule for JSX text (babel's cleanJSXElementLiteralChild): a line loses the
+// whitespace on the sides that touch a line break — never the sides that touch a tag or an
+// expression — whitespace-only lines are dropped, and the lines are joined by one space.
 function jsxText(text) {
-  return text
-    .split(/\r?\n/)
-    .map((line, index, all) =>
-      index === 0 ? line.trimEnd() : index === all.length - 1 ? line.trimStart() : line.trim()
-    )
-    .filter(line => line.length)
-    .join(" ");
+  const lines = text.split(/\r\n|\n|\r/);
+  const kept = [];
+  lines.forEach((line, index) => {
+    let value = line.replace(/\t/g, " ");
+    if (index > 0) value = value.replace(/^ +/, "");
+    if (index < lines.length - 1) value = value.replace(/ +$/, "");
+    if (value) kept.push(value);
+  });
+  return kept.join(" ");
+}
+
+// A JSX child that renders as plain text: text itself, or an expression that is a string
+// literal — which is how Prettier keeps a space when it breaks a line: {" "}.
+function textOf(child) {
+  if (child.kind === ts.SyntaxKind.JsxText) return { text: child.text, raw: true };
+  if (ts.isJsxExpression(child) && child.expression && ts.isStringLiteral(child.expression)) {
+    return { text: child.expression.text, raw: false };
+  }
+  return null;
+}
+
+const NAMED = new Set([
+  ts.SyntaxKind.PropertyAssignment,
+  ts.SyntaxKind.PropertySignature,
+  ts.SyntaxKind.PropertyDeclaration,
+  ts.SyntaxKind.MethodDeclaration,
+  ts.SyntaxKind.MethodSignature,
+  ts.SyntaxKind.GetAccessor,
+  ts.SyntaxKind.SetAccessor,
+  ts.SyntaxKind.EnumMember,
+]);
+function plainKey(name) {
+  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
+  if (ts.isNumericLiteral(name)) return String(Number(name.text.replace(/_/g, "")));
+  return null;
+}
+
+/** The literal value a leaf contributes, or null for a node without one. */
+function leafValue(node) {
+  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
+    return JSON.stringify(node.text);
+  }
+  if (ts.isNumericLiteral(node)) return String(Number(node.text.replace(/_/g, "")));
+  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
+  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
+    return JSON.stringify(node.text);
+  }
+  if (ts.isRegularExpressionLiteral(node)) return node.text;
+  return null;
+}
+
+/** Adjacent text-like JSX children render as one run of text: emit the run, not its pieces. */
+function emitChildren(node, out, visit) {
+  let run = null;
+  const flush = () => {
+    if (run !== null && run.length) out.push("TEXT", JSON.stringify(run));
+    run = null;
+  };
+  for (const child of node.children) {
+    const piece = textOf(child);
+    if (piece) {
+      run = (run ?? "") + (piece.raw ? jsxText(piece.text) : piece.text);
+    } else {
+      flush();
+      visit(child);
+    }
+  }
+  flush();
+}
+
+function scriptKind(path) {
+  if (/\.tsx$/.test(path)) return ts.ScriptKind.TSX;
+  return /\.(mjs|js|cjs)$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
 }
@@ -30,10 +99,15 @@ function jsxText(text) {
 function canonical(path, text) {
-  const kind = /\.tsx$/.test(path)
-    ? ts.ScriptKind.TSX
-    : /\.(mjs|js|cjs)$/.test(path)
-      ? ts.ScriptKind.JS
-      : ts.ScriptKind.TS;
-  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind);
+  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, scriptKind(path));
   const out = [];
-  const visit = node => {
+  const visit = (node) => {
+    // A key is the same key quoted or not ({"a": 1} is {a: 1}, {"1": x} is {1: x}):
+    // Prettier's quoteProps removes quotes it does not need, so compare a key by its text.
+    if (NAMED.has(node.kind) && node.name && plainKey(node.name) !== null) {
+      out.push(node.kind, "(", "KEY", JSON.stringify(plainKey(node.name)));
+      ts.forEachChild(node, (child) => {
+        if (child !== node.name) visit(child);
+      });
+      out.push(")");
+      return;
+    }
     if (ts.isParenthesizedExpression(node) || ts.isParenthesizedTypeNode(node)) {
@@ -43,19 +117,14 @@ function canonical(path, text) {
     out.push(node.kind);
-    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
-      out.push(JSON.stringify(node.text));
-    else if (ts.isNumericLiteral(node)) out.push(String(Number(node.text.replace(/_/g, ""))));
-    else if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) out.push(node.text);
-    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
-      out.push(JSON.stringify(node.text));
-    else if (ts.isRegularExpressionLiteral(node)) out.push(node.text);
-    else if (node.kind === ts.SyntaxKind.JsxText) {
-      const value = jsxText(node.text);
-      if (!value) {
-        out.pop();
-        return;
-      }
-      out.push(JSON.stringify(value));
-    }
+    const value = leafValue(node);
+    if (value !== null) out.push(value);
     out.push("(");
-    ts.forEachChild(node, visit);
+    if (ts.isJsxElement(node)) {
+      visit(node.openingElement);
+      emitChildren(node, out, visit);
+      visit(node.closingElement);
+    } else if (ts.isJsxFragment(node)) {
+      emitChildren(node, out, visit);
+    } else {
+      ts.forEachChild(node, visit);
+    }
     out.push(")");
```

</details>

## a8ced5d — Review batch 1 (guards): five guards read code by structure, not by line layout

التاريخ: 2026-11-21

> Formatting at 100 columns wraps long statements, and five guards read source
> as single lines. Each now reads the same thing whatever the layout (checked on
> the current, unformatted code — every guard green):
> - list:guard — a route's path may follow `app.get(` on the next line.
> - checkout:payload — the `checkout` member is every line up to the next
>   member at its indentation, not one line.
> - platform:nav — store staff entries may span lines (`s` flag).
> - screens:guard — `path:` and `status:` may be on different lines.
> - clock:guard — counts every literal date, not lines holding one. The legacy
>   count for list-cursor.unit.mjs is 7, not 5: two lines held two dates each.
>   No date was added; the unit was wrong.

| الملفّ | التغيير | أُضيف | حُذف | الأسطر (قبل ← بعد) |
|---|---|---|---|---|
| `phase1-backend/tests/checkout-payload.guard.mjs` | عُدّل | 8 | 2 | 60–61 ← 60–67 |
| `phase1-backend/tests/frozen-clock.guard.mjs` | عُدّل | 5 | 2 | 58 ← 58، — ← 65–66، 67 ← 69–70 |
| `phase1-backend/tests/frozen-clock.legacy.json` | عُدّل | 1 | 1 | 3 ← 3 |
| `phase1-backend/tests/list-envelope.guard.mjs` | عُدّل | 1 | 1 | 57 ← 57 |
| `phase1-backend/tests/merchant-screens.guard.mjs` | عُدّل | 1 | 1 | 20 ← 20 |
| `phase1-backend/tests/platform-nav.guard.mjs` | عُدّل | 1 | 1 | 114 ← 114 |

<details><summary>كلّ سطر تغيّر (قبل/بعد)</summary>

```diff
diff --git a/phase1-backend/tests/checkout-payload.guard.mjs b/phase1-backend/tests/checkout-payload.guard.mjs
index 60bdb4c..c2bd80b 100644
--- a/phase1-backend/tests/checkout-payload.guard.mjs
+++ b/phase1-backend/tests/checkout-payload.guard.mjs
@@ -59,4 +59,10 @@ function block(text, open) {
 
-const member = source.split(/\r?\n/).find((line) => /^\s*checkout:\s*\(/.test(line));
-assert.ok(member, "the `checkout` member must exist in storefrontApi — if it was renamed, rename it here too");
+// The member is every line from `checkout: (` to the next member at the same indentation —
+// one line or many, however a formatter wraps it (review batch 1: it was read as one line).
+const lines = source.split(/\r?\n/);
+const first = lines.findIndex((line) => /^\s*checkout:\s*\(/.test(line));
+assert.ok(first >= 0, "the `checkout` member must exist in storefrontApi — if it was renamed, rename it here too");
+const indent = lines[first].match(/^\s*/)[0].length;
+const nextMember = lines.findIndex((line, index) => index > first && line.trim() && line.match(/^\s*/)[0].length <= indent);
+const member = lines.slice(first, nextMember < 0 ? undefined : nextMember).join("\n");
 
diff --git a/phase1-backend/tests/frozen-clock.guard.mjs b/phase1-backend/tests/frozen-clock.guard.mjs
index 334297d..6716f22 100644
--- a/phase1-backend/tests/frozen-clock.guard.mjs
+++ b/phase1-backend/tests/frozen-clock.guard.mjs
@@ -57,3 +57,3 @@ const legacyPath = path.join(testsDir, "frozen-clock.legacy.json");
 /** `new Date("2026-09-07…")` and `Date.UTC(2026, 8, 7)`. */
-const LITERAL_DATE = /new Date\("20\d\d-|Date\.UTC\(20\d\d\s*,/;
+const LITERAL_DATES = /new Date\("20\d\d-|Date\.UTC\(20\d\d\s*,/g;
 const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);
@@ -64,5 +64,8 @@ for (const entry of readdirSync(testsDir)) {
   if (entry === "frozen-clock.guard.mjs") continue;
+  // Every literal date counts, however many share a line: counting LINES made a formatter
+  // that wraps one line into two look like a new date (review batch 1).
   const hits = readFileSync(path.join(testsDir, entry), "utf8")
     .split(/\r?\n/)
-    .filter((line) => !isComment(line) && LITERAL_DATE.test(line)).length;
+    .filter((line) => !isComment(line))
+    .reduce((sum, line) => sum + (line.match(LITERAL_DATES) ?? []).length, 0);
   if (hits > 0) counts[entry] = hits;
diff --git a/phase1-backend/tests/frozen-clock.legacy.json b/phase1-backend/tests/frozen-clock.legacy.json
index 6e28678..fe4cc91 100644
--- a/phase1-backend/tests/frozen-clock.legacy.json
+++ b/phase1-backend/tests/frozen-clock.legacy.json
@@ -2,3 +2,3 @@
   "backup-recovery.guard.mjs": 1,
-  "list-cursor.unit.mjs": 5,
+  "list-cursor.unit.mjs": 7,
   "md1.integration.mjs": 4,
diff --git a/phase1-backend/tests/list-envelope.guard.mjs b/phase1-backend/tests/list-envelope.guard.mjs
index f9fc183..e4d7ed1 100644
--- a/phase1-backend/tests/list-envelope.guard.mjs
+++ b/phase1-backend/tests/list-envelope.guard.mjs
@@ -56,3 +56,3 @@ const HOUSE_CURSOR = /encodeListCursor|pageOf\s*\(/;
 const ANY_ROUTE = /\n {2}app\.(get|post|put|patch|delete)\(/g;
-const GET_ROUTE = /app\.get\((["'`])(.*?)\1/g;
+const GET_ROUTE = /app\.get\(\s*(["'`])(.*?)\1/g;
 
diff --git a/phase1-backend/tests/merchant-screens.guard.mjs b/phase1-backend/tests/merchant-screens.guard.mjs
index e1e9e20..fbab64d 100644
--- a/phase1-backend/tests/merchant-screens.guard.mjs
+++ b/phase1-backend/tests/merchant-screens.guard.mjs
@@ -19,3 +19,3 @@ const dashboard = read("client/src/pages/MerchantDashboard.tsx");
 const merchantNav = navigation.slice(navigation.indexOf("export const merchantNavGroups"), navigation.indexOf("];", navigation.indexOf("export const merchantNavGroups")));
-const implemented = [...merchantNav.matchAll(/path: "([^"]+)", status: "implemented"/g)].map((m) => m[1]);
+const implemented = [...merchantNav.matchAll(/path:\s*"([^"]+)",\s*status:\s*"implemented"/g)].map((m) => m[1]);
 const screenPaths = new Set([...screens.matchAll(/^\s+"(\/merchant\/dashboard[^"]*)": /gm)].map((m) => m[1]));
diff --git a/phase1-backend/tests/platform-nav.guard.mjs b/phase1-backend/tests/platform-nav.guard.mjs
index dcefd58..45e5978 100644
--- a/phase1-backend/tests/platform-nav.guard.mjs
+++ b/phase1-backend/tests/platform-nav.guard.mjs
@@ -113,3 +113,3 @@ const storeShell = read("client/src/pages/StaffDashboard.tsx");
 const storeBlock = storeNav.slice(storeNav.indexOf("export const staffNavEntries"), storeNav.indexOf("];", storeNav.indexOf("export const staffNavEntries")));
-const storeEntries = Array.from(storeBlock.matchAll(/\{\s*id:\s*"([^"]+)".*?segment:\s*"([^"]*)"/g), (m) => ({ id: m[1], segment: m[2] }));
+const storeEntries = Array.from(storeBlock.matchAll(/\{\s*id:\s*"([^"]+)".*?segment:\s*"([^"]*)"/gs), (m) => ({ id: m[1], segment: m[2] }));
 assert.ok(storeEntries.length >= 8, `expected the staff navigation entries, read ${storeEntries.length}`);
```

</details>

## 1f32194 — Review batch 1 (guards): checkout:payload stops at the next key, not at `) =>`

التاريخ: 2026-11-21

> The previous fix ended the `checkout` member at the first line back at its
> indentation — which, once formatted, is the `) =>` closing its parameters, so
> the body was never read and three sent fields looked missing. It now ends at
> the next KEY at that indentation. Checked on both layouts: the current code,
> and the same code formatted at 100 columns.

| الملفّ | التغيير | أُضيف | حُذف | الأسطر (قبل ← بعد) |
|---|---|---|---|---|
| `phase1-backend/tests/checkout-payload.guard.mjs` | عُدّل | 5 | 1 | 66 ← 66–70 |

<details><summary>كلّ سطر تغيّر (قبل/بعد)</summary>

```diff
diff --git a/phase1-backend/tests/checkout-payload.guard.mjs b/phase1-backend/tests/checkout-payload.guard.mjs
index c2bd80b..96dc754 100644
--- a/phase1-backend/tests/checkout-payload.guard.mjs
+++ b/phase1-backend/tests/checkout-payload.guard.mjs
@@ -65,3 +65,7 @@ assert.ok(first >= 0, "the `checkout` member must exist in storefrontApi — if
 const indent = lines[first].match(/^\s*/)[0].length;
-const nextMember = lines.findIndex((line, index) => index > first && line.trim() && line.match(/^\s*/)[0].length <= indent);
+// The next member is the next KEY at this indentation — not a closing `) =>` that a
+// formatter puts at the same depth.
+const nextMember = lines.findIndex(
+  (line, index) => index > first && line.match(/^\s*/)[0].length <= indent && /^\s*[A-Za-z_$][\w$]*\s*:/.test(line),
+);
 const member = lines.slice(first, nextMember < 0 ? undefined : nextMember).join("\n");
```

</details>

## 8b0956f — Review batch 1: format all code at 100 columns — no behaviour change, proven per file

التاريخ: 2026-11-21

> Prettier (printWidth 100) over every TypeScript/JavaScript file of the
> backend, client, shared code, server, tests, scripts and tools (725 files).
> Proof that nothing but layout changed: tools/ast-same.mjs compared each
> file's syntax tree before and after — identical in 725 of 725 files (strings
> by value, JSX text as React renders it, keys by their text, redundant
> parentheses ignored, meaningful ones compared). Typecheck (client and
> backend), the build, every guard and the lint ratchet (218, unchanged) pass.
> Comments only, beyond Prettier: five `eslint-disable-line` directives that the
> wrap moved one line down are now `eslint-disable-next-line` above the line
> they govern.
> Baselines: lines over 100 characters 11,117 → 2,584. The file-size,
> function-length and duplicate baselines are re-recorded once, because a
> wrapped line is several lines now (113 files, 442 functions, 8,018
> duplicated lines) — the unit changed, not the code; from here they only fall.

| الملفّ | التغيير | أُضيف | حُذف | الأسطر (قبل ← بعد) |
|---|---|---|---|---|
| `client/src/App.tsx` | عُدّل | 148 | 67 | 38 ← 38–40، 54 ← 56–60، 106 ← 112، 114–120 ← 120–126، 129–134 ← 135–146، 136–138 ← 148–156، 140–146 ← 158–188، 148–188 ← 190–269 |
| `client/src/components/AbandonedCartsPanel.tsx` | عُدّل | 327 | 83 | 9 ← 9–19، 14 ← 24–31، 16–17 ← 33–47، 23 ← 53–59، 27 ← 63–67، 29 ← 69–74، 33 ← 78–79، 50 ← 96–98، 52–63 ← 100–106، 65–89 ← 108–152، 91 ← 154–156، 93 ← 158–162 … (٣٨ موضعاً) |
| `client/src/components/AccountSecurityPanel.tsx` | عُدّل | 68 | 18 | 81–82 ← 81–92، 98 ← 108–112، 135 ← 149–150، 141 ← 156–157، 146 ← 162–165، 160 ← 179–182، 176 ← 198–201، 188 ← 213–216، 211 ← 239–240، 215 ← 244–249، 266 ← 300–302، 268 ← 304–305 … (١٧ موضعاً) |
| `client/src/components/ActivityLog.tsx` | عُدّل | 137 | 42 | 21 ← 21–30، 25 ← 34–39، 57–62 ← 71–100، 118–135 ← 156–178، 143 ← 186–194، 147 ← 198–201، 150 ← 204–206، 153 ← 209–212، 164 ← 223–227، 169 ← 232–237، 172 ← 240–245، 175 ← 248–252 … (١٨ موضعاً) |
| `client/src/components/AddressForm.tsx` | عُدّل | 99 | 13 | 19–20 ← 19–32، 22–23 ← 34–61، 26 ← 64–70، 37–40 ← 81–107، 42 ← 109–114، 51–52 ← 123–134، 54 ← 136–140 |
| `client/src/components/AttributesEditor.tsx` | عُدّل | 112 | 15 | 11 ← 11–12، 13–14 ← 14–22، 16 ← 24–27، 18–19 ← 29–43، 21 ← 45–48، 23 ← 50–53، 25–26 ← 55–72، 31–33 ← 77–115، 36 ← 118–128، 47 ← 139–144 |
| `client/src/components/BoughtTogether.tsx` | عُدّل | 30 | 9 | 16 ← 16–22، 25–26 ← 31–35، 29–30 ← 38–43، 37 ← 50–52، 55–56 ← 70–75، 58 ← 77–79 |
| `client/src/components/CouponsManager.tsx` | عُدّل | 417 | 80 | 17 ← 17–25، 21 ← 29–34، 25–27 ← 38–50، 31 ← 54–58، 33–34 ← 60–81، 66 ← 113–120، 69 ← 123–124، 91 ← 146–148، 93–105 ← 150–171، 107 ← 173–175، 115 ← 183–187، 118 ← 190–194 … (٢١ موضعاً) |
| `client/src/components/CustomersDirectory.tsx` | عُدّل | 215 | 50 | 9 ← 9–18، 56–75 ← 65–93، 78 ← 96–103، 93–98 ← 118–129، 103 ← 134–136، 114–115 ← 147–157، 119 ← 161–168، 122 ← 171–177، 125 ← 180–186، 127 ← 188–194، 129–131 ← 196–210، 134 ← 213–216 … (١٩ موضعاً) |
| `client/src/components/DashboardOverview.tsx` | عُدّل | 75 | 17 | 13 ← 13–22، 39 ← 48–50، 43 ← 54–64، 49–51 ← 70–78، 60 ← 87–89، 63–64 ← 92–99، 68 ← 103–105، 80 ← 117–119، 85 ← 124–131، 91 ← 137–140، 98 ← 147–149، 116 ← 167–169 … (١٤ موضعاً) |
| `client/src/components/DeleteConfirmSheet.tsx` | عُدّل | 281 | 64 | 62 ← 62–67، 76–77 ← 81–92، 79–82 ← 94–117، 100 ← 135، 110 ← 145–147، 112 ← 149–151، 116 ← 155–160، 159 ← 203–207، 163 ← 211–216، 166–167 ← 219–226، 252–254 ← 311–315، 265 ← 326–327 … (٤٤ موضعاً) |
| `client/src/components/DeliveryCenter.tsx` | عُدّل | 311 | 56 | 23–25 ← 23–53، 28 ← 56–60، 30 ← 62–65، 67–69 ← 102–110، 71 ← 112–114، 77 ← 120–123، 80–81 ← 126–130، 85 ← 134–140، 88–93 ← 143–177، 95–97 ← 179–218، — ← 220–232، 100–107 ← — … (١٦ موضعاً) |
| `client/src/components/DeliveryRatesManager.tsx` | عُدّل | 111 | 22 | 16 ← 16–22، 20 ← 26–30، 22 ← 32–37، 32 ← 47–49، 39 ← 56–58، 42 ← 61–67، 47 ← 72–74، 54–55 ← 81–88، 78 ← 111–115، 86 ← 123–125، 88–91 ← 127–151، 94 ← 154–160 … (١٨ موضعاً) |
| `client/src/components/DemoBanner.tsx` | عُدّل | 24 | 6 | 17 ← 17–18، 35–36 ← 36–41، 42 ← 47–51، 50 ← 59–64، 60 ← 74–78 |
| `client/src/components/EmailComplaintsSection.tsx` | عُدّل | 90 | 18 | 9 ← 9–16، 14 ← 21–27، 20 ← 33–38، 34–35 ← 52–57، 44 ← 66–68، 47–49 ← 71–80، 51–53 ← 82–104، 55–57 ← 106–118، 63 ← 124–130، 65 ← —، 70 ← 136–142 |
| `client/src/components/ErrorBoundary.tsx` | عُدّل | 1 | 4 | 29–32 ← 29 |
| `client/src/components/FinanceCenter.tsx` | عُدّل | 307 | 54 | 11–12 ← 11–25، 14–15 ← 27–49، 22 ← 56–57، 28 ← 63–67، 36 ← 75–78، 46 ← 88–91، 48 ← 93–98، 57 ← 107–109، 66 ← 118–122، 72 ← 128–130، 80 ← 138–140، 92 ← 152–154 … (٣٦ موضعاً) |
| `client/src/components/GuestPasswordCard.tsx` | عُدّل | 55 | 10 | 22 ← 22–23، 28–29 ← 29–33، 32–34 ← 36–56، 36–38 ← 58–79، 40 ← 81–85 |
| `client/src/components/InventoryMovementsPanel.tsx` | عُدّل | 118 | 36 | 31 ← 31–37، 37 ← 43–48، 41 ← 52–55، 53–68 ← 67–89، 70 ← 91–93، 73 ← 96–99، 76–77 ← 102–108، 87 ← 118–122، 92–94 ← 127–143، 97 ← 146–149، 99 ← 151–155، 103–104 ← 159–173 … (١٥ موضعاً) |
| `client/src/components/LoadMoreButton.tsx` | عُدّل | 5 | 1 | 51 ← 51–55 |
| `client/src/components/LoyaltyRedeem.tsx` | عُدّل | 48 | 11 | 37 ← 37–41، 53–54 ← 57–72، 59–60 ← 77–82، 62–63 ← 84–89، 69–70 ← 95–100، 102 ← 132–136، 110 ← 144–147 |
| `client/src/components/LoyaltySettingsCard.tsx` | عُدّل | 99 | 25 | 34 ← 34–40، 38 ← 44–48، 40 ← 50–55، 68 ← 83–85، 73–74 ← 90–95، 92 ← 113–117، 100–101 ← 125–133، 103–105 ← 135–139، 115 ← 149–150، 129 ← 164–167، 136 ← 174–179، 142 ← 185–188 … (١٩ موضعاً) |
| `client/src/components/ManualCustomerForm.tsx` | عُدّل | 80 | 15 | 8 ← 8–14، 11 ← 17–21، 13–17 ← 23–50، 20–27 ← 53–92 |
| `client/src/components/ManualMerchantForm.tsx` | عُدّل | 83 | 19 | 16 ← 16–17، 22 ← 23–30، 26 ← 34–37، 28–29 ← 39–46، 32–36 ← 49–60، 39–47 ← 63–111 |
| `client/src/components/MarketCatalogPanel.tsx` | عُدّل | 447 | 70 | 12 ← 12–15، 15–17 ← 18–35، 21–22 ← 39–45، 26 ← 49–53، 32 ← 59–71، 34 ← 73–78، 39 ← 83–87، 47 ← 95–97، 55–60 ← 105–115، 64 ← 119–121، 70 ← 127–131، 73 ← 134–135 … (٤٢ موضعاً) |
| `client/src/components/MarketDealsPanel.tsx` | عُدّل | 203 | 28 | 10–12 ← 10–34، 15 ← 37–42، 17 ← 44–52، 20 ← 55–59، 34 ← 73–80، 38 ← 84–88، 44–46 ← 94–108، 49 ← 111–119، 51 ← 121–126، 54–57 ← 129–153، 59–61 ← 155–168، 65 ← 172–176 … (١٦ موضعاً) |
| `client/src/components/MarketProfilePanel.tsx` | عُدّل | 410 | 78 | 8 ← 8–18، 16–17 ← 26–54، 19–20 ← —، 23 ← 58–60، 27–31 ← 64–83، 35 ← 87–94، 41 ← 100–108، 56 ← 123–125، 64 ← 133–136، 68–69 ← 140–145، 73–74 ← 149–159، 78–80 ← 163–172 … (٤٨ موضعاً) |
| `client/src/components/MarketReelsPanel.tsx` | عُدّل | 190 | 31 | 10 ← 10–19، 12–14 ← 21–29، 17 ← 32–39، 33 ← 55–61، 37 ← 65–69، 44 ← 76–79، 50–51 ← 85–93، 54 ← 96–105، 59–68 ← 110–175، 70 ← 177–181، 73 ← 184–191، 77 ← 195–199 … (١٥ موضعاً) |
| `client/src/components/MarketingIntegrationsPanel.tsx` | عُدّل | 179 | 32 | 13 ← 13–18، 30 ← 35–36، 32–33 ← 38–57، 45 ← 69–71، 57 ← 83–85، 60 ← 88–90، 71 ← 101–106، 76–77 ← 111–115، 80–91 ← 118–125، 93–99 ← 127–135، 101–103 ← 137–250 |
| `client/src/components/MerchantAnalytics.tsx` | عُدّل | 410 | 76 | 10 ← 10–23، 16 ← 29–36، 23 ← 43–48، 26 ← 51–59، 28–29 ← 61–77، 35 ← 83–87، 38–39 ← 90–102، 41 ← —، 56 ← 118–119، 73–74 ← 136–147، 77 ← 150–155، 79 ← 157–165 … (٤٦ موضعاً) |
| `client/src/components/MerchantAvailabilityBanner.tsx` | عُدّل | 93 | 16 | 13–14 ← 13–31، 17–18 ← 34–44، 24 ← 50–53، 29–30 ← 58–65، 40 ← 75–78، 46 ← 84–88، 48 ← 90–95، 51 ← 98–104، 53 ← 106–111، 58–59 ← 116–126، 61 ← 128–134، 63 ← 136–140 |
| `client/src/components/MerchantCommandPalette.tsx` | عُدّل | 236 | 63 | 15 ← 15–22، 22–23 ← 29–45، 32 ← 54–60، 34–35 ← 62–73، 39–40 ← 77–84، 53 ← 97–102، 76 ← 125–130، 91 ← 145–152، 94 ← 155–159، 99 ← 164–167، 102–103 ← 170–181، 106 ← 184–187 … (١٩ موضعاً) |
| `client/src/components/MerchantConfigPanel.tsx` | عُدّل | 204 | 43 | 16–17 ← 16–24، 19 ← 26–29، 23 ← 33–37، 29–30 ← 43–52، 33 ← 55–56، 45–46 ← 68–75، 48 ← 77–79، 54–55 ← 85–95، 58–59 ← 98–102، 62–90 ← 105–251 |
| `client/src/components/MerchantFinancePanel.tsx` | عُدّل | 153 | 29 | 12–14 ← 12–39، 19 ← 44–47، 26 ← 54–56، 40 ← 70–72، 46 ← 78–79، 55 ← 88–90، 60 ← 95–98، 76 ← 114–116، 78–80 ← 118–145، 83–84 ← 148–157، 89 ← 162–165، 92 ← 168–171 … (٢١ موضعاً) |
| `client/src/components/MerchantHome.tsx` | عُدّل | 917 | 111 | 10 ← 10–36، 16 ← 42–49، 18–19 ← 51–64، 26 ← 71–74، 28–29 ← 76–95، 34–36 ← 100–128، 40 ← 132–134، 47–49 ← 141–162، 51 ← 164–169، 54 ← 172–179، 57 ← 182–194، 59–61 ← 196–208 … (٥٤ موضعاً) |
| `client/src/components/MerchantMonthlyReport.tsx` | عُدّل | 140 | 28 | 15 ← 15–22، 24 ← 31–36، 26 ← 38–44، 32–34 ← 50–61، 36 ← 63–71، 52–54 ← 87–101، 71 ← 118–121، 80 ← 130–132، 85 ← 137–139، 89 ← 143–149، 91 ← 151–158، 95–96 ← 162–171 … (٢٠ موضعاً) |
| `client/src/components/MerchantOnboarding.tsx` | عُدّل | 132 | 29 | 18 ← 18–22، 24 ← 28–34، 28–32 ← 38–62، 37 ← 67–73، 40 ← 76–78، 54 ← 92–94، 59 ← 99–102، 69 ← 112–116، 72 ← 119–121، 75 ← 124–126، 78–79 ← 129–138، 84 ← 143–146 … (١٨ موضعاً) |
| `client/src/components/MerchantPaymentsPanel.tsx` | عُدّل | 193 | 28 | 15 ← 15–26، 18 ← 29–36، 24 ← 42–50، 30 ← 56–60، 32–36 ← 62–80، 39 ← 83–86، 42–43 ← 89–99، 47 ← 103–120، 51–55 ← 124–176، 58 ← 179–183، 66 ← 191–193، 69–70 ← 196–202 … (١٤ موضعاً) |
| `client/src/components/MerchantServicesPanel.tsx` | عُدّل | 119 | 29 | 11–12 ← 11–25، 28 ← 41–46، 31 ← 49–50، 43 ← 62–65، 46–48 ← 68–74، 50 ← 76–78، 52–56 ← 80–110، 58–72 ← 112–162 |
| `client/src/components/MerchantStoreSwitcher.tsx` | عُدّل | 188 | 40 | 10–12 ← 10–15، 20 ← 23–27، 24 ← 31–37، 33 ← 46–48، 43 ← 58–61، 49 ← 67، 73 ← 91، 77 ← 95، 92 ← 110–111، 95 ← 114، 99 ← 118، 110–112 ← 129–143 … (١٦ موضعاً) |
| `client/src/components/MerchantWalletCard.tsx` | عُدّل | 74 | 14 | 19 ← 19–27، 24 ← 32–35، 34 ← 45–47، 37 ← 50–53، 42 ← 58–60، 45–46 ← 63–74، 56–57 ← 84–89، 64 ← 96–98، 75 ← 109–111، 86–88 ← 122–148 |
| `client/src/components/MerchantsDirectory.tsx` | عُدّل | 238 | 41 | 9 ← 9–19، 26 ← 36–40، 53–54 ← 67–72، 56 ← 74–76، 73 ← 93–95، 90–93 ← 112–120، 109–110 ← 136–144، 122 ← 156–160، 126–129 ← 164–178، 135–136 ← 184–195، 140 ← 199–205، 142–145 ← 207–226 … (٢٣ موضعاً) |
| `client/src/components/NotificationCenter.tsx` | عُدّل | 286 | 49 | 11 ← 11–26، 21 ← 36–40، 24 ← 43–49، 39 ← 64–70، 106 ← 137–141، 110 ← 145–151، 114 ← 155–159، 116 ← 161–166، 127 ← 177–179، 140 ← 192–198، 146 ← 204–206، 148 ← 208–214 … (٣٨ موضعاً) |
| `client/src/components/OrderPrintSheet.tsx` | عُدّل | 209 | 45 | 16 ← 16–24، 18–22 ← 26–44، 28 ← 50–56، 33 ← 61–65، 36 ← 68–75، 38 ← 77–81، 40 ← 83–93، 49 ← 102–105، 52 ← 108–111، 57 ← 116–118، 65 ← 126–128، 67–68 ← 130–145 … (٣٠ موضعاً) |
| `client/src/components/OrderWorkspace.tsx` | عُدّل | 2002 | 361 | 3 ← 3–24، 8 ← 29–37، 13–14 ← 42–53، 16 ← 55–64، 22–25 ← 70–90، 29–30 ← 94–111، 34–36 ← 115–136، 78 ← 178–181، 86–87 ← 189–196، 98 ← 207–209، 105–107 ← 216–227، 112 ← 232–238 … (٩٥ موضعاً) |
| `client/src/components/OwnerAccountPanels.tsx` | عُدّل | 394 | 77 | 29 ← 29–37، 36 ← 44–48، 54 ← 66–67، 57 ← 70–71، 65 ← 79–82، 73 ← 90–93، 115 ← 135–139، 129 ← 153–155، 135 ← 161–163، 145 ← 173–176، 150 ← 181–185، 156 ← 191–193 … (٦٠ موضعاً) |
| `client/src/components/OwnerHome.tsx` | عُدّل | 153 | 30 | 3 ← 3–15، 32–33 ← 44–53، 42 ← 62–64، 48–49 ← 70–74، 54 ← 79–89، 58 ← 93–98، 64 ← 104–114، 67–68 ← 117–122، 89–91 ← 143–151، 99 ← 159–165، 104 ← 170–173، 107 ← 176–181 … (٢٢ موضعاً) |
| `client/src/components/PlansManager.tsx` | عُدّل | 284 | 58 | 8 ← 8–17، 37 ← 46–50، 43 ← 56–66، 46 ← 69–71، 55–62 ← 80–92، 64–66 ← 94–98، 84–87 ← 116–124، 101–102 ← 138–145، 112 ← 155–158، 116 ← 162–164، 119–120 ← 167–180، 125 ← 185–191 … (٣٥ موضعاً) |
| `client/src/components/PlatformConfigPanel.tsx` | عُدّل | 155 | 35 | 12–13 ← 12–23، 17 ← 27–31، 23–24 ← 37–46، 32–33 ← 54–58، 35 ← 60–62، 41–42 ← 68–76، 45–46 ← 79–83، 49–71 ← 86–191 |
| `client/src/components/PlatformLogoSection.tsx` | عُدّل | 69 | 17 | 26 ← 26–30، 28 ← 32–33، 30 ← 35–37، 48 ← 55–59، 50 ← 61–63، 54 ← 67–68، 62–63 ← 76–81، 74 ← 92–96، 76–77 ← 98–106، 80–81 ← 109–118، 87–88 ← 124–138، 91 ← — … (١٣ موضعاً) |
| `client/src/components/PlatformMaintenancePanel.tsx` | عُدّل | 641 | 121 | 21–23 ← 21–44، 25 ← —، 27–28 ← 47–58، 32 ← 62–66، 38 ← 72–73، 40–44 ← 75–105، 48 ← 109–113، 50 ← 115–119، 55 ← 124–135، 57–64 ← 137–153، 69 ← 158–164، 74–75 ← 169–174 … (٣٠ موضعاً) |
| `client/src/components/PlatformMarketCampaignsPanel.tsx` | عُدّل | 475 | 56 | 10 ← 10–22، 14 ← 26–41، 16 ← —، 19 ← 45–49، 24–26 ← 54–61، 28 ← 63–69، 35–38 ← 76–105، 41–43 ← 108–123، 47–49 ← 127–152، 54–59 ← 157–211، 61 ← 213–219، 64 ← 222–226 … (٢٦ موضعاً) |
| `client/src/components/PlatformMarketContentPanel.tsx` | عُدّل | 1119 | 139 | 8 ← 8–18، 13 ← 23–27، 17 ← 31–38، 23–25 ← 44–53، 32 ← 60–69، 37–38 ← 74–87، 40 ← 89–96، 42–44 ← 98–124، 53–54 ← 133–148، 56–57 ← 150–159، 59–63 ← 161–185، 69–72 ← 191–218 … (٦٧ موضعاً) |
| `client/src/components/PlatformMarketCouponsPanel.tsx` | عُدّل | 260 | 39 | 9–10 ← 9–34، 13 ← 37–41، 18–19 ← 46–49، 21 ← 51–62، 33 ← 74–76، 35 ← 78–80، 38 ← 83–86، 40–49 ← 88–118، 52 ← 121–129، 58 ← 135–148، 61–62 ← 151–166، 65 ← 169–171 … (١٦ موضعاً) |
| `client/src/components/PlatformMarketImageIndexPanel.tsx` | عُدّل | 86 | 16 | 14 ← 14–18، 26 ← 30–34، 28 ← 36–38، 32 ← 42–45، 34 ← 47–49، 36 ← 51–56، 41–42 ← 61–73، 44–46 ← 75–84، 48–50 ← 86–109، 54–55 ← 113–125 |
| `client/src/components/PlatformMarketPanel.tsx` | عُدّل | 280 | 41 | 13–15 ← 13–31، 26 ← 42–46، 34 ← 54–55، 46 ← 67–69، 51 ← 74–77، 54–55 ← 80–91، 61 ← 97–99، 64–65 ← 102–114، 69 ← 118–126، 76–77 ← 133–140، 82–83 ← 145–165، 86–89 ← 168–190 … (٢٢ موضعاً) |
| `client/src/components/PlatformMarketPaymentsPanel.tsx` | عُدّل | 124 | 21 | 10 ← 10–24، 12 ← 26–33، 26–32 ← 47–65، 35–37 ← 68–86، 39 ← 88–97، 41 ← 99–103، 44 ← 106–115، 47–48 ← 118–125، 50–51 ← 127–144، 53 ← 146–148، 60 ← 155–163 |
| `client/src/components/PlatformMarketReelsPanel.tsx` | عُدّل | 159 | 31 | 9–11 ← 9–25، 14 ← 28–32، 27 ← 45–52، 29 ← 54–57، 32–34 ← 60–70، 38–39 ← 74–89، 41 ← 91–100، 43–57 ← 102–116، 59–62 ← 118–190 |
| `client/src/components/PlatformMarketSupportPanel.tsx` | عُدّل | 501 | 65 | 12 ← 12–17، 15 ← 20–24، 20–21 ← 29–32، 28 ← 39–48، 32 ← 52–67، 34–36 ← 69–93، 43 ← 100–108، 45 ← 110–115، 50 ← 120–125، 52 ← 127–129، 54 ← 131–139، 56 ← 141–143 … (٣٥ موضعاً) |
| `client/src/components/PlatformMarketWheelPanel.tsx` | عُدّل | 444 | 46 | 10–12 ← 10–49، 16 ← 53–57، 21–23 ← 62–71، 31 ← 79–86، 33–34 ← 88–94، 41–42 ← 101–112، 45 ← 115–117، 47–48 ← 119–132، 50–51 ← 134–151، 57–58 ← 157–172، 61–62 ← 175–193، 70 ← 201–216 … (١٧ موضعاً) |
| `client/src/components/PlatformModulesPanel.tsx` | عُدّل | 55 | 19 | 9 ← 9–15، 32 ← 38–41، 37–38 ← 46–57، 44 ← 63–64، 47–48 ← 67–73، 50–54 ← 75–96، 56–62 ← 98 |
| `client/src/components/PlatformPulse.tsx` | عُدّل | 150 | 31 | 3 ← 3–12، 26 ← 35–38، 31 ← 43–55، 44 ← 68–72، 72–74 ← 100–108، 83 ← 117–119، 87 ← 123–125، 96–98 ← 134–137، 103 ← 142–145، 106 ← 148–156، 113 ← 163–171، 116–119 ← 174–200 … (٢١ موضعاً) |
| `client/src/components/PlatformServicesPanel.tsx` | عُدّل | 712 | 129 | 24–27 ← 24–59، 30 ← 62–66، 36–40 ← 72–104، 47–48 ← 111–115، 50 ← 117–119، 55 ← 124–127، 58–59 ← 130–134، 63–81 ← 138–172، 83–86 ← 174–227، 93–100 ← 234–263، 105 ← 268–272، 108 ← 275–276 … (٢٨ موضعاً) |
| `client/src/components/PlatformSettingsPanel.tsx` | عُدّل | 88 | 16 | 13 ← 13–17، 33 ← 37–39، 38 ← 44–47، 50–52 ← 59–71، 55–57 ← 74–94، 60 ← 97–103، 65 ← 108–118، 69 ← 122–124، 73 ← 128–130، 88–90 ← 145–162 |
| `client/src/components/PlatformStoresDirectory.tsx` | عُدّل | 239 | 42 | 8 ← 8–17، 30–32 ← 39–50، 37 ← 55–59، 62 ← 84–86، 73 ← 97–99، 79–88 ← 105–132، 101 ← 145–151، 107–108 ← 157–167، 112 ← 171–177، 114–117 ← 179–201، 120 ← 204–207، 124–125 ← 211–222 … (١٩ موضعاً) |
| `client/src/components/PlatformTeamManager.tsx` | عُدّل | 413 | 134 | 7 ← 7–17، 52–53 ← 62–70، 79 ← 96–102، 83 ← 106–110، 86 ← 113–118، 92 ← 124–125، 98 ← 131–139، 102 ← 143–144، 107 ← 149–152، 112 ← 157–160، 163 ← 211–213، 173 ← 223–225 … (٢٦ موضعاً) |
| `client/src/components/PosDevicesPanel.tsx` | عُدّل | 99 | 35 | 26 ← 26–33، 118 ← 125–130، 133 ← 145–147، 198 ← 212–213، 211 ← 226–229، 215 ← 233–236، 225 ← 246–250، 250 ← 275–277، 280 ← 307–309، 296 ← 325–327، 335–352 ← 366–392، 354 ← 394–396 … (١٨ موضعاً) |
| `client/src/components/ProductCard.tsx` | عُدّل | 83 | 18 | 13 ← 13–16، 19–20 ← 22–29، 26 ← 35–45، 29 ← 48–51، 32–37 ← 54–84، 39–40 ← 86–91، 42–46 ← 93–111 |
| `client/src/components/ProductCatalogManager.tsx` | عُدّل | 1234 | 135 | 2 ← 2–6، 6 ← 10–25، 12–13 ← 31–41، 15 ← 43–48، 17 ← 50–65، 46 ← 94–96، 64–65 ← 114–128، 83 ← 146–156، 92 ← 165–168، 106–120 ← 182–206، 138 ← 224–227، 147 ← 236–244 … (٤٦ موضعاً) |
| `client/src/components/ProductRail.tsx` | عُدّل | 62 | 8 | 11 ← 11–17، 15 ← 21–29، 20 ← 34–37، 22 ← 39–47، 27 ← 52–68، 35–36 ← 76–85، 40 ← 89–94 |
| `client/src/components/ProductReviews.tsx` | عُدّل | 151 | 29 | 18–19 ← 18–33، 22 ← 36–39، 27 ← 44–48، 29 ← 50–54، 35 ← 60–68، 72 ← 105–107، 93–94 ← 128–139، 98 ← 143–145، 107–108 ← 154–160، 115 ← 167–170، 118 ← 173–176، 129 ← 187–192 … (٢٢ موضعاً) |
| `client/src/components/ProductShareCard.tsx` | عُدّل | 118 | 19 | 34 ← 34–39، 40 ← 45–50، 47 ← 57–60، 60 ← 73–80، 70 ← 90–100، 86 ← 116–120، 121 ← 155–161، 155 ← 195–197، 163 ← 205–213، 165 ← 215–217، 184–185 ← 236–245، 195 ← 255–262 … (١٥ موضعاً) |
| `client/src/components/RegistrationCenter.tsx` | عُدّل | 148 | 24 | 10 ← 10–18، 13 ← 21–25، 37 ← 49–51، 40 ← 54–56، 49 ← 65–67، 55 ← 73–76، 57 ← 78–82، 69–70 ← 94–102، 82–83 ← 114–121، 86–88 ← 124–146، 95–96 ← 153–163، 98–100 ← 165–180 … (١٦ موضعاً) |
| `client/src/components/ReturnInspectionCard.tsx` | عُدّل | 144 | 52 | 61–79 ← 61–84، 105 ← 110–113، 108 ← 116–119، 123 ← 134–140، 128–129 ← 145–154، 147 ← 172–174، 151 ← 178–179، 158–159 ← 186–198، 161 ← 200–205، 169 ← 213–216، 173 ← 220–221، 177–178 ← 225–236 … (٢٠ موضعاً) |
| `client/src/components/ReturnInspectionHistory.tsx` | عُدّل | 113 | 33 | 32–34 ← 32–43، 38 ← 47–53، 44 ← 59–64، 55–67 ← 75–92، 69 ← 94–96، 72–74 ← 99–109، 76–78 ← 111–125، 81 ← 128–131، 89–90 ← 139–148، 93 ← 151–164، 95–96 ← —، 98 ← 167–171 … (١٣ موضعاً) |
| `client/src/components/ReturnsQueue.tsx` | عُدّل | 175 | 54 | 20–21 ← 20–26، 27 ← 32–35، 31–32 ← 39–46، 34 ← 48–51، 48–65 ← 65–90، 70–75 ← 95–103، 92–93 ← 120–130، 98–99 ← 135–137، 102–104 ← 140–154، 108 ← 158–161، 112 ← 165–168، 115–117 ← 171–179 … (٢٠ موضعاً) |
| `client/src/components/ReviewModeration.tsx` | عُدّل | 142 | 34 | 18 ← 18–23، 24 ← 29–32، 35 ← 43–46، 44 ← 55–57، 49–54 ← 62–70، 71–72 ← 87–97، 77–79 ← 102–105، 82–84 ← 108–122، 88 ← 126–129، 91–92 ← 132–146، 94–96 ← 148–155، 99–100 ← 158–166 … (١٧ موضعاً) |
| `client/src/components/RoadmapPanel.tsx` | عُدّل | 4 | 2 | 31 ← 31، 63 ← 63–65 |
| `client/src/components/StockForecastPanel.tsx` | عُدّل | 62 | 15 | 19–20 ← 19–27، 33 ← 40–43، 42 ← 52–54، 47–48 ← 59–69، 51–52 ← 72–81، 58 ← 87–88، 63 ← 93–96، 65 ← 98–100، 68–69 ← 103–113، 72 ← 116–118، 81 ← 127–128 |
| `client/src/components/StoreMessagingCapsPanel.tsx` | عُدّل | 120 | 23 | 14 ← 14–18، 17 ← 21–27، 21 ← 31–35، 23 ← 37–42، 28–30 ← 47–67، 35 ← 72–76، 45 ← 86–90، 52 ← 97–99، 54–55 ← 101–109، 64 ← 118–121، 74 ← 131–137، 77–80 ← 140–156 … (١٦ موضعاً) |
| `client/src/components/StoreTeamManager.tsx` | عُدّل | 317 | 60 | 6 ← 6–14، 12 ← 20–25، 53 ← 66–72، 57 ← 76–80، 60 ← 83–88، 66–67 ← 94–97، 73–74 ← 103–114، 79 ← 119–122، 84 ← 127–130، 110 ← 156–163، 128 ← 181–186، 143 ← 201–203 … (٣٩ موضعاً) |
| `client/src/components/StoreVerificationPanel.tsx` | عُدّل | 124 | 29 | 13 ← 13–19، 26 ← 32–35، 34 ← 43–45، 45 ← 56–59، 55 ← 69–71، 60–65 ← 76–87، 78–79 ← 100–111، 85–86 ← 117–122، 89 ← 125–127، 91 ← 129–131، 95 ← 135–139، 99 ← 143–146 … (٢٠ موضعاً) |
| `client/src/components/StorefrontFooter.tsx` | عُدّل | 205 | 24 | 11 ← 11–25، 28 ← 42–46، 30 ← 48–54، 43–44 ← 67–79، 47–49 ← 82–112، 56–59 ← 119–160، 62–65 ← 163–206، 67–68 ← 208–229، 72 ← 233–237، 78–79 ← 243–251، 84 ← 256–258، 89–90 ← 263–271 |
| `client/src/components/StorefrontProvider.tsx` | عُدّل | 103 | 21 | 3 ← 3–10، 7 ← 14–18، 12–13 ← 23–28، 23 ← 38–44، 31 ← 52–56، 33–34 ← 58–65، 38–40 ← 69–75، 42 ← 77–79، 52–58 ← 89–109، 62–63 ← 113–145 |
| `client/src/components/StorefrontSettingsPanel.tsx` | عُدّل | 1197 | 157 | 14 ← 14–34، 18 ← 38–49، 22–27 ← 53–76، 31–32 ← 80–93، 35 ← 96–104، 40 ← 109–116، 42 ← 118–123، 46–47 ← 127–130، 50–51 ← 133–159، 54–55 ← 162–193، 63–67 ← 201–219، 72 ← 224–232 … (٦٦ موضعاً) |
| `client/src/components/StorefrontShell.tsx` | عُدّل | 584 | 113 | 10 ← 10–31، 13–14 ← 34–48، 41 ← 75–78، 45 ← 82–90، 48 ← 93–99، 60–61 ← 111–121، 64 ← 124–130، 70 ← 136–147، 88 ← 165–167، 91–92 ← 170–185، 102 ← 195–197، 104–105 ← 199–209 … (١٩ موضعاً) |
| `client/src/components/StorefrontStates.tsx` | عُدّل | 67 | 3 | 4–6 ← 4–70 |
| `client/src/components/StoresManager.tsx` | عُدّل | 559 | 118 | 12 ← 12–23، 21–24 ← 32–39، 36–38 ← 51–59، 41 ← 62–68، 56 ← 83–85، 74 ← 103–105، 76–77 ← 107–121، 82 ← 126–133، 85–87 ← 136–150، 90 ← 153–156، 95 ← 161–165، 97 ← 167–169 … (٥٣ موضعاً) |
| `client/src/components/SubscriptionPanel.tsx` | عُدّل | 128 | 34 | 7 ← 7–14، 11 ← 18–22، 43 ← 54–56، 70–71 ← 83–93، 73–74 ← 95–104، 77 ← 107–110، 79 ← 112–114، 83 ← 118–124، 85–86 ← 126–132، 89 ← 135–145، 93 ← 149–152، 97 ← 156–159 … (١٨ موضعاً) |
| `client/src/components/SubscriptionsManager.tsx` | عُدّل | 71 | 15 | 23 ← 23–27، 50 ← 54–56، 57 ← 63–66، 70–71 ← 79–89، 73–76 ← 91–111، 79 ← 114–118، 82 ← 121–123، 85–87 ← 126–139، 96 ← 148–152 |
| `client/src/components/SupportTicketsWorkspace.tsx` | عُدّل | 385 | 59 | 10–12 ← 10–39، 15 ← 42–49، 20–22 ← 54–68، 24 ← 70–76، 26 ← 78–81، 33–43 ← 88–110، 45 ← 112–123، 49–50 ← 127–147، 52 ← 149–153، 54 ← 155–159، 58 ← 163–168، 60–61 ← 170–188 … (٢٩ موضعاً) |
| `client/src/components/TrashBin.tsx` | عُدّل | 329 | 93 | 19 ← 19–28، 58 ← 67–70، 109 ← 121–125، 122 ← 138–140، 128 ← 146–150، 140 ← 162–168، 158–177 ← 186–214، 179 ← 216–219، 181 ← 221–223، 194 ← 236–239، 215 ← 260–268، 223 ← 276–278 … (٤٦ موضعاً) |
| `client/src/components/UpgradeRequestsPanel.tsx` | عُدّل | 141 | 28 | 26–27 ← 26–33، 31 ← 37–41، 37 ← 47–55، 40 ← 58–61، 43–44 ← 64–69، 47–48 ← 72–79، 50 ← 81–83، 52 ← 85–89، 54 ← 91–94، 57–58 ← 97–115، 84–85 ← 141–148، 96 ← 159–161 … (١٨ موضعاً) |
| `client/src/components/VariantManager.tsx` | عُدّل | 581 | 103 | 41–42 ← 41–49، 47–48 ← 54–68، 51–52 ← 71–88، 55 ← 91–102، 59 ← 106–108، 62–82 ← 111–250، 85 ← 253–261، 88–92 ← 264–289، 96–100 ← 293–311، 105–108 ← 316–335، 111 ← 338–348، 123–125 ← 360–367 … (٢٩ موضعاً) |
| `client/src/components/WishlistButton.tsx` | عُدّل | 42 | 11 | 18–19 ← 18–29، 27–30 ← 37–47، 38–41 ← 55–66، 55 ← 80–86 |
| `client/src/components/landing/DeviceShowcase.tsx` | عُدّل | 82 | 10 | 45 ← 45–55، 77 ← 87، 119 ← 129–138، 128 ← 147–155، 143 ← 170–179، 148 ← 184–193، 169–170 ← 214–233، 197 ← 260–266، 206 ← 275–278 |
| `client/src/components/landing/Faq.tsx` | عُدّل | 13 | 3 | 87 ← 87–90، 96 ← 99–104، 98 ← 106–108 |
| `client/src/components/landing/HeroMotif.tsx` | عُدّل | 44 | 5 | 26 ← 26–32، 50 ← 56–64، 74–75 ← 88–108، 87 ← 120–126 |
| `client/src/components/landing/OrderRail.tsx` | عُدّل | 3 | 1 | 40 ← 40–42 |
| `client/src/components/landing/PanelDiagram.tsx` | عُدّل | 74 | 8 | 23–24 ← 23–40، 56 ← 72–81، 69–70 ← 94–111، 79 ← 120–129، 83–84 ← 133–150 |
| `client/src/components/landing/Reveal.tsx` | عُدّل | 8 | 1 | 23 ← 23–30 |
| `client/src/components/ui/accordion.tsx` | عُدّل | 1 | 3 | 7–9 ← 7 |
| `client/src/components/ui/alert-dialog.tsx` | عُدّل | 8 | 30 | 7–9 ← 7، 16–18 ← 14، 21–26 ← 17–18، 64–67 ← 56، 77–80 ← 66، 84–87 ← 70، 123–128 ← 106 |
| `client/src/components/ui/alert.tsx` | عُدّل | 2 | 8 | 41–44 ← 41، 50–53 ← 47 |
| `client/src/components/ui/aspect-ratio.tsx` | عُدّل | 1 | 3 | 3–5 ← 3 |
| `client/src/components/ui/avatar.tsx` | عُدّل | 4 | 16 | 6–9 ← 6، 13–16 ← 10، 22–25 ← 16، 42–45 ← 33 |
| `client/src/components/ui/badge.tsx` | عُدّل | 4 | 11 | 12–13 ← 12، 18–19 ← 17، 33–34 ← 31، 38–42 ← 35 |
| `client/src/components/ui/breadcrumb.tsx` | عُدّل | 2 | 9 | 65–69 ← 65، 83–86 ← 79 |
| `client/src/components/ui/button-group.tsx` | عُدّل | 1 | 6 | 78–83 ← 78 |
| `client/src/components/ui/calendar.tsx` | عُدّل | 11 | 47 | 2–6 ← 2، 37–38 ← 33، 43–46 ← 38، 74–77 ← 66، 92–95 ← 81، 104–107 ← 90، 118–121 ← 101، 127–134 ← 107، 138–140 ← 111، 144–149 ← 115، 152–154 ← 118 |
| `client/src/components/ui/card.tsx` | عُدّل | 3 | 20 | 55–58 ← 55، 65–71 ← 62، 84–92 ← 75 |
| `client/src/components/ui/carousel.tsx` | عُدّل | 4 | 15 | 2–4 ← 2، 111–112 ← 109، 137–141 ← 134، 143–147 ← 136 |
| `client/src/components/ui/checkbox.tsx` | عُدّل | 1 | 4 | 7–10 ← 7 |
| `client/src/components/ui/collapsible.tsx` | عُدّل | 3 | 15 | 3–5 ← 3، 12–17 ← 10، 23–28 ← 16 |
| `client/src/components/ui/command.tsx` | عُدّل | 8 | 31 | 16–19 ← 16، 68–71 ← 65، 85–88 ← 79، 92–95 ← 83، 101–103 ← 89، 142–145 ← 128، 158–161 ← 141، 165–168 ← 145 |
| `client/src/components/ui/context-menu.tsx` | عُدّل | 11 | 39 | 7–9 ← 7، 16–18 ← 14، 21–26 ← 17–18، 29–34 ← 21–22، 37–39 ← 25، 46–51 ← 32، 196–199 ← 177، 218–221 ← 196، 225–228 ← 200 |
| `client/src/components/ui/dialog.tsx` | عُدّل | 8 | 24 | 19–20 ← 19، 22–24 ← 21، 56–58 ← 53، 62–64 ← 57، 68–70 ← 61، 163–166 ← 154، 172–175 ← 160، 208 ← 193، 210 ← — |
| `client/src/components/ui/drawer.tsx` | عُدّل | 5 | 16 | 6–8 ← 6، 12–14 ← 10، 18–20 ← 14، 24–26 ← 18، 96–99 ← 88 |
| `client/src/components/ui/dropdown-menu.tsx` | عُدّل | 10 | 39 | 7–9 ← 7، 16–18 ← 14، 24–29 ← 20، 52–57 ← 43–44، 112–117 ← 99، 155–158 ← 137، 177–180 ← 156، 184–187 ← 160، 193–195 ← 166 |
| `client/src/components/ui/empty.tsx` | عُدّل | 2 | 12 | 22–25 ← 22، 97–104 ← 94 |
| `client/src/components/ui/field.tsx` | عُدّل | 22 | 34 | 55–71 ← 55–68، 73–77 ← 70–74، 99–102 ← 96، 108–111 ← 102، 207–210 ← 198 |
| `client/src/components/ui/form.tsx` | عُدّل | 6 | 22 | 28–30 ← 28، 72–74 ← 70، 81–85 ← 77، 90–93 ← 82، 108–109 ← 97، 115–119 ← 103 |
| `client/src/components/ui/hover-card.tsx` | عُدّل | 3 | 9 | 6–8 ← 6، 12–17 ← 10–11 |
| `client/src/components/ui/input-group.tsx` | عُدّل | 17 | 29 | 42–45 ← 42–43، 69 ← 67، 80–90 ← 78–84، 92–96 ← 86–90، 129–132 ← 123، 145–148 ← 136 |
| `client/src/components/ui/input-otp.tsx` | عُدّل | 2 | 9 | 17–20 ← 17، 29–33 ← 26 |
| `client/src/components/ui/input.tsx` | عُدّل | 4 | 3 | 25 ← 25–26، 36 ← 37، 40 ← 41 |
| `client/src/components/ui/item.tsx` | عُدّل | 8 | 29 | 19–22 ← 19، 60–61 ← 57، 81–82 ← 77، 110–113 ← 105، 123–126 ← 115، 148–152 ← 137، 160–163 ← 145، 173–176 ← 155 |
| `client/src/components/ui/label.tsx` | عُدّل | 1 | 4 | 6–9 ← 6 |
| `client/src/components/ui/menubar.tsx` | عُدّل | 10 | 34 | 7–10 ← 7، 23–25 ← 20، 29–31 ← 24، 35–37 ← 28، 41–46 ← 32–33، 173–176 ← 160، 195–198 ← 179، 202–205 ← 183، 211–213 ← 189 |
| `client/src/components/ui/navigation-menu.tsx` | عُدّل | 2 | 9 | 39–42 ← 39، 107–111 ← 104 |
| `client/src/components/ui/pagination.tsx` | عُدّل | 6 | 27 | 2–6 ← 2، 23–26 ← 19، 45–50 ← 38، 68–71 ← 56، 85–88 ← 70، 102–105 ← 84 |
| `client/src/components/ui/password-input.tsx` | عُدّل | 1 | 1 | 70 ← 70 |
| `client/src/components/ui/password-strength-meter.tsx` | عُدّل | 22 | 8 | 4 ← 4–8، 100 ← 104، 106 ← 110–112، 117 ← 123–125، 122 ← 130–133، 138 ← 149، 150 ← 161–163، 158 ← 171–172 |
| `client/src/components/ui/popover.tsx` | عُدّل | 3 | 9 | 6–8 ← 6، 12–14 ← 10، 40–42 ← 36 |
| `client/src/components/ui/progress.tsx` | عُدّل | 1 | 4 | 14–17 ← 14 |
| `client/src/components/ui/resizable.tsx` | عُدّل | 2 | 7 | 14–17 ← 14، 23–25 ← 20 |
| `client/src/components/ui/scroll-area.tsx` | عُدّل | 2 | 4 | 40–43 ← 40–41 |
| `client/src/components/ui/select.tsx` | عُدّل | 6 | 21 | 7–9 ← 7، 13–15 ← 11، 19–21 ← 15، 88–91 ← 82، 145–148 ← 136، 163–166 ← 151 |
| `client/src/components/ui/sheet.tsx` | عُدّل | 4 | 13 | 13–15 ← 13، 19–21 ← 17، 25–27 ← 21، 104–107 ← 98 |
| `client/src/components/ui/sidebar.tsx` | عُدّل | 13 | 48 | 14–19 ← 14، 92 ← 87، 98–101 ← 93، 223–225 ← 215، 263–267 ← 253، 277 ← 263، 328–331 ← 314، 364–367 ← 347، 447–450 ← 427، 587–590 ← 564، 628–633 ← 602، 662–665 ← 631 … (١٤ موضعاً) |
| `client/src/components/ui/slider.tsx` | عُدّل | 1 | 6 | 15–20 ← 15 |
| `client/src/components/ui/switch.tsx` | عُدّل | 1 | 4 | 6–9 ← 6 |
| `client/src/components/ui/table.tsx` | عُدّل | 5 | 29 | 7–10 ← 7، 21–27 ← 18، 44–47 ← 35، 92–95 ← 80، 105–114 ← 90 |
| `client/src/components/ui/tabs.tsx` | عُدّل | 4 | 16 | 6–9 ← 6، 19–22 ← 16، 35–38 ← 29، 51–54 ← 42 |
| `client/src/components/ui/textarea.tsx` | عُدّل | 4 | 3 | 24 ← 24–25، 36 ← 37، 40 ← 41 |
| `client/src/components/ui/toggle-group.tsx` | عُدّل | 3 | 7 | 10–12 ← 10، 23–24 ← 21، 49–50 ← 46 |
| `client/src/components/ui/toggle.tsx` | عُدّل | 1 | 2 | 34–35 ← 34 |
| `client/src/components/ui/tooltip.tsx` | عُدّل | 2 | 6 | 19–21 ← 19، 29–31 ← 27 |
| `client/src/config/navigation.ts` | عُدّل | 369 | 64 | 36 ← 36–42، 77 ← 83–87، 88 ← 98–102، 95–96 ← 109–118، 99–101 ← 121–135، 111 ← 145–149، 126 ← 164–168، 131 ← 173–177، 142 ← 188–192، 148 ← 198–202، 153 ← 207–211، 166 ← 224–228 … (٤٠ موضعاً) |
| `client/src/config/platform-staff-navigation.ts` | عُدّل | 145 | 19 | 11 ← 11–26، 34 ← 49–56، 37–45 ← 59–130، 49–50 ← 134–149، 53–55 ← 152–175، 59 ← 179–181، 63–64 ← 185–190 |
| `client/src/contexts/ThemeContext.tsx` | عُدّل | 1 | 1 | 47 ← 47 |
| `client/src/dashboard/merchant-screens.tsx` | عُدّل | 96 | 29 | 44 ← 44–47، 48–54 ← 51–71، 57–76 ← 74–133، 83 ← 140–150 |
| `client/src/hooks/useComposition.ts` | عُدّل | 6 | 13 | 4–6 ← 4، 13–15 ← 11، 23–25 ← 19–21، 61–64 ← 57 |
| `client/src/hooks/useMobile.tsx` | عُدّل | 1 | 3 | 6–8 ← 6 |
| `client/src/hooks/usePlatformBrand.ts` | عُدّل | 9 | 3 | 34 ← 34–36، 48–49 ← 50–55 |
| `client/src/lib/category-tree.ts` | عُدّل | 35 | 8 | 10 ← 10–14، 13 ← 17–19، 17 ← 23–26، 24 ← 33–36، 27 ← 39–43، 32 ← 48–51، 34 ← 53–58، 40 ← 64–67 |
| `client/src/lib/engineering-roadmap-data.ts` | عُدّل | 13 | 5 | 51–52 ← 51–54، 70 ← 72–73، 79 ← 82–83، 278 ← 282–286 |
| `client/src/lib/landing-motion.ts` | عُدّل | 5 | 4 | 88 ← 88–89، 115 ← 116، 172 ← 173، 234 ← 235 |
| `client/src/lib/password-strength.ts` | عُدّل | 187 | 29 | 47–70 ← 47–206، 205 ← 341–346، 209–210 ← 350–361، 228 ← 379–386، 252 ← 410 |
| `client/src/lib/platform-contact.ts` | عُدّل | 6 | 1 | 64 ← 64–69 |
| `client/src/lib/storefront-api.ts` | عُدّل | 557 | 99 | 57 ← 57–65، 62 ← 70–78، 66 ← 82–86، 68 ← 88–89، 82 ← 103–112، 94–95 ← 124–155، 98 ← 158–166، 101 ← 169–176، 104 ← 179–186، 117–118 ← 199–213، 129 ← 224–228، 137–139 ← 236–258 … (٦٠ موضعاً) |
| `client/src/lib/storefront-pixels.ts` | عُدّل | 72 | 15 | 28 ← 28–32، 35 ← 39–45، 58 ← 68–70، 74–75 ← 86–103، 77 ← 105–109، 115–117 ← 147–156، 127 ← 166–169، 129 ← 171–175، 137 ← 183–187، 145 ← 195–196، 154–155 ← 205–212 |
| `client/src/lib/till-queue.ts` | عُدّل | 81 | 26 | 95 ← 95–96، 106 ← 107–108، 136 ← 138–140، 141–143 ← 145–156، 159–163 ← 172–178، 186 ← 201–209، 245 ← 268–270، 299 ← 324–325، 320 ← 346–348، 327–328 ← 355–359، 341 ← 372–375، 355 ← 389–391 … (١٩ موضعاً) |
| `client/src/lib/use-reorder.ts` | عُدّل | 29 | 22 | 25–39 ← 25–50، 41–47 ← 52–54 |
| `client/src/main.tsx` | عُدّل | 15 | 4 | 18 ← 18–22، 20 ← 24–28، 24 ← 32–36، 42 ← — |
| `client/src/market/LocationPicker.tsx` | عُدّل | 150 | 41 | 12 ← 12–16، 22–23 ← 26–31، 27 ← 35–37، 35–36 ← 45–49، 39–40 ← 52–56، 43 ← 59–62، 46 ← 65–70، 51–52 ← 75–86، 55 ← 89–96، 58–59 ← 99–109، 61 ← 111–115، 64 ← 118–124 … (١٣ موضعاً) |
| `client/src/market/MarketApp.tsx` | عُدّل | 36 | 7 | 24–29 ← 24–54، 37 ← 62–66 |
| `client/src/market/MarketEmptyState.tsx` | عُدّل | 23 | 4 | 5 ← 5–17، 7–8 ← 19–25، 10 ← 27–29 |
| `client/src/market/MarketShell.tsx` | عُدّل | 92 | 14 | 8 ← 8–18، 45 ← 55–59، 50 ← 64–70، 52 ← 72–77، 54 ← 79–86، 58 ← 90–95، 60 ← 97–104، 67–68 ← 111–126، 75 ← 133–136، 82–83 ← 143–148، 86 ← 151–158، 96 ← 168–174 |
| `client/src/market/components/BannerCarousel.tsx` | عُدّل | 73 | 17 | 10 ← 10–17، 14 ← 21–27، 24–31 ← 37–50، 39 ← 58–61، 44 ← 66–73، 47 ← 76–78، 50 ← 81–85، 54–55 ← 89–106، 62 ← 113–118 |
| `client/src/market/components/CodeEntry.tsx` | عُدّل | 36 | 5 | 4 ← 4–16، 6 ← 18–21، 10–11 ← 25–36، 13 ← 38–44 |
| `client/src/market/components/Countdown.tsx` | عُدّل | 22 | 4 | 7 ← 7–10، 9 ← 12–17، 14–15 ← 22–33 |
| `client/src/market/components/DeliveryToMe.tsx` | عُدّل | 20 | 6 | 16 ← 16–19، 20 ← 23–25، 23 ← 28–30، 25 ← 32–34، 27 ← 36–38، 31 ← 42–45 |
| `client/src/market/components/FavouriteButtons.tsx` | عُدّل | 37 | 6 | 6 ← 6–11، 8 ← 13–19، 17 ← 28–36، 21 ← 40–42، 36 ← 57–66، 40 ← 70–71 |
| `client/src/market/components/InstalmentChooser.tsx` | عُدّل | 131 | 21 | 16 ← 16–33، 18 ← —، 23 ← 39–44، 31 ← 52–54، 39 ← 62–63، 41 ← 65–70، 43 ← 72–77، 47–48 ← 81–88، 51 ← 91–95، 53 ← 97–107، 56 ← 110–122، 63–66 ← 129–150 … (١٥ موضعاً) |
| `client/src/market/components/OrderAfterSales.tsx` | عُدّل | 424 | 69 | 16 ← 16–22، 19 ← 25–32، 22 ← 35–41، 26 ← 45–50، 31–32 ← 55–58، 35 ← 61–68، 38 ← 71–81، 42–43 ← 85–97، 51 ← 105–115، 53 ← 117–122، 56–59 ← 125–144، 70–71 ← 155–163 … (٤١ موضعاً) |
| `client/src/market/components/ProductBrowser.tsx` | عُدّل | 323 | 54 | 15–16 ← 15–34، 18 ← 36–46، 30 ← 58–61، 33 ← 64–74، 40–53 ← 81–98، 55 ← 100–102، 60–61 ← 107–118، 63–64 ← 120–131، 67–70 ← 134–165، 72–73 ← 167–175، 76 ← 178–189، 81 ← 194–206 … (٢٧ موضعاً) |
| `client/src/market/components/ProductCard.tsx` | عُدّل | 81 | 14 | 8 ← 8–10، 10 ← 12–16، 12–16 ← 18–51، 18 ← 53–57، 21 ← 60–62، 23–24 ← 64–72، 27–28 ← 75–90، 30 ← 92–97 |
| `client/src/market/components/ProductShelf.tsx` | عُدّل | 18 | 3 | 7 ← 7–17، 12 ← 22–25، 14 ← 27–29 |
| `client/src/market/components/RankingSheet.tsx` | عُدّل | 42 | 9 | 6 ← 6–10، 10 ← 14–18، 12–13 ← 20–31، 16 ← 34–41، 19 ← 44–45، 23 ← 49–52، 25 ← 54–56، 29 ← 60–62 |
| `client/src/market/components/StoreBadges.tsx` | عُدّل | 35 | 6 | 2 ← 2–15، 28 ← 41–44، 34 ← 50–56، 44 ← 66–69، 54 ← 79–80، 58 ← 84–87 |
| `client/src/market/components/StoreCards.tsx` | عُدّل | 64 | 13 | 10 ← 10–15، 12 ← 17–21، 22 ← 31–35، 24–25 ← 37–42، 30 ← 47–55، 32 ← —، 34 ← 58–62، 42 ← 70–74، 47 ← 79–84، 51 ← 88–93، 55–56 ← 97–107 |
| `client/src/market/components/StoreShelf.tsx` | عُدّل | 22 | 4 | 7 ← 7–19، 15 ← 27–29، 21 ← 35–37، 24 ← 40–42 |
| `client/src/market/map/StoreMap.tsx` | عُدّل | 113 | 17 | 13–14 ← 13–30، 26 ← 42–44، 56 ← 74–86، 67 ← 97–101، 69 ← 103–107، 75 ← 113–121، 78 ← 124–126، 84 ← 132–136، 92 ← 144–149، 102 ← 159–165، 109–111 ← 172–189، 115 ← 193–197 … (١٤ موضعاً) |
| `client/src/market/market-api.ts` | عُدّل | 15 | 3 | 3 ← 3–7، 9 ← 13–17، 12 ← 20–24 |
| `client/src/market/market-cart.ts` | عُدّل | 34 | 7 | 7 ← 7–13، 17 ← 23–35، 19 ← —، 24 ← 41–44، 27 ← 47–51، 42 ← 66–68، 45 ← 71–72 |
| `client/src/market/market-favourites.ts` | عُدّل | 44 | 15 | 16–17 ← 16–25، 29–33 ← 37–45، 49–50 ← 61–70، 59 ← 79–80، 61 ← 82–84، 63 ← 86–87، 69 ← 93–94، 71 ← 96–99، 74 ← 102–103 |
| `client/src/market/market-geo.ts` | عُدّل | 18 | 5 | 8 ← 8–11، 10–12 ← 13–23، 24 ← 35–37 |
| `client/src/market/market-links.ts` | عُدّل | 24 | 10 | 5–6 ← 5–12، 13–20 ← 19–34 |
| `client/src/market/market-location.ts` | عُدّل | 14 | 4 | 10 ← 10–15، 20 ← 25–26، 42 ← 48–51، 45 ← 54–55 |
| `client/src/market/market-photo.ts` | عُدّل | 8 | 2 | 3–4 ← 3–10 |
| `client/src/market/market-products.ts` | عُدّل | 54 | 12 | 33 ← 33–41، 39 ← 47–52، 43–44 ← 56–67، 46 ← —، 56 ← 78–80، 64–65 ← 88–96، 72 ← 103–105، 79–80 ← 112–118، 83 ← 121–125 |
| `client/src/market/market-shopper.ts` | عُدّل | 35 | 6 | 7 ← 7–17، 26 ← 36–39، 37 ← 50–53، 39 ← 55–57، 46 ← 64–71، 49 ← 74–78 |
| `client/src/market/market-types.ts` | عُدّل | 47 | 8 | 4 ← 4–10، 29 ← 35–42، 31 ← 44–48، 33 ← 50–56، 48–49 ← 71–80، 52 ← 83–86، 56 ← 90–95 |
| `client/src/market/pages/MarketAccountPages.tsx` | عُدّل | 885 | 124 | 9–10 ← 9–41، 15–16 ← 46–49، 19 ← 52–59، 32 ← 72–73، 34–35 ← 75–82، 37 ← 84–88، 41 ← 92–93، 43 ← 95–98، 46 ← 101–106، 50 ← 110–113، 52–53 ← 115–121، 56–57 ← 124–141 … (٧٠ موضعاً) |
| `client/src/market/pages/MarketCampaignPage.tsx` | عُدّل | 215 | 33 | 17 ← 17–23، 19 ← 25–32، 26–27 ← 39–51، 35 ← 59–65، 38–39 ← 68–89، 44–45 ← 94–104، 47 ← 106–114، 52–53 ← 119–129، 56–58 ← 132–156، 63 ← 161–163، 65 ← 165–172، 69–70 ← 176–183 … (٢١ موضعاً) |
| `client/src/market/pages/MarketCartPage.tsx` | عُدّل | 234 | 32 | 8 ← 8–17، 22–24 ← 31–65، 27–28 ← 68–76، 30 ← 78–80، 35–36 ← 85–98، 38 ← 100–107، 42 ← 111–118، 46–48 ← 122–136، 51 ← 139–154، 55 ← 158–160، 58–59 ← 163–174، 62 ← 177–179 … (١٧ موضعاً) |
| `client/src/market/pages/MarketCategoriesPage.tsx` | عُدّل | 30 | 6 | 12 ← 12–16، 17–18 ← 21–28، 22–23 ← 32–40، 28 ← 45–52 |
| `client/src/market/pages/MarketCategoryPage.tsx` | عُدّل | 92 | 14 | 13 ← 13–19، 21–22 ← 27–31، 26–27 ← 35–55، 31–33 ← 59–76، 35 ← 78–83، 38 ← 86–94، 46–48 ← 102–121، 54 ← 127–132 |
| `client/src/market/pages/MarketCheckoutPage.tsx` | عُدّل | 438 | 64 | 14 ← 14–18، 17 ← 21–30، 20 ← 33–37، 28 ← 45–52، 37 ← 61–64، 59 ← 86–91، 62 ← 94–105، 70 ← 113–119، 72 ← 121–123، 74 ← 125–133، 80 ← 139–140، 82 ← 142–145 … (٣٨ موضعاً) |
| `client/src/market/pages/MarketHelpPages.tsx` | عُدّل | 546 | 74 | 6 ← 6–24، 18 ← 36–37، 20–23 ← 39–56، 26 ← 59–66، 35–36 ← 75–82، 44–45 ← 90–107، 48–52 ← 110–153، 60 ← 161–169، 63 ← 172–174، 71–72 ← 182–188، 74 ← 190–195، 82 ← 203–206 … (٤٧ موضعاً) |
| `client/src/market/pages/MarketHomePage.tsx` | عُدّل | 303 | 65 | 10 ← 10–21، 24–26 ← 35–60، 28 ← 62–70، 37–38 ← 79–86، 46 ← 94–98، 48–56 ← 100–129، 58–61 ← 131–150، 63–96 ← 152–261، 101–103 ← 266–296، 119–120 ← 312–321، 123 ← 324–331، 136 ← 344–346 … (١٤ موضعاً) |
| `client/src/market/pages/MarketImageSearchPage.tsx` | عُدّل | 120 | 19 | 20 ← 20–24، 22 ← 26–31، 26 ← 35–43، 30–32 ← 47–68، 44 ← 80–83، 49 ← 88–90، 51–52 ← 92–102، 59 ← 109–115، 64–66 ← 120–130، 70–71 ← 134–153، 74–75 ← 156–171، 81 ← 177–182 |
| `client/src/market/pages/MarketMapPages.tsx` | عُدّل | 383 | 64 | 14 ← 14–24، 25 ← 35–39، 34 ← 48–56، 39 ← 61–66، 57 ← 84–87، 62 ← 92–97، 68–69 ← 103–114، 75–76 ← 120–134، 78 ← 136–142، 82–84 ← 146–170، 86–87 ← 172–188، 89 ← 190–194 … (٣٦ موضعاً) |
| `client/src/market/pages/MarketNotFoundPage.tsx` | عُدّل | 16 | 1 | 7 ← 7–22 |
| `client/src/market/pages/MarketOrdersPages.tsx` | عُدّل | 527 | 83 | 4 ← 4–12، 11 ← 19–26، 13–14 ← 28–44، 25 ← 55–58، 32–34 ← 65–89، 38–41 ← 93–119، 46 ← 124–132، 52–53 ← 138–150، 55–58 ← 152–183، 61–62 ← 186–198، 71–72 ← 207–221، 75–76 ← 224–245 … (٣٥ موضعاً) |
| `client/src/market/pages/MarketPartnerPages.tsx` | عُدّل | 180 | 29 | 18 ← 18–23، 21 ← 26–27، 32 ← 38–41، 35–36 ← 44–51، 41 ← 56–67، 48 ← 74–78، 51 ← 81–91، 54 ← 94–97، 57–58 ← 100–117، 60 ← 119–128، 65 ← 133–139، 67 ← 141–147 … (١٩ موضعاً) |
| `client/src/market/pages/MarketPayPage.tsx` | عُدّل | 117 | 18 | 15 ← 15–24، 24 ← 33–40، 26 ← 42–44، 36–37 ← 54–69، 39 ← 71–80، 45–46 ← 86–92، 48–51 ← 94–117، 55–56 ← 121–127، 58–59 ← 129–146، 63–64 ← 150–163 |
| `client/src/market/pages/MarketProductPage.tsx` | عُدّل | 473 | 83 | 12 ← 12–30، 14 ← 32–38، 22 ← 46–54، 43–46 ← 75–97، 50–51 ← 101–114، 53–55 ← 116–140، 63 ← 148–152، 65 ← 154–156، 68 ← 159–162، 70 ← 164–166، 72 ← 168–171، 74 ← 173–177 … (٣٧ موضعاً) |
| `client/src/market/pages/MarketReelsPage.tsx` | عُدّل | 247 | 54 | 10 ← 10–19، 33 ← 42–50، 45–54 ← 62–79، 56–60 ← 81–83، 62 ← 85–88، 66 ← 92–95، 70 ← 99–102، 79–80 ← 111–120، 84–86 ← 124–148، 90–91 ← 152–161، 94–95 ← 164–176، 98–99 ← 179–186 … (٢٥ موضعاً) |
| `client/src/market/pages/MarketRewardsPages.tsx` | عُدّل | 458 | 66 | 18–19 ← 18–41، 21–23 ← 43–50، 25 ← 52–60، 27–28 ← 62–73، 30–32 ← 75–89، 43 ← 100–103، 45–46 ← 105–116، 48 ← 118–121، 50–51 ← 123–135، 57 ← 141–157، 59 ← 159–166، 61 ← 168–172 … (٣٨ موضعاً) |
| `client/src/market/pages/MarketSearchPage.tsx` | عُدّل | 148 | 21 | 15 ← 15–19، 25–26 ← 29–40، 29 ← 43–46، 32 ← 49–53، 34 ← 55–58، 37 ← 61–64، 42 ← 69–76، 45–47 ← 79–100، 49–53 ← 102–139، 61 ← 147–152، 69 ← 160–181، 71 ← — … (١٤ موضعاً) |
| `client/src/market/pages/MarketSectionPages.tsx` | عُدّل | 150 | 23 | 26 ← 26–40، 30 ← 44–49، 35 ← 54–61، 42–43 ← 68–72، 46–47 ← 75–97، 51–53 ← 101–119، 55 ← 121–125، 57 ← 127–132، 62 ← 137–140، 69–70 ← 147–151، 73–74 ← 154–174، 78–79 ← 178–183 … (١٤ موضعاً) |
| `client/src/market/pages/MarketStorePage.tsx` | عُدّل | 396 | 72 | 11 ← 11–26، 15 ← 30–36، 20 ← 41–48، 27 ← 55–57، 33 ← 63–66، 38 ← 71–76، 42 ← 80–81، 47–49 ← 86–110، 60–61 ← 121–128، 67–69 ← 134–150، 74–75 ← 155–165، 77 ← 167–170 … (٤٦ موضعاً) |
| `client/src/market/pages/MarketStoreProductsPage.tsx` | عُدّل | 28 | 4 | 14–15 ← 14–26، 18 ← 29–36، 21 ← 39–45 |
| `client/src/market/pages/MarketStoreReviewsPage.tsx` | عُدّل | 40 | 7 | 20 ← 20–25، 27 ← 32–34، 30 ← 37–39، 35 ← 44–49، 38 ← 52–56، 40–41 ← 58–74 |
| `client/src/market/pages/MarketStoresPage.tsx` | عُدّل | 196 | 36 | 8 ← 8–16، 39–40 ← 47–54، 43 ← 57–58، 45 ← 60، 50 ← 65–68، 53 ← 71–74، 55 ← 76، 63 ← 84–89، 69–70 ← 95–108، 75 ← 113–119، 79–81 ← 123–141، 86 ← 146–151 … (٢٢ موضعاً) |
| `client/src/market/pages/MarketTicketsPages.tsx` | عُدّل | 474 | 65 | 13 ← 13–24، 15–16 ← 26–39، 18 ← —، 21–24 ← 43–53، 27 ← 56–63، 32–33 ← 68–79، 35–36 ← 81–100، 44 ← 108–112، 47 ← 115–122، 53 ← 128–139، 55 ← 141–152، 57–58 ← 154–165 … (٣٥ موضعاً) |
| `client/src/market/pages/MarketWheelPage.tsx` | عُدّل | 450 | 68 | 17–20 ← 17–58، 22–23 ← 60–67، 28 ← 72–75، 31–32 ← 78–91، 39–40 ← 98–117، 44 ← 121–128، 53 ← 137–138، 59–64 ← 144–156، 78–79 ← 170–179، 82 ← 182–185، 84 ← 187–189، 92 ← 197–201 … (٤٢ موضعاً) |
| `client/src/market/use-market-list.ts` | عُدّل | 19 | 5 | 13 ← 13–17، 16 ← 20–21، 18–19 ← 23–31، 28 ← 40–42 |
| `client/src/market/use-market-stores.ts` | عُدّل | 19 | 5 | 6 ← 6–8، 23 ← 25–28، 29–30 ← 34–42، 39 ← 51–53 |
| `client/src/pages/CustomerAddressesPage.tsx` | عُدّل | 178 | 25 | 58 ← 58–60، 66 ← 68–74، 102 ← 110–115، 129 ← 142–149، 137 ← 157–159، 140–141 ← 162–172، 151 ← 182–185، 155–156 ← 189–201، 158 ← 203–209، 160–161 ← 211–231، 163 ← —، 169 ← 238–247 … (٢٠ موضعاً) |
| `client/src/pages/CustomerAuthPage.tsx` | عُدّل | 158 | 15 | 22 ← 22–31، 51 ← 60–65، 60 ← 74–76، 71 ← 87–93، 73–81 ← 95–209، 85–86 ← 213–229 |
| `client/src/pages/CustomerOrderDetailPage.tsx` | عُدّل | 465 | 79 | 3 ← 3–13، 11–12 ← 21–35، 15–18 ← 38–58، 28 ← 68–76، 40–42 ← 88–97، 45–47 ← 100–113، 49–59 ← 115–173، 63 ← 177–185، 69–70 ← 191–196، 75–77 ← 201–209، 79–88 ← 211–255، 91 ← — … (١٩ موضعاً) |
| `client/src/pages/CustomerOrdersPage.tsx` | عُدّل | 145 | 22 | 10–11 ← 10–24، 23–36 ← 36–79، 38–40 ← 81–117، 42–44 ← 119–167 |
| `client/src/pages/CustomerPreferencesPage.tsx` | عُدّل | 69 | 15 | 13 ← 13–20، 22–25 ← 29–39، 32–34 ← 46–69، 39–40 ← 74–80، 44–48 ← 84–102 |
| `client/src/pages/CustomerReturnsPage.tsx` | عُدّل | 113 | 35 | 21–22 ← 21–27، 27 ← 32–35، 31–34 ← 39–58، 45–46 ← 69–90، 48–51 ← 92–93، 53 ← 95، 55 ← 97، 57–64 ← —، 67 ← 101–106، 73 ← 112–118، 81–83 ← 126–138، 96–97 ← 151–156 … (١٧ موضعاً) |
| `client/src/pages/CustomerWishlistPage.tsx` | عُدّل | 103 | 35 | 21–22 ← 21–29، 37–38 ← 44–65، 40–43 ← 67–68، 45 ← 70، 47 ← 72، 49–56 ← —، 61–63 ← 78–85، 66 ← 88–93، 72 ← 99–105، 80–82 ← 113–125، 84 ← 127–129، 92–93 ← 137–144 … (١٦ موضعاً) |
| `client/src/pages/DashboardLogin.tsx` | عُدّل | 66 | 14 | 44 ← 44–45، 72 ← 73–74، 94 ← 96–100، 131 ← 137–141، 144 ← 154–157، 146 ← 159–161، 156–157 ← 171–181، 165 ← 189–194، 170–171 ← 199–210، 176 ← 215–221، 178 ← 223–226، 193 ← 241–245 |
| `client/src/pages/DemoEntryPage.tsx` | عُدّل | 17 | 4 | 26 ← 26–31، 32 ← 37–39، 40 ← 47–49، 47 ← 56–60 |
| `client/src/pages/EngineeringArchitectureDashboard.tsx` | عُدّل | 425 | 73 | 36–41 ← 36–69، 47 ← 75، 52–54 ← 80–82، 70–71 ← 98–101، 75 ← 105–111، 77 ← 113–116، 80–81 ← 119–127، 83 ← 129–131، 95 ← 143–145، 105–106 ← 155–162، 108 ← 164–166، 110 ← 168–170 … (٤١ موضعاً) |
| `client/src/pages/Home.tsx` | عُدّل | 612 | 140 | 34–35 ← 34–51، 47 ← —، 49–50 ← 64–79، 122 ← 151–154، 134–137 ← 166–181، 142–145 ← 186–201، 192–194 ← 248–250، 199–201 ← 255–269، 209 ← 277–283، 212 ← 286–290، 222 ← 300–304، 267 ← 349–350 … (٩٠ موضعاً) |
| `client/src/pages/MerchantDashboard.tsx` | عُدّل | 650 | 75 | 29 ← 29–34، 35 ← 40–44، 43 ← 52–61، 57 ← 75–83، 60–61 ← 86–92، 68 ← 99–104، 71–72 ← 107–120، 74–76 ← 122–142، 81–89 ← 147–203، 92–93 ← 206–217، 101–103 ← 225–232، 106 ← 235–245 … (٣٥ موضعاً) |
| `client/src/pages/NotFound.tsx` | عُدّل | 1 | 3 | 26–28 ← 26 |
| `client/src/pages/OwnerDashboard.tsx` | عُدّل | 327 | 51 | 27 ← 27–32، 29 ← 34–38، 56 ← 65–72، 60 ← 76–81، 68–70 ← 89–96، 73 ← 99–107، 83 ← 117–121، 99–103 ← 137–143، 119 ← 159–165، 122 ← 168–170، 125 ← 173–175، 134 ← 184–191 … (٣٠ موضعاً) |
| `client/src/pages/PasswordResetConsume.tsx` | عُدّل | 73 | 17 | 40–41 ← 40–47، 62 ← 68–70، 91 ← 99–101، 104 ← 114–116، 110 ← 122–123، 115 ← 128–133، 124 ← 142–143، 132 ← 151–158، 136 ← 162–168، 140 ← 172–178، 142 ← 180–184، 157 ← 199–202 … (١٦ موضعاً) |
| `client/src/pages/PasswordResetRequest.tsx` | عُدّل | 44 | 10 | 41 ← 41–42، 55 ← 56–59، 83 ← 87–89، 108 ← 114–115، 114 ← 121–128، 118 ← 132–138، 120 ← 140–144، 133 ← 157–158، 154 ← 179–185، 158 ← 189–192 |
| `client/src/pages/PlatformStaffDashboard.tsx` | عُدّل | 316 | 62 | 11 ← 11–21، 28 ← 38–44، 38 ← 54–58، 62 ← 82–85، 70 ← 93–95، 101 ← 126–128، 103–106 ← 130–151، 111 ← 156–158، 113–114 ← 160–176، 118 ← 180–182، 120–121 ← 184–199، 128 ← 206–215 … (٤٢ موضعاً) |
| `client/src/pages/StaffDashboard.tsx` | عُدّل | 219 | 46 | 8 ← 8–17، 19 ← 28–33، 32 ← 46–53، 48–52 ← 69–75، 57 ← 80–82، 64 ← 89–92، 71 ← 99–102، 75–76 ← 106–114، 84 ← 122–124، 86–87 ← 126–134، 100 ← 147–150، 105–106 ← 155–161 … (٣١ موضعاً) |
| `client/src/pages/StorefrontCartPage.tsx` | عُدّل | 182 | 27 | 15 ← 15–16، 17–18 ← 18–36، 20–21 ← 38–51، 28 ← 58–63، 32 ← 67–72، 36–38 ← 76–97، 41–44 ← 100–123، 47 ← 126–135، 49 ← 137–146، 52–53 ← 149–162، 60–61 ← 169–178، 63–65 ← 180–195 … (١٣ موضعاً) |
| `client/src/pages/StorefrontCatalogPage.tsx` | عُدّل | 199 | 40 | 19 ← 19–23، 26 ← 30–33، 30 ← 37–40، 41 ← 51–53، 44 ← 56–59، 47 ← 62–69، 51–61 ← 73–105، 65 ← 109–110، 69 ← 114–116، 73 ← 120–123، 82–83 ← 132–136، 91–92 ← 144–150 … (٢٢ موضعاً) |
| `client/src/pages/StorefrontCheckoutPage.tsx` | عُدّل | 685 | 141 | 16 ← 16–29، 21 ← 34–46، 24 ← 49–51، 27 ← 54–58، 30 ← 61–70، 70 ← 110–113، 98 ← 141–144، 103 ← 149–155، 112–129 ← 164–184، 131 ← 186–188، 147 ← 204–206، 149 ← 208–210 … (٣٧ موضعاً) |
| `client/src/pages/StorefrontHomePage.tsx` | عُدّل | 211 | 40 | 12 ← 12–17، 18 ← 23–31، 34 ← 47–57، 45 ← 68–75، 47 ← 77–83، 50 ← 86–96، 53 ← 99–103، 55–58 ← 105–124، 76–77 ← 142–148، 87 ← 158–162، 99–100 ← 174–184، 106 ← 190–194 … (٢٣ موضعاً) |
| `client/src/pages/StorefrontPolicyPage.tsx` | عُدّل | 39 | 8 | 18 ← 18–22، 24 ← 28–29، 29–31 ← 34–42، 37–38 ← 48–62، 40 ← 64–71 |
| `client/src/pages/StorefrontProductPage.tsx` | عُدّل | 381 | 98 | 20 ← 20–27، 27 ← 34–38، 38–39 ← 49–59، 44 ← 64–66، 48–51 ← 70–89، 72–75 ← 110–121، 77 ← 123–125، 82–84 ← 130–135، 87–88 ← 138–148، 93 ← 153–158، 97 ← 162–173، 99 ← — … (٢٢ موضعاً) |
| `client/src/pages/StorefrontTrackOrderPage.tsx` | عُدّل | 134 | 25 | 16 ← 16–22، 18–19 ← 24–38، 23 ← 42–43، 30 ← 50–52، 53 ← 75–77، 61 ← 85–91، 65 ← 95–97، 68 ← 100–102، 70–71 ← 104–117، 73–74 ← 119–129، 77–78 ← 132–144، 80–81 ← 146–157 … (١٧ موضعاً) |
| `client/src/pages/StorefrontWrapper.tsx` | عُدّل | 5 | 1 | 52 ← 52–56 |
| `client/src/pages/TillPage.tsx` | عُدّل | 692 | 193 | 20 ← 20–28، 23–24 ← 31–44، 36–39 ← 56–87، 42 ← 90–97، 70–72 ← 125–133، 79 ← 140–143، 102 ← 166، 118 ← 182–184، 138 ← 204–207، 142 ← 211–212، 151 ← 221–222، 198 ← 269–271 … (١٠٤ موضعاً) |
| `client/src/pages/UnsubscribePage.tsx` | عُدّل | 78 | 16 | 17 ← 17–22، 39 ← 44–50، 45 ← 56–58، 52 ← 65–69، 57 ← 74–80، 69 ← 92–95، 73–74 ← 99–104، 78 ← 108–111، 80 ← 113–118، 84 ← 122–125، 89 ← 130–133، 91 ← 135–140 … (١٥ موضعاً) |
| `docs/review/README.md` | عُدّل | 7 | 2 | 42 ← 42، 44 ← 44، — ← 47–51 |
| `eslint.config.mjs` | عُدّل | 25 | 7 | 18–19 ← 18–25، 53–54 ← 59–63، 57 ← 66–69، 73 ← 85–91، 81 ← 99 |
| `phase1-backend/scripts/backup-database.ts` | عُدّل | 23 | 15 | 59 ← 59–62، 62 ← 65، 92–93 ← 95، 111–113 ← 113–118، 115 ← —، 149 ← 153، 174 ← 178–180، 181 ← 187–189، 206–207 ← 214–215، 250–251 ← 258–259 |
| `phase1-backend/scripts/create-first-owner.ts` | عُدّل | 32 | 11 | 46 ← 46–47، 61 ← 62–63، 78 ← 80–84، 81 ← 87–89، 87–88 ← 95–100، 96 ← 108–110، 103 ← 117–119، 111 ← 127–129، 125 ← 143–145، 132 ← 152–153 |
| `phase1-backend/scripts/encrypt-secrets-at-rest.ts` | عُدّل | 37 | 11 | 18 ← 18–24، 53 ← 59، 83 ← 89–91، 91–92 ← 99–106، 102–103 ← 116–123، 108–109 ← 128–135، 126–127 ← 152–153 |
| `phase1-backend/scripts/env-check.ts` | عُدّل | 20 | 5 | 21 ← 21–23، 26 ← 28–35، 32 ← 41–44، 37 ← 49–51، 42 ← 56–57 |
| `phase1-backend/scripts/generate-openapi.mjs` | عُدّل | 564 | 144 | 169 ← 169–172، 177 ← 180–181، 189–190 ← 193–203، 213–216 ← 226–245، 219 ← 248–251، 222 ← 254–257، 261 ← 296–297، 266 ← 302–304، 268 ← 306–309، 273 ← 314–320، 281 ← 328–334، 290 ← 343–346 … (٩١ موضعاً) |
| `phase1-backend/scripts/generate-search-corpus.ts` | عُدّل | 152 | 23 | 47–49 ← 47–76، 54–55 ← 81–96، 59–61 ← 100–129، 65–66 ← 133–152، 71 ← 157–164، 88 ← 181، 96 ← 189، 103 ← 196–199، 115 ← 211–213، 118 ← 216–217، 139 ← 238–240، 163 ← 264–267 … (١٧ موضعاً) |
| `phase1-backend/scripts/index-product-images.ts` | عُدّل | 6 | 2 | 11 ← 11–13، 14 ← 16–18 |
| `phase1-backend/scripts/mail-probe.ts` | عُدّل | 113 | 21 | 33 ← 33–40، 37 ← 44–45، 50 ← 58–63، 56 ← 69–77، 62 ← 83–94، 70 ← 102–113، 78–79 ← 121–135، 86–94 ← 142–159، 101 ← 166–177، 118 ← 194–206، 120 ← 208–211، 125 ← 216–217 |
| `phase1-backend/scripts/migrate-deploy.ts` | عُدّل | 28 | 8 | 27 ← 27–31، 36 ← 40، 60 ← 64–72، 66 ← 78، 74 ← 86، 80 ← 92–94، 94 ← 108–112، 100 ← 118–120 |
| `phase1-backend/scripts/restore-database.ts` | عُدّل | 61 | 20 | 46 ← 46–51، 57 ← 62–68، 88–89 ← 99–102، 108 ← 121–123، 114 ← 129–131، 125 ← 142–143، 140 ← 158، 148 ← 166، 174 ← 192–201، 176–177 ← 203–204، 184 ← 211–214، 191 ← 221 … (١٦ موضعاً) |
| `phase1-backend/scripts/seed-demo.ts` | عُدّل | 753 | 120 | 56 ← 56–58، 60 ← 62–64، 67–73 ← 71–104، 83 ← 114–120، 85–86 ← 122–129، 98–99 ← 141–147، 101–102 ← 149–162، 105 ← —، 107–108 ← 166–181، 110–111 ← 183–196، 114–115 ← —، 117–118 ← 200–224 … (٦٢ موضعاً) |
| `phase1-backend/scripts/set-owner-email.ts` | عُدّل | 42 | 10 | 37 ← 37–38، 44 ← 45–48، 53 ← 57–59، 63 ← 69–72، 66 ← 75–77، 71 ← 82–84، 83 ← 96–98، 89 ← 104–116، 93–94 ← 120–126 |
| `phase1-backend/scripts/theme-collapse.mjs` | عُدّل | 41 | 21 | 62 ← 62–63، 65 ← 66–69، 80 ← 84–86، 94 ← 100–103، 119 ← 128–129، 177 ← 187–191، 183–193 ← 197–213، 195–198 ← 215–218 |
| `phase1-backend/scripts/theme-literals.mjs` | عُدّل | 23 | 14 | 84 ← 84–87، 90–99 ← 93–107، 101–103 ← 109–112 |
| `phase1-backend/scripts/theme-ratchet.mjs` | عُدّل | 29 | 15 | 71 ← 71–73، 75 ← 77–79، 81 ← 85–89، 85–96 ← 93–110 |
| `phase1-backend/src/auth/auth.errors.ts` | عُدّل | 1 | 1 | 11 ← 11 |
| `phase1-backend/src/auth/auth.service.ts` | عُدّل | 238 | 56 | 7–8 ← 7–23، 11 ← 26–30، 13 ← 32–36، 16 ← 39–42، 18 ← 44–48، 21 ← 51–55، 26 ← 60–66، 28 ← 68–72، 37 ← 81–84، 39 ← 86–90، 71 ← 122–125، 76 ← 130–135 … (٤٥ موضعاً) |
| `phase1-backend/src/auth/breached-passwords.ts` | عُدّل | 2 | 1 | 14 ← 14–15 |
| `phase1-backend/src/auth/identity.ts` | عُدّل | 154 | 26 | 80 ← 80–81، 128 ← 129–133، 186 ← 191–192، 231 ← 237–242، 233 ← 244–248، 236 ← 251–255، 240 ← 259–260، 243 ← 263–269، 252 ← 278–286، 254 ← 288–297، 256 ← 299–309، 260 ← 313–321 … (٢١ موضعاً) |
| `phase1-backend/src/auth/keys.ts` | عُدّل | 7 | 1 | 67 ← 67–73 |
| `phase1-backend/src/auth/password-policy.ts` | عُدّل | 162 | 26 | 73–83 ← 73–145، 86–88 ← 148–164، 90–95 ← 166–207، 97–100 ← 209–236، 185 ← 321، 241 ← 377 |
| `phase1-backend/src/auth/platform-permissions.ts` | عُدّل | 67 | 16 | 36 ← 36–40، 45–46 ← 49–58، 52–53 ← 64–72، 59–60 ← 78–86، 68 ← 94، 109 ← 135، 126 ← 152–156، 129 ← 159–163، 150 ← 184–187، 154 ← 191–194، 159 ← 199–203، 161 ← 205–208 … (١٣ موضعاً) |
| `phase1-backend/src/auth/redirects.ts` | عُدّل | 7 | 1 | 4 ← 4–10 |
| `phase1-backend/src/auth/secret-box.ts` | عُدّل | 47 | 14 | 110 ← 110–114، 135 ← 139–141، 167 ← 173–175، 177 ← 185، 181 ← 189–191، 199 ← 209، 228 ← 238–244، 249–250 ← 265–275، 252 ← 277–278، 256 ← 282، 263 ← 289–291، 269 ← 297–300 … (١٣ موضعاً) |
| `phase1-backend/src/auth/staff-permissions.ts` | عُدّل | 141 | 30 | 51 ← 51–57، 56 ← 62–66، 63 ← 73–77، 69 ← 83–86، 139–142 ← 156–168، 144 ← 170–174، 154 ← 184–193، 168 ← 207–210، 172 ← 214–218، 176 ← 222–227، 182 ← 233–241، 187 ← 246–250 … (٢٤ موضعاً) |
| `phase1-backend/src/auth/totp.ts` | عُدّل | 7 | 2 | 123 ← 123، 137 ← 137–142 |
| `phase1-backend/src/backup/backup-envelope.ts` | عُدّل | 36 | 17 | 118 ← 118–120، 122 ← 124–127، 130 ← 135، 144 ← 149، 182 ← 187–193، 202 ← 213، 236 ← 247–248، 255 ← 267، 272 ← 284، 293 ← 305، 304 ← 316، 313 ← 325–327 … (١٧ موضعاً) |
| `phase1-backend/src/backup/backup-policy.ts` | عُدّل | 1 | 1 | 96 ← 96 |
| `phase1-backend/src/backup/backup-storage.ts` | عُدّل | 61 | 18 | 98 ← 98–103، 104 ← 109–114، 110 ← 120–121، 113–114 ← 124–129، 123 ← 138–140، 134 ← 151، 164 ← 181–184، 186 ← 206، 201 ← 221، 211 ← 231، 221 ← 241–244، 226 ← 249–253 … (١٧ موضعاً) |
| `phase1-backend/src/config.ts` | عُدّل | 9 | 7 | 34–40 ← 34–42 |
| `phase1-backend/src/config/environment-report.ts` | عُدّل | 78 | 28 | 120 ← 120–121، 153 ← 154–161، 168 ← 176–177، 179–181 ← 188–194، 190–192 ← 203–210، 206–207 ← 224–232، 214 ← 239–244، 235 ← 265–266، 278 ← 309–311، 315 ← 348–351، 332 ← 368–370، 334–341 ← 372–385 … (١٦ موضعاً) |
| `phase1-backend/src/db/database-url.ts` | عُدّل | 7 | 2 | 5 ← 5–8، 39 ← 42–44 |
| `phase1-backend/src/demo/demo-mode.ts` | عُدّل | 9 | 3 | 67 ← 67–69، 120 ← 122–123، 139 ← 142–145 |
| `phase1-backend/src/events/domain-events.ts` | عُدّل | 37 | 8 | 24 ← 24–30، 26 ← 32–37، 28 ← 39–46، 40 ← 58–60، 43 ← 63–66، 60–61 ← 83–88، 73 ← 100–102 |
| `phase1-backend/src/http/app.ts` | عُدّل | 56 | 41 | 66 ← 66–68، 89–127 ← 91–135، 152 ← 160–167 |
| `phase1-backend/src/http/client-ip.ts` | عُدّل | 6 | 2 | 46 ← 46–47، 49 ← 50–53 |
| `phase1-backend/src/http/correlation.ts` | عُدّل | 6 | 2 | 96 ← 96–100، 100 ← 104 |
| `phase1-backend/src/http/errors.ts` | عُدّل | 274 | 38 | 4 ← 4–9، 14 ← 19–23، 36 ← 45–50، 93 ← 107–111، 95 ← 113–117، 125 ← 147–151، 150 ← 176–177، 173 ← 200–205، 179 ← 211–219، 188 ← 228–235، 193 ← 240–250، 215 ← 272–282 … (٢٩ موضعاً) |
| `phase1-backend/src/http/https-only.ts` | عُدّل | 10 | 2 | 31 ← 31–34، 49 ← 52–57 |
| `phase1-backend/src/http/routes/account-security.ts` | عُدّل | 98 | 66 | 1–20 ← 1–28، 22–67 ← 30–99 |
| `phase1-backend/src/http/routes/auth.ts` | عُدّل | 102 | 51 | 3 ← 3–8، 5 ← 10–13، 8 ← 16–21، 15–29 ← 28–63، 44–58 ← 78–98، 81–90 ← 121–133، 95–102 ← 138–153 |
| `phase1-backend/src/http/routes/catalog.ts` | عُدّل | 389 | 74 | 10–13 ← 10–43، 27 ← 57–63، 32 ← 68–69، 37 ← 74–77، 46 ← 86–90، 53–55 ← 97–136، 59–74 ← 140–248، 79–82 ← 253–269، 86–91 ← 273–361، 96–102 ← 366–381، 106–122 ← 385–426، 127–139 ← 431–454 |
| `phase1-backend/src/http/routes/customer-delight.ts` | عُدّل | 118 | 82 | 1–48 ← 1–59، 50–83 ← 61–119 |
| `phase1-backend/src/http/routes/marketing.ts` | عُدّل | 323 | 149 | 26–29 ← 26–51، 31 ← 53–56، 46 ← 71–80، 50–72 ← 84–119، 75–79 ← 122–129، 84–90 ← 134–145، 93–106 ← 148–178، 114–117 ← 186–197، 121–154 ← 201–267، 159–176 ← 272–307، 181–192 ← 312–333، 196–221 ← 337–395 |
| `phase1-backend/src/http/routes/merchant-home.ts` | عُدّل | 19 | 5 | 12–16 ← 12–30 |
| `phase1-backend/src/http/routes/merchant.ts` | عُدّل | 307 | 132 | 1 ← 1–5، 5 ← 9–12، 8 ← 15–21، 15–17 ← 28–43، 22 ← 48–55، 43–50 ← 76–86، 53–94 ← 89–159، 97–106 ← 162–181، 111–125 ← 186–215، 127–132 ← 217–227، 140–149 ← 235–252، 152–155 ← 255–266 … (١٤ موضعاً) |
| `phase1-backend/src/http/routes/notifications.ts` | عُدّل | 33 | 15 | 3 ← 3–7، 9–22 ← 13–40 |
| `phase1-backend/src/http/routes/openapi.ts` | عُدّل | 12 | 9 | 35–43 ← 35–46 |
| `phase1-backend/src/http/routes/orders.ts` | عُدّل | 541 | 155 | 7 ← 7–11، 10 ← 14–20، 12 ← 22–26، 14–17 ← 28–49، 20 ← 52–61، 25 ← 66–75، 30 ← 80–82، 33–34 ← 85–100، 53 ← 119–123، 58–60 ← 128–139، 63–65 ← 142–156، 78 ← 169–173 … (٢٥ موضعاً) |
| `phase1-backend/src/http/routes/owner-security.ts` | عُدّل | 56 | 38 | 23–26 ← 23–29، 28–35 ← 31–41، 37–43 ← 43–52، 45–51 ← 54–63، 66–69 ← 78–84، 71–78 ← 86–96 |
| `phase1-backend/src/http/routes/payment-methods.ts` | عُدّل | 21 | 10 | 14–17 ← 14–20، 19–24 ← 22–35 |
| `phase1-backend/src/http/routes/platform-services.ts` | عُدّل | 277 | 118 | 16–17 ← 16–22، 19–21 ← 24–39، 24 ← 42–53، 31–32 ← 60–65، 38–39 ← 71–76، 46 ← 83–86، 53–68 ← 93–121، 71–87 ← 124–158، 90–97 ← 161–179، 100–116 ← 182–219، 119–135 ← 222–253، 138–147 ← 256–273 … (١٣ موضعاً) |
| `phase1-backend/src/http/routes/platform-staff.ts` | عُدّل | 130 | 59 | 23 ← 23–26، 27 ← 30–34، 38–47 ← 45–57، 51–61 ← 61–77، 64–95 ← 80–161، 98–101 ← 164–172 |
| `phase1-backend/src/http/routes/platform.ts` | عُدّل | 522 | 218 | 1–2 ← 1–8، 9–10 ← 15–34، 15–17 ← 39–54، 36 ← 73–82، 39 ← 85–88، 57 ← 106–110، 76–79 ← 129–135، 82–85 ← 138–144، 88–96 ← 147–158، 98–167 ← 160–282، 171–178 ← 286–299، 186–187 ← 307–331 … (٢٠ موضعاً) |
| `phase1-backend/src/http/routes/pos.ts` | عُدّل | 85 | 49 | 45–51 ← 45–54، 53–57 ← 56–65، 59–64 ← 67–75، 78–83 ← 89–105، 86–99 ← 108–124، 102–106 ← 127–139، 108–113 ← 141–149 |
| `phase1-backend/src/http/routes/public.ts` | عُدّل | 220 | 149 | 1–13 ← 1–20، 15–150 ← 22–221 |
| `phase1-backend/src/http/routes/return-inspection.ts` | عُدّل | 46 | 17 | 11 ← 11–15، 18–22 ← 22–34، 26–36 ← 38–65 |
| `phase1-backend/src/http/routes/returns.ts` | عُدّل | 75 | 28 | 11 ← 11–16، 25–29 ← 30–42، 31–37 ← 44–62، 39–43 ← 64–75، 45–48 ← 77–88، 50–55 ← 90–102 |
| `phase1-backend/src/http/routes/reviews-wishlist.ts` | عُدّل | 204 | 95 | 17 ← 17–25، 34 ← 42–46، 36 ← 48–52، 41–54 ← 57–82، 58–62 ← 86–100، 65–69 ← 103–117، 71–75 ← 119–131، 78–88 ← 134–151، 90–95 ← 153–161، 99–103 ← 165–177، 107–118 ← 181–198، 121–125 ← 201–213 … (١٦ موضعاً) |
| `phase1-backend/src/http/routes/sessions.ts` | عُدّل | 43 | 26 | 16 ← 16–21، 19–22 ← 24–30، 24–33 ← 32–44، 35–40 ← 46–54، 42–46 ← 56–63 |
| `phase1-backend/src/http/routes/store-banners.ts` | عُدّل | 93 | 43 | 16 ← 16–24، 19–21 ← 27–42، 40–44 ← 61–68، 46–53 ← 70–85، 55–60 ← 87–99، 62–67 ← 101–109، 72–76 ← 114–123، 78–86 ← 125–136 |
| `phase1-backend/src/http/routes/store-traffic.ts` | عُدّل | 33 | 16 | 13 ← 13–18، 42 ← 47–51، 44 ← —، 58–70 ← 66–87 |
| `phase1-backend/src/http/routes/storefront-config.ts` | عُدّل | 104 | 42 | 16 ← 16–24، 20–21 ← 28–40، 35–38 ← 54–62، 40–45 ← 64–77، 47–51 ← 79–92، 53–57 ← 94–103، 60–68 ← 106–117، 70–74 ← 119–128، 79–83 ← 133–145 |
| `phase1-backend/src/http/routes/storefront.ts` | عُدّل | 548 | 195 | 9–12 ← 9–41، 28–29 ← 57–75، 39 ← 85–88، 54–58 ← 103–112، 61–79 ← 115–164، 104–181 ← 189–363، 192–205 ← 374–416، 207–241 ← 418–530، 246–262 ← 535–570، 264–272 ← 572–614، 276–286 ← 618–639 |
| `phase1-backend/src/http/routes/team.ts` | عُدّل | 103 | 49 | 4–5 ← 4–16، 10–45 ← 21–87، 49–53 ← 91–100، 58–63 ← 105–117 |
| `phase1-backend/src/http/routes/trash.ts` | عُدّل | 78 | 28 | 33–34 ← 33–42، 46–71 ← 54–121 |
| `phase1-backend/src/http/routes/webhooks.ts` | عُدّل | 52 | 23 | 14 ← 14–18، 21–38 ← 25–64، 42–45 ← 68–74 |
| `phase1-backend/src/http/schemas/catalog.schema.ts` | عُدّل | 6 | 4 | 54–57 ← 54–59 |
| `phase1-backend/src/http/schemas/list.schema.ts` | عُدّل | 5 | 2 | 25 ← 25–28، 36 ← 39 |
| `phase1-backend/src/http/schemas/loyalty.schema.ts` | عُدّل | 6 | 1 | 23 ← 23–28 |
| `phase1-backend/src/http/schemas/marketing.schema.ts` | عُدّل | 17 | 3 | 37 ← 37–40، 46 ← 49–52، 53 ← 59–67 |
| `phase1-backend/src/http/schemas/messaging-caps.schema.ts` | عُدّل | 3 | 1 | 18 ← 18–20 |
| `phase1-backend/src/http/schemas/payment-methods.schema.ts` | عُدّل | 3 | 1 | 13 ← 13–15 |
| `phase1-backend/src/http/schemas/platform-staff.schema.ts` | عُدّل | 1 | 1 | 36 ← 36 |
| `phase1-backend/src/http/schemas/platform.schema.ts` | عُدّل | 31 | 7 | 51 ← 51–52، 54–56 ← 55–68، 88 ← 100–105، 92 ← 109–113، 104 ← 125–128 |
| `phase1-backend/src/http/schemas/pos.schema.ts` | عُدّل | 10 | 5 | 20–24 ← 20–29 |
| `phase1-backend/src/http/schemas/returns.schema.ts` | عُدّل | 4 | 1 | 33 ← 33–36 |
| `phase1-backend/src/http/schemas/reviews.schema.ts` | عُدّل | 6 | 1 | 23 ← 23–28 |
| `phase1-backend/src/http/schemas/search.schema.ts` | عُدّل | 7 | 2 | 55 ← 55، 61 ← 61–66 |
| `phase1-backend/src/http/schemas/store-banner.schema.ts` | عُدّل | 3 | 1 | 17 ← 17–19 |
| `phase1-backend/src/http/schemas/storefront-config.schema.ts` | عُدّل | 52 | 15 | 23 ← 23–31، 53 ← 61–63، 60 ← 70–72، 69 ← 81، 72 ← 84–86، 96 ← 110–113، 99 ← 116، 102 ← 119–121، 106–108 ← 125–130، 117–118 ← 139–148، 125 ← 155–160، 155 ← 190–192 |
| `phase1-backend/src/http/schemas/team.schema.ts` | عُدّل | 1 | 1 | 62 ← 62 |
| `phase1-backend/src/http/schemas/webhooks.schema.ts` | عُدّل | 12 | 7 | 8–14 ← 8–19 |
| `phase1-backend/src/http/security-headers.ts` | عُدّل | 19 | 7 | 124 ← 124–125، 130 ← 131–133، 138 ← 141–143، 199 ← 204–206، 277 ← 284–287، 279 ← 289–290، 352 ← 363–364 |
| `phase1-backend/src/http/session-cookie.ts` | عُدّل | 5 | 1 | 51 ← 51–55 |
| `phase1-backend/src/http/shared.ts` | عُدّل | 163 | 33 | 11 ← 11–14، 21–23 ← 24–28، 33–35 ← 38–46، 80 ← 91–97، 83–84 ← 100–112، 88 ← 116–121، 120 ← 153–157، 128 ← 165–169، 132–133 ← 173–184، 161 ← 212، 185 ← 236–240، 187 ← 242–245 … (٢٦ موضعاً) |
| `phase1-backend/src/http/validate.ts` | عُدّل | 8 | 3 | 55 ← 55، 60 ← 60–62، 102 ← 104–107 |
| `phase1-backend/src/index.ts` | عُدّل | 3 | 1 | 7 ← 7–9 |
| `phase1-backend/src/jobs/scheduler.ts` | عُدّل | 7 | 2 | 65 ← 65–68، 113 ← 116–118 |
| `phase1-backend/src/logging/logger.ts` | عُدّل | 27 | 7 | 34 ← 34–40، 60 ← 66–68، 70 ← 78–80، 79–80 ← 89–95، 94 ← 109–111، 149 ← 166–169 |
| `phase1-backend/src/logging/redact.ts` | عُدّل | 2 | 1 | 97 ← 97–98 |
| `phase1-backend/src/modules/core-modules.ts` | عُدّل | 168 | 28 | 44–71 ← 44–211 |
| `phase1-backend/src/modules/market-account/account.service.ts` | عُدّل | 229 | 47 | 10 ← 10–14، 22 ← 26–30، 26 ← 34–43، 38 ← 55–57، 54 ← 73–74، 57 ← 77–81، 66 ← 90–91، 70 ← 95–100، 77 ← 107–110، 81 ← 114–121، 91–93 ← 131–140، 99–101 ← 146–155 … (٣١ موضعاً) |
| `phase1-backend/src/modules/market-account/otp.service.ts` | عُدّل | 87 | 17 | 73 ← 73–78، 75–78 ← 80–102، 81 ← 105–107، 86 ← 112–121، 90 ← 125–129، 101–102 ← 140–147، 104 ← 149–159، 109–112 ← 164–172، 115 ← 175–182، 117 ← 184–187 |
| `phase1-backend/src/modules/market-account/routes.ts` | عُدّل | 198 | 101 | 7 ← 7–13، 12 ← —، 14–15 ← 19–38، 17–19 ← 40–51، 29–50 ← 61–93، 56–86 ← 99–150، 89–129 ← 153–226 |
| `phase1-backend/src/modules/market-account/schema.ts` | عُدّل | 39 | 16 | 7 ← 7–13، 13 ← 19–22، 17–30 ← 26–53 |
| `phase1-backend/src/modules/market-account/shopper-auth.ts` | عُدّل | 20 | 5 | 16 ← 16–18، 27 ← 29–30، 30 ← 33–34، 36 ← 40–46، 40 ← 50–55 |
| `phase1-backend/src/modules/market-campaigns/campaigns.service.ts` | عُدّل | 351 | 69 | 19 ← 19–24، 27 ← 32–40، 35 ← 48–58، 37–38 ← 60–72، 40–41 ← 74–85، 45 ← 89–90، 58 ← 103–107، 60–61 ← 109–120، 68 ← 127–131، 70–71 ← 133–142، 74–75 ← 145–151، 79 ← 155–159 … (٤٥ موضعاً) |
| `phase1-backend/src/modules/market-campaigns/routes.ts` | عُدّل | 161 | 67 | 14–15 ← 14–27، 17 ← 29–36، 21–27 ← 40–52، 30–43 ← 55–79، 46–88 ← 82–182 |
| `phase1-backend/src/modules/market-campaigns/schema.ts` | عُدّل | 58 | 18 | 5–14 ← 5–26، 17–18 ← 29–40، 21–23 ← 43–52، 25–27 ← 54–67 |
| `phase1-backend/src/modules/market-cart/cart.service.ts` | عُدّل | 340 | 85 | 19–20 ← 19–28، 24–25 ← 32–45، 29–30 ← 49–64، 34–35 ← 68–76، 40 ← 81–88، 45 ← 93–97، 47–48 ← 99–104، 53–54 ← 109–121، 56 ← 123–130، 58 ← 132–137، 63 ← 142–148، 67–85 ← 152–208 … (٢٨ موضعاً) |
| `phase1-backend/src/modules/market-cart/checkout.service.ts` | عُدّل | 420 | 66 | 14 ← 14–20، 22 ← 28–33، 32 ← 43–46، 38–39 ← 52–60، 41 ← 62–67، 44 ← 70–80، 46 ← 82–85، 50 ← 89–98، 54 ← 102–105، 61–62 ← 112–127، 67 ← 132–141، 71 ← 145–155 … (٥١ موضعاً) |
| `phase1-backend/src/modules/market-cart/routes.ts` | عُدّل | 180 | 70 | 11–12 ← 11–25، 15 ← 28–34، 18–21 ← 37–43، 23–27 ← 45–54، 29–33 ← 56–71، 35–39 ← 73–80، 41–45 ← 82–89، 47–51 ← 91–98، 53–66 ← 100–126، 68–74 ← 128–154، 77–85 ← 157–180، 87–90 ← 182–197 … (١٣ موضعاً) |
| `phase1-backend/src/modules/market-cart/schema.ts` | عُدّل | 21 | 8 | 4 ← 4–7، 6–11 ← 9–19، 35 ← 43–48 |
| `phase1-backend/src/modules/market-catalog/categories.service.ts` | عُدّل | 56 | 11 | 9 ← 9–15، 12 ← 18–23، 16–17 ← 27–37، 25 ← 45–50، 39 ← 64–66، 52 ← 79، 54 ← 81–89، 68 ← 103–105، 73–74 ← 110–119 |
| `phase1-backend/src/modules/market-catalog/merchant.service.ts` | عُدّل | 98 | 21 | 11 ← 11–16، 26 ← 31–32، 29 ← 35–39، 31–32 ← 41–46، 37–39 ← 51–66، 41 ← 68–71، 72 ← 102–106، 77 ← 111–117، 82 ← 122–124، 87 ← 129–132، 92 ← 137–141، 96 ← 145–149 … (١٧ موضعاً) |
| `phase1-backend/src/modules/market-catalog/products.service.ts` | عُدّل | 148 | 37 | 19 ← 19–24، 31 ← 36–39، 35–40 ← 43–70، 43 ← 73–77، 47 ← 81–83، 51–57 ← 87–100، 62 ← 105–107، 75 ← 120–123، 77 ← 125–126، 91 ← 140–141، 154 ← 204–205، 161 ← 212–214 … (٢٥ موضعاً) |
| `phase1-backend/src/modules/market-catalog/routes.ts` | عُدّل | 115 | 56 | 14–15 ← 14–26، 21–24 ← 32–38، 26–29 ← 40–46، 31–36 ← 48–56، 38–42 ← 58–67، 44–48 ← 69–76، 50–53 ← 78–84، 56–59 ← 87–95، 61–66 ← 97–107، 68–71 ← 109–120، 73–78 ← 122–132، 80–85 ← 134–144 |
| `phase1-backend/src/modules/market-catalog/schema.ts` | عُدّل | 137 | 51 | 4 ← 4–14، 7 ← 17–25، 10–13 ← 28–53، 16–42 ← 56–93، 47–62 ← 98–138، 66 ← 142–150، 69 ← 153–155 |
| `phase1-backend/src/modules/market-catalog/search.service.ts` | عُدّل | 0 | 1 | 62 ← — |
| `phase1-backend/src/modules/market-catalog/stats.service.ts` | عُدّل | 11 | 2 | 10–11 ← 10–20 |
| `phase1-backend/src/modules/market-geo/routes.ts` | عُدّل | 7 | 4 | 10–13 ← 10–16 |
| `phase1-backend/src/modules/market-help/favourites.service.ts` | عُدّل | 112 | 26 | 9 ← 9–14، 25 ← 30–32، 27–30 ← 34–48، 32 ← 50–53، 44–46 ← 65–75، 48–49 ← 77–85، 53 ← 89–92، 56 ← 95–99، 61 ← 104–107، 63 ← 109–110، 73 ← 120–125، 78 ← 130–132 … (١٩ موضعاً) |
| `phase1-backend/src/modules/market-help/help.service.ts` | عُدّل | 196 | 38 | 10 ← 10–15، 15 ← 20–25، 20 ← 30–33، 31 ← 44–48، 37 ← 54–60، 46 ← 69–79، 53 ← 86–88، 57 ← 92–96، 60–61 ← 99–110، 69 ← 118–128، 75–76 ← 134–141، 86 ← 151–152 … (٢٨ موضعاً) |
| `phase1-backend/src/modules/market-help/inbox.service.ts` | عُدّل | 103 | 22 | 16 ← 16–21، 18 ← 23–36، 52–60 ← 70–103، 65 ← 108–117، 67–72 ← 119–142، 78 ← 148–150، 86 ← 158–160، 103 ← 177–180، 111 ← 188–192 |
| `phase1-backend/src/modules/market-help/routes.ts` | عُدّل | 299 | 130 | 17 ← 17–26، 20–21 ← 29–44، 24–25 ← 47–56، 30–66 ← 61–131، 69–86 ← 134–167، 89–105 ← 170–208، 108–160 ← 211–329 |
| `phase1-backend/src/modules/market-help/schema.ts` | عُدّل | 57 | 21 | 5–21 ← 5–41، 34 ← 54–58، 41–42 ← 65–72، 58 ← 88–94 |
| `phase1-backend/src/modules/market-home/content.service.ts` | عُدّل | 279 | 50 | 9 ← 9–12، 23–24 ← 26–40، 34 ← 50–54، 39 ← 59–70، 43 ← 74–78، 49 ← 84–88، 53 ← 92–95، 62 ← 104–107، 66 ← 111–118، 72 ← 124–128، 78–79 ← 134–150، 82 ← 153–155 … (٤٦ موضعاً) |
| `phase1-backend/src/modules/market-home/home.service.ts` | عُدّل | 147 | 28 | 16 ← 16–19، 20 ← 23–26، 28 ← 34–42، 30 ← 44–51، 39 ← 60–68، 41 ← 70–78، 46 ← 83–88، 48 ← 90–98، 59–60 ← 109–121، 68 ← 129–133، 70 ← 135–143، 72 ← 145–147 … (٢٠ موضعاً) |
| `phase1-backend/src/modules/market-home/routes.ts` | عُدّل | 295 | 93 | 10 ← 10–16، 15–16 ← —، 18–19 ← 22–52، 22 ← 55–63، 26 ← 67–70، 41–50 ← 85–91، — ← 93–99، 53–56 ← 101–107، 58–64 ← 109–118، 66–72 ← 120–134، 75–88 ← 137–183، 90–103 ← 185–239 … (١٥ موضعاً) |
| `phase1-backend/src/modules/market-home/schema.ts` | عُدّل | 170 | 52 | 4–7 ← 4–39، 9–10 ← 41–50، 12 ← 52–53، 14–26 ← 55–77، 32–42 ← 83–95، 56 ← 109–111، 58–67 ← 113–135، 70–79 ← 138–197 |
| `phase1-backend/src/modules/market-orders/after-sales.service.ts` | عُدّل | 370 | 67 | 23–24 ← 23–39، 40 ← 55–62، 52 ← 74–78، 56–57 ← 82–88، 61 ← 92–96، 69 ← 104–108، 72 ← 111–113، 78 ← 119–122، 86 ← 130–133، 92–93 ← 139–146، 96 ← 149–150، 98 ← 152–156 … (٤٨ موضعاً) |
| `phase1-backend/src/modules/market-orders/reasons.ts` | عُدّل | 7 | 3 | 45–46 ← 45–49، 49 ← 52–53 |
| `phase1-backend/src/modules/market-orders/routes.ts` | عُدّل | 126 | 50 | 13–14 ← 13–22، 16 ← 24–30، 19–21 ← 33–38، 23–27 ← 40–55، 29–33 ← 57–72، 35–39 ← 74–81، 41–45 ← 83–98، 47–50 ← 100–108، 52–55 ← 110–118، 57–60 ← 120–126، 62–67 ← 128–138، 69–74 ← 140–150 |
| `phase1-backend/src/modules/market-orders/schema.ts` | عُدّل | 34 | 10 | 3 ← 3–9، 8–9 ← 14–19، 14 ← 24–28، 16–20 ← 30–39، 24 ← 43–48 |
| `phase1-backend/src/modules/market-partner/partner.service.ts` | عُدّل | 298 | 52 | 62 ← 62–69، 68 ← 75–79، 71–72 ← 82–97، 76 ← 101–106، 91 ← 121–125، 93 ← 127–129، 95 ← 131–136، 99 ← 140–145، 102–105 ← 148–171، 109–112 ← 175–192، 118–119 ← 198–209، 125 ← 215–218 … (٣٣ موضعاً) |
| `phase1-backend/src/modules/market-partner/routes.ts` | عُدّل | 76 | 38 | 18 ← 18–25، 24–31 ← 31–46، 33–36 ← 48–54، 38–42 ← 56–63، 44–51 ← 65–80، 53–57 ← 82–89، 59–65 ← 91–103 |
| `phase1-backend/src/modules/market-partner/schema.ts` | عُدّل | 4 | 1 | 5 ← 5–8 |
| `phase1-backend/src/modules/market-payments/payments.service.ts` | عُدّل | 405 | 84 | 23 ← 23–28، 25 ← 30–37، 33–34 ← 45–58، 48 ← 72–76، 56–57 ← 84–91، 60–70 ← 94–120، 80 ← 130–133، 82–83 ← 135–140، 87–88 ← 144–162، 93–94 ← 167–176، 110–112 ← 192–201، 115 ← 204–207 … (٤٩ موضعاً) |
| `phase1-backend/src/modules/market-payments/providers.ts` | عُدّل | 120 | 22 | 21 ← 21–26، 26 ← 31–35، 44 ← 53–58، 61 ← 75–78، 74 ← 91–94، 83 ← 103–108، 85–86 ← 110–121، 88 ← —، 97 ← 131–140، 103 ← 146–148، 107–108 ← 152–162، 112 ← 166–170 … (١٥ موضعاً) |
| `phase1-backend/src/modules/market-payments/routes.ts` | عُدّل | 52 | 27 | 24–28 ← 24–31، 32–42 ← 35–59، 44–49 ← 61–71، 51–55 ← 73–80 |
| `phase1-backend/src/modules/market-payments/schema.ts` | عُدّل | 13 | 1 | 6 ← 6–18 |
| `phase1-backend/src/modules/market-reels/reels.service.ts` | عُدّل | 238 | 52 | 16–17 ← 16–28، 26 ← 37–38، 28 ← 40–42، 33–34 ← 47–59، 43–44 ← 68–75، 54 ← 85–88، 60 ← 94–100، 65 ← 105–107، 72 ← 114–117، 79 ← 124–133، 85–88 ← 139–150، 90 ← 152–155 … (٣٣ موضعاً) |
| `phase1-backend/src/modules/market-reels/routes.ts` | عُدّل | 215 | 69 | 11 ← 11–17، 19–20 ← 25–44، 24 ← 48–51، 32 ← 59–64، 36–37 ← 68–73، 39 ← 75–78، 46–73 ← 85–162، 75–93 ← 164–218، 95–108 ← 220–254 |
| `phase1-backend/src/modules/market-reels/schema.ts` | عُدّل | 19 | 4 | 6 ← 6–24، 8–10 ← — |
| `phase1-backend/src/modules/market-rewards/rewards.service.ts` | عُدّل | 352 | 66 | 18–19 ← 18–32، 23–24 ← 36–51، 30–33 ← 57–71، 42 ← 80–85، 44 ← 87–96، 46 ← 98–100، 52–55 ← 106–129، 64 ← 138–140، 67–69 ← 143–150، 74 ← 155–158، 76 ← 160–161، 79 ← 164–170 … (٣٧ موضعاً) |
| `phase1-backend/src/modules/market-rewards/routes.ts` | عُدّل | 119 | 50 | 13 ← 13–25، 17–42 ← 29–82، 44–66 ← 84–135 |
| `phase1-backend/src/modules/market-rewards/schema.ts` | عُدّل | 35 | 18 | 4–20 ← 4–32، 22 ← 34–39 |
| `phase1-backend/src/modules/market-stores/directory.service.ts` | عُدّل | 231 | 56 | 18 ← 18–23، 22 ← 27–35، 38 ← 51–52، 40–45 ← 54–65، 50–57 ← 70–98، 60 ← 101–102، 69–71 ← 111–121، 73 ← 123–132، 106 ← 165–166، 116 ← 176–179، 119 ← 182–183، 121 ← 185–188 … (٣١ موضعاً) |
| `phase1-backend/src/modules/market-stores/map-tiles.service.ts` | عُدّل | 56 | 16 | 39–40 ← 39–45، 44 ← 49–50، 58 ← 64–67، 63 ← 72–73، 70 ← 80–84، 74 ← 88–89، 77 ← 92–93، 79 ← 95–96، 81 ← 98–99، 86 ← 104–108، 89–90 ← 111–121، 98–99 ← 129–135 … (١٣ موضعاً) |
| `phase1-backend/src/modules/market-stores/market-score.ts` | عُدّل | 51 | 12 | 44 ← 44–49، 57 ← 62–69، 80 ← 92–95، 108 ← 123–125، 112 ← 129–132، 114 ← 134–136، 116 ← 138–139، 119 ← 142–145، 123 ← 149–152، 141–143 ← 170–182 |
| `phase1-backend/src/modules/market-stores/metrics.service.ts` | عُدّل | 52 | 27 | 16–18 ← 16–27، 93 ← 102–103، 96–97 ← 106–116، 102–122 ← 121–147 |
| `phase1-backend/src/modules/market-stores/moderation.service.ts` | عُدّل | 82 | 17 | 8 ← 8–13، 17 ← 22–24، 27 ← 34–41، 32–33 ← 46–60، 39 ← 66–68، 48 ← 77–79، 60 ← 91–94، 73 ← 107–111، 75–76 ← 113–120، 85 ← 129، 90 ← 134–140، 95 ← 145–148 … (١٤ موضعاً) |
| `phase1-backend/src/modules/market-stores/presentation.ts` | عُدّل | 113 | 21 | 12–22 ← 12–77، 25 ← 80–85، 43 ← 103–107، 47 ← 111–117، 50 ← 120–123، 55 ← 128–134، 61 ← 140–142، 70 ← 151–154، 109 ← 193–197، 122 ← 210–212، 126 ← 216–218 |
| `phase1-backend/src/modules/market-stores/profile.service.ts` | عُدّل | 120 | 26 | 15 ← 15–18، 17 ← 20–28، 21–25 ← 32–55، 32 ← 62–64، 36 ← 68–72، 73 ← 109–112، 77 ← 116–119، 95–96 ← 137–140، 98–99 ← 142–151، 115 ← 167–172، 126 ← 183–187، 130 ← 191–196 … (١٧ موضعاً) |
| `phase1-backend/src/modules/market-stores/routes.ts` | عُدّل | 222 | 118 | 10 ← 10–16، 15 ← 21–30، 17 ← 32–39، 21 ← 43–50، 24 ← 53–56، 37–41 ← 69–76، 43–46 ← 78–84، 50–94 ← 88–163، 97–131 ← 166–219، 134–157 ← 222–261 |
| `phase1-backend/src/modules/market-stores/schema.ts` | عُدّل | 101 | 39 | 4 ← 4–12، 7 ← 15–18، 10–24 ← 21–43، 29–41 ← 48–80، 44–47 ← 83–91، 60 ← 104–109، 63–65 ← 112–123، 68 ← 126–130 |
| `phase1-backend/src/modules/market-support/routes.ts` | عُدّل | 317 | 102 | 10 ← 10–16، 17–18 ← 23–40، 20 ← 42–49، 22 ← 51–54، 34 ← 66–69، 41–43 ← 76–88، 46–82 ← 91–202، 85–112 ← 205–291، 115–142 ← 294–357 |
| `phase1-backend/src/modules/market-support/schema.ts` | عُدّل | 10 | 3 | 9 ← 9–11، 18–19 ← 20–26 |
| `phase1-backend/src/modules/market-support/tickets.service.ts` | عُدّل | 320 | 62 | 18–19 ← 18–28، 33 ← 42–46، 46 ← 59–63، 51 ← 68–70، 56 ← 75–76، 58 ← 78–91، 60–61 ← 93–99، 64 ← 102–105، 68–69 ← 109–120، 77 ← 128–131، 79–81 ← 133–152، 83 ← 154–161 … (٤٤ موضعاً) |
| `phase1-backend/src/modules/market-visual/routes.ts` | عُدّل | 64 | 26 | 11 ← 11–16، 18 ← 23–29، 24 ← 35–38، 29 ← 43–48، 35–42 ← 54–71، 44–47 ← 73–79، 49–52 ← 81–87، 54–59 ← 89–97 |
| `phase1-backend/src/modules/market-visual/schema.ts` | عُدّل | 3 | 1 | 4 ← 4–6 |
| `phase1-backend/src/modules/market-visual/visual.service.ts` | عُدّل | 52 | 12 | 20 ← 20–24، 34 ← 38–44، 65 ← 75–76، 67 ← 78–81، 69 ← 83–86، 78–79 ← 95–101، 94 ← 116–120، 119 ← 145–151، 121 ← 153–156، 127 ← 162–166، 143 ← 182–183 |
| `phase1-backend/src/modules/market-wheel/routes.ts` | عُدّل | 180 | 73 | 16–17 ← 16–39، 20–47 ← 42–104، 49–91 ← 106–198 |
| `phase1-backend/src/modules/market-wheel/schema.ts` | عُدّل | 54 | 27 | 4–16 ← 4–25، 18–29 ← 27–49، 32–33 ← 52–60 |
| `phase1-backend/src/modules/market-wheel/wheel.service.ts` | عُدّل | 437 | 91 | 18 ← 18–23، 35 ← 40–43، 51 ← 59–67، 56 ← 72–76، 62–63 ← 82–95، 67 ← 99–101، 73 ← 107–115، 86 ← 128–131، 94–120 ← 139–212، 125 ← 217–221، 132 ← 228–235، 134 ← 237–253 … (٤٦ موضعاً) |
| `phase1-backend/src/modules/platform-module.ts` | عُدّل | 13 | 2 | 27 ← 27–37، 42 ← 52–53 |
| `phase1-backend/src/modules/platform-modules/routes.ts` | عُدّل | 7 | 4 | 13–16 ← 13–19 |
| `phase1-backend/src/modules/registry.ts` | عُدّل | 8 | 2 | 53 ← 53–56، 68 ← 71–74 |
| `phase1-backend/src/notifications/abandoned-cart-scanner.ts` | عُدّل | 50 | 13 | 56 ← 56–58، 58 ← 60–65، 70 ← 77–84، 74 ← 88–92، 80 ← 98–100، 82 ← 102–105، 84–87 ← 107–115، 131 ← 159–162، 168 ← 199–202، 173 ← 207–210 |
| `phase1-backend/src/notifications/merchant-digest-scanner.ts` | عُدّل | 48 | 11 | 63 ← 63–68، 67 ← 72–77، 70 ← 80–82، 72 ← 84–90، 80 ← 98–102، 84 ← 106–108، 96 ← 120–123، 102 ← 129–133، 108 ← 139–141، 111 ← 144–147، 136 ← 172–173 |
| `phase1-backend/src/notifications/messaging-compliance.service.ts` | عُدّل | 54 | 13 | 46 ← 46–48، 67 ← 69–72، 85 ← 90–92، 89–90 ← 96–101، 139 ← 150–154، 198 ← 213–216، 200 ← 218–220، 226 ← 246–251، 271 ← 296–298، 288 ← 315–319، 291–292 ← 322–333 |
| `phase1-backend/src/notifications/notification-outbox.service.ts` | عُدّل | 153 | 67 | 71 ← 71–74، 74 ← 77–82، 87–94 ← 95–105، 97 ← 108–113، 99 ← 115–125، 103 ← 129–139، 108–129 ← 144–168، 132 ← 171–176، 135 ← 179–189، 139 ← 193–203، 160–165 ← 224–232، 170 ← 237–240 … (١٥ موضعاً) |
| `phase1-backend/src/notifications/notification-provider.ts` | عُدّل | 48 | 13 | 92 ← 92–94، 129 ← 131–134، 171 ← 176–179، 173 ← 181–187، 180–183 ← 194–200، 204 ← 221–226، 287 ← 309–311، 307 ← 331–337، 310 ← 340–343، 350 ← 383–385 |
| `phase1-backend/src/notifications/outbox-worker.ts` | عُدّل | 270 | 79 | 37–38 ← 37–42، 81 ← 85–89، 87 ← 95–98، 89 ← 100–103، 93 ← 107–110، 100–102 ← 117–120، 107 ← 125–126، 110–112 ← 129–132، 132–135 ← 152–156، 139 ← 160، 153–155 ← 174–177، 184–187 ← 206–212 … (٤٦ موضعاً) |
| `phase1-backend/src/notifications/resend-webhook.ts` | عُدّل | 74 | 14 | 22 ← 22–28، 28–29 ← 34–44، 31 ← 46–50، 37 ← 56–59، 43 ← 65–69، 59 ← 85–89، 61 ← 91–92، 71 ← 102–108، 78 ← 115–121، 81 ← 124–125، 97 ← 141–148، 99 ← 150–152 … (١٣ موضعاً) |
| `phase1-backend/src/notifications/restock-scanner.ts` | عُدّل | 18 | 5 | 67 ← 67–70، 80 ← 83–87، 108 ← 115–117، 114 ← 123–126، 119 ← 131–132 |
| `phase1-backend/src/notifications/trial-expiry-scanner.ts` | عُدّل | 26 | 6 | 59 ← 59–62، 64 ← 67–69، 92 ← 97–101، 104 ← 113–117، 169 ← 182–185، 194 ← 210–214 |
| `phase1-backend/src/notifications/worker-entry.ts` | عُدّل | 102 | 18 | 26–28 ← 26–37، 30–31 ← 39–47، 36 ← 52–55، 64 ← 83–90، 66 ← 92–96، 68 ← 98–105، 72 ← 109–119، 75 ← 122–129، 78 ← 132–139، 82 ← 143–147، 85 ← 150–154، 91–92 ← 160–172 … (١٤ موضعاً) |
| `phase1-backend/src/observability/sentry.ts` | عُدّل | 4 | 1 | 137 ← 137–140 |
| `phase1-backend/src/services/abandoned-cart.service.ts` | عُدّل | 95 | 21 | 20 ← 20–26، 41 ← 47–49، 44 ← 52–55، 49 ← 60–63، 52 ← 66–69، 75–77 ← 92–103، 80–83 ← 106–126، 86 ← 129–132، 122 ← 168–172، 125 ← 175–178، 130 ← 183–189، 137 ← 196–200 … (١٥ موضعاً) |
| `phase1-backend/src/services/analytics.service.ts` | عُدّل | 66 | 13 | 31 ← 31–32، 33 ← 34–35، 66 ← 68–73، 96 ← 103–110، 99 ← 113–114، 150 ← 165–167، 167 ← 184–188، 178 ← 199–204، 181 ← 207–217، 225 ← 261–267، 229 ← 271–273، 240 ← 284–289 … (١٣ موضعاً) |
| `phase1-backend/src/services/availability.service.ts` | عُدّل | 647 | 129 | 37–38 ← 37–50، 43 ← 55–61، 47–49 ← 65–77، 54 ← 82–90، 63 ← 99–112، 70 ← 119–122، 93–97 ← 145–154، 103 ← 160–161، 137 ← 195–196، 163–164 ← 222–229، 178 ← 243–245، 181 ← 248–256 … (٨٠ موضعاً) |
| `phase1-backend/src/services/config.service.ts` | عُدّل | 314 | 59 | 37 ← 37–41، 64–72 ← 68–168، 78–79 ← 174–186، 83 ← 190–191، 88 ← 196–199، 100 ← 211–214، 104 ← 218–219، 122 ← 237–238، 125 ← 241–242، 128 ← 245–246، 133 ← 251–255، 137 ← 259–263 … (٤٠ موضعاً) |
| `phase1-backend/src/services/coupon.service.ts` | عُدّل | 219 | 54 | 20 ← 20–26، 35 ← 41–42، 37 ← 44–49، 52–53 ← 64–69، 61–62 ← 77–83، 67 ← 88–90، 69–70 ← 92–100، 73–74 ← 103–111، 92–93 ← 129–149، 101 ← 157–160، 112 ← 171–180، 122–125 ← 190–206 … (٣٥ موضعاً) |
| `phase1-backend/src/services/csv-transfer.service.ts` | عُدّل | 498 | 150 | 52 ← 52–57، 70 ← 75–78، 73 ← 81–85، 86 ← 98–104، 110 ← 128–132، 119 ← 141–144، 127 ← 152–156، 129 ← 158–159، 134–135 ← 164–173، 139 ← 177–184، 142–144 ← 187–204، 156 ← 216–225 … (٥٢ موضعاً) |
| `phase1-backend/src/services/csv.ts` | عُدّل | 51 | 12 | 24–25 ← 24–33، 30–31 ← 38–45، 33 ← 47–49، 35–39 ← 51–74، 70 ← 105–107، 75 ← 112–114 |
| `phase1-backend/src/services/customer-directory.service.ts` | عُدّل | 49 | 10 | 12 ← 12–18، 31 ← 37–41، 73 ← 83–86، 81 ← 94–97، 100 ← 116–125، 104 ← 129–131، 106 ← 133–141، 128 ← 163، 131–132 ← 166–171 |
| `phase1-backend/src/services/delivery-rates.service.ts` | عُدّل | 40 | 8 | 10 ← 10–15، 44 ← 49–53، 47 ← 56–60، 51 ← 64–68، 53 ← 70–73، 57 ← 77–81، 62–63 ← 86–95 |
| `phase1-backend/src/services/delivery.service.ts` | عُدّل | 203 | 51 | 54 ← 54–58، 57 ← 61–62، 60 ← 65–70، 68 ← 78–81، 71 ← 84–88، 76 ← 93–98، 87 ← 109–113، 90 ← 116–121، 92 ← 123–127، 95–97 ← 130–145، 108–110 ← 156–169، 130 ← 189–191 … (٣١ موضعاً) |
| `phase1-backend/src/services/entitlement.service.ts` | عُدّل | 427 | 95 | 11 ← 11–17، 61–63 ← 67–77، 67 ← 81–89، 72 ← 94–101، 76 ← 105–107، 82 ← 113–117، 84 ← 119–122، 87–88 ← 125–136، 90 ← 138–139، 92 ← 141–149، 95 ← 152–155، 101 ← 161–163 … (٧٣ موضعاً) |
| `phase1-backend/src/services/feature-flags.service.ts` | عُدّل | 187 | 31 | 24 ← 24–31، 28–29 ← 35–52، 33 ← 56–59، 35–36 ← 61–68، 46–49 ← 78–104، 51 ← 106–109، 55 ← 113–116، 58 ← 119–129، 63–65 ← 134–156، 69–72 ← 160–170، 78 ← 176–179، 85 ← 186–201 … (١٨ موضعاً) |
| `phase1-backend/src/services/finance.service.ts` | عُدّل | 229 | 56 | 11 ← 11–17، 50–51 ← 56–70، 74 ← 93–96، 80 ← 102–105، 104–105 ← 129–134، 107–109 ← 136–145، 111–112 ← 147–152، 135 ← 175–179، 145 ← 189–190، 178 ← 223–224، 182 ← —، 184–185 ← 229–248 … (٣٩ موضعاً) |
| `phase1-backend/src/services/guest-checkout.service.ts` | عُدّل | 78 | 14 | 34 ← 34–38، 37 ← 41–45، 39 ← 47–54، 67–69 ← 82–93، 75 ← 99–102، 78–79 ← 105–112، 85 ← 118–125، 87 ← 127–141، 91 ← 145–149، 111 ← 169–174، 115 ← 178–179 |
| `phase1-backend/src/services/image-embedding.ts` | عُدّل | 64 | 16 | 40 ← 40–42، 56 ← 58–60، 60 ← 64–68، 62 ← 70–73، 65–67 ← 76–95، 85–89 ← 113–130، 98 ← 139–141، 107 ← 150–152، 126 ← 171–173، 140 ← 187–188 |
| `phase1-backend/src/services/image-variants.service.ts` | عُدّل | 15 | 3 | 73 ← 73–77، 151 ← 155–159، 179 ← 187–191 |
| `phase1-backend/src/services/incidents.service.ts` | عُدّل | 170 | 35 | 18 ← 18–24، 27–28 ← 33–43، 34 ← 49–54، 39 ← 59–64، 43 ← 68–69، 53–54 ← 79–83، 61 ← 90–93، 63 ← 95–96، 67 ← 100–102، 72–74 ← 107–121، 93 ← 140–147، 99 ← 153–162 … (٢٥ موضعاً) |
| `phase1-backend/src/services/inventory-movements.service.ts` | عُدّل | 23 | 6 | 21 ← 21–27، 43 ← 49، 47 ← 53–54، 58–59 ← 65–74، 63 ← 78–80 |
| `phase1-backend/src/services/keyset-cursor.ts` | عُدّل | 2 | 1 | 35 ← 35–36 |
| `phase1-backend/src/services/list-page.ts` | عُدّل | 41 | 11 | 84 ← 84–87، 96 ← 99–103، 108 ← 115–116، 139 ← 147، 145 ← 153–158، 153 ← 166–169، 210 ← 226، 213–214 ← 229–236، 236 ← 258–262، 252 ← 278–282 |
| `phase1-backend/src/services/live-price.ts` | عُدّل | 4 | 1 | 17 ← 17–20 |
| `phase1-backend/src/services/loyalty.service.ts` | عُدّل | 142 | 33 | 34 ← 34–40، 89 ← 95–99، 92 ← 102–106، 98 ← 112–115، 160 ← 177–180، 254 ← 274–280، 256 ← 282–284، 261 ← 289–294، 269 ← 302–309، 292 ← 332، 308 ← 348–357، 323 ← 372 … (٣٠ موضعاً) |
| `phase1-backend/src/services/maintenance.service.ts` | عُدّل | 405 | 92 | 25 ← 25–31، 30 ← 36–42، 43 ← 55–59، 50 ← 66–69، 57 ← 76–84، 60 ← 87–89، 67 ← 96–100، 73 ← 106–107، 75 ← 109–110، 80 ← 115–119، 83–85 ← 122–135، 93 ← 143–148 … (٦٤ موضعاً) |
| `phase1-backend/src/services/manual-provisioning.service.ts` | عُدّل | 96 | 18 | 3 ← 3–10، 19 ← 26–36، 21 ← 38–42، 32 ← 53–56، 34 ← 58–62، 43–44 ← 71–88، 49–54 ← 93–101، 67 ← 114–128، 69 ← —، 114 ← 174–179، 127 ← 192–196، 143 ← 212–221 |
| `phase1-backend/src/services/marketing-settings.service.ts` | عُدّل | 57 | 13 | 27–29 ← 27–44، 40 ← 55–62، 57 ← 79–82، 62 ← 87–90، 64 ← 92–96، 69 ← 101–102، 74 ← 107–113، 86 ← 125–127، 90–92 ← 131–136 |
| `phase1-backend/src/services/merchant-home.service.ts` | عُدّل | 144 | 24 | 24 ← 24–30، 32 ← 38–39، 34 ← 41–42، 41 ← 49–51، 48 ← 58، 51 ← 61–68، 53 ← 70–74، 56–57 ← 77–83، 65 ← 91–92، 74 ← 101–107، 78 ← 111–115، 81 ← 118–131 … (١٩ موضعاً) |
| `phase1-backend/src/services/merchant-monthly-report.service.ts` | عُدّل | 71 | 16 | 38 ← 38–46، 52 ← 60–64، 59–60 ← 71–78، 65 ← 83–84، 75 ← 94–96، 78 ← 99–103، 82 ← 107–110، 114 ← 142–146، 126 ← 158–162، 131 ← 167–171، 134–135 ← 174–181، 138 ← 184–187 … (١٤ موضعاً) |
| `phase1-backend/src/services/merchant-onboarding.service.ts` | عُدّل | 47 | 9 | 26 ← 26–31، 41 ← 46–52، 44 ← 55–58، 47–48 ← 61–69، 50 ← 71–74، 73 ← 97–105، 79 ← 111–114، 88 ← 123–126 |
| `phase1-backend/src/services/merchant-search.service.ts` | عُدّل | 91 | 18 | 76 ← 76–78، 83 ← 85–86، 85–86 ← 88–95، 163–164 ← 172–188، 177 ← 201–205، 186 ← 214–222، 193 ← 229–231، 195 ← 233–235، 206 ← 246–249، 209 ← 252–262، 212 ← 265–268، 217 ← 273–277 … (١٥ موضعاً) |
| `phase1-backend/src/services/merchant-store.service.ts` | عُدّل | 76 | 16 | 23 ← 23–27، 29–30 ← 33–43، 57 ← 70–77، 60–61 ← 80–85، 63 ← 87–92، 78 ← 107–110، 87 ← 119–123، 93 ← 129–133، 100 ← 140–144، 116 ← 160–163، 118 ← 165–169، 121 ← 172–175 … (١٤ موضعاً) |
| `phase1-backend/src/services/merchant-suspension.service.ts` | عُدّل | 42 | 9 | 80 ← 80، 91 ← 91–95، 94 ← 98–102، 107 ← 115–119، 110 ← 122–128، 116 ← 134–137، 125–126 ← 146–154، 128 ← 156–161 |
| `phase1-backend/src/services/merchant-wallet.service.ts` | عُدّل | 77 | 11 | 52–53 ← 52–71، 56 ← 74–75، 80–81 ← 99–107، 84 ← 110–113، 88 ← 117–125، 98 ← 135–150، 100 ← —، 106 ← 157–164، 108 ← 166–174 |
| `phase1-backend/src/services/messaging-caps.service.ts` | عُدّل | 36 | 10 | 17 ← 17–20، 32 ← 35–36، 37 ← 41–44، 42 ← 49–51، 46 ← 55–59، 51 ← 64–67، 54–56 ← 70–78، 65 ← 87–91 |
| `phase1-backend/src/services/notification-settings.service.ts` | عُدّل | 134 | 29 | 10–12 ← 10–25، 33 ← 46–49، 47 ← 63–75، 58 ← 86–89، 83 ← 114–117، 88 ← 122–126، 91 ← 129–133، 94–95 ← 136–139، 102 ← 146–150، 106–107 ← 154–157، 117 ← 167–171، 122 ← 176–177 … (٢٢ موضعاً) |
| `phase1-backend/src/services/order-bulk.service.ts` | عُدّل | 73 | 15 | 21 ← 21–26، 53–54 ← 58–62، 58 ← 66–69، 60 ← 71–72، 62–63 ← 74–83، 72 ← 92–96، 77 ← 101–105، 100 ← 128–131، 102 ← 133–138، 106–107 ← 142–153، 111 ← 157–163، 114 ← 166–172 |
| `phase1-backend/src/services/order-lifecycle.service.ts` | عُدّل | 416 | 82 | 2 ← 2–8، 5 ← 11–18، 9 ← 22–25، 14 ← 30–39، 34 ← 59–61، 52 ← 79–80، 58 ← 86–87، 60 ← 89–90، 97 ← 127–134، 99–100 ← 136–161، 105–108 ← 166–180، 117 ← 189–190 … (٤٧ موضعاً) |
| `phase1-backend/src/services/order-notes.service.ts` | عُدّل | 112 | 22 | 23 ← 23–29، 32–33 ← 38–47، 37–38 ← 51–62، 48–50 ← 72–80، 52–53 ← 82–93، 69 ← 109–114، 79 ← 124–126، 83 ← 130–135، 87 ← 139–144، 102 ← 159–160، 106 ← 164–165، 109 ← 168–173 … (١٧ موضعاً) |
| `phase1-backend/src/services/order-print.service.ts` | عُدّل | 87 | 18 | 25 ← 25–31، 31–33 ← 37–52، 41 ← 60–64، 46–49 ← 69–81، 52–53 ← 84–89، 55–56 ← 91–104، 64 ← 112–116، 80 ← 132–139، 85 ← 144–149، 87 ← 151–153، 90 ← 156–159 |
| `phase1-backend/src/services/order-self-cancel.service.ts` | عُدّل | 36 | 10 | 33 ← 33–37، 37 ← 41–45، 42 ← 50–55، 52 ← 65–69، 59–63 ← 76–85، 78 ← 100–104 |
| `phase1-backend/src/services/order-tracking.service.ts` | عُدّل | 22 | 4 | 33 ← 33–41، 80 ← 88–92، 88 ← 100–103، 108 ← 123–126 |
| `phase1-backend/src/services/owner-account.service.ts` | عُدّل | 17 | 4 | 41 ← 41–44، 51–52 ← 54–61، 65 ← 74–78 |
| `phase1-backend/src/services/owner-totp.service.ts` | عُدّل | 71 | 17 | 24 ← 24–29، 78 ← 83–87، 82–83 ← 91–97، 87 ← 101–105، 90 ← 108–111، 101–102 ← 122–130، 104 ← 132–133، 107 ← 136–141، 110 ← 144–146، 135 ← 171–174، 137 ← 176–177، 144 ← 184–188 … (١٥ موضعاً) |
| `phase1-backend/src/services/password-reset.service.ts` | عُدّل | 81 | 18 | 226 ← 226–230، 230 ← 234–237، 238 ← 245–248، 242 ← 252–255، 248 ← 261–264، 255 ← 271–274، 287 ← 306–309، 309 ← 331، 365 ← 387–392، 371 ← 398–405، 380 ← 414–420، 504 ← 544–547 … (١٨ موضعاً) |
| `phase1-backend/src/services/password.service.ts` | عُدّل | 40 | 9 | 31 ← 31–36، 69 ← 74، 82–83 ← 87–95، 96–97 ← 108–116، 113 ← 132–135، 117 ← 139–142، 125 ← 150–156 |
| `phase1-backend/src/services/payment-methods.service.ts` | عُدّل | 171 | 37 | 44–49 ← 44–87، 53 ← 91–95، 70 ← 112–114، 74–75 ← 118–126، 86–87 ← 137–143، 92 ← 148–154، 100 ← 162–167، 103–104 ← 170–179، 106 ← 181–186، 113 ← 193–197، 117 ← 201–205، 121–122 ← 209–218 … (٢٠ موضعاً) |
| `phase1-backend/src/services/platform-audit.service.ts` | عُدّل | 30 | 7 | 17 ← 17–23، 108 ← 114–117، 110 ← 119–122، 113 ← 125–128، 118 ← 133–136، 167 ← 185–188، 180 ← 201–203 |
| `phase1-backend/src/services/platform-brand.service.ts` | عُدّل | 58 | 17 | 51 ← 51–55، 53 ← 57–63، 83 ← 93–98، 101 ← 116–120، 107 ← 126، 110 ← 129–134، 126 ← 150–154، 133–140 ← 161–177، 178 ← 215–217، 186 ← 225–227 |
| `phase1-backend/src/services/platform-contact.service.ts` | عُدّل | 26 | 6 | 137 ← 137، 155 ← 155–158، 165–166 ← 168–177، 168 ← 179–183، 177 ← 192–197 |
| `phase1-backend/src/services/platform-directory.service.ts` | عُدّل | 24 | 4 | 8 ← 8–14، 27 ← 33–35، 42 ← 50–60، 46 ← 64–66 |
| `phase1-backend/src/services/platform-health.service.ts` | عُدّل | 52 | 12 | 97 ← 97–100، 100 ← 103–106، 120 ← 126–129، 131 ← 140–144، 141 ← 154–159، 143 ← 161–162، 159 ← 178–181، 162 ← 184–186، 169 ← 193–195، 171–172 ← 197–207، 179 ← 214–219 |
| `phase1-backend/src/services/platform-overview.service.ts` | عُدّل | 21 | 5 | 50 ← 50–53، 72 ← 75–77، 79–80 ← 84–93، 107 ← 120–123 |
| `phase1-backend/src/services/platform-pulse.service.ts` | عُدّل | 48 | 12 | 41 ← 41–47، 45 ← 51–52، 70 ← 77–85، 101 ← 116–119، 138 ← 156–162، 154–155 ← 178–180، 158–159 ← 183–184، 162 ← 187، 166–167 ← 191–203 |
| `phase1-backend/src/services/platform-rewards.service.ts` | عُدّل | 127 | 30 | 40 ← 40–47، 45 ← 52–55، 51–53 ← 61–77، 55 ← 79–82، 60 ← 87–92، 64 ← 96–97، 73–79 ← 106–130، 82 ← 133–137، 86–87 ← 141–146، 94 ← 153–156، 103 ← 165–168، 105 ← 170–173 … (٢١ موضعاً) |
| `phase1-backend/src/services/platform-staff-totp.service.ts` | عُدّل | 34 | 8 | 43 ← 43–45، 48 ← 50–54، 51 ← 57–60، 56 ← 65–69، 59 ← 72–73، 62 ← 76–81، 76 ← 95–99، 88 ← 111–114 |
| `phase1-backend/src/services/platform-staff.service.ts` | عُدّل | 67 | 18 | 16 ← 16–22، 37 ← 43–46، 61 ← 70–72، 76 ← 87، 115 ← 126، 118 ← 129–130، 138 ← 150–153، 156 ← 171–175، 158–159 ← 177–185، 167 ← 193–194، 177 ← 204–206، 209 ← 238–241 … (١٧ موضعاً) |
| `phase1-backend/src/services/pos.service.ts` | عُدّل | 400 | 226 | 62 ← 62–66، 65 ← 69–75، 79 ← 89–92، 87 ← 100–104، 112 ← 129–136، 129 ← 153–156، 153–157 ← 180–186، 162 ← 191–195، 165 ← 198–202، 171 ← 208–212، 174–177 ← 215–228، 186 ← 237–241 … (٣٤ موضعاً) |
| `phase1-backend/src/services/prescription.service.ts` | عُدّل | 139 | 25 | 19 ← 19–23، 21 ← 25–30، 24–25 ← 33–48، 30 ← 53–56، 36 ← 62–67، 38 ← 69–74، 40 ← 76–80، 42 ← 82–87، 49 ← 94–97، 51 ← 99–105، 58 ← 112–114، 65 ← 121–126 … (٢١ موضعاً) |
| `phase1-backend/src/services/product-catalog.service.ts` | عُدّل | 555 | 119 | 8–9 ← 8–20، 15 ← 26–30، 19 ← 34–37، 32 ← 50–55، 39 ← 62–63، 45 ← 69–70، 54 ← 79–81، 59–60 ← 86–95، 65–66 ← 100–108، 73 ← 115–116، 100 ← 143–146، 115 ← 161–164 … (٨٦ موضعاً) |
| `phase1-backend/src/services/product-image-storage.service.ts` | عُدّل | 215 | 46 | 1 ← 1–6، 6 ← 11–17، 54 ← 65–69، 56 ← 71–77، 60 ← 81–86، 63–66 ← 89–104، 76 ← 114–119، 78 ← 121–125، 83 ← 130–134، 123–129 ← 174–182، 131 ← 184–191، 134 ← 194–198 … (٣٥ موضعاً) |
| `phase1-backend/src/services/product-review.service.ts` | عُدّل | 114 | 28 | 78 ← 78–79، 81 ← 82–83، 91 ← 93–97، 111 ← 117–119، 137 ← 145–148، 149–150 ← 160–168، 154 ← 172–174، 160 ← 180–185، 164 ← 189–191، 200 ← 227–234، 203 ← 237–244، 222 ← 263 … (٢٧ موضعاً) |
| `phase1-backend/src/services/recommendation.service.ts` | عُدّل | 43 | 8 | 32 ← 32–37، 45 ← 50–54، 48 ← 57–60، 53 ← 65–68، 59 ← 74–79، 61 ← 81–88، 82 ← 109، 86 ← 113–121 |
| `phase1-backend/src/services/registration.service.ts` | عُدّل | 147 | 30 | 10 ← 10–15، 12 ← 17–23، 24 ← 35–37، 29 ← 42–43، 60 ← 74–82، 62 ← 84–88، 64–65 ← 90–99، 68 ← 102–106، 80–81 ← 118–127، 91 ← 137–138، 93–94 ← 140–156، 97 ← 159–162 … (٢٣ موضعاً) |
| `phase1-backend/src/services/reservation-expiry-job.ts` | عُدّل | 12 | 3 | 133 ← 133–138، 162 ← 167، 185 ← 190–194 |
| `phase1-backend/src/services/reserved-slugs.ts` | عُدّل | 5 | 1 | 111 ← 111–115 |
| `phase1-backend/src/services/retention-job.ts` | عُدّل | 1 | 1 | 195 ← 195 |
| `phase1-backend/src/services/return-inspection.service.ts` | عُدّل | 121 | 25 | 32 ← 32–38، 55 ← 61–65، 59 ← 69–73، 63–64 ← 77–84، 69 ← 89–91، 90 ← 112–116، 94 ← 120–124، 102 ← 132–134، 106 ← 138–140، 128 ← 162، 133 ← 167–171، 142–144 ← 180–195 … (٢٢ موضعاً) |
| `phase1-backend/src/services/return-request.service.ts` | عُدّل | 75 | 21 | 25 ← 25–31، 55 ← 61–62، 64 ← 71، 79 ← 86–90، 85 ← 96–100، 88–89 ← 103–108، 98 ← 117–121، 118 ← 141–146، 126–127 ← 154–160، 131 ← 164–166، 152–153 ← 187–193، 158 ← 198–200 … (١٧ موضعاً) |
| `phase1-backend/src/services/search/index.ts` | عُدّل | 20 | 4 | 30 ← 30–32، 37 ← 39–43، 40 ← 46–53، 48 ← 61–64 |
| `phase1-backend/src/services/search/postgres-trigram.engine.ts` | عُدّل | 79 | 17 | 86 ← 86–93، 138 ← 145–149، 178 ← 189–194، 193 ← 209–214، 207 ← 228–233، 226 ← 252–257، 228 ← 259–262، 232 ← 266–269، 239 ← 276–278، 258 ← 297–298، 261 ← 301–303، 265 ← 307–310 … (١٧ موضعاً) |
| `phase1-backend/src/services/search/search.types.ts` | عُدّل | 4 | 1 | 78 ← 78–81 |
| `phase1-backend/src/services/session.service.ts` | عُدّل | 85 | 19 | 54–56 ← 54–67، 59 ← 70–75، 61–62 ← 77–87، 68 ← 93–96، 71 ← 99–102، 73 ← 104–118، 109 ← 154–158، 111 ← 160–164، 114 ← 167–169، 128 ← 183–186، 130 ← 188–190، 152 ← 212 … (١٦ موضعاً) |
| `phase1-backend/src/services/soft-delete/audit-log.service.ts` | عُدّل | 40 | 9 | 19 ← 19–25، 41 ← 47–50، 44 ← 53–56، 48 ← 60–63، 51 ← 66–69، 56 ← 74–77، 97 ← 118–123، 113 ← 139–142، 129 ← 158–160 |
| `phase1-backend/src/services/soft-delete/constants.ts` | عُدّل | 26 | 7 | 34 ← 34–39، 50 ← 55–62، 54–57 ← 66–75، 59 ← 77–78 |
| `phase1-backend/src/services/soft-delete/delete-preview.service.ts` | عُدّل | 93 | 21 | 71 ← 71–76، 78 ← 83–89، 82 ← 93–97، 85 ← 100–105، 87 ← 107–112، 105–111 ← 130–147، 125–126 ← 161–170، 131 ← 175–178، 134–136 ← 181–195، 159 ← 218–223، 166–167 ← 230–239 |
| `phase1-backend/src/services/soft-delete/fk-violations.ts` | عُدّل | 20 | 4 | 26 ← 26–31، 52 ← 57–63، 138 ← 149–151، 145 ← 158–161 |
| `phase1-backend/src/services/soft-delete/purge-job.ts` | عُدّل | 151 | 25 | 25 ← 25–28، 56 ← 59–62، 61–64 ← 67–103، 67–70 ← 106–149، 97 ← 176–179، 101 ← 183–185، 103 ← 187–189، 105 ← 191–193، 112–113 ← 200–205، 141–144 ← 233–252، 166 ← 274–276، 186 ← 296–299 … (١٥ موضعاً) |
| `phase1-backend/src/services/soft-delete/soft-delete.service.ts` | عُدّل | 580 | 115 | 31 ← 31–38، 65 ← 72–76، 73 ← 84–88، 78 ← 93–99، 86 ← 107، 94–98 ← 115–128، 103 ← 133–140، 114 ← 151–154، 120 ← 160–164، 124 ← 168–171، 126 ← 173–178، 140 ← 192–194 … (٩٨ موضعاً) |
| `phase1-backend/src/services/staff.service.ts` | عُدّل | 102 | 21 | 11 ← 11–16، 24 ← 29–32، 44 ← 52–54، 67 ← 77–81، 72 ← 86–90، 85 ← 103–112، 89 ← 116–119، 96 ← 126–129، 129 ← 162، 143 ← 176–180، 149–150 ← 186–198، 156–157 ← 204–213 … (١٩ موضعاً) |
| `phase1-backend/src/services/stock-forecast.service.ts` | عُدّل | 32 | 7 | 57 ← 57–60، 62–64 ← 65–74، 114 ← 124–128، 119 ← 133–141، 125 ← 147–150 |
| `phase1-backend/src/services/store-banner.service.ts` | عُدّل | 113 | 22 | 75 ← 75–76، 79 ← 80–82، 82–83 ← 85–106، 86 ← 109–117، 89 ← 120–123، 101 ← 135–138، 117 ← 154–158، 127 ← 168، 130 ← 171–172، 136 ← 178–182، 139 ← 185–188، 143 ← 192–198 … (٢١ موضعاً) |
| `phase1-backend/src/services/store-bootstrap.service.ts` | عُدّل | 20 | 9 | 15 ← 15، 35–41 ← 35–51، 52 ← 62–63 |
| `phase1-backend/src/services/store-traffic.service.ts` | عُدّل | 55 | 14 | 69 ← 69–72، 85 ← 88–91، 127 ← 133–136، 142 ← 151–154، 145–146 ← 157–163، 148 ← 165–167، 152 ← 171–172، 157–158 ← 177–184، 165 ← 191–195، 168–169 ← 198–206، 179 ← 216–220 |
| `phase1-backend/src/services/store-verification.service.ts` | عُدّل | 29 | 9 | 68 ← 68–69، 71 ← 72–77، 79–80 ← 85–91، 136 ← 147، 138 ← 149–150، 145 ← 157–160، 183–184 ← 198–204 |
| `phase1-backend/src/services/storefront-config.service.ts` | عُدّل | 221 | 51 | 97–104 ← 97–123، 109 ← 128–132، 125 ← 148–152، 180–186 ← 207–228، 211 ← 253–257، 215 ← 261–266، 219 ← 270–273، 224 ← 278–294، 237–238 ← 307–312، 241 ← 315–319، 244 ← 322–323، 246 ← 325–329 … (٣٠ موضعاً) |
| `phase1-backend/src/services/storefront-seo.service.ts` | عُدّل | 104 | 27 | 26 ← 26–29، 51 ← 54–57، 74 ← 80–85، 81 ← 92–94، 101 ← 114–117، 112–113 ← 128–143، 126–132 ← 156–164، 164–169 ← 196–219، 179–180 ← 229–238، 211 ← 269–274، 214 ← 277–280، 221 ← 287–290 … (١٤ موضعاً) |
| `phase1-backend/src/services/storefront.service.ts` | عُدّل | 1718 | 456 | 10 ← 10–14، 14–15 ← 18–26، 23 ← 34–41، 28 ← 46–49، 35 ← 56–71، 49 ← 85–86، 52 ← 89–90، 56–58 ← 94–102، 60 ← 104–105، 65 ← 110–115، 70 ← 120–121، 74 ← 125–130 … (١٣٢ موضعاً) |
| `phase1-backend/src/services/whatsapp-manual.service.ts` | عُدّل | 107 | 28 | 32 ← 32–36، 42 ← 46، 65 ← 69–75، 72 ← 82–84، 78 ← 90–92، 103 ← 117–118، 107 ← 122–126، 138–142 ← 157–161، 146 ← 165–170، 160 ← 184–191، 162 ← 193–198، 167 ← 203–206 … (٢٣ موضعاً) |
| `phase1-backend/src/services/wishlist.service.ts` | عُدّل | 63 | 13 | 16 ← 16–22، 29 ← 35–40، 37 ← 48–50، 39 ← 52–63، 42 ← 66–68، 49 ← 75–81، 75 ← 107، 84 ← 116–122، 101 ← 139–141، 108 ← 148–152، 113 ← 157–160، 121–122 ← 168–172 |
| `phase1-backend/tests/api-edge.integration.mjs` | عُدّل | 40 | 9 | 31 ← 31–35، 34 ← 38–42، 36 ← 44–48، 39 ← 51–55، 45 ← 61–65، 69 ← 89–93، 81–82 ← 105–112، 84 ← 114–115 |
| `phase1-backend/tests/apiv1.integration.mjs` | عُدّل | 138 | 35 | 37 ← 37–39، 49 ← 51–53، 60 ← 64–67، 63–64 ← 70–76، 69 ← 81–85، 76–79 ← 92–109، 81 ← 111–112، 89–90 ← 120–129، 95–97 ← 134–145، 103–104 ← 151–157، 110 ← 163–168، 113–114 ← 171–180 … (٢٢ موضعاً) |
| `phase1-backend/tests/availability.integration.mjs` | عُدّل | 477 | 76 | 45 ← 45–51، 50 ← 56–61، 55 ← 66–70، 64 ← 79–82، 66 ← 84–89، 71–72 ← 94–111، 75–78 ← 114–143، 84 ← 149–163، 89 ← 168–169، 91 ← 171–174، 96 ← 179–183، 100 ← 187–191 … (٤٦ موضعاً) |
| `phase1-backend/tests/availability.unit.mjs` | عُدّل | 250 | 41 | 12 ← 12–18، 15 ← 21–31، 18 ← 34–39، 21–24 ← 42–65، 26–34 ← 67–120، 36 ← 122–127، 39 ← 130–135، 41–42 ← 137–148، 44 ← 150–155، 46 ← 157–162، 61 ← 177–178، 70 ← 187–198 … (٢١ موضعاً) |
| `phase1-backend/tests/backup-recovery.guard.mjs` | عُدّل | 137 | 43 | 46–47 ← 46–49، 49 ← —، 61 ← 62–63، 86 ← 88–93، 88 ← 95، 96–97 ← 103–112، 103 ← 118–120، 111 ← 128–131، 113 ← —، 126 ← 145–147، 130 ← 151، 134 ← 155–157 … (٣٣ موضعاً) |
| `phase1-backend/tests/brand-name.guard.mjs` | عُدّل | 33 | 18 | 67 ← 67–69، 71–76 ← 73–81، 78 ← —، 86 ← 90، 90–98 ← 94–113 |
| `phase1-backend/tests/capability-registry.guard.mjs` | عُدّل | 85 | 21 | 45 ← 45–51، 50 ← 56–62، 52–54 ← 64–81، 66 ← 93–94، 78 ← 106–111، 80 ← 113–115، 86 ← 121–123، 88 ← 125–128، 93 ← 133–135، 95–96 ← 137–139، 98 ← 141–143، 103 ← 148–151 … (١٧ موضعاً) |
| `phase1-backend/tests/category-hierarchy.integration.mjs` | عُدّل | 416 | 83 | 43 ← 43–47، 46 ← 50–53، 50–59 ← 57–102، 65 ← 108–112، 68 ← 115–119، 71 ← 122–126، 76–77 ← 131–138، 81–82 ← 142–148، 85–88 ← 151–164، 92–93 ← 168–180، 95 ← 182–189، 99–100 ← 193–202 … (٣٠ موضعاً) |
| `phase1-backend/tests/cd1.integration.mjs` | عُدّل | 655 | 124 | 55 ← 55–57، 64 ← 66–69، 71 ← 76–80، 79 ← 88–92، 83 ← 96–100، 85 ← 102–106، 93 ← 114–117، 95 ← 119–130، 97 ← 132–137، 110 ← 150–155، 115–116 ← 160–169، 121 ← 174–176 … (٧١ موضعاً) |
| `phase1-backend/tests/cd2.integration.mjs` | عُدّل | 627 | 120 | 34 ← 34–35، 73 ← 74–80، 75 ← 82–88، 78–81 ← 91–118، 84 ← 121–123، 86 ← 125–131، 108 ← 153–156، 119–123 ← 167–191، 128 ← 196–197، 134 ← 203–207، 136 ← 209–213، 140 ← 217–227 … (٧٢ موضعاً) |
| `phase1-backend/tests/cd3.integration.mjs` | عُدّل | 264 | 52 | 28 ← 28–29، 65 ← 66–72، 67–68 ← 74–87، 70 ← 89–91، 72 ← 93–99، 82 ← 109–114، 85 ← 117–120، 96–100 ← 131–155، 108 ← 163–167، 121 ← 180–184، 123 ← 186–190، 128–131 ← 195–214 … (٣٤ موضعاً) |
| `phase1-backend/tests/cd5.integration.mjs` | عُدّل | 537 | 130 | 36 ← 36–37، 44 ← 45–47، 73 ← 76–79، 83 ← 89–95، 85–88 ← 97–120، 90 ← 122–128، 93 ← 131–133، 98 ← 138–143، 102 ← 147–150، 104–105 ← 152–161، 113 ← 169–173، 116 ← 176–177 … (٩٢ موضعاً) |
| `phase1-backend/tests/checkout-payload.guard.mjs` | عُدّل | 34 | 15 | 45 ← 45–48، 64 ← 67–70، 69 ← 75–76، 80–81 ← 87–94، 99 ← 112، 102–110 ← 115–129 |
| `phase1-backend/tests/ci-workflow.guard.mjs` | عُدّل | 34 | 9 | 25 ← 25–29، 30 ← 34–37، 32 ← 39–40، 36 ← 44–47، 38 ← 49–50، 40 ← 52–54، 48 ← 62–64، 50 ← 66–68، 54 ← 72–79 |
| `phase1-backend/tests/client-ip.unit.mjs` | عُدّل | 29 | 6 | 39–40 ← 39–47، 46 ← 53–57، 55–56 ← 66–75، 71 ← 90–94 |
| `phase1-backend/tests/column-round-trip.guard.mjs` | عُدّل | 35 | 13 | 79–80 ← 79–89، 106 ← 115–120، 125 ← 139، 128–136 ← 142–158 |
| `phase1-backend/tests/complaints-webhook.integration.mjs` | عُدّل | 200 | 35 | 37 ← 37–42، 42 ← 47–51، 47–49 ← 56–68، 57–58 ← 76–90، 60 ← 92–98، 62 ← 100–107، 68 ← 113–115، 70 ← 117–126، 74 ← 130–135، 77 ← 138–141، 80 ← 144–148، 82 ← 150–156 … (٢٦ موضعاً) |
| `phase1-backend/tests/compression.guard.mjs` | عُدّل | 77 | 16 | 58 ← 58–60، 66 ← 68–70، 72 ← 76–82، 81 ← 91–97، 92–93 ← 108–117، 96 ← 120–124، 98 ← 126–130، 101–102 ← 133–142، 116–117 ← 156–165، 125–126 ← 173–179، 133 ← 186–190، 137 ← 194–198 |
| `phase1-backend/tests/config.integration.mjs` | عُدّل | 339 | 50 | 38 ← 38–40، 48 ← 50–56، 53 ← 61–66، 58 ← 71–75، 64 ← 81–88، 69 ← 93–96، 71 ← 98–103، 76 ← 108–116، 79–80 ← 119–133، 83–84 ← 136–142، 92 ← 150–154، 97 ← 159–163 … (٣٠ موضعاً) |
| `phase1-backend/tests/config.unit.mjs` | عُدّل | 167 | 26 | 20 ← 20–28، 24–26 ← 32–48، 29–30 ← 51–57، 34 ← 61–64، 36–38 ← 66–90، 41–42 ← 93–108، 45–48 ← 111–140، 50–51 ← 142–157، 53–54 ← 159–167، 58 ← 171–174، 60–63 ← 176–192، 65 ← 194–206 |
| `phase1-backend/tests/contract.list-envelope.integration.mjs` | عُدّل | 325 | 73 | 33 ← 33–34، 54 ← 55–59، 63 ← 68–71، 67 ← 75–78، 87 ← 98–101، 89 ← 103–106، 96 ← 113–117، 103 ← 124–129، 105 ← 131–135، 109 ← 139–143، 111–112 ← 145–152، 118 ← 158–162 … (٤٨ موضعاً) |
| `phase1-backend/tests/cookie-secure-check.mjs` | عُدّل | 74 | 21 | 26 ← 26–27، 31 ← 32–36، 35 ← 40–44، 43 ← 52، 49–50 ← 58–67، 57 ← 74، 76–77 ← 93–102، 85 ← 110–114، 87 ← 116–120، 94 ← 127–130، 96 ← 132–135، 99 ← 138–142 … (١٧ موضعاً) |
| `phase1-backend/tests/copy-tone.guard.mjs` | عُدّل | 159 | 21 | 31–34 ← 31–65، 43 ← 74–77، 45 ← 79–85، 47–48 ← 87–98، 71–74 ← 121–159، 77–78 ← 162–180، 102 ← 204، 131 ← 233–236، 156 ← 261–266، 181 ← 291–296، 191 ← 306–311، 196 ← 316–318 … (١٣ موضعاً) |
| `phase1-backend/tests/csrf-origin.guard.mjs` | عُدّل | 24 | 10 | 34–36 ← 34–39، 57 ← 60–63، 67 ← 73–75، 77–81 ← 85–95 |
| `phase1-backend/tests/customer-block.integration.mjs` | عُدّل | 198 | 30 | 35 ← 35–39، 40 ← 44–48، 47–48 ← 55–68، 51–54 ← 71–98، 60 ← 104–107، 64 ← 111–115، 69 ← 120–124، 72 ← 127–131، 78–79 ← 137–145، 81 ← 147–151، 83 ← 153–157، 87 ← 161–163 … (٢٠ موضعاً) |
| `phase1-backend/tests/database-url-resolution.test.ts` | عُدّل | 14 | 6 | 2 ← 2–5، 14–18 ← 17–26 |
| `phase1-backend/tests/database-url.unit.mjs` | عُدّل | 46 | 19 | 27 ← 27–31، 29–30 ← 33–36، 34 ← 40–44، 52–53 ← 62–71، 65 ← 83، 70 ← 88–91، 72 ← 93، 78 ← 99، 81–89 ← 102–116 |
| `phase1-backend/tests/delivery-cod.integration.mjs` | عُدّل | 294 | 61 | 40 ← 40–46، 45 ← 51–55، 53 ← 63–67، 61–62 ← 75–88، 65–68 ← 91–118، 73–80 ← 123–141، 82 ← 143–147، 88 ← 153–156، 96 ← 164–165، 104 ← 173–177، 109–110 ← 182–191، 112 ← 193–197 … (٣٣ موضعاً) |
| `phase1-backend/tests/demo-mode.integration.mjs` | عُدّل | 410 | 80 | 42 ← 42–46، 48 ← 52–54، 69 ← 75–77، 71 ← 79–80، 84 ← 93–97، 88 ← 101–102، 133 ← 147–151، 162–164 ← 180–197، 167–168 ← 200–208، 173–174 ← 213–232، 181–182 ← 239–254، 189 ← 261–266 … (٥٦ موضعاً) |
| `phase1-backend/tests/development-database-connection.test.ts` | عُدّل | 8 | 3 | 11 ← 11–13، 21 ← 23–26، 27 ← 32 |
| `phase1-backend/tests/docs-freshness.guard.mjs` | عُدّل | 83 | 27 | 43–44 ← 43–48، 53 ← 57–59، 65 ← 71–76، 70–71 ← 81–92، 79 ← 100–102، 99–100 ← 122–129، 102 ← 131–135، 105 ← 138–140، 122 ← 157–159، 137–138 ← 174–179، 140 ← 181–183، 145 ← 188–190 … (١٤ موضعاً) |
| `phase1-backend/tests/domain-events.integration.mjs` | عُدّل | 97 | 16 | 32 ← 32–40، 36 ← 44–45، 40 ← 49–55، 43–44 ← 58–78، 51 ← 85–95، 53 ← —، 57 ← 100–103، 61 ← 107–115، 67–68 ← 121–128، 75–76 ← 135–146، 82 ← 152–156، 88–89 ← 162–170 |
| `phase1-backend/tests/engineering-roadmap-data.test.ts` | عُدّل | 11 | 3 | 2 ← 2–6، 6 ← 10–12، 11 ← 17–19 |
| `phase1-backend/tests/env-preflight.unit.mjs` | عُدّل | 248 | 55 | 25 ← 25–27، 67 ← 69–73، 74 ← 80–82، 78 ← 86–90، 80–83 ← 92–115، 91 ← 123–127، 94–96 ← 130–141، 105–108 ← 150–166، 114–115 ← 172–180، 128 ← 193–197، 134 ← 203–204، 140–141 ← 210–219 … (٣٢ موضعاً) |
| `phase1-backend/tests/frozen-clock.guard.mjs` | عُدّل | 21 | 13 | 76 ← 76–78، 89 ← 91، 105 ← 107، 109–118 ← 111–126 |
| `phase1-backend/tests/governorates.unit.mjs` | عُدّل | 53 | 14 | 38 ← 38–43، 46–47 ← 51–60، 59 ← 72–76، 72 ← 89–90، 91 ← 109–113، 100 ← 122–124، 104 ← 128، 117 ← 141–151، 119–120 ← —، 122 ← 154–157، 124–125 ← 159–164 |
| `phase1-backend/tests/graceful-shutdown.unit.mjs` | عُدّل | 98 | 25 | 34 ← 34–35، 36 ← 37–39، 59–60 ← 62–67، 77 ← 84–86، 94–97 ← 103–116، 104–106 ← 123–137، 110 ← 141–145، 115 ← 150–154، 117–118 ← 156–159، 128 ← 169–171، 130 ← 173–176، 135 ← 181–185 … (١٧ موضعاً) |
| `phase1-backend/tests/guest-checkout.integration.mjs` | عُدّل | 368 | 71 | 42 ← 42–43، 50 ← 51–58، 56 ← 64–68، 64 ← 76–82، 66–68 ← 84–104، 72 ← 108–114، 76 ← 118–121، 81–82 ← 126–136، 87–89 ← 141–155، 92–95 ← 158–175، 105–106 ← 185–194، 109 ← 197–201 … (٤٠ موضعاً) |
| `phase1-backend/tests/helpers/deleted-leak-guard.ts` | عُدّل | 104 | 24 | 32–33 ← 32–48، 40 ← 55–60، 107 ← 127–128، 116 ← 137–138، 132 ← 154–162، 150–151 ← 180–184، 161 ← 194–195، 165–166 ← 199–204، 176 ← 214–217، 178 ← 219–224، 190 ← 236–237، 194 ← 241–245 … (٢٠ موضعاً) |
| `phase1-backend/tests/helpers/fake-notification-provider.ts` | عُدّل | 20 | 3 | 1 ← 1–6، 6 ← 11–17، 23 ← 34–40 |
| `phase1-backend/tests/helpers/login-timing.ts` | عُدّل | 17 | 6 | 53 ← 53–57، 78 ← 82–85، 82–84 ← 89–91، 86 ← 93–97 |
| `phase1-backend/tests/helpers/own-provisioned-password.ts` | عُدّل | 12 | 4 | 26 ← 26، 36 ← 36–38، 40 ← 42–46، 44 ← 50–52 |
| `phase1-backend/tests/helpers/own-staff-password.ts` | عُدّل | 27 | 6 | 19 ← 19–24، 24 ← 29–33، 26 ← 35–38، 28 ← 40–43، 34 ← 49–52، 37 ← 55–58 |
| `phase1-backend/tests/helpers/plan-terms.ts` | عُدّل | 1 | 1 | 26 ← 26 |
| `phase1-backend/tests/helpers/register-merchant.ts` | عُدّل | 13 | 2 | 40 ← 40–46، 46 ← 52–57 |
| `phase1-backend/tests/helpers/test-database-guard.ts` | عُدّل | 14 | 5 | 6 ← 6–7، 9 ← 10–12، 16 ← 19–21، 26 ← 31–33، 32 ← 39–41 |
| `phase1-backend/tests/http-mail.unit.mjs` | عُدّل | 90 | 22 | 62 ← 62–65، 74 ← 77–81، 77 ← 84–88، 80 ← 91–94، 86 ← 100–105، 88 ← 107–111، 94 ← 117–121، 97–99 ← 124–136، 114 ← 151–155، 131–132 ← 172–177، 144–146 ← 189–202، 155 ← 211–212 … (١٦ موضعاً) |
| `phase1-backend/tests/identity-boundary.unit.mjs` | عُدّل | 45 | 14 | 32 ← 32–35، 34 ← 37–41، 41–42 ← 48–55، 80–81 ← 93–96، 85–86 ← 100–106، 90 ← 110، 94–98 ← 114–129 |
| `phase1-backend/tests/image-embedding.unit.mjs` | عُدّل | 31 | 9 | 12–14 ← 12–20، 25 ← 31–34، 29 ← 38–41، 39 ← 51–52، 43 ← 56–59، 46 ← 62–65، 51 ← 70–73 |
| `phase1-backend/tests/image-upload-atomic.integration.mjs` | عُدّل | 100 | 20 | 33 ← 33–36، 47 ← 50–53، 49 ← 55–60، 52 ← 63–68، 69 ← 85–89، 74 ← 94–98، 80 ← 104–105، 87 ← 112–118، 89–90 ← 120–131، 93 ← 134–143، 96–97 ← 146–156، 107 ← 166–168 … (١٥ موضعاً) |
| `phase1-backend/tests/image-variants.unit.mjs` | عُدّل | 117 | 28 | 35–36 ← 35–42، 44 ← 50–52، 53 ← 61–65، 57 ← 69–73، 59 ← 75–79، 64 ← 84–91، 73 ← 100–105، 76–77 ← 108–117، 85 ← 125–127، 87–90 ← 129–145، 97 ← 152–155، 102 ← 160–164 … (٢١ موضعاً) |
| `phase1-backend/tests/inventory-cas.integration.mjs` | عُدّل | 160 | 32 | 48 ← 48–54، 53 ← 59–63، 58 ← 68–72، 65 ← 79–85، 67–68 ← 87–98، 74–75 ← 104–117، 79 ← 121–127، 81 ← 129–132، 86 ← 137–141، 91–92 ← 146–155، 94 ← 157–161، 97–99 ← 164–175 … (٢٣ موضعاً) |
| `phase1-backend/tests/inventory-movements.integration.mjs` | عُدّل | 151 | 26 | 37 ← 37–41، 42 ← 46–50، 50–51 ← 58–71، 54–57 ← 74–97، 65–67 ← 105–134، 73 ← 140–144، 75 ← 146–150، 79 ← 154–158، 90 ← 169–173، 102 ← 185–187، 107–108 ← 192–200، 110 ← 202–206 … (١٧ موضعاً) |
| `phase1-backend/tests/keys-rotation-check.mjs` | عُدّل | 137 | 43 | 40–42 ← 40–54، 47 ← 59–63، 51 ← 67، 67 ← 83–86، 75 ← 94، 79–82 ← 98–105، 92 ← 115–118، 95 ← 121، 99–100 ← 125–128، 102–103 ← 130–137، 107 ← 141–145، 111–114 ← 149–156 … (٢٥ موضعاً) |
| `phase1-backend/tests/keyset-index.guard.mjs` | عُدّل | 134 | 50 | 125 ← 125–127، 129 ← 131–135، 132–133 ← 138–143، 137–138 ← 147–154، 141 ← 157–160، 163 ← 182–184، 179 ← 200–204، 195 ← 220–223، 208 ← 236–239، 211 ← 242–247، 240 ← 276–278، 243 ← 281–282 … (٣٢ موضعاً) |
| `phase1-backend/tests/ledger-sign.guard.mjs` | عُدّل | 7 | 5 | 85 ← 85، 101 ← 101–103، 110 ← 112، 125–126 ← 127–128 |
| `phase1-backend/tests/list-cursor.unit.mjs` | عُدّل | 76 | 22 | 34 ← 34–40، 49 ← 55–58، 53–55 ← 62–76، 59 ← 80–81، 71 ← 93–101، 80 ← 110–113، 85 ← 118–121، 91 ← 127–129، 96 ← 134–136، 110 ← 150–153، 122–125 ← 165، 140–141 ← 180–186 … (١٦ موضعاً) |
| `phase1-backend/tests/list-envelope.guard.mjs` | عُدّل | 83 | 29 | 47 ← 47–49، 99 ← 101–102، 104 ← 107–109، 106 ← 111–114، 112 ← 120–126، 120 ← 134–140، 129–130 ← 149–154، 142 ← 166–169، 147 ← 174–175، 149 ← 177–178، 184 ← 213–214، 195 ← 225–226 … (٢٢ موضعاً) |
| `phase1-backend/tests/logging.guard.mjs` | عُدّل | 220 | 55 | 38 ← 38–39، 49 ← 50–52، 58–59 ← 61–71، 62 ← 74–78، 67 ← 83–86، 80 ← 99–103، 85 ← 108، 95 ← 118–122، 118 ← 145، 120–121 ← 147–153، 127 ← 159–163، 131–133 ← 167–179 … (٤٠ موضعاً) |
| `phase1-backend/tests/login-counter.guard.mjs` | عُدّل | 22 | 12 | 65 ← 65–68، 69 ← 72، 72–81 ← 75–91 |
| `phase1-backend/tests/logout-reachable.guard.mjs` | عُدّل | 20 | 7 | 82 ← 82–85، 86 ← 89، 89–93 ← 92–106 |
| `phase1-backend/tests/loyalty-mirror.guard.mjs` | عُدّل | 29 | 9 | 40 ← 40–43، 51 ← 54–58، 68 ← 75، 76 ← 83–86، 79–83 ← 89–103 |
| `phase1-backend/tests/mail-probe.unit.mjs` | عُدّل | 61 | 13 | 33 ← 33–36، 42–43 ← 45–53، 53 ← 63–67، 74 ← 88–92، 107 ← 125–132، 116–118 ← 141–155، 127 ← 164–168، 135–136 ← 176–183، 138 ← 185–186 |
| `phase1-backend/tests/maintenance.integration.mjs` | عُدّل | 650 | 98 | 43 ← 43–45، 46 ← 48–51، 54 ← 59–65، 59 ← 70–75، 64 ← 80–84، 74 ← 94–97، 76 ← 99–104، 81–82 ← 109–126، 85–88 ← 129–158، 100–101 ← 170–176، 104–105 ← 179–185، 110–112 ← 190–212 … (٥٩ موضعاً) |
| `phase1-backend/tests/market-account.browser-acceptance.mjs` | عُدّل | 128 | 21 | 36 ← 36–45، 42 ← 51–56، 48 ← 62–65، 55 ← 72–77، 65 ← 87–93، 67 ← 95–105، 69–70 ← 107–118، 72 ← 120–122، 90 ← 140–143، 93 ← 146–148، 100–102 ← 155–169، 109–110 ← 176–185 … (١٦ موضعاً) |
| `phase1-backend/tests/market-account.integration.mjs` | عُدّل | 318 | 53 | 27 ← 27–29، 30 ← 32–37، 50 ← 57–64، 57 ← 71–73، 67 ← 83–86، 80 ← 99–103، 82–84 ← 105–125، 88 ← 129–132، 91 ← 135–138، 96–97 ← 143–156، 100 ← 159–162، 102–103 ← 164–175 … (٣١ موضعاً) |
| `phase1-backend/tests/market-campaigns.browser-acceptance.mjs` | عُدّل | 112 | 20 | 30 ← 30–41، 35 ← 46–51، 51 ← 67–77، 54 ← 80–86، 56 ← 88–98، 58–59 ← 100–111، 61 ← 113–115، 63 ← 117–123، 86 ← 146–148، 88 ← 150–154، 97 ← 163–165، 113 ← 181–184 … (١٧ موضعاً) |
| `phase1-backend/tests/market-campaigns.integration.mjs` | عُدّل | 411 | 65 | 35 ← 35–40، 51 ← 56–64، 54 ← 67–71، 64–65 ← 81–98، 69 ← 102–108، 71 ← 110–118، 73–74 ← 120–128، 79–80 ← 133–150، 84–86 ← 154–172، 92–97 ← 178–236، 102 ← 241–242، 104–106 ← 244–266 … (٣٢ موضعاً) |
| `phase1-backend/tests/market-cart.browser-acceptance.mjs` | عُدّل | 171 | 26 | 32 ← 32–41، 38 ← 47–51، 42 ← 55–58، 47 ← 63–68، 57 ← 78–84، 60–61 ← 87–107، 63–66 ← 109–133، 68 ← 135–137، 79–81 ← 148–166، 87 ← 172–176، 93 ← 182–186، 103 ← 196–200 … (١٨ موضعاً) |
| `phase1-backend/tests/market-cart.integration.mjs` | عُدّل | 389 | 65 | 33 ← 33–38، 47 ← 52–59، 50 ← 62–66، 59 ← 75–78، 69 ← 88–94، 72–73 ← 97–117، 75–77 ← 119–132، 79–81 ← 134–150، 83 ← 152–157، 85 ← 159–167، 87 ← 169–176، 91–92 ← 180–198 … (٣٦ موضعاً) |
| `phase1-backend/tests/market-catalog.browser-acceptance.mjs` | عُدّل | 105 | 17 | 32 ← 32–40، 37 ← 45–50، 49 ← 62–68، 51 ← 70–81، 54 ← 84–93، 56 ← 95–97، 59 ← 100–102، 64 ← 107–109، 72 ← 117–121، 84 ← 133–136، 110 ← 162–165، 131 ← 186–189 … (١٧ موضعاً) |
| `phase1-backend/tests/market-catalog.integration.mjs` | عُدّل | 400 | 66 | 47 ← 47–55، 55 ← 63–67، 67 ← 79–83، 69 ← 85–91، 71 ← 93–104، 73–74 ← 106–114، 80 ← 120–122، 82–89 ← 124–175، 95 ← 181–184، 97 ← 186–189، 99–102 ← 191–216، 107–108 ← 221–229 … (٤٠ موضعاً) |
| `phase1-backend/tests/market-foundation.integration.mjs` | عُدّل | 111 | 23 | 28–32 ← 28–36، 43 ← 47–48، 45 ← 50–54، 54 ← 63–69، 56 ← 71–78، 58 ← 80–82، 60–66 ← 84–118، 70 ← 122–129، 77–78 ← 136–145، 91 ← 158–162، 97 ← 168–173، 104 ← 180–192 |
| `phase1-backend/tests/market-help.browser-acceptance.mjs` | عُدّل | 170 | 33 | 33 ← 33–43، 39 ← 49–53، 43 ← 57–60، 48 ← 65–70، 63–65 ← 85–100، 68 ← 103–113، 70–71 ← 115–126، 73 ← 128–130، 79 ← 136–138، 95 ← 154–158، 104–106 ← 167–185، 111 ← 190–196 … (٢٢ موضعاً) |
| `phase1-backend/tests/market-help.integration.mjs` | عُدّل | 450 | 72 | 29 ← 29–34، 43 ← 48–56، 46 ← 59–63، 55 ← 72–75، 64–65 ← 84–101، 67 ← 103–109، 71–73 ← 113–138، 75–78 ← 140–163، 83–84 ← 168–186، 87–91 ← 189–210، 93 ← 212–216، 95–97 ← 218–231 … (٣٦ موضعاً) |
| `phase1-backend/tests/market-home.browser-acceptance.mjs` | عُدّل | 124 | 22 | 30 ← 30–38، 35 ← 43–48، 49 ← 62–66، 51 ← 68–74، 53 ← 76–86، 55 ← 88–97، 57 ← 99–101، 60 ← 104–106، 84 ← 130–132، 97 ← 145–146، 99 ← 148–149، 109 ← 159–163 … (٢٠ موضعاً) |
| `phase1-backend/tests/market-home.integration.mjs` | عُدّل | 444 | 62 | 27 ← 27–29، 39 ← 41–45، 50–51 ← 56–71، 53 ← 73–79، 55 ← 81–86، 57–58 ← 88–106، 61–63 ← 109–137، 66–71 ← 140–202، 73 ← 204–211، 78–81 ← 216–230، 83–87 ← 232–272، 92–93 ← 277–293 … (٣٤ موضعاً) |
| `phase1-backend/tests/market-map.browser-acceptance.mjs` | عُدّل | 99 | 18 | 31 ← 31–42، 37 ← 48–52، 41 ← 56–59، 46 ← 64–69، 58 ← 81–87، 62 ← 91–102، 67–68 ← 107–108، 70–71 ← 110–117، 109–111 ← 155–175، 128–129 ← 192–199، 136–137 ← 206–213، 143 ← 219–224 |
| `phase1-backend/tests/market-map.integration.mjs` | عُدّل | 148 | 34 | 25 ← 25–27، 29 ← 31–39، 32 ← 42–45، 36–38 ← 49–60، 47 ← 69–75، 51 ← 79–89، 56–60 ← 94–98، 62 ← 100–103، 67 ← 108–112، 70–72 ← 115–128، 79–80 ← 135–143، 83–86 ← 146–165 … (١٨ موضعاً) |
| `phase1-backend/tests/market-orders.browser-acceptance.mjs` | عُدّل | 136 | 27 | 34 ← 34–43، 40 ← 49–53، 44 ← 57–60، 49 ← 65–70، 58 ← 79–81، 61 ← 84–90، 64 ← 93–103، 66–67 ← 105–116، 69 ← 118–120، 79–81 ← 130–148، 84–88 ← 151–172، 111 ← 195–197 … (٢٠ موضعاً) |
| `phase1-backend/tests/market-orders.integration.mjs` | عُدّل | 377 | 60 | 32 ← 32–37، 46 ← 51–59، 49 ← 62–66، 58 ← 75–78، 68 ← 88–94، 70 ← 96–109، 72–73 ← 111–122، 79–80 ← 128–146، 83–84 ← 149–158، 88 ← 162–165، 93–94 ← 170–177، 100 ← 183–187 … (٣٥ موضعاً) |
| `phase1-backend/tests/market-partner.browser-acceptance.mjs` | عُدّل | 135 | 23 | 30 ← 30–41، 35 ← 46–51، 41 ← 57–64، 50–52 ← 73–93، 54–55 ← 95–106، 59 ← 110–112، 65 ← 118–120، 67 ← 122–126، 78–80 ← 137–159، 83 ← 162–166، 88–90 ← 171–187، 92–94 ← 189–199 … (١٤ موضعاً) |
| `phase1-backend/tests/market-partner.integration.mjs` | عُدّل | 343 | 49 | 28 ← 28–32، 31 ← 35–40، 43 ← 52–57، 46 ← 60–64، 52 ← 70–77، 57 ← 82–86، 59 ← 88–91، 64 ← 96–102، 66 ← 104–114، 68–69 ← 116–127، 73 ← 131–140، 76–77 ← 143–163 … (٣٢ موضعاً) |
| `phase1-backend/tests/market-payments.browser-acceptance.mjs` | عُدّل | 135 | 24 | 32 ← 32–44، 40 ← 52–54، 44 ← 58–61، 49 ← 66–71، 60 ← 82–86، 63–65 ← 89–117، 67–68 ← 119–130، 70 ← 132–134، 79–81 ← 143–161، 85 ← 165–168، 100 ← 183–186، 110 ← 196–200 … (١٧ موضعاً) |
| `phase1-backend/tests/market-payments.integration.mjs` | عُدّل | 363 | 61 | 31 ← 31–35، 34 ← 38–43، 46 ← 55–60، 49 ← 63–67، 58 ← 76–79، 62 ← 83–84، 68 ← 90–96، 70 ← 98–108، 72–73 ← 110–123، 78–79 ← 128–141، 82–83 ← 144–160، 86–88 ← 163–182 … (٣٦ موضعاً) |
| `phase1-backend/tests/market-reels.browser-acceptance.mjs` | عُدّل | 165 | 30 | 27 ← 27–32، 36 ← 41–48، 39 ← 51–56، 42 ← 59–64، 47 ← 69–80، 53 ← 86–90، 57 ← 94–97، 62 ← 102–107، 73 ← 118–122، 76 ← 125–129، 80 ← 133–139، 82 ← 141–151 … (٢٩ موضعاً) |
| `phase1-backend/tests/market-reels.integration.mjs` | عُدّل | 313 | 50 | 28 ← 28–35، 31 ← 38–43، 34 ← 46–51، 40 ← 57–61، 43 ← 64–69، 50–51 ← 76–85، 59 ← 93–101، 62 ← 104–108، 64 ← 110–116، 79–80 ← 131–148، 84–85 ← 152–167، 87–88 ← 169–183 … (٢٩ موضعاً) |
| `phase1-backend/tests/market-rewards.browser-acceptance.mjs` | عُدّل | 151 | 26 | 19 ← 19–22، 32 ← 35–45، 38 ← 51–55، 42 ← 59–62، 47 ← 67–72، 61 ← 86–96، 64 ← 99–105، 66 ← 107–117، 68–70 ← 119–141، 73 ← 144–146، 75 ← 148–154، 102–104 ← 181–199 … (٢٠ موضعاً) |
| `phase1-backend/tests/market-rewards.integration.mjs` | عُدّل | 312 | 54 | 33 ← 33–38، 35 ← 40–43، 49 ← 57–65، 52 ← 68–72، 61 ← 81–84، 70–71 ← 93–110، 75 ← 114–120، 77 ← 122–130، 79–81 ← 132–149، 86 ← 154–157، 88 ← 159–162، 95–100 ← 169–217 … (٢٨ موضعاً) |
| `phase1-backend/tests/market-score.unit.mjs` | عُدّل | 113 | 20 | 7–8 ← 7–12، 11–12 ← 15–26، 16 ← 30–33، 23 ← 40–44، 27–28 ← 48–60، 33 ← 65–69، 37 ← 73–84، 40 ← 87–91، 47–48 ← 98–113، 62 ← 127–131، 64 ← 133–134، 66–67 ← 136–137 … (١٥ موضعاً) |
| `phase1-backend/tests/market-shell.browser-acceptance.mjs` | عُدّل | 60 | 11 | 26 ← 26–34، 32 ← 40–45، 41 ← 54–56، 45 ← 60–62، 57 ← 74–78، 72 ← 93–97، 74 ← 99–103، 83 ← 112–116، 86 ← 119–123، 97 ← 134–136، 101 ← 140–150 |
| `phase1-backend/tests/market-stores.browser-acceptance.mjs` | عُدّل | 154 | 26 | 30 ← 30–38، 36 ← 44–49، 42 ← 55–59، 54 ← 71–81، 57 ← 84–90، 60 ← 93–104، 62 ← 106–114، 64 ← 116–118، 67 ← 121–123، 72 ← 128–130، 76 ← 134–138، 84 ← 146–147 … (٢٥ موضعاً) |
| `phase1-backend/tests/market-stores.integration.mjs` | عُدّل | 316 | 57 | 37 ← 37–41، 40 ← 44–48، 42 ← 50–51، 49 ← 58–61، 51 ← 63–68، 56 ← 73–77، 58 ← 79–85، 60 ← 87–95، 62 ← 97–102، 68–69 ← 108–113، 76 ← 120–123، 82–83 ← 129–143 … (٤٤ موضعاً) |
| `phase1-backend/tests/market-support.browser-acceptance.mjs` | عُدّل | 205 | 40 | 27 ← 27–30، 37 ← 40–47، 40 ← 50–55، 43 ← 58–63، 48 ← 68–79، 54 ← 85–89، 58 ← 93–96، 63 ← 101–106، 74 ← 117–125، 77 ← 128–132، 81 ← 136–142، 84 ← 145–155 … (٢٩ موضعاً) |
| `phase1-backend/tests/market-support.integration.mjs` | عُدّل | 392 | 64 | 29 ← 29–32، 32 ← 35–42، 35 ← 45–50، 38 ← 53–58، 44 ← 64–72، 47 ← 75–80، 59 ← 92–100، 62 ← 103–107، 64 ← 109–115، 72 ← 123–126، 76 ← 130–134، 82–83 ← 140–157 … (٣٨ موضعاً) |
| `phase1-backend/tests/market-visual.browser-acceptance.mjs` | عُدّل | 190 | 33 | 32–33 ← 32–37، 35–36 ← 39–49، 42 ← 55–62، 45 ← 65–70، 48 ← 73–78، 51 ← 81–92، 56 ← 97–102، 61–64 ← 107–122، 71 ← 129–133، 74 ← 136–145، 76–77 ← 147–164، 79 ← 166–173 … (٢٢ موضعاً) |
| `phase1-backend/tests/market-visual.integration.mjs` | عُدّل | 217 | 38 | 27 ← 27–34، 30 ← 37–42، 33 ← 45–50، 38 ← 55–59، 45–46 ← 66–80، 52–53 ← 86–91، 59 ← 97–102، 65 ← 108–112، 71–72 ← 118–129، 75–76 ← 132–149، 78 ← 151–156، 85–87 ← 163–177 … (٢٢ موضعاً) |
| `phase1-backend/tests/market-wheel.browser-acceptance.mjs` | عُدّل | 67 | 13 | 32 ← 32–42، 38 ← 48–52، 42 ← 56–59، 47 ← 64–69، 60–61 ← 82–95، 63 ← 97–99، 87 ← 123–125، 110 ← 148–151، 112 ← 153–159، 119 ← 166–168، 125 ← 174–176، 127 ← 178–181 |
| `phase1-backend/tests/market-wheel.integration.mjs` | عُدّل | 400 | 68 | 27 ← 27–29، 32 ← 34–39، 34 ← 41–44، 48 ← 58–66، 51 ← 69–73، 61 ← 83–86، 70–73 ← 95–130، 75–77 ← 132–153، 79–81 ← 155–176، 83 ← 178–180، 85–86 ← 182–197، 88 ← 199–208 … (٣٨ موضعاً) |
| `phase1-backend/tests/marketing-recipient-cap.integration.mjs` | عُدّل | 109 | 18 | 33 ← 33–35، 38 ← 40–46، 40–41 ← 48–63، 54–56 ← 76–85، 61 ← 90–99، 68 ← 106–110، 81–85 ← 123–156، 87–88 ← 158–168، 95 ← 175–184، 98 ← 187–189 |
| `phase1-backend/tests/md1.integration.mjs` | عُدّل | 1473 | 309 | 48 ← 48–49، 66–67 ← 67–74، 70 ← 77–79، 75–76 ← 84–91، 89 ← 104–108، 100 ← 119–122، 102 ← 124–135، 104 ← 137–143، 109 ← 148–152، 113–115 ← 156–165، 123 ← 173–175، 126–127 ← 178–191 … (١٦٦ موضعاً) |
| `phase1-backend/tests/md3.integration.mjs` | عُدّل | 269 | 55 | 33 ← 33–34، 41–42 ← 42–47، 71 ← 76–78، 79 ← 86–92، 81–83 ← 94–113، 93 ← 123–125، 95–96 ← 127–136، 98 ← 138–142، 102 ← 146–150، 106 ← 154–158، 110 ← 162–166، 113 ← 169–173 … (٣٧ موضعاً) |
| `phase1-backend/tests/md6.integration.mjs` | عُدّل | 252 | 54 | 32 ← 32–33، 69 ← 70–77، 71 ← 79–82، 76 ← 87–93، 78–79 ← 95–106، 93 ← 120–124، 97 ← 128، 100–101 ← 131–137، 107–108 ← 143–150، 113 ← 155–158، 115 ← 160–168، 120 ← 173–174 … (٢٨ موضعاً) |
| `phase1-backend/tests/merchant-home.integration.mjs` | عُدّل | 173 | 31 | 28 ← 28–30، 43 ← 45–51، 57 ← 65–67، 60 ← 70–74، 66 ← 80–86، 68 ← 88–95، 70–71 ← 97–111، 75–76 ← 115–120، 81 ← 125–134، 89 ← 142–146، 92–93 ← 149–158، 95–98 ← 160–178 … (٢٢ موضعاً) |
| `phase1-backend/tests/merchant-screens.guard.mjs` | عُدّل | 34 | 8 | 19–23 ← 19–36، 32–34 ← 45–60 |
| `phase1-backend/tests/merchant-suspension.integration.mjs` | عُدّل | 379 | 60 | 35 ← 35–36، 50 ← 51–53، 58 ← 61–64، 61 ← 67–71، 64 ← 74–76، 71 ← 83–90، 73 ← 92–98، 77 ← 102–113، 85 ← 121–127، 87 ← 129–141، 90 ← 144–150، 94 ← 154–163 … (٤٢ موضعاً) |
| `phase1-backend/tests/messaging-caps.integration.mjs` | عُدّل | 151 | 24 | 35 ← 35–39، 40 ← 44–48، 49 ← 57–60، 51 ← 62–65، 56 ← 70–76، 58–59 ← 78–91، 68 ← 100–104، 72 ← 108–112، 76 ← 116–120، 78–80 ← 122–135، 82 ← 137–142، 86–89 ← 146–179 … (١٤ موضعاً) |
| `phase1-backend/tests/migration-rehearsal.integration.mjs` | عُدّل | 77 | 18 | 36 ← 36–45، 51 ← 60–62، 66 ← 77–82، 71–72 ← 87–93، 74 ← 95–98، 84 ← 108–113، 90 ← 119–120، 92 ← 122–126، 99–100 ← 133–142، 108 ← 150–153، 111 ← 156، 119–123 ← 164–182 |
| `phase1-backend/tests/module-registry.unit.mjs` | عُدّل | 71 | 12 | 22 ← 22–24، 25–28 ← 27–54، 30 ← 56–60، 35 ← 65–69، 39 ← 73–76، 45 ← 82–84، 50 ← 89–92، 54 ← 96–99، 56 ← 101–115 |
| `phase1-backend/tests/neon-connection.test.ts` | عُدّل | 11 | 2 | 32–33 ← 32–42 |
| `phase1-backend/tests/openapi.guard.mjs` | عُدّل | 110 | 33 | 98 ← 98–100، 100 ← 102–103، 113–115 ← 116–127، 133 ← 145–146، 153 ← 166–169، 166–167 ← 182–189، 171 ← 193–194، 175 ← 198–199، 180–181 ← 204–211، 184 ← 214–215، 189–190 ← 220–227، 192 ← 229–232 … (٢٤ موضعاً) |
| `phase1-backend/tests/order-money.guard.mjs` | عُدّل | 38 | 18 | 57 ← 57، 92 ← 92، 115 ← 115–118، 144 ← 147–152، 153–154 ← 161–167، 188 ← 201، 191–201 ← 204–221 |
| `phase1-backend/tests/order-transitions-mirror.guard.mjs` | عُدّل | 34 | 15 | 51 ← 51–54، 62 ← 65–68، 77 ← 83، 82–83 ← 88–96، 85–94 ← 98–113 |
| `phase1-backend/tests/outcome-vocabulary.guard.mjs` | عُدّل | 42 | 18 | 61–62 ← 61–64، 65–66 ← 67–74، 69 ← 77–80، 71 ← 82–86، 73 ← 88–90، 84 ← 101، 87–96 ← 104–120 |
| `phase1-backend/tests/owner-bootstrap.integration.mjs` | عُدّل | 59 | 16 | 31 ← 31–35، 39 ← 43، 42 ← 46–47، 47 ← 52–56، 49 ← 58–62، 52–55 ← 65–78، 61 ← 84–89، 63 ← 91، 74 ← 102–107، 76–78 ← 109–118، 84 ← 124–127 |
| `phase1-backend/tests/owner-surface.guard.mjs` | عُدّل | 21 | 8 | 94–96 ← 94–98، 100–104 ← 102–117 |
| `phase1-backend/tests/p27-brand.integration.mjs` | عُدّل | 503 | 106 | 54 ← 54–58، 67 ← 71–74، 69 ← 76–79، 73 ← 83–87، 88 ← 102–107، 90 ← 109–114، 93 ← 117–119، 114 ← 140–145، 120–121 ← 151–163، 128 ← 170–174، 132 ← 178–182، 135–136 ← 185–193 … (٧٧ موضعاً) |
| `phase1-backend/tests/password-hash.unit.mjs` | عُدّل | 84 | 20 | 36 ← 36–37، 38 ← 39–41، 49–51 ← 52–66، 58 ← 73–77، 60 ← 79–83، 66 ← 89–93، 68 ← 95–99، 73–74 ← 104–111، 87 ← 124–126، 92 ← 131–134، 95 ← 137–140، 103–106 ← 148–166 … (١٣ موضعاً) |
| `phase1-backend/tests/password-mirror.guard.mjs` | عُدّل | 79 | 20 | 83 ← 83–86، 90 ← 93، 95 ← 98، 104 ← 107، 114 ← 117–120، 119–120 ← 125–132، 126 ← 138–142، 140–142 ← 156–174، 144–146 ← 176–187، 159 ← 200–202، 162 ← 205–209، 167 ← 214–217 … (١٤ موضعاً) |
| `phase1-backend/tests/password-policy-check.mjs` | عُدّل | 86 | 19 | 27 ← 27–29، 51 ← 53–56، 55–57 ← 60–77، 62 ← 82–86، 65–67 ← 89–105، 72 ← 110–116، 74 ← 118–122، 80 ← 128–132، 89 ← 141، 95 ← 147–151، 113 ← 169–172، 130–131 ← 189–190 … (١٤ موضعاً) |
| `phase1-backend/tests/payment-methods.integration.mjs` | عُدّل | 189 | 32 | 36 ← 36–41، 41 ← 46–50، 47 ← 56–62، 49 ← 64–71، 51–52 ← 73–87، 61 ← 96–100، 63 ← 102–106، 65 ← 108–114، 69 ← 118–122، 71–72 ← 124–133، 74 ← 135–139، 77–78 ← 142–156 … (٢٥ موضعاً) |
| `phase1-backend/tests/pc1.platform-contact.integration.mjs` | عُدّل | 473 | 91 | 38 ← 38–39، 54–55 ← 55–61، 58 ← 64، 82 ← 88–91، 97–102 ← 106–134، 111 ← 143–147، 113 ← 149–153، 117–121 ← 157–180، 128 ← 187–190، 131 ← 193–198، 135 ← 202–208، 137–138 ← 210–223 … (٤٥ موضعاً) |
| `phase1-backend/tests/perf-budget.guard.mjs` | عُدّل | 19 | 7 | 40 ← 40–42، 53 ← 55–58، 57 ← 62–63، 77 ← 83–85، 83 ← 91–92، 86 ← 95–96، 95 ← 105–107 |
| `phase1-backend/tests/perf-index-evidence.mjs` | عُدّل | 331 | 101 | 43 ← 43–45، 49 ← —، 67–70 ← 68–75، 73 ← 78–82، 82–162 ← 91–349، 176 ← 363–366، 196 ← 386–387، 202–204 ← 393–398، 212 ← 406–409، 215 ← 412–422، 232 ← 439–442، 251 ← 461–464 … (١٥ موضعاً) |
| `phase1-backend/tests/pg1.integration.mjs` | عُدّل | 255 | 51 | 52 ← 52–56، 63 ← 67–70، 65 ← 72–83، 72 ← 90–94، 75 ← 97–106، 80 ← 111–113، 85 ← 118–120، 88–95 ← 123–164، 99–101 ← 168–190، 108 ← 197–201، 112 ← 205–208، 115 ← 211–215 … (٣٣ موضعاً) |
| `phase1-backend/tests/pg2.browser-acceptance.mjs` | عُدّل | 399 | 84 | 39 ← 39–46، 48 ← 55–58، 57 ← 67–71، 76–77 ← 90–100، 84 ← 107–112، 87 ← 115–117، 94–95 ← 124–136، 97 ← 138–149، 100 ← 152–155، 105–109 ← 160–180، 111 ← 182–185، 116 ← 190–194 … (٤٨ موضعاً) |
| `phase1-backend/tests/pg2.integration.mjs` | عُدّل | 1729 | 361 | 39 ← 39–42، 52 ← 55–58، 54 ← 60–65، 57 ← 68–73، 72–73 ← 88–95، 78 ← 100–102، 81–82 ← 105–110، 99 ← 127–131، 103 ← 135–136، 113 ← 146–148، 117 ← 152–158، 120–121 ← 161–171 … (٢١٢ موضعاً) |
| `phase1-backend/tests/pg2.no-deleted-leak.test.ts` | عُدّل | 14 | 3 | 10 ← 10–15، 20 ← 25–28، 26 ← 34–37 |
| `phase1-backend/tests/pg3.integration.mjs` | عُدّل | 349 | 104 | 76 ← 76–78، 80 ← 82–88، 82–83 ← 90–105، 101 ← 123–130، 156–194 ← 185–227، 198 ← 231–240، 211–212 ← 253–260، 214 ← 262–265، 219 ← 270–274، 230 ← 285–287، 235 ← 292–296، 237–238 ← 298–305 … (٥٠ موضعاً) |
| `phase1-backend/tests/pg6.arabic-search.integration.mjs` | عُدّل | 464 | 99 | 42 ← 42–43، 50 ← 51–53، 80 ← 83–87، 90 ← 97–99، 94–95 ← 103–116، 99–100 ← 120–135، 102–103 ← 137–144، 110–115 ← 151–162، 119 ← 166–169، 125 ← 175–179، 133–135 ← 187–206، 137–138 ← 208–220 … (٥٤ موضعاً) |
| `phase1-backend/tests/phase1.integration.ts` | عُدّل | 409 | 87 | 15–16 ← 15–19، 21–22 ← 24–33، 41–42 ← 52–61، 46 ← 65–72، 49 ← 75–81، 51–53 ← 83–104، 61 ← 112–115، 66 ← 120–123، 69 ← 126–128، 80 ← 139، 92 ← 151، 103 ← — … (٤٨ موضعاً) |
| `phase1-backend/tests/phase10.composite-server.runtime.mjs` | عُدّل | 72 | 15 | 11 ← 11–12، 24–25 ← 25–30، 33 ← 38–39، 45 ← 51–53، 62 ← 70–74، 67 ← 79–83، 79–83 ← 95–115، 90 ← 122–126، 92 ← 128–130، 105 ← 143–162 |
| `phase1-backend/tests/phase13.browser-flow.mjs` | عُدّل | 67 | 19 | 21 ← 21–24، 23 ← 26–27، 27 ← 31–33، 30–33 ← 36–57، 35 ← 59–60، 54 ← 79–82، 56 ← 84–85، 58 ← 87–90، 64 ← 96–100، 71 ← 107–110، 80 ← 119–122، 82–86 ← 124–134 |
| `phase1-backend/tests/phase13.store-switcher.integration.ts` | عُدّل | 133 | 35 | 43 ← 43–46، 48–49 ← 51–57، 52 ← 60–62، 60 ← 70–74، 63 ← 77–81، 66–70 ← 84–112، 78 ← 120–129، 80 ← —، 86 ← 136–138، 102 ← 154–156، 104 ← 158–160، 107 ← 163–165 … (١٩ موضعاً) |
| `phase1-backend/tests/phase14.browser-acceptance.mjs` | عُدّل | 178 | 46 | 24 ← 24–30، 30 ← 36–38، 34 ← 42–45، 41 ← 52–55، 67 ← 81–83، 78 ← 94–101، 80 ← 103–106، 82 ← 108–119، 91–93 ← 128–144، 96 ← 147–155، 112 ← 171–175، 117 ← 180–183 … (٢٤ موضعاً) |
| `phase1-backend/tests/phase14.staff-permissions.integration.ts` | عُدّل | 756 | 137 | 20 ← 20–25، 32 ← 37–40، 35 ← 43–47، 39 ← 51–53، 42–43 ← 56–62، 46 ← 65–67، 57–59 ← 78–98، 61–67 ← 100–141، 75 ← 149–157، 81 ← 163–172، 84 ← 175–184، 86 ← 186–195 … (٩٩ موضعاً) |
| `phase1-backend/tests/phase15.browser-acceptance.mjs` | عُدّل | 134 | 30 | 25 ← 25–32، 31 ← 38–40، 35 ← 44–47، 42 ← 54–57، 55 ← 70–72، 62 ← 79–86، 64 ← 88–91، 66 ← 93–104، 74–75 ← 112–125، 91 ← 141–144، 94 ← 147–151، 101 ← 158–161 … (١٨ موضعاً) |
| `phase1-backend/tests/phase15.notifications.integration.ts` | عُدّل | 560 | 95 | 16 ← 16–20، 26 ← 30–37، 29 ← 40–44، 33 ← 48–50، 36–37 ← 53–59، 40 ← 62–64، 49–50 ← 73–86، 52–57 ← 88–124، 62 ← 129–131، 65–68 ← 134–149، 70 ← 151–155، 73 ← 158–162 … (٦١ موضعاً) |
| `phase1-backend/tests/phase16.browser-acceptance.mjs` | عُدّل | 83 | 23 | 24 ← 24–31، 30 ← 37–39، 34 ← 43–46، 41 ← 53–56، 54 ← 69–71، 61 ← 78–85، 63 ← 87–90، 65 ← 92–103، 77 ← 115–118، 97 ← 138–141، 106 ← 150–153، 121 ← 168–171 … (١٣ موضعاً) |
| `phase1-backend/tests/phase16.plans-entitlements.integration.ts` | عُدّل | 334 | 74 | 23 ← 23–26، 26 ← 29–33، 30 ← 37–39، 33–34 ← 42–48، 38 ← 52–54، 49 ← 65–72، 51 ← 74–77، 54 ← 80–86، 57–59 ← 89–101، 61 ← 103–114، 69–71 ← 122–134، 77 ← 140–143 … (٥٠ موضعاً) |
| `phase1-backend/tests/phase17.browser-acceptance.mjs` | عُدّل | 149 | 40 | 24 ← 24–31، 30 ← 37–39، 34 ← 43–46، 41 ← 53–56، 48–49 ← 63–70، 57 ← 78–85، 75 ← 103–107، 80 ← 112، 85 ← 117، 90 ← 122، 100 ← 132–136، 102 ← 138–142 … (٢٤ موضعاً) |
| `phase1-backend/tests/phase17.finance.integration.ts` | عُدّل | 861 | 161 | 27 ← 27–30، 30 ← 33–37، 34 ← 41–43، 37–38 ← 46–52، 41–42 ← 55–62، 52 ← 72–79، 54 ← 81–84، 58 ← 88–99، 66 ← 107–110، 71 ← 115–125، 74 ← 128–132، 93 ← 151–153 … (١١٥ موضعاً) |
| `phase1-backend/tests/phase19a.sessions.integration.mjs` | عُدّل | 210 | 43 | 30 ← 30–31، 70–71 ← 71–85، 74 ← 88–94، 76–77 ← 96–109، 81 ← 113–119، 86–87 ← 124–137، 97 ← 147–150، 99–100 ← 152–159، 113–114 ← 172–175، 116 ← 177–182، 120 ← 186–189، 122 ← 191–194 … (٢٣ موضعاً) |
| `phase1-backend/tests/phase19b.owner-totp.integration.mjs` | عُدّل | 250 | 51 | 26 ← 26–27، 35 ← 36–38، 71 ← 74–77، 80 ← 86–89، 85 ← 94، 88 ← 97–101، 96–98 ← 109–122، 101–102 ← 125–134، 104 ← 136–146، 107 ← 149–153، 110–112 ← 156–168، 115 ← 171–174 … (٣٥ موضعاً) |
| `phase1-backend/tests/phase19c.password-change.integration.mjs` | عُدّل | 160 | 35 | 31 ← 31–32، 83–84 ← 84–93، 87 ← 96–100، 89 ← 102–106، 92–93 ← 109–118، 96–98 ← 121–135، 101 ← 138–142، 104 ← 145–149، 106 ← 151–154، 110 ← 158–162، 113 ← 165–169، 138 ← 194–199 … (٢٦ موضعاً) |
| `phase1-backend/tests/phase20a.browser-acceptance.mjs` | عُدّل | 223 | 46 | 29 ← 29–36، 35 ← 42–44، 40 ← 49–52، 47 ← 59–62، 54 ← 69–71، 62 ← 79–86، 64 ← 88–91، 67 ← 94–105، 74 ← 112–115، 76 ← 117–124، 82 ← 130–133، 114 ← 165–172 … (٢٧ موضعاً) |
| `phase1-backend/tests/phase20a.variants.integration.mjs` | عُدّل | 548 | 104 | 41 ← 41–46، 44 ← 49–53، 48 ← 57–61، 52 ← 65–70، 54 ← 72–76، 60 ← 82–84، 72 ← 96–99، 74 ← 101–112، 76 ← 114–118، 80 ← 122–124، 82–87 ← 126–160، 89 ← 162–165 … (٤٨ موضعاً) |
| `phase1-backend/tests/phase20b.browser-acceptance.mjs` | عُدّل | 263 | 58 | 50 ← 50–53، 52 ← 55–60، 56 ← 64–69، 62 ← 75–83، 68 ← 89–91، 73 ← 96–99، 80 ← 106–109، 87 ← 116–118، 94–95 ← 125–141، 97–98 ← 143–158، 105 ← 165–168، 107 ← 170–177 … (٣٤ موضعاً) |
| `phase1-backend/tests/phase20b1.integration.mjs` | عُدّل | 804 | 178 | 41 ← 41–44، 56 ← 59–64، 59 ← 67–72، 80 ← 93–97، 84–86 ← 101–110، 90 ← 114–118، 94 ← 122–127، 97 ← 130–134، 103 ← 140–142، 114 ← 153–156، 116 ← 158–169، 118 ← 171–175 … (٩٨ موضعاً) |
| `phase1-backend/tests/phase20b2.integration.mjs` | عُدّل | 656 | 125 | 63 ← 63–67، 71 ← 75–79، 75 ← 83–88، 78 ← 91–95، 86 ← 103–106، 88 ← 108–119، 90 ← 121–125، 103–104 ← 138–149، 107 ← 152–154، 112 ← 159–161، 115–121 ← 164–201، 123–125 ← 203–212 … (٦٩ موضعاً) |
| `phase1-backend/tests/phase20b3.integration.mjs` | عُدّل | 503 | 104 | 63 ← 63–67، 74 ← 78–81، 76 ← 83–87، 82 ← 93–95، 94 ← 107–110، 96 ← 112–123، 98 ← 125–129، 104–105 ← 135–146، 111 ← 152–154، 114–119 ← 157–198، 121–122 ← 200–209، 125 ← 212–216 … (٦٣ موضعاً) |
| `phase1-backend/tests/phase5.tenancy.integration.ts` | عُدّل | 255 | 39 | 12–13 ← 12–16، 18 ← 21–27، 56–58 ← 65–86، 63–64 ← 91–102، 67–69 ← 105–131، 72–74 ← 134–160، 76–77 ← 162–215، 79–81 ← 217–234، 89 ← 242–244، 91 ← 246–248، 102–105 ← 259–271، 114–117 ← 280–292 … (١٤ موضعاً) |
| `phase1-backend/tests/phase6.browser-flow.mjs` | عُدّل | 60 | 15 | 22 ← 22–24، 27–28 ← 29–39، 44 ← 55–59، 48 ← 63–66، 53 ← 71–74، 77 ← 98–101، 82 ← 106–108، 84 ← 110–114، 88 ← 118–121، 91 ← 124–127، 93–96 ← 129–141 |
| `phase1-backend/tests/phase6.manual-provisioning.integration.ts` | عُدّل | 363 | 72 | 13–14 ← 13–21، 17 ← 24–26، 20–21 ← 29–38، 50 ← 67–74، 52 ← 76–79، 57 ← 84–95، 63 ← 101–112، 67 ← 116–127، 71–73 ← 131–146، 89–90 ← 162–171، 92 ← 173–177، 94 ← 179–183 … (٣٣ موضعاً) |
| `phase1-backend/tests/phase7.browser-flow.mjs` | عُدّل | 108 | 16 | 19 ← 19–22، 22 ← 25–40، 28 ← 46–55، 32 ← 59–64، 38 ← 70–78، 40–41 ← 80–86، 43 ← 88–99، 45 ← 101–104، 52 ← 111–115، 54 ← 117–120، 56–57 ← 122–133، 81 ← 157–159 … (١٤ موضعاً) |
| `phase1-backend/tests/phase7.product-management.integration.mjs` | عُدّل | 437 | 84 | 14 ← 14–17، 16 ← 19–25، 30 ← 39–44، 33 ← 47–52، 42 ← 61–68، 64 ← 90–93، 69 ← 98–100، 97 ← 128–134، 99 ← 136–142، 109 ← 152–154، 127 ← 172–179، 129–136 ← 181–222 … (٣٨ موضعاً) |
| `phase1-backend/tests/phase8a.order-lifecycle.integration.mjs` | عُدّل | 304 | 69 | 27 ← 27–30، 30 ← 33–36، 34 ← 40–44، 39 ← 49–51، 41 ← 53–60، 43 ← 62–65، 47–51 ← 69–100، 53–56 ← 102–113، 58 ← 115–122، 60–73 ← 124–216، 75 ← 218–219، 80 ← 224–228 … (١٩ موضعاً) |
| `phase1-backend/tests/phase8b.browser-acceptance.mjs` | عُدّل | 254 | 47 | 20 ← 20–26، 26 ← 32–35، 49 ← 58–60، 52 ← 63–67، 65 ← 80–82، 73 ← 90–98، 75 ← 100–104، 86 ← 115–126، 98–100 ← 138–157، 104–105 ← 161–189، 116–120 ← 200–222، 125 ← 227–231 … (٢٩ موضعاً) |
| `phase1-backend/tests/phase9a.storefront.integration.mjs` | عُدّل | 1023 | 202 | 32 ← 32–37، 35 ← 40–44، 39 ← 48–52، 44 ← 57–59، 52–59 ← 67–106، 63–67 ← 110–142، 69 ← 144–152، 73–82 ← 156–204، 84 ← 206–208، 86–87 ← 210–215، 90–92 ← 218–235، 94 ← 237–244 … (١٠٢ موضعاً) |
| `phase1-backend/tests/phase9b.browser-acceptance.mjs` | عُدّل | 411 | 81 | 18 ← 18–25، 24 ← 31–34، 32 ← 42–46، 36 ← 50–54، 42 ← 60–71، 49–62 ← 78–160، 86–87 ← 184–193، 92–93 ← 198–204، 150 ← 261–265، 154 ← 269–273، 157 ← 276، 160 ← 279–284 … (٢٤ موضعاً) |
| `phase1-backend/tests/phase9b.cookie-session.acceptance.mjs` | عُدّل | 156 | 31 | 22 ← 22–28، 44 ← 50–52، 46 ← 54–60، 48–50 ← 62–87، 65–67 ← 102–113، 78 ← 124–128، 85 ← 135–139، 96 ← 150–152، 98–99 ← 154–163، 105 ← 169–173، 114 ← 182–186، 117–119 ← 189–203 … (١٦ موضعاً) |
| `phase1-backend/tests/phone-normalisation.unit.mjs` | عُدّل | 59 | 16 | 31–32 ← 31–40، 44–45 ← 52–61، 55 ← 71–75، 63–69 ← 83–99، 71 ← 101–102، 80–81 ← 111–120، 89 ← 128–132 |
| `phase1-backend/tests/plans-management.integration.mjs` | عُدّل | 329 | 65 | 19 ← 19–20، 38–39 ← 39–46، 52 ← 59–61، 61 ← 70–73، 64 ← 76–80، 68 ← 84–86، 74 ← 92–99، 76 ← 101–104، 80 ← 108–119، 82 ← 121–132، 88–90 ← 138–151، 93–94 ← 154–172 … (٥١ موضعاً) |
| `phase1-backend/tests/platform-health.integration.mjs` | عُدّل | 101 | 18 | 23 ← 23–25، 40–41 ← 42–51، 43 ← 53–60، 55 ← 72–80، 62 ← 87–91، 69–70 ← 98–107، 73 ← 110–112، 82–83 ← 121–129، 88 ← 134–137، 91 ← 140–144، 95 ← 148–152، 100 ← 157–172 … (١٤ موضعاً) |
| `phase1-backend/tests/platform-nav.guard.mjs` | عُدّل | 68 | 26 | 56–57 ← 56–59، 62 ← 64–67، 69–70 ← 74–77، 86 ← 93، 91 ← 98–101، 99 ← 109–113، 105 ← 119، 113–115 ← 127–138، 118 ← 141–145، 120 ← 147–151، 125 ← 156–160، 127–137 ← 162–179 |
| `phase1-backend/tests/pos-offline.browser-acceptance.mjs` | عُدّل | 247 | 65 | 59 ← 59–66، 67 ← 74–76، 71 ← 80–83، 79 ← 91–94، 89 ← 104–105، 115 ← 131–133، 118 ← 136–140، 143–152 ← 165–179، 157 ← 184–186، 160–169 ← 189–204، 175 ← 210–212، 183 ← 220–227 … (٣٦ موضعاً) |
| `phase1-backend/tests/pos-race.integration.mjs` | عُدّل | 113 | 26 | 27 ← 27–28، 63 ← 64–70، 65 ← 72–79، 67–71 ← 81–103، 74 ← 106–108، 84 ← 118–119، 86 ← 121–122، 89 ← 125–129، 94 ← 134–138، 100 ← 144–149، 102–106 ← 151–172، 113 ← 179–180 … (١٥ موضعاً) |
| `phase1-backend/tests/pos.browser-acceptance.mjs` | عُدّل | 353 | 105 | 45 ← 45–52، 51 ← 58–60، 56 ← 65–68، 63 ← 75–78، 87 ← 102–104، 90 ← 107–111، 97 ← 118–120، 105 ← 128–135، 107 ← 137–140، 109 ← 142–153، 120–123 ← 164–191، 143–144 ← 211–218 … (٤١ موضعاً) |
| `phase1-backend/tests/pos.integration.mjs` | عُدّل | 776 | 153 | 57 ← 57–58، 96 ← 97–103، 98–99 ← 105–119، 101 ← 121–128، 103–104 ← 130–141، 106–108 ← 143–158، 113 ← 163–167، 116 ← 170–174، 134 ← 192–196، 136 ← 198–202، 139 ← 205–208، 142 ← 211–216 … (٨٦ موضعاً) |
| `phase1-backend/tests/pr1.browser-acceptance.mjs` | عُدّل | 94 | 27 | 73 ← 73–75، 77 ← 79–82، 84 ← 89–92، 114 ← 122–124، 131–132 ← 141–146، 135 ← 149–153، 141 ← 159–161، 147 ← 167–173، 149 ← 175–182، 183 ← 216–220، 193 ← 230–234، 198 ← 239–241 … (١٧ موضعاً) |
| `phase1-backend/tests/pr1.password-recovery.integration.mjs` | عُدّل | 604 | 131 | 40 ← 40–41، 42 ← 43–44، 114 ← 116–119، 117–118 ← 122–128، 159 ← 169–175، 165 ← 181–185، 180 ← 200–203، 182 ← 205–209، 184 ← 211–215، 186 ← 217–220، 188–191 ← 222–240، 198 ← 247–251 … (٧٧ موضعاً) |
| `phase1-backend/tests/product-image-storage.secret.test.ts` | عُدّل | 25 | 4 | 1 ← 1–6، 18 ← 23–28، 21–22 ← 31–43 |
| `phase1-backend/tests/ps1.browser-acceptance.mjs` | عُدّل | 95 | 25 | 39 ← 39–46، 45 ← 52–54، 49 ← 58–61، 56 ← 68–71، 66–68 ← 81، 77 ← 90–92، 80 ← 95–99، 92 ← 111–113، 99 ← 120–127، 123 ← 151–153، 142 ← 172–174، 146 ← 178–180 … (١٩ موضعاً) |
| `phase1-backend/tests/ps1.platform-staff.integration.mjs` | عُدّل | 1005 | 171 | 26 ← 26–27، 37 ← 38–43، 44–45 ← 50–56، 50 ← 61، 84 ← 95–98، 90 ← 104–106، 98 ← 114–117، 101 ← 120–123، 106–110 ← 128–147، 121 ← 158–167، 127 ← 173–177، 129 ← 179–188 … (١٢٠ موضعاً) |
| `phase1-backend/tests/public-bytes-cache.guard.mjs` | عُدّل | 27 | 13 | 95 ← 95–97، 111 ← 113–115، 116 ← 120–122، 120 ← 126–128، 124–132 ← 132–146 |
| `phase1-backend/tests/public-rails.integration.mjs` | عُدّل | 185 | 37 | 37 ← 37–41، 43 ← 47–53، 45 ← 55–62، 49–50 ← 66–71، 52–53 ← 73–86، 61–62 ← 94–111، 70–72 ← 119–138، 77–80 ← 143–152، 83 ← 155–157، 88–89 ← 162–166، 94–98 ← 171–197، 104 ← 203–207 … (٢١ موضعاً) |
| `phase1-backend/tests/rate-limit-key.integration.mjs` | عُدّل | 78 | 18 | 67 ← 67–71، 73 ← 77–83، 75 ← 85–92، 91 ← 108–111، 93–94 ← 113–121، 99–100 ← 126–139، 112 ← 151–154، 114 ← 156–160، 133 ← 179–182، 136 ← 185–188، 152–153 ← 204–211، 164 ← 222 … (١٤ موضعاً) |
| `phase1-backend/tests/ready-endpoint.integration.mjs` | عُدّل | 37 | 9 | 44 ← 44–50، 68 ← 74–77، 71 ← 80–84، 74 ← 87–90، 98–100 ← 114–124، 121 ← 145–148، 124 ← 151–152 |
| `phase1-backend/tests/rehearsal.e2e.mjs` | عُدّل | 92 | 44 | 47 ← 47–49، 53 ← 55، 60 ← 62–64، 95 ← 99–105، 109–110 ← 119–126، 128 ← 144–146، 139 ← 157–160، 146–159 ← 167–184، 171 ← 196، 235 ← 260–262، 265 ← 292–295، 272–277 ← 302–311 … (١٥ موضعاً) |
| `phase1-backend/tests/restore-args.unit.mjs` | عُدّل | 58 | 17 | 44 ← 44–48، 47 ← 51–54، 50–52 ← 57–71، 54 ← 73–77، 57–58 ← 80–92، 60–68 ← 94–109 |
| `phase1-backend/tests/retention.integration.mjs` | عُدّل | 542 | 113 | 46 ← 46–47، 54 ← 55–57، 56–57 ← 59–63، 70 ← 76–80، 86 ← 96، 90 ← 100–106، 93 ← 109–120، 95–96 ← 122–127، 101–102 ← 132–140، 116–117 ← 154–162، 129 ← 174–177، 134–135 ← 182–191 … (٦٨ موضعاً) |
| `phase1-backend/tests/review-fixes.integration.mjs` | عُدّل | 339 | 66 | 30 ← 30–32، 45 ← 47–51، 50 ← 56–60، 57 ← 67–73، 60 ← 76–83، 64–70 ← 87–103، 72–73 ← 105–111، 77 ← 115–124، 80 ← 127–131، 82 ← 133–142، 84–85 ← 144–153، 87 ← 155–157 … (٣٦ موضعاً) |
| `phase1-backend/tests/ri1.return-inspection.integration.mjs` | عُدّل | 383 | 76 | 36 ← 36–37، 56 ← 57–61، 66 ← 71–73، 69–75 ← 76–119، 80 ← 124–134، 84 ← 138–148، 90 ← 154–157، 93 ← 160–171، 98 ← 176–180، 102 ← 184–185، 113 ← 196–200، 118–120 ← 205–215 … (٤٨ موضعاً) |
| `phase1-backend/tests/schema-fields-sent.guard.mjs` | عُدّل | 15 | 9 | 81 ← 81، 84–91 ← 84–97 |
| `phase1-backend/tests/search-mirror.guard.mjs` | عُدّل | 120 | 28 | 36–37 ← 36–41، 41 ← 45–50، 179 ← 188–191، 188 ← 200، 202 ← 214، 207–208 ← 219–227، 214 ← 233–236، 218 ← 240–244، 220–225 ← 246–275، 228 ← 278–282، 230–232 ← 284–298، 235–237 ← 301–315 … (١٦ موضعاً) |
| `phase1-backend/tests/security-headers.guard.mjs` | عُدّل | 313 | 76 | 30 ← 30–31، 60 ← 61–65، 75 ← 80–84، 79 ← 88–92، 82 ← 95–99، 84 ← 101–105، 93 ← 114–117، 96 ← 120–124، 98 ← 126–129، 102–103 ← 133–140، 106–110 ← 143–167، 113–114 ← 170–177 … (٥١ موضعاً) |
| `phase1-backend/tests/security-pass.acceptance.mjs` | عُدّل | 385 | 67 | 37 ← 37–41، 42 ← 46–56، 48 ← 62–66، 52 ← 70–73، 57 ← 78–83، 64–65 ← 90–97، 69 ← 101–106، 82–86 ← 119–171، 88–93 ← 173–187، 98 ← 192–205، 101 ← 208–211، 120–122 ← 230–245 … (٣٦ موضعاً) |
| `phase1-backend/tests/sentry-scrub.unit.mjs` | عُدّل | 86 | 18 | 26 ← 26–30، 43 ← 47–53، 47–48 ← 57–66، 51 ← 69–74، 59 ← 82–85، 69–73 ← 95–119، 78–79 ← 124–133، 82 ← 136–137، 91 ← 146–150، 94 ← 153–156، 101–102 ← 163–170 |
| `phase1-backend/tests/serializable-retry.unit.mjs` | عُدّل | 108 | 28 | 15–16 ← 15–20، 19 ← 23–27، 25 ← 33–37، 27–28 ← 39–48، 30 ← 50–54، 33 ← 57–61، 35 ← 63–67، 37 ← 69–70، 44 ← 77–81، 46 ← 83–92، 48–49 ← —، 53–54 ← 97–102 … (٢٢ موضعاً) |
| `phase1-backend/tests/store-banners.integration.mjs` | عُدّل | 232 | 47 | 39 ← 39–44، 42–43 ← 47–52، 57 ← 66–69، 62 ← 74–79، 67 ← 84–88، 78 ← 99–101، 82 ← 105–109، 88 ← 115–121، 90 ← 123–130، 93–94 ← 133–147، 100 ← 153–157، 106–107 ← 163–172 … (٣٥ موضعاً) |
| `phase1-backend/tests/storefront-config.guard.mjs` | عُدّل | 61 | 17 | 46 ← 46–48، 49 ← 51–54، 51 ← 56–59، 54–55 ← 62–71، 60–61 ← 76–83، 64 ← 86–89، 67–68 ← 92–96، 70–71 ← 98–104، 77–81 ← 110–125 |
| `phase1-backend/tests/storefront-config.integration.mjs` | عُدّل | 459 | 85 | 39 ← 39–44، 42–43 ← 47–52، 59 ← 68–71، 64 ← 76–81، 69 ← 86–90، 76 ← 97–101، 79 ← 104–108، 85 ← 114–120، 87 ← 122–129، 89–90 ← 131–145، 101–103 ← 156–168، 106–107 ← 171–181 … (٤٥ موضعاً) |
| `phase1-backend/tests/storefront-routes.guard.mjs` | عُدّل | 32 | 10 | 37 ← 37–42، 48 ← 53–56، 55 ← 63–64، 67 ← 76، 70 ← 79–82، 72–76 ← 84–98 |
| `phase1-backend/tests/surface.guard.mjs` | عُدّل | 130 | 47 | 96 ← 96–97، 99–111 ← 100–125، 126 ← 140–144، 133 ← 151–156، 148 ← 171–176، 153 ← 181–185، 161 ← 193–195، 165 ← 199–200، 180 ← 215–219، 197 ← 236–239، 203 ← 245–246، 208 ← 251–255 … (٢٣ موضعاً) |
| `phase1-backend/tests/sw-precache.guard.mjs` | عُدّل | 50 | 14 | 38 ← 38–40، 50 ← 52–54، 63 ← 67–69، 70–71 ← 76–80، 106 ← 115–117، 114–116 ← 125–135، 121 ← 140–143، 123 ← 145–146، 125 ← 148–150، 132 ← 157–158، 140 ← 166–176 |
| `phase1-backend/tests/template-residue.guard.mjs` | عُدّل | 50 | 17 | 43 ← 43–49، 46 ← 52–60، 58 ← 72–75، 78 ← 95–98، 80 ← 100–104، 93 ← 117، 99 ← 123–126، 101–110 ← 128–143 |
| `phase1-backend/tests/theme-tokens.guard.mjs` | عُدّل | 23 | 10 | 38 ← 38–40، 63 ← 65–66، 68–71 ← 71–76، 73 ← 78–80، 75 ← 82–84، 92–93 ← 101–106 |
| `phase1-backend/tests/totp-qr.unit.mjs` | عُدّل | 17 | 6 | 37 ← 37–39، 51 ← 53–56، 59 ← 64، 63 ← 68، 67 ← 72، 70 ← 75–81 |
| `phase1-backend/tests/totp-rfc-check.mjs` | عُدّل | 11 | 8 | 8–12 ← 8–12، 23 ← 23، 30 ← 30، 32 ← 32–35 |
| `phase1-backend/tests/trial-expiry.integration.mjs` | عُدّل | 126 | 32 | 36 ← 36–37، 45–46 ← 46–56، 77 ← 87–93، 91–93 ← 107–120، 106–108 ← 133–145، 131–133 ← 168–180، 137–139 ← 184–200، 177 ← 238–242، 184–185 ← 249–258، 196–197 ← 269–277، 201 ← 281–284، 209 ← 292–294 … (١٥ موضعاً) |
| `phase1-backend/tests/ui-conventions.guard.mjs` | عُدّل | 16 | 8 | 42–46 ← 42–48، 55–56 ← 57–58، 60 ← 62–68 |
| `phase1-backend/tests/upload-limits.guard.mjs` | عُدّل | 59 | 14 | 28 ← 28–29، 60–61 ← 61–68، 65–66 ← 72–80، 76 ← 90–94، 87 ← 105–108، 112–114 ← 133–145، 119–122 ← 150–167 |
| `phase1-backend/tests/validation-adoption.guard.mjs` | عُدّل | 15 | 7 | 24 ← 24–26، 58 ← 60، 80–82 ← 82–86، 84 ← 88–90، 100 ← 106–108 |
| `phase1-backend/tests/wa1.whatsapp-manual.integration.mjs` | عُدّل | 272 | 55 | 38 ← 38–39، 59 ← 60–64، 69 ← 74–76، 72–73 ← 79–86، 76–78 ← 89–104، 81–84 ← 107–136، 93–96 ← 145–157، 104 ← 165–174، 106 ← 176–181، 108 ← 183–188، 110 ← 190–193، 112 ← 195–200 … (٤٠ موضعاً) |
| `phase1-backend/tests/worker-scheduling.unit.mjs` | عُدّل | 125 | 28 | 51–54 ← 51–69، 59 ← 74–78، 63 ← 82–86، 77–81 ← 100–126، 83 ← 128–132، 94–97 ← 143–158، 130 ← 191–195، 139 ← 204–207، 149 ← 217–220، 151–152 ← 222–229، 164 ← 241–244، 168 ← 248–251 … (١٦ موضعاً) |
| `phase1-backend/tests/worker-timers.guard.mjs` | عُدّل | 22 | 11 | 66–67 ← 66–72، 83–91 ← 88–102 |
| `scripts/generate-sw-manifest.mjs` | عُدّل | 28 | 9 | 35 ← 35–37، 38 ← 40–42، 44–46 ← 48–58، 73 ← 85–87، 87 ← 101–102، 94 ← 109–111، 112 ← 129–131 |
| `scripts/rebrand.mjs` | عُدّل | 10 | 5 | 30 ← 30–32، 65–66 ← 67–68، 73–74 ← 75–79 |
| `server/graceful-shutdown.ts` | عُدّل | 5 | 2 | 68 ← 68، 89 ← 89–92 |
| `server/index.ts` | عُدّل | 84 | 23 | 2 ← 2–8، 17 ← 23–26، 58 ← 67–70، 62 ← 74–76، 72 ← 86–91، 77 ← 96–104، 82 ← —، 89 ← 115–116، 163 ← 190–194، 181–185 ← 212–221، 195 ← 231–233، 199 ← 237–241 … (١٩ موضعاً) |
| `shared/search/arabic-normalize.ts` | عُدّل | 46 | 17 | 61 ← 61، 78 ← 78–84، 80–81 ← 86–92، 83–84 ← 94–113، 88–94 ← 117–119، 129 ← 154، 133 ← 158–160، 137–138 ← 164–167 |
| `tools/code-shape.mjs` | عُدّل | 4 | 4 | 48–49 ← 48–49، 60 ← 60، 82 ← 82 |
| `tools/duplicate-baseline.json` | عُدّل | 226 | 109 | 4–6 ← 4–6، 9 ← 9، 11–14 ← 11–24، 16–24 ← 26–72، 26–34 ← 74–104، 36–37 ← 106–110، 39–41 ← 112–124، — ← 126، 44 ← 128–143، 46–50 ← 145–154، 53–90 ← 157–200، 93–95 ← 203–206 … (٢٠ موضعاً) |
| `tools/duplicate-code.mjs` | عُدّل | 9 | 9 | 48 ← 48، 53 ← 53، 85 ← 85، 135 ← 135، 137 ← 137، 142 ← 142، 147–148 ← 147–148، 157 ← 157 |
| `tools/lint-ratchet.mjs` | عُدّل | 40 | 10 | 17–18 ← 17–24، 26 ← 32–35، 32 ← 41–44، 38–39 ← 50–55، 41–43 ← 57–66، 45 ← 68–75 |
| `tools/review-report.mjs` | عُدّل | 10 | 13 | 23 ← 23، 45 ← 45، 59 ← 59، 73–77 ← 73–74، 83 ← 80، 91–92 ← 88–89، 125 ← 122، 134 ← 131 |
| `tools/shape-baseline.json` | عُدّل | 609 | 1039 | 9–11 ← 9–11، 15–16 ← 15–16، 25–29 ← —، 31–32 ← 26–27، 39–43 ← —، 45 ← 35، 50 ← 40، 55–60 ← 45، 62 ← 47، 65 ← 50، 70 ← 55، 75–76 ← 60–61 … (٤٦٢ موضعاً) |
| `tools/unused-code.mjs` | عُدّل | 16 | 16 | 48 ← 48، 52 ← 52، 65–66 ← 65–66، 68 ← 68، 80 ← 80، 103 ← 103، 122 ← 122، 183 ← 183، 191 ← 191، 221 ← 221، 260 ← 260، 283 ← 283 … (١٣ موضعاً) |
| `vite.config.ts` | عُدّل | 33 | 33 | 43–48 ← 43–49، 50–75 ← 51–76، 77 ← — |

**إثبات أنّ المنطق لم يتغيّر:** شجرة الصياغة متطابقة قبل وبعد في ٧٢٥ من ٧٢٥ ملفّاً.

هذا الكومِت غيّر ١٤٦٬٦١٣ سطراً — كلّ سطر منها: `git show 8b0956f`.

## b037750 — Review report tool: the syntax-tree proof only for commits that format

التاريخ: 2026-11-21

> A commit that changes code on purpose is expected to change its syntax tree;
> printing «0 of 1 the same» for it said nothing and read like a failure.

| الملفّ | التغيير | أُضيف | حُذف | الأسطر (قبل ← بعد) |
|---|---|---|---|---|
| `tools/review-report.mjs` | عُدّل | 7 | 4 | 14–16 ← 14–16، — ← 76–78، 111 ← 114 |

**إثبات أنّ المنطق لم يتغيّر:** شجرة الصياغة متطابقة قبل وبعد في ٠ من ١ ملفّاً.

ملفّات تختلف شجرتها (تُراجع واحداً واحداً):
- `tools/review-report.mjs`

<details><summary>كلّ سطر تغيّر (قبل/بعد)</summary>

```diff
diff --git a/tools/review-report.mjs b/tools/review-report.mjs
index 8dfa1e2..6586f58 100644
--- a/tools/review-report.mjs
+++ b/tools/review-report.mjs
@@ -13,5 +13,5 @@
  * before and after. A bigger one (a formatting pass) is summarised per file,
- * and `--ast-proof` adds, per changed TypeScript/JavaScript file, the proof that
- * its syntax tree is the same before and after (see tools/ast-same.mjs) —
- * which is what «no behaviour changed» means for a formatting commit.
+ * and `--ast-proof` adds, for every commit whose title says it formats, per changed
+ * TypeScript/JavaScript file, the proof that its syntax tree is the same before and
+ * after (see tools/ast-same.mjs) — which is what «no behaviour changed» means there.
  */
@@ -75,2 +75,5 @@ for (const hash of commits) {
   const proofs = [];
+  // The proof is for FORMATTING commits only: a commit that changes code on purpose is
+  // expected to change its syntax tree, so «0 of 1 the same» there would say nothing.
+  const proveThis = astProof && /\bformat/i.test(subject);
   for (const row of status) {
@@ -110,3 +113,3 @@ for (const hash of commits) {
     );
-    if (astProof && code[0] === "M" && /\.(ts|tsx|mjs|js)$/.test(path)) {
+    if (proveThis && code[0] === "M" && /\.(ts|tsx|mjs|js)$/.test(path)) {
       const before = show(`${hash}^`, path);
```

</details>

## a00e908 — Review batch 1 report: every commit, file and changed line range, with the per-file proof

التاريخ: 2026-11-21

> docs/review/batch-01-formatting.md: the four commits of batch 1, the five
> moved ESLint directives by file and line, the guard defects found (the clock
> guard counted lines, not dates), the numbers before and after, and the
> syntax-tree proof — 725 of 725 files unchanged in logic. The full CI result
> is added when the local run finishes.

| الملفّ | التغيير | أُضيف | حُذف | الأسطر (قبل ← بعد) |
|---|---|---|---|---|
| `docs/review/README.md` | عُدّل | 1 | 0 | — ← 10 |
| `docs/review/batch-01-formatting.md` | أُضيف | 1143 | 0 | — ← 1–1143 |

هذا الكومِت غيّر ١٬١٤٤ سطراً — كلّ سطر منها: `git show a00e908`.

## dfb90bd — Review batch 1 (tests): the ق-196 check reads a rate-limit call however its arguments wrap

التاريخ: 2026-11-21

> rate-limit-key.integration.mjs read `limitStorefrontWriteWithAddressCeiling(request, "cart_write"`
> as one line; formatted, the arguments are on their own lines, so the check
> failed. Worse, its twin — the check that the PLAIN limiter is NOT used on
> these scopes — would have passed silently, blind rather than satisfied. Both
> patterns now allow whitespace and line breaks between the arguments.
> Searched the other source-reading checks for the same assumption: those that
> assert an absence match a single token (settings.pass, main().catch), which
> wrapping cannot hide.

| الملفّ | التغيير | أُضيف | حُذف | الأسطر (قبل ← بعد) |
|---|---|---|---|---|
| `phase1-backend/tests/rate-limit-key.integration.mjs` | عُدّل | 2 | 2 | 222 ← 222، 232 ← 232 |

<details><summary>كلّ سطر تغيّر (قبل/بعد)</summary>

```diff
diff --git a/phase1-backend/tests/rate-limit-key.integration.mjs b/phase1-backend/tests/rate-limit-key.integration.mjs
index b763438..c8fcd24 100644
--- a/phase1-backend/tests/rate-limit-key.integration.mjs
+++ b/phase1-backend/tests/rate-limit-key.integration.mjs
@@ -221,3 +221,3 @@ try {
   const unguarded = mustCarryCeiling.filter(({ file, scope }) =>
-    new RegExp(`limitStorefrontWrite\\(request, "${scope}"`).test(routeSources[file])
+    new RegExp(`limitStorefrontWrite\\(\\s*request,\\s*"${scope}"`).test(routeSources[file])
   );
@@ -231,3 +231,3 @@ try {
     assert.ok(
-      new RegExp(`limitStorefrontWriteWithAddressCeiling\\(request, "${scope}"`).test(
+      new RegExp(`limitStorefrontWriteWithAddressCeiling\\(\\s*request,\\s*"${scope}"`).test(
         routeSources[file]
```

</details>

