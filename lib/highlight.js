// CotEditor-style line painter. The marked region is copied verbatim into
// lib/client.js (the browser bundle cannot import this module). test/highlight.test.js
// asserts the two copies stay the same.

/* @highlight-start */
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (ch) => (ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;"));
}

function wordSet(text) {
  return new Set(text.split(" "));
}

const JS_KW = wordSet("async await break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while with yield");
const PY_KW = wordSet("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield");
const GO_KW = wordSet("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var");
const JAVA_KW = wordSet("abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while");
const C_KW = wordSet("auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while");
const RS_KW = wordSet("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while");
const SH_KW = wordSet("if then else elif fi for while do done case esac function in");
const SQL_KW = wordSet("select from where and or insert into values update set delete create table drop alter join left right inner outer on group by order limit offset as null not is in like between distinct union all having primary key");
const JSON_KW = wordSet("true false null");

const SPECS = {
  js: { line: "//", block: ["/*", "*/"], quotes: ["'", "\"", "`"], keywords: JS_KW },
  c: { line: "//", block: ["/*", "*/"], quotes: ["'", "\""], keywords: C_KW },
  java: { line: "//", block: ["/*", "*/"], quotes: ["\""], keywords: JAVA_KW },
  go: { line: "//", block: ["/*", "*/"], quotes: ["\"", "`"], keywords: GO_KW },
  rs: { line: "//", block: ["/*", "*/"], quotes: ["\""], keywords: RS_KW },
  py: { line: "#", quotes: ["'", "\""], keywords: PY_KW, triples: true },
  sh: { line: "#", quotes: ["'", "\""], keywords: SH_KW },
  yml: { line: "#", quotes: ["'", "\""], keywords: null },
  css: { block: ["/*", "*/"], quotes: ["'", "\""], keywords: null },
  sql: { line: "--", block: ["/*", "*/"], quotes: ["'"], keywords: SQL_KW },
  json: { quotes: ["\""], keywords: JSON_KW },
  html: { kind: "html" },
  md: { kind: "md" },
  plain: { kind: "plain" }
};

const EXT = {
  js: ["js", "JavaScript"], jsx: ["js", "JSX"], mjs: ["js", "JavaScript"], cjs: ["js", "JavaScript"],
  ts: ["js", "TypeScript"], tsx: ["js", "TSX"], mts: ["js", "TypeScript"], cts: ["js", "TypeScript"],
  json: ["json", "JSON"], md: ["md", "Markdown"], markdown: ["md", "Markdown"],
  py: ["py", "Python"], go: ["go", "Go"], rs: ["rs", "Rust"],
  java: ["java", "Java"], kt: ["java", "Kotlin"], kts: ["java", "Kotlin"],
  c: ["c", "C"], h: ["c", "C"], cc: ["c", "C++"], cpp: ["c", "C++"], hpp: ["c", "C++"],
  cs: ["c", "C#"], swift: ["c", "Swift"],
  css: ["css", "CSS"], scss: ["css", "SCSS"],
  html: ["html", "HTML"], htm: ["html", "HTML"], xml: ["html", "XML"], svg: ["html", "SVG"],
  sql: ["sql", "SQL"], sh: ["sh", "Shell"], bash: ["sh", "Shell"], zsh: ["sh", "Shell"],
  yml: ["yml", "YAML"], yaml: ["yml", "YAML"], toml: ["yml", "TOML"], rb: ["py", "Ruby"]
};

function languageOf(name) {
  const base = String(name || "").toLowerCase();
  const dot = base.lastIndexOf(".");
  const ext = dot < 0 ? "" : base.slice(dot + 1);
  const hit = EXT[ext];
  if (hit) return { id: hit[0], label: hit[1] };
  return { id: "plain", label: "Plain Text" };
}

function span(cls, text) {
  const esc = escapeHtml(text);
  if (!cls || text === "") return esc;
  return '<span class="' + cls + '">' + esc + "</span>";
}

function scanString(line, from, quote) {
  let i = from;
  while (i < line.length) {
    if (line.startsWith(quote, i)) {
      if (countSlash(line, i) % 2 === 1) { i += 1; continue; }
      return i + quote.length;
    }
    i += 1;
  }
  return -1;
}

