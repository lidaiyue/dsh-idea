/**
 * Large-file editor path: generate disposable JS under a *safe* existing
 * session cwd (Personal/dsh or /tmp — never EPF/MM/BNGS/Luna/etc.), open via
 * __dshEditorPanel.open() then openFile(rel), measure open / first paint /
 * scroll / find / type+undo, then delete the temps.
 *
 * Typing is fully undone. The suite fails if any /write is observed.
 * Opening the right column alone does not mount the editor.
 */

import { writeFileSync, existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { delay } from "../lib/cdp.mjs";
import {
  snapshot,
  mark,
  slice,
  profileAction,
  formatLt,
  openRightColumn,
  openEditor
} from "../lib/page.mjs";

const TMP_DIR_NAME = ".dsh-idea-perf-tmp";
const NEEDLE = "PERF_NEEDLE_7f3a";
const NEEDLE_HITS = 8;
const UNSAFE_RE = /\/(EPF|MM|BNGS|Luna|Clients|Work)\b/i;

export const name = "large-file";
export const description = "Disposable mid / near / over-PAINT_TEXT_MAX files: open, scroll, find, type+undo";

function safeRoots() {
  const home = homedir();
  const extra = (process.env.DSH_IDEA_PERF_SAFE_CWD || "")
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean);
  return [
    join(home, "Documents/Projects/Personal/dsh"),
    "/tmp",
    "/private/tmp",
    ...extra
  ];
}

function isSafeCwd(cwd) {
  if (!cwd) return false;
  const real = cwd.replace(/\/+$/, "");
  if (UNSAFE_RE.test(real) && !/\/Personal\/dsh(?:\/|$)/.test(real)) return false;
  return safeRoots().some((root) => real === root || real.startsWith(root + "/"));
}

function isSafeProjectLabel(label) {
  const s = String(label || "").replace(/\s+/g, " ").trim();
  if (!s) return false;
  if (/\b(EPF|BNGS|Luna|Clients|Work)\b/i.test(s) && !/Personal\/dsh/.test(s)) return false;
  if (s === "dsh" || s === "plugins" || s === "dsh-idea") return true;
  if (/Personal\/dsh/.test(s) || /(^|\/)dsh$/.test(s)) return true;
  if (s === "tmp" || s === "/tmp" || s === "private/tmp" || s === "/private/tmp") return true;
  return false;
}

function filesFor(paintTextMax) {
  return [
    { key: "mid", chars: 50000, name: "perf-mid-50k.js" },
    { key: "near", chars: Math.max(100000, paintTextMax - 20000), name: "perf-near-180k.js" },
    { key: "over", chars: paintTextMax + 50000, name: "perf-over-250k.js" }
  ];
}

function generateJs(chars, tag) {
  const parts = [`// TEMP dsh-idea perf file tag=${tag} SAFE TO DELETE\n`];
  let i = 0;
  while (parts.reduce((n, s) => n + s.length, 0) < chars) {
    const plant = i < NEEDLE_HITS ? `  const ${NEEDLE} = "${NEEDLE}_${i}";\n` : "";
    parts.push(
`export function sample_${tag}_${i}(input = 0) {
  const label = "ITEM_${tag}_${i}";
${plant}  /* token mix for the highlighter */
  if (input > 0 && label.length) {
    return Math.max(input, Number(label.split("_").pop()) || 0);
  }
  return 0;
}
`);
    i += 1;
  }
  let text = parts.join("");
  if (text.length > chars) text = text.slice(0, chars);
  if (text.length < chars) text += "\n" + " ".repeat(chars - text.length - 1);
  if (!text.endsWith("\n")) text += "\n";
  return text.slice(0, chars);
}

function relFor(cwd, absDir, fileName) {
  const root = cwd.replace(/\/+$/, "");
  const abs = join(absDir, fileName);
  if (abs === root || abs.startsWith(root + "/")) return abs.slice(root.length + 1);
  throw new Error("temp file is outside session cwd: " + abs + " cwd=" + cwd);
}

