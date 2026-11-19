// CodeMirror 6 entry point for the SQL console.
//
// The DSH client module table is a frozen whitelist (react, react-dom, cordis and a
// few DSH UI packages), so CodeMirror cannot be `require`d from the plugin bundle.
// Instead this file is bundled once into `lib/vendor/codemirror.js` and served by the
// plugin's own webServer prefix route; the browser half injects a classic <script>
// for it, then reads the global below.
//
// Only what the console actually needs is pulled in. `@codemirror/search` is
// deliberately absent — its panel would need its own styling to fit the host theme,
// and the browser's own find-in-page still works. Completion IS wired: `sql()`
// registers the dialect's keywords as language data, but that data does nothing
// until `autocompletion()` consumes it.
import { Compartment, EditorSelection, EditorState, Prec } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { MySQL, PLSQL, PostgreSQL, StandardSQL, sql } from "@codemirror/lang-sql";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { tags } from "@lezer/highlight";

// A classic-script global, not an ES module: the browser half loads this with a
// plain <script> tag because its bundle has no module graph to hang an ESM import on.
globalThis.__ddbCodeMirror = {
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  EditorView,
  autocompletion,
  bracketMatching,
  completionKeymap,
  crosshairCursor,
  defaultKeymap,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  history,
  historyKeymap,
  indentOnInput,
  indentUnit,
  indentWithTab,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
  syntaxHighlighting,
  HighlightStyle,
  MySQL,
  PLSQL,
  PostgreSQL,
  StandardSQL,
  sql,
  tags,
};