function paintLine(line, spec, state, quote) {
  let i = 0;
  let html = "";
  let at = 0;
  const flush = (cls, to) => { html += span(cls, line.slice(at, to)); at = to; };
  if (state === "block") {
    const end = spec.block ? line.indexOf(spec.block[1]) : -1;
    if (end < 0) return { html: span("dce-c", line), state: "block", quote: "" };
    flush("dce-c", end + spec.block[1].length);
    i = at;
    state = "code";
  } else if (state === "str") {
    const closed = scanString(line, 0, quote);
    if (closed < 0) return { html: span("dce-s", line), state: "str", quote };
    flush("dce-s", closed);
    i = at;
    state = "code";
    quote = "";
  }
  while (i < line.length) {
    if (spec.line && line.startsWith(spec.line, i)) {
      flush(null, i);
      flush("dce-c", line.length);
      return { html, state: "code", quote: "" };
    }
    if (spec.block && line.startsWith(spec.block[0], i)) {
      flush(null, i);
      const end = line.indexOf(spec.block[1], i + spec.block[0].length);
      if (end < 0) {
        flush("dce-c", line.length);
        return { html, state: "block", quote: "" };
      }
      flush("dce-c", end + spec.block[1].length);
      i = at;
      continue;
    }
    const q = quoteAt(line, i, spec);
    if (q !== "") {
      flush(null, i);
      const closed = scanString(line, i + q.length, q);
      if (closed < 0) {
        flush("dce-s", line.length);
        return { html, state: "str", quote: q };
      }
      flush("dce-s", closed);
      i = at;
      continue;
    }
    const ch = line[i];
    if ((ch >= "0" && ch <= "9") || (ch === "." && line[i + 1] >= "0" && line[i + 1] <= "9")) {
      let j = i + 1;
      // Hex letters continue a number only behind a 0x prefix; without that
      // gate "1abc" paints as one number.
      let digits = /[0-9._]/;
      if (ch === "0") {
        const mark = line[j];
        if (mark === "x" || mark === "X") { digits = /[0-9a-fA-F._]/; j += 1; }
        else if (mark === "b" || mark === "B" || mark === "o" || mark === "O") j += 1;
      }
      while (j < line.length && digits.test(line[j])) j += 1;
      flush(null, i);
      flush("dce-n", j);
      i = at;
      continue;
    }
    if (isWord(ch)) {
      let j = i + 1;
      while (j < line.length && isWord(line[j])) j += 1;
      flush(null, i);
      flush(spec.keywords && spec.keywords.has(line.slice(i, j)) ? "dce-k" : null, j);
      i = at;
      continue;
    }
    i += 1;
  }
  flush(null, line.length);
  return { html, state: "code", quote: "" };
}

function countSlash(line, i) {
  let n = 0;
  let k = i - 1;
  while (k >= 0 && line[k] === "\\") { n += 1; k -= 1; }
  return n;
}

function quoteAt(line, i, spec) {
  if (!spec.quotes) return "";
  if (spec.triples) {
    if (line.startsWith('"""', i)) return '"""';
    if (line.startsWith("'''", i)) return "'''";
  }
  const ch = line[i];
  if (spec.quotes.indexOf(ch) < 0) return "";
  if (countSlash(line, i) % 2 === 1) return "";
  return ch;
}

function isWord(ch) {
  return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_" || ch === "$";
}

function paintHtml(text) {
  const lines = String(text).split("\n");
  let comment = false;
  const out = [];
  for (let n = 0; n < lines.length; n++) {
    let line = lines[n];
    let html = "";
    if (comment) {
      const end = line.indexOf("-->");
      if (end < 0) { out.push(span("dce-c", line)); continue; }
      html += span("dce-c", line.slice(0, end + 3));
      line = line.slice(end + 3);
      comment = false;
    }
    let i = 0;
    while (i < line.length) {
      const open = line.indexOf("<!--", i);
      const tag = line.indexOf("<", i);
      if (open >= 0 && (tag < 0 || open <= tag)) {
        html += escapeHtml(line.slice(i, open));
        const end = line.indexOf("-->", open + 4);
        if (end < 0) { html += span("dce-c", line.slice(open)); comment = true; i = line.length; break; }
        html += span("dce-c", line.slice(open, end + 3));
        i = end + 3;
        continue;
      }
      if (tag < 0) { html += escapeHtml(line.slice(i)); break; }
      html += escapeHtml(line.slice(i, tag));
      const close = line.indexOf(">", tag + 1);
      if (close < 0) { html += span("dce-f", line.slice(tag)); i = line.length; break; }
      html += span("dce-f", line.slice(tag, close + 1));
      i = close + 1;
    }
    out.push(html);
  }
  return { html: out.join("\n"), cache: null };
}