async function listSidebar(page) {
  return page.evaluate(`(() => {
    const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
    const projects = [...document.querySelectorAll(".YDXeBa_projectRow")].map((el, i) => ({
      i,
      label: norm((el.querySelector(".YDXeBa_title, .YDXeBa_projectText") || el).textContent).slice(0, 200),
      expanded: el.getAttribute("aria-expanded"),
      key: el.getAttribute("data-row-key") || ""
    }));
    const sessions = [...document.querySelectorAll(".YDXeBa_sessionRow")].map((el, i) => {
      const label = norm((el.getAttribute("aria-label") || "") + " " + (el.textContent || "")).slice(0, 240);
      return { i, label };
    });
    const groups = [];
    let cur = null;
    for (const el of document.querySelectorAll(".YDXeBa_projectRow, .YDXeBa_sessionRow")) {
      if (el.classList.contains("YDXeBa_projectRow")) {
        cur = {
          label: norm((el.querySelector(".YDXeBa_title, .YDXeBa_projectText") || el).textContent).slice(0, 200),
          expanded: el.getAttribute("aria-expanded"),
          key: el.getAttribute("data-row-key") || "",
          sessions: []
        };
        groups.push(cur);
      } else if (cur) {
        const label = norm((el.getAttribute("aria-label") || "") + " " + (el.textContent || "")).slice(0, 240);
        const gi = [...document.querySelectorAll(".YDXeBa_sessionRow")].indexOf(el);
        cur.sessions.push({ i: gi, label });
      }
    }
    return { projects, sessions, groups };
  })()`);
}

async function clickProject(page, index) {
  return page.evaluate(`(() => {
    const el = document.querySelectorAll(".YDXeBa_projectRow")[${index}];
    if (!el) return { ok: false };
    el.click();
    return {
      ok: true,
      label: ((el.querySelector(".YDXeBa_title, .YDXeBa_projectText") || el).textContent || "").replace(/\\s+/g, " ").trim().slice(0, 200)
    };
  })()`);
}

async function clickSessionEl(page, index) {
  return page.evaluate(`(() => {
    const el = document.querySelectorAll(".YDXeBa_sessionRow")[${index}];
    if (!el) return { ok: false };
    el.click();
    return { ok: true, label: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 200) };
  })()`);
}

async function scrollSidebar(page) {
  return page.evaluate(`(() => {
    const row = document.querySelector(".YDXeBa_projectRow, .YDXeBa_sessionRow");
    if (!row) return { ok: false, reason: "no-rows" };
    let el = row.parentElement;
    while (el && el !== document.body) {
      const s = getComputedStyle(el);
      if ((s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 20) {
        const before = el.scrollTop;
        el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + Math.max(80, el.clientHeight * 0.9));
        return { ok: true, before, after: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight };
      }
      el = el.parentElement;
    }
    return { ok: false, reason: "no-scroller" };
  })()`);
}

async function expandSafeProjects(page, out) {
  for (let round = 0; round < 4; round++) {
    const side = await listSidebar(page);
    const unsafeOpen = (side.groups || []).filter((g) => g.expanded === "true" && !isSafeProjectLabel(g.label));
    if (unsafeOpen.length === 0) break;
    for (const g of unsafeOpen) {
      const now = await listSidebar(page);
      const idx = now.projects.findIndex((p) => p.key === g.key && p.label === g.label);
      if (idx < 0) continue;
      await clickProject(page, idx);
      out.collapsedUnsafe = out.collapsedUnsafe || [];
      out.collapsedUnsafe.push({ label: g.label });
      await delay(300);
    }
  }
  const projects = (await listSidebar(page)).projects;
  for (const proj of projects.filter((p) => isSafeProjectLabel(p.label) && p.expanded !== "true")) {
    const side = await listSidebar(page);
    const idx = side.projects.findIndex((p) => p.key === proj.key && p.label === proj.label);
    if (idx < 0) continue;
    await clickProject(page, idx);
    await delay(300);
  }
  out.groupsKnown = (await listSidebar(page)).groups.map((g) => ({
    label: g.label, expanded: g.expanded, n: (g.sessions || []).length
  }));
}

