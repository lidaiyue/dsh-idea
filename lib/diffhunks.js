// "Jump to the change" geometry for a unified diff.
//
// The marked region is copied verbatim into lib/client.git.js (the browser
// bundle cannot import this module). test/diffhunks.test.js asserts the two
// copies stay the same.

/* @diffjump-start */
const DIFF_HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Where every row of a unified diff sits in the file, so a diff view can answer
 * "which line is the reader looking at".
 *
 * `rows[i]` describes the i-th line of the diff, file headers included: `kind`
 * is the diff marker the row is painted with, `newLine` the 1-based line of the
 * new file the row stands for (0 outside a hunk). A removed row carries the
 * position the following line takes once the change lands, so a jump never
 * overshoots by the length of the deletion.
 *
 * `hunks[j]` names the two edges of one `@@` block: `headerRow` is the `@@`
 * row, `firstRow` / `lastRow` the block it introduces, so a viewport can pick
 * the block it is showing. `changeRow` is the first added row of the block (or
 * the first removed one when the block only deletes) and `changeLine` its
 * new-side line.
 */
function diffGeometry(text) {
  const raw = String(text === undefined || text === null ? "" : text);
  if (raw.trim() === "") return { rows: [], hunks: [] };
  const lines = raw.replace(/\n$/, "").split("\n");
  const rows = [];
  const hunks = [];
  let oldLine = 0;
  let newLine = 0;
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const head = DIFF_HUNK_HEADER.exec(line);
    if (head !== null) {
      oldLine = Number(head[1]);
      newLine = Number(head[3]);
      at = hunks.length;
      hunks.push({
        headerRow: i,
        firstRow: i + 1,
        lastRow: i,
        newStart: newLine,
        addRow: -1,
        addLine: 0,
        delRow: -1,
        delLine: 0,
        changeRow: i,
        changeLine: newLine
      });
      rows.push({ kind: "@", oldLine: 0, newLine: 0 });
      continue;
    }
    if (at < 0) {
      rows.push({ kind: "h", oldLine: 0, newLine: 0 });
      continue;
    }
    const hunk = hunks[at];
    const mark = line.charAt(0);
    if (mark === "\\") {
      // "\ No newline at end of file" belongs to the line before it.
      rows.push({ kind: "\\", oldLine: 0, newLine: 0 });
      continue;
    }
    if (mark === "+") {
      rows.push({ kind: "+", oldLine: 0, newLine });
      if (hunk.addRow < 0) {
        hunk.addRow = i;
        hunk.addLine = newLine;
      }
      newLine += 1;
    } else if (mark === "-") {
      rows.push({ kind: "-", oldLine, newLine });
      if (hunk.delRow < 0) {
        hunk.delRow = i;
        hunk.delLine = newLine;
      }
      oldLine += 1;
    } else {
      rows.push({ kind: " ", oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
    hunk.lastRow = i;
  }
  for (let j = 0; j < hunks.length; j++) {
    const hunk = hunks[j];
    if (hunk.addRow >= 0) {
      hunk.changeRow = hunk.addRow;
      hunk.changeLine = hunk.addLine;
    } else if (hunk.delRow >= 0) {
      hunk.changeRow = hunk.delRow;
      hunk.changeLine = hunk.delLine;
    }
    if (hunk.changeLine < 1) hunk.changeLine = 1;
  }
  return { rows, hunks };
}

/**
 * New-side line of the hunk nearest `row` — a 0-based row of the diff, usually
 * the row at the viewport centre. 0 when the diff carries no hunk at all.
 */
function diffLineAt(hunks, row) {
  const list = Array.isArray(hunks) ? hunks : [];
  if (list.length === 0) return 0;
  const want = Number.isFinite(Number(row)) ? Number(row) : 0;
  let best = list[0];
  let bestGap = Infinity;
  for (let i = 0; i < list.length; i++) {
    const hunk = list[i];
    let gap = 0;
    if (want < hunk.headerRow) gap = hunk.headerRow - want;
    else if (want > hunk.lastRow) gap = want - hunk.lastRow;
    if (gap < bestGap) {
      bestGap = gap;
      best = hunk;
      if (gap === 0) break;
    }
  }
  return best.changeLine;
}
/* @diffjump-end */

export { diffGeometry, diffLineAt };