function paintMd(text) {
  const lines = String(text).split("\n");
  let fence = false;
  const out = lines.map((line) => {
    if (line.startsWith("```")) { fence = !fence; return span("dce-c", line); }
    if (fence) return span("dce-s", line);
    if (/^#{1,6}( |$)/.test(line)) return span("dce-k", line);
    return escapeHtml(line);
  });
  return { html: out.join("\n"), cache: null };
}

function paintDocument(text, lang, cache) {
  const spec = SPECS[lang] || SPECS.plain;
  if (spec.kind === "plain") return { html: escapeHtml(text), cache: null };
  if (spec.kind === "html") return paintHtml(text);
  if (spec.kind === "md") return paintMd(text);
  const lines = String(text).split("\n");
  const reuse = cache && cache.lang === lang ? cache.lines : null;
  const next = new Array(lines.length);
  const parts = new Array(lines.length);
  let state = "code";
  let quote = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = reuse ? reuse[i] : undefined;
    if (prev && prev.line === line && prev.stateIn === state && prev.quoteIn === quote) next[i] = prev;
    else {
      const painted = paintLine(line, spec, state, quote);
      next[i] = { line, html: painted.html, stateIn: state, quoteIn: quote, stateOut: painted.state, quoteOut: painted.quote };
    }
    state = next[i].stateOut;
    quote = next[i].quoteOut;
    parts[i] = next[i].html;
  }
  return { html: parts.join("\n"), cache: { lang, lines: next } };
}

/*
 * Markdown preview. Rendering is local on purpose: no dependency, no sanitizer
 * pass, no raw HTML. Every tag below is one this file writes, and all document
 * text goes through escapeHtml first, so a .md file cannot inject markup —
 * HTML written in the source shows up as text.
 */
const MD_FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`~]*)/;
const MD_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const MD_SAFE_URL = /^(?:https?:\/\/|mailto:)/i;

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === "\"" ? "&quot;" : "&#39;");
}

function mdIndent(line) {
  let n = 0;
  while (n < line.length) {
    const ch = line.charAt(n);
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 2;
    else break;
  }
  return n;
}

function mdEmphasis(raw) {
  let s = escapeHtml(raw);
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>");
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1<em>$2</em>");
  return s;
}

/** One line (or one table cell) of inline markup. */
function mdInline(raw) {
  const s = String(raw);
  const out = [];
  let buf = "";
  let i = 0;
  const flush = () => { if (buf !== "") { out.push(mdEmphasis(buf)); buf = ""; } };
  while (i < s.length) {
    const ch = s.charAt(i);
    if (ch === "\\" && i + 1 < s.length && "\\`*_{}[]()#+-.!>~|".indexOf(s.charAt(i + 1)) >= 0) {
      buf += s.charAt(i + 1);
      i += 2;
      continue;
    }
    if (ch === "`") {
      let run = 1;
      while (s.charAt(i + run) === "`") run += 1;
      const fence = s.slice(i, i + run);
      const close = s.indexOf(fence, i + run);
      if (close < 0) { buf += fence; i += run; continue; }
      flush();
      out.push('<code class="dce-md-ic">' + escapeHtml(s.slice(i + run, close).replace(/^ (.+) $/, "$1")) + "</code>");
      i = close + run;
      continue;
    }
    if (ch === "!" && s.charAt(i + 1) === "[") {
      const m = /^!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/.exec(s.slice(i));
      if (m !== null) {
        flush();
        // Only remote images load. A workspace-relative path would need the
        // host's file route, so its alt text stands in instead of a broken box.
        if (MD_SAFE_URL.test(m[2])) {
          out.push('<img class="dce-md-img" src="' + escapeAttr(m[2]) + '" alt="' + escapeAttr(m[1]) + '" loading="lazy" referrerpolicy="no-referrer">');
        } else {
          out.push('<span class="dce-md-imgref">' + escapeHtml(m[1] !== "" ? m[1] : m[2]) + "</span>");
        }
        i += m[0].length;
        continue;
      }
    }
    if (ch === "[") {
      const m = /^\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/.exec(s.slice(i));
      if (m !== null) {
        flush();
        if (MD_SAFE_URL.test(m[2])) {
          out.push('<a class="dce-md-a" href="' + escapeAttr(m[2]) + '" target="_blank" rel="noreferrer noopener">' + mdInline(m[1]) + "</a>");
        } else {
          out.push('<span class="dce-md-ref">' + mdInline(m[1]) + "</span>");
        }
        i += m[0].length;
        continue;
      }
    }
    if (ch === "<") {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/.exec(s.slice(i));
      if (m !== null) {
        flush();
        out.push('<a class="dce-md-a" href="' + escapeAttr(m[1]) + '" target="_blank" rel="noreferrer noopener">' + escapeHtml(m[1]) + "</a>");
        i += m[0].length;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
  return out.join("");
}

function mdCells(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let buf = "";
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed.charAt(i);
    if (ch === "\\" && trimmed.charAt(i + 1) === "|") { buf += "|"; i += 1; continue; }
    if (ch === "|") { cells.push(buf.trim()); buf = ""; continue; }
    buf += ch;
  }
  cells.push(buf.trim());
  return cells;
}