async function pickSafeSession(page, out) {
  await expandSafeProjects(page, out);
  const tried = [];
  const seen = new Set();
  for (let pass = 0; pass < 12; pass++) {
    const side = await listSidebar(page);
    const safeGroups = (side.groups || []).filter((g) => g.expanded === "true" && isSafeProjectLabel(g.label));
    for (const g of safeGroups) {
      for (const row of g.sessions || []) {
        const key = g.label + "|" + row.label + "|" + row.i;
        if (seen.has(key) || row.i < 0) continue;
        seen.add(key);
        const clicked = await clickSessionEl(page, row.i);
        await delay(500);
        const opened = await openEditor(page);
        let snap = opened.snap;
        const t0 = Date.now();
        while (Date.now() - t0 < 2000 && !isSafeCwd(snap && snap.cwd)) {
          await delay(200);
          snap = await snapshot(page);
        }
        const rec = { group: g.label, i: row.i, label: row.label, clicked, cwd: snap && snap.cwd };
        tried.push(rec);
        if (isSafeCwd(rec.cwd)) {
          out.chosen = rec;
          out.triedSessions = tried.map((t) => ({ group: t.group, label: t.label, cwd: t.cwd }));
          return rec;
        }
        if (snap && snap.path) {
          try { await closeDoc(page); } catch {}
        }
      }
    }
    const more = await page.evaluate(`(() => {
      const btns = [...document.querySelectorAll("button[data-row-key^='overflow:']")];
      const hit = btns.find((b) => /更多|more|展开|expand|Show/i.test(b.textContent || ""));
      if (!hit) return { ok: false };
      hit.click();
      return { ok: true };
    })()`);
    if (more && more.ok) { await delay(300); continue; }
    const scrolled = await scrollSidebar(page);
    if (!scrolled.ok || scrolled.after === scrolled.before) break;
    await delay(200);
  }
  out.triedSessions = tried.map((t) => ({ group: t.group, label: t.label, cwd: t.cwd }));
  return null;
}

async function openFile(page, rel) {
  return page.evaluate(`(() => {
    const p = window.__dshEditorPanel;
    if (!p || typeof p.openFile !== "function") return { ok: false, reason: "no-openFile" };
    p.openFile(${JSON.stringify(rel)});
    return { ok: true };
  })()`);
}

async function waitForFile(page, rel, minLen, timeoutMs = 15000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await snapshot(page);
    if (last.paint > 0 && last.paintLen >= minLen && last.inputLen >= minLen) {
      return { ok: true, snap: last, waited: Date.now() - start };
    }
    await delay(100);
  }
  return { ok: false, snap: last, waited: Date.now() - start };
}

async function closeDoc(page, { discard = false } = {}) {
  return page.evaluate(`(() => {
    const keys = window.__dshEditorHotkeys;
    if (!keys || typeof keys.closeDoc !== "function") return { ok: false, reason: "no-closeDoc" };
    const prev = window.confirm;
    if (${discard ? "true" : "false"}) {
      try { window.confirm = () => true; } catch {}
    }
    try { keys.closeDoc(); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e) }; }
    finally { try { window.confirm = prev; } catch {} }
  })()`);
}

async function closeFind(page) {
  await page.evaluate(`(() => {
    const input = document.querySelector(".dce-find input");
    if (!input) return false;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    return true;
  })()`);
  await delay(150);
}

async function setFindQuery(page, query) {
  await page.evaluate(`(() => {
    const ta = document.querySelector("textarea.dce-input, .dce-root textarea");
    if (ta) ta.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "f", code: "KeyF", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
      bubbles: true, cancelable: true
    }));
  })()`);
  await delay(200);
  if (!(await page.evaluate(`!!document.querySelector(".dce-find")`))) {
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 8, key: "f", code: "KeyF", windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70 });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 8, key: "f", code: "KeyF", windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70 });
    await delay(200);
  }
  await page.evaluate(`(() => {
    const el = document.querySelector(".dce-find input");
    if (!el) return false;
    el.focus();
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    desc.set.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  const elBox = await page.evaluate(`(() => {
    const el = document.querySelector(".dce-find input");
    if (!el) return null;
    el.focus();
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (elBox) {
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: elBox.x, y: elBox.y, button: "left", clickCount: 1 });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: elBox.x, y: elBox.y, button: "left", clickCount: 1 });
  }
  await page.send("Input.insertText", { text: query });
  await delay(200);
  return { query, snap: await snapshot(page) };
}

function packProfile(profile) {
  if (!profile) return undefined;
  return { pluginSelfSum: profile.pluginSelfSum, pluginSelf: profile.pluginSelf, hostTop: (profile.hostTop || []).slice(0, 5) };
}

