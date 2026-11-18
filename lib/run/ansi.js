/** Strip terminal color codes from application output for display and copy. */

/**
 * Remove ANSI/CSI/OSC sequences, and leftover SGR like `[32m` when ESC was
 * lost. Ordinary bracket text such as `[stderr]` or `[foo]` is kept.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text) {
  if (typeof text !== "string" || text === "") return "";
  return text
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u009b[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, "")
    .replace(/\u001b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "")
    .replace(/\[(\d+)(;\d+)*m/g, "");
}

/**
 * Keep the lines that contain `keyword`, compared case-insensitively.
 * An empty keyword returns the text unchanged.
 *
 * @param {string} text
 * @param {string} [keyword]
 * @returns {string}
 */
export function filterLines(text, keyword) {
  if (typeof text !== "string") return "";
  if (keyword === undefined || keyword === null || keyword === "") return text;
  const needle = String(keyword).toLowerCase();
  const lines = text.split("\n");
  const kept = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].toLowerCase().includes(needle)) kept.push(lines[index]);
  }
  return kept.join("\n");
}