function mdTable(lines, start) {
  const rule = lines[start + 1];
  if (rule === undefined || rule.indexOf("|") < 0 || !/^[\s:|-]*-[\s:|-]*$/.test(rule)) return null;
  const head = mdCells(lines[start]);
  const spec = mdCells(rule).map((cell) => {
    const left = cell.charAt(0) === ":";
    const right = cell.charAt(cell.length - 1) === ":";
    return left && right ? "center" : right ? "right" : left ? "left" : "";
  });
  const rows = [];
  let i = start + 2;
  while (i < lines.length && !/^\s*$/.test(lines[i]) && lines[i].indexOf("|") >= 0) {
    rows.push(mdCells(lines[i]));
    i += 1;
  }
  const cell = (tag, text, at) => {
    const align = spec[at] || "";
    return "<" + tag + (align === "" ? "" : ' style="text-align:' + align + '"') + ">" + mdInline(text) + "</" + tag + ">";
  };
  const body = rows.length === 0 ? "" : "<tbody>" + rows.map((row) => "<tr>" + row.map((text, at) => cell("td", text, at)).join("") + "</tr>").join("") + "</tbody>";
  return {
    html: '<table class="dce-md-table"><thead><tr>' + head.map((text, at) => cell("th", text, at)).join("") + "</tr></thead>" + body + "</table>",
    next: i
  };
}

/** A list at `start`, including its indented continuations. */
function mdList(lines, start, copyLabel) {
  const first = MD_ITEM.exec(lines[start]);
  const base = mdIndent(lines[start]);
  const ordered = /^\d/.test(first[2]);
  // A list ends where its marker kind changes: "1." after "- " is a second
  // list, not more of the first one.
  const keeps = (text) => {
    const hit = MD_ITEM.exec(text);
    return hit !== null && /^\d/.test(hit[2]) === ordered;
  };
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      let k = i + 1;
      while (k < lines.length && /^\s*$/.test(lines[k])) k += 1;
      if (k >= lines.length) { i = k; break; }
      if (mdIndent(lines[k]) <= base && keeps(lines[k]) === false) { i = k; break; }
      if (mdIndent(lines[k]) < base) { i = k; break; }
      i = k;
      continue;
    }
    const item = MD_ITEM.exec(line);
    const indent = mdIndent(line);
    if (indent < base) break;
    if (item !== null && indent <= base + 1) {
      if (indent === base && /^\d/.test(item[2]) !== ordered) break;
      items.push({ text: item[3].replace(/\s+$/, ""), rest: [] });
      i += 1;
      continue;
    }
    if (items.length === 0) break;
    // Anything indented past the marker belongs to the item above: a nested
    // list, a fenced block, a table. Dedent by its own margin and let the
    // recursive pass read it as a block of its own.
    const chunk = [];
    while (i < lines.length) {
      const inner = lines[i];
      if (/^\s*$/.test(inner)) {
        const next = lines[i + 1];
        if (next !== undefined && mdIndent(next) > base) { chunk.push(""); i += 1; continue; }
        break;
      }
      if (mdIndent(inner) <= base) break;
      chunk.push(inner);
      i += 1;
    }
    let cut = Infinity;
    chunk.forEach((inner) => { if (!/^\s*$/.test(inner)) cut = Math.min(cut, mdIndent(inner)); });
    // Nothing indented followed, so the list is over; without this the outer
    // loop would retry the same line forever.
    if (chunk.length === 0) break;
    if (!Number.isFinite(cut)) cut = 0;
    const text = chunk.map((inner) => (/^\s*$/.test(inner) ? "" : inner.slice(cut))).join("\n").replace(/^\n+|\n+$/g, "");
    if (text !== "") items[items.length - 1].rest.push(text);
  }
  const body = items.map((item) => {
    let text = item.text;
    let box = "";
    const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
    if (task !== null) {
      box = '<span class="dce-md-check">' + (task[1] === " " ? "☐" : "☑") + "</span>";
      text = task[2];
    }
    return "<li>" + box + mdInline(text) + item.rest.map((rest) => renderMarkdown(rest, copyLabel)).join("") + "</li>";
  }).join("");
  const tag = ordered ? "ol" : "ul";
  return { html: "<" + tag + ' class="dce-md-list">' + body + "</" + tag + ">", next: i };
}