async function measureOpenRounds(page, rel, minLen, net, intervalUs) {
  const rounds = [];
  const runOnce = async (kind, withProfile) => {
    const from = await mark(page);
    const t0 = Date.now();
    let wait, profile;
    const run = async () => {
      await openFile(page, rel);
      const w = await waitForFile(page, rel, minLen);
      await delay(400);
      return w;
    };
    if (withProfile) {
      const wrap = await profileAction(page, run, intervalUs);
      wait = wrap.result;
      profile = wrap.profile;
    } else {
      wait = await run();
    }
    rounds.push({
      kind,
      openMs: Date.now() - t0,
      wait: { ok: wait.ok, waited: wait.waited, pathLoose: wait.pathLoose },
      longTasks: await slice(page, from),
      snap: wait.snap && {
        paintLen: wait.snap.paintLen,
        paintNodes: wait.snap.paintNodes,
        paintFirstIsText: wait.snap.paintFirstIsText,
        highlights: wait.snap.highlights,
        path: wait.snap.path
      },
      profile: packProfile(profile),
      reads: net.since(t0).filter((r) => /\/read$/.test(r.path)).length
    });
  };
  await runOnce("warmup", false);
  await closeDoc(page);
  await delay(300);
  for (let i = 0; i < 3; i++) {
    await runOnce("steady-" + (i + 1), i === 0);
    if (i < 2) {
      await closeDoc(page);
      await delay(250);
    }
  }
  return rounds;
}

async function measureScroll(page, intervalUs) {
  const scrollOnce = async (kind, withProfile, paced) => {
    const from = await mark(page);
    const run = async () => {
      if (!paced) {
        return page.evaluate(`(() => {
          const box = document.querySelector(".dce-scroller");
          if (!box) return { none: true };
          const start = box.scrollTop;
          const max = Math.max(0, box.scrollHeight - box.clientHeight);
          for (const y of [0, Math.floor(max * 0.25), Math.floor(max * 0.5), Math.floor(max * 0.75), max, Math.floor(max * 0.3), start]) {
            box.scrollTop = y;
            box.dispatchEvent(new Event("scroll", { bubbles: true }));
          }
          return { sh: box.scrollHeight, ch: box.clientHeight, max };
        })()`);
      }
      const boxInfo = await page.evaluate(`(() => {
        const box = document.querySelector(".dce-scroller");
        if (!box) return { none: true };
        const max = Math.max(0, box.scrollHeight - box.clientHeight);
        return { max, sh: box.scrollHeight, ch: box.clientHeight };
      })()`);
      if (boxInfo.none) return boxInfo;
      const max = boxInfo.max;
      for (const y of [0, Math.floor(max * 0.2), Math.floor(max * 0.5), Math.floor(max * 0.85), max, 0]) {
        await page.evaluate(`document.querySelector(".dce-scroller").scrollTop = ${y}`);
        await delay(80);
      }
      return boxInfo;
    };
    let info, profile;
    if (withProfile) {
      const wrap = await profileAction(page, run, intervalUs);
      info = wrap.result;
      profile = wrap.profile;
    } else {
      info = await run();
    }
    await delay(400);
    return { kind, info, longTasks: await slice(page, from), profile: packProfile(profile) };
  };
  return {
    warmup: await scrollOnce("warmup-sync", false, false),
    steady: [await scrollOnce("steady-sync-1", true, false), await scrollOnce("steady-sync-2", false, false)],
    warmupPaced: await scrollOnce("warmup-paced", false, true),
    steadyPaced: await scrollOnce("steady-paced", true, true)
  };
}

async function measureFind(page, intervalUs) {
  const runQuery = async (bucket, query, expectedHint) => {
    const rows = [];
    const once = async (kind, withProfile) => {
      const from = await mark(page);
      const t0 = Date.now();
      let r, profile;
      const run = async () => {
        const x = await setFindQuery(page, query);
        await delay(300);
        return x;
      };
      if (withProfile) {
        const wrap = await profileAction(page, run, intervalUs);
        r = wrap.result;
        profile = wrap.profile;
      } else {
        r = await run();
      }
      rows.push({
        kind,
        query,
        expectedHint,
        openMs: Date.now() - t0,
        longTasks: await slice(page, from),
        findCount: r.snap && r.snap.findCount,
        profile: packProfile(profile)
      });
      await closeFind(page);
      await delay(200);
    };
    await once("warmup", false);
    await once("steady-1", true);
    await once("steady-2", false);
    return rows;
  };
  return {
    rare: await runQuery("rare", NEEDLE, NEEDLE_HITS),
    common: await runQuery("common", "function", "many-capped-400")
  };
}

async function restoreClean(page, originalLen) {
  const snap = await snapshot(page);
  if (!snap.dirty && snap.inputLen === originalLen) return { how: "already-clean", len: snap.inputLen, dirty: snap.dirty };
  for (let i = 0; i < 12; i++) {
    const done = await page.evaluate(`(() => {
      const ta = document.querySelector("textarea.dce-input, .dce-root textarea");
      if (ta) ta.focus();
      const ok = document.execCommand("undo");
      return { ok, len: ta ? ta.value.length : -1, dirty: !!document.querySelector(".dce-dirty") };
    })()`);
    if (done && done.len === originalLen && done.dirty === false) {
      return { how: "execCommand-undo", tries: i + 1, len: done.len, dirty: false };
    }
    await delay(30);
  }
  for (let i = 0; i < 8; i++) {
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 8, key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 8, key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 });
    await delay(40);
    const now = await snapshot(page);
    if (!now.dirty && now.inputLen === originalLen) return { how: "meta-z", tries: i + 1, len: now.inputLen, dirty: false };
  }
  const last = await snapshot(page);
  return { how: "still-dirty", len: last.inputLen, dirty: last.dirty };
}

async function measureType(page, net, rel, minLen, intervalUs) {
  const original = await snapshot(page);
  const originalLen = original.inputLen;
  const rounds = [];
  const typeOnce = async (kind, withProfile) => {
    const focused = await page.evaluate(`(() => {
      const ta = document.querySelector("textarea.dce-input, .dce-root textarea");
      if (!ta) return { ok: false };
      ta.focus();
      try { ta.setSelectionRange(0, 0); } catch {}
      const r = ta.getBoundingClientRect();
      return { ok: true, x: r.x + Math.min(40, r.width / 2), y: r.y + 12, len: ta.value.length };
    })()`);
    if (!focused.ok) return { kind, error: "no-textarea" };
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: focused.x, y: focused.y, button: "left", clickCount: 1 });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: focused.x, y: focused.y, button: "left", clickCount: 1 });
    const from = await mark(page);
    const t0 = Date.now();
    const run = async () => {
      await page.send("Input.insertText", { text: "X" });
      await delay(80);
      await page.send("Input.insertText", { text: "Y" });
      await delay(80);
      await page.send("Input.insertText", { text: "Z" });
      await delay(250);
      return snapshot(page);
    };
    let mid, profile;
    if (withProfile) {
      const wrap = await profileAction(page, run, intervalUs);
      mid = wrap.result;
      profile = wrap.profile;
    } else {
      mid = await run();
    }
    const lt = await slice(page, from);
    let restore = await restoreClean(page, originalLen);
    if (restore.how === "still-dirty") {
      const beforeWrites = net.writes(0).length;
      await closeDoc(page, { discard: true });
      await delay(200);
      await openFile(page, rel);
      await waitForFile(page, rel, minLen);
      const after = await snapshot(page);
      restore = {
        ...restore,
        fallback: "discard-reopen",
        writesDelta: net.writes(0).length - beforeWrites,
        dirty: after.dirty,
        len: after.inputLen
      };
    }
    return {
      kind,
      typedMs: Date.now() - t0,
      midDirty: mid && mid.dirty,
      midLen: mid && mid.inputLen,
      longTasks: lt,
      restore,
      profile: packProfile(profile),
      writes: net.writes(t0).map((r) => r.path)
    };
  };
  rounds.push(await typeOnce("warmup", false));
  rounds.push(await typeOnce("steady-1", true));
  rounds.push(await typeOnce("steady-2", false));
  const final = await snapshot(page);
  return {
    originalLen,
    rounds,
    finalDirty: final.dirty,
    finalLen: final.inputLen,
    totalWrites: net.writes(0).map((r) => r.path)
  };
}