function mdFrontmatter(lines) {
  if (lines.length === 0 || !/^---\s*$/.test(lines[0])) return null;
  let end = -1;
  for (let i = 1; i < lines.length && i <= 200; i += 1) {
    if (/^(---|\.\.\.)\s*$/.test(lines[i])) { end = i; break; }
  }
  if (end < 0) return null;
  const rows = [];
  for (let i = 1; i < end; i += 1) {
    const line = lines[i];
    if (/^\s*$/.test(line)) continue;
    const at = line.indexOf(":");
    if (at <= 0 || /^\s/.test(line)) continue;
    rows.push('<div class="dce-md-fmrow"><span class="dce-md-fmkey">' + escapeHtml(line.slice(0, at).trim()) + '</span><span class="dce-md-fmval">' + escapeHtml(line.slice(at + 1).trim()) + "</span></div>");
  }
  if (rows.length === 0) return { html: "", next: end + 1 };
  return { html: '<div class="dce-md-fm">' + rows.join("") + "</div>", next: end + 1 };
}

/** Markdown source to HTML for the preview pane. */
function renderMarkdown(src, copyLabel) {
  const copyText = typeof copyLabel === "string" && copyLabel !== "" ? copyLabel : "Copy";
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  const fm = mdFrontmatter(lines);
  if (fm !== null) { if (fm.html !== "") out.push(fm.html); i = fm.next; }
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i += 1; continue; }
    const fence = MD_FENCE.exec(line);
    if (fence !== null) {
      const close = new RegExp("^\\s{0,3}" + (fence[1].charAt(0) === "`" ? "`" : "~") + "{3,}\\s*$");
      const body = [];
      i += 1;
      while (i < lines.length && !close.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1;
      // A known fence language gets the same painter as the editor; anything
      // else stays escaped plain text inside the block.
      const name = String(fence[2] || "").toLowerCase();
      const spec = EXT[name];
      const code = spec === undefined
        ? escapeHtml(body.join("\n"))
        : paintDocument(body.join("\n"), spec[0], null).html;
      // The copy button reads the rendered <code> textContent, so the block
      // never carries a second escaped copy of the source. Highlighting only
      // wraps characters in spans, so textContent is the original code.
      out.push('<div class="dce-md-code"><div class="dce-md-codebar">'
        + '<span class="dce-md-codelang">' + escapeHtml(spec === undefined ? name : spec[1]) + "</span>"
        + '<button type="button" class="dce-md-copy">' + escapeHtml(copyText) + "</button>"
        + '</div><pre class="dce-md-pre"><code>' + code + "</code></pre></div>");
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      const level = heading[1].length;
      out.push("<h" + level + ' class="dce-md-h">' + mdInline(heading[2]) + "</h" + level + ">");
      i += 1;
      continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) { out.push('<hr class="dce-md-hr">'); i += 1; continue; }
    if (/^\s{0,3}>/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
        i += 1;
      }
      out.push('<blockquote class="dce-md-quote">' + renderMarkdown(quoted.join("\n"), copyLabel) + "</blockquote>");
      continue;
    }
    const table = mdTable(lines, i);
    if (table !== null) { out.push(table.html); i = table.next; continue; }
    if (MD_ITEM.test(line)) {
      const list = mdList(lines, i, copyLabel);
      out.push(list.html);
      i = list.next;
      continue;
    }
    const para = [];
    while (i < lines.length) {
      const current = lines[i];
      if (/^\s*$/.test(current)) break;
      if (para.length > 0 && (MD_FENCE.test(current) || MD_ITEM.test(current) || /^\s{0,3}(#{1,6})\s+/.test(current) || /^\s{0,3}>/.test(current) || /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(current))) break;
      para.push(current.replace(/^ {0,3}/, "").replace(/\\$/, ""));
      i += 1;
    }
    out.push('<p class="dce-md-p">' + para.map((text) => mdInline(text)).join("<br>") + "</p>");
  }
  return out.join("");
}
/* @highlight-end */

export { languageOf, paintDocument, renderMarkdown };