export async function run({ page, config, net }) {
  const out = { files: filesFor(config.paintTextMax), paintTextMax: config.paintTextMax };
  const openedRight = await openRightColumn(page);
  out.openedRight = openedRight;
  const chosen = await pickSafeSession(page, out);
  if (!chosen) {
    throw new Error(
      "No safe existing session (Personal/dsh or /tmp) is visible. This suite will not open business repos (EPF/MM, BNGS, Luna, etc.) and never creates sessions."
    );
  }
  const cwd = chosen.cwd.replace(/\/+$/, "");
  if (!isSafeCwd(cwd)) throw new Error("Refusing to write temp files in unsafe cwd: " + cwd);
  const absDir = join(cwd, TMP_DIR_NAME);
  const created = [];
  try {
    await mkdir(absDir, { recursive: true });
    out.tempDir = absDir;
    out.fileRels = {};
    out.fileStats = {};
    for (const f of out.files) {
      const text = generateJs(f.chars, f.key);
      const abs = join(absDir, f.name);
      writeFileSync(abs, text);
      created.push(abs);
      const rel = relFor(cwd, absDir, f.name);
      out.fileRels[f.key] = rel;
      out.fileStats[f.key] = {
        chars: text.length,
        bytes: Buffer.byteLength(text),
        lines: text.split("\n").length,
        needleHits: text.split(NEEDLE).length - 1,
        overPaintMax: text.length > config.paintTextMax
      };
    }

    out.results = {};
    for (const f of out.files) {
      const rel = out.fileRels[f.key];
      const minLen = Math.floor(f.chars * 0.95);
      const block = { rel, stats: out.fileStats[f.key] };
      block.open = await measureOpenRounds(page, rel, minLen, net, config.profilerIntervalUs);
      const opened = await waitForFile(page, rel, minLen, 5000);
      if (!opened.ok) {
        await openFile(page, rel);
        await waitForFile(page, rel, minLen);
      }
      block.afterOpen = pickPaint(await snapshot(page));
      block.scroll = await measureScroll(page, config.profilerIntervalUs);
      block.find = await measureFind(page, config.profilerIntervalUs);
      block.type = await measureType(page, net, rel, minLen, config.profilerIntervalUs);
      const endSnap = await snapshot(page);
      if (endSnap.dirty) await closeDoc(page, { discard: true });
      else await closeDoc(page);
      await delay(200);
      block.afterClose = pickPaint(await snapshot(page));
      out.results[f.key] = block;
    }

    out.writesAll = net.writes(0).map((r) => r.path);
    out.highlightRules = (await snapshot(page)).highlightRules;
    out.ok = out.writesAll.length === 0;
    if (!out.ok) out.error = "Observed /write during the large-file suite; typing should be undone and files never saved.";
    return out;
  } finally {
    for (const abs of created) {
      try { await rm(abs, { force: true }); } catch {}
    }
    if (existsSync(absDir)) {
      try { await rm(absDir, { recursive: true, force: true }); } catch {}
    }
    out.tempsDeleted = !existsSync(absDir);
  }
}

function pickPaint(ui) {
  return {
    path: ui.path,
    paintLen: ui.paintLen,
    paintNodes: ui.paintNodes,
    paintFirstIsText: ui.paintFirstIsText,
    dirty: ui.dirty,
    highlights: ui.highlights,
    highlightRules: ui.highlightRules,
    cwd: ui.cwd
  };
}

export function summarize(result) {
  const lines = [
    `cwd=${result.chosen && result.chosen.cwd}  tempsDeleted=${result.tempsDeleted}  writes=${(result.writesAll || []).length}`,
    `historyPump recorded on snapshots; highlight scoped=${result.highlightRules && result.highlightRules.scoped} bare=${result.highlightRules && result.highlightRules.bare}`
  ];
  for (const [key, block] of Object.entries(result.results || {})) {
    const stats = block.stats || {};
    lines.push(`${key}: ${stats.chars} chars, overPaintMax=${stats.overPaintMax}, rel=${block.rel}`);
    const opens = (block.open || []).filter((r) => r.kind !== "warmup");
    for (const r of opens) {
      const self = r.profile ? `  plugin SELF=${r.profile.pluginSelfSum}ms` : "";
      lines.push(`  open ${r.kind}  ${r.openMs}ms  ${formatLt(r.longTasks)}${self}`);
    }
    for (const r of (block.scroll && block.scroll.steady) || []) {
      const self = r.profile ? `  plugin SELF=${r.profile.pluginSelfSum}ms` : "";
      lines.push(`  scroll ${r.kind}  ${formatLt(r.longTasks)}${self}`);
    }
    if (block.scroll && block.scroll.steadyPaced) {
      const r = block.scroll.steadyPaced;
      const self = r.profile ? `  plugin SELF=${r.profile.pluginSelfSum}ms` : "";
      lines.push(`  scroll ${r.kind}  ${formatLt(r.longTasks)}${self}`);
    }
    const findRows = [...((block.find && block.find.rare) || []), ...((block.find && block.find.common) || [])]
      .filter((r) => r.kind !== "warmup");
    for (const r of findRows) {
      lines.push(`  find ${r.query} ${r.kind}  ${formatLt(r.longTasks)}  count=${r.findCount || "?"}`);
    }
    for (const r of (block.type && block.type.rounds) || []) {
      if (r.kind === "warmup") continue;
      lines.push(`  type ${r.kind}  ${formatLt(r.longTasks)}  midLen=${r.midLen} restore=${r.restore && r.restore.how}`);
    }
  }
  if ((result.writesAll || []).length) lines.push("FAIL: /write was observed. Buffers should be undone, never saved.");
  return lines;
}
