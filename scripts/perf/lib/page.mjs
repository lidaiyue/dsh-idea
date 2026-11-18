/**
 * Shared in-page helpers: long-task observer, profiler, network watch, snapshots.
 *
 * Plugin SELF time: charge SELF only. Official plugin time is limited to
 * non-combo `/plugins/dsh-idea/` URLs. Combo frames
 * (`/plugins/??...&rev=...`) are host time, even when a function name looks
 * like it belongs to this plugin.
 */

import { delay, redactUrl } from "./cdp.mjs";

export const PAGE_HELPERS = `
(() => {
  const longTasks = (window.__dshIdeaPerfTasks = window.__dshIdeaPerfTasks || []);
  if (!window.__dshIdeaPerfObs) {
    window.__dshIdeaPerfObs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push({ start: e.startTime, ms: e.duration });
    });
    try { window.__dshIdeaPerfObs.observe({ type: "longtask", buffered: true }); }
    catch (err) { window.__dshIdeaPerfObsError = String(err && err.message ? err.message : err); }
  }
  window.__dshIdeaPerfMark = () => ({ t: performance.now(), n: longTasks.length });
  window.__dshIdeaPerfSlice = (from) => {
    const rows = longTasks.slice(from.n).filter((e) => e.start >= from.t - 0.01);
    const ms = rows.map((r) => r.ms);
    return {
      count: rows.length,
      sum: Math.round(ms.reduce((a, b) => a + b, 0)),
      max: ms.length ? Math.round(Math.max(...ms)) : 0,
      rows: rows.map((r) => ({ start: Math.round(r.start), ms: Math.round(r.ms) }))
    };
  };
  return { ok: true, buffered: longTasks.length, obsError: window.__dshIdeaPerfObsError || null };
})()
`;

export async function installHelpers(page) {
  return page.evaluate(PAGE_HELPERS);
}

export async function mark(page) {
  return page.evaluate(`window.__dshIdeaPerfMark()`);
}

export async function slice(page, from) {
  return page.evaluate(`window.__dshIdeaPerfSlice(${JSON.stringify(from)})`);
}

export function formatLt(lt) {
  if (!lt) return "n/a";
  return `count=${lt.count} sum=${lt.sum}ms max=${lt.max}ms`;
}

const WATCH_RE = /\/(git\/state|git\/log|run\/list|run\/tail)(?:\?|$)/;

export function classifyPath(path) {
  if (WATCH_RE.test(path)) {
    const m = path.match(/\/(git\/state|git\/log|run\/list|run\/tail)/);
    return m ? m[1] : "other";
  }
  return null;
}

export function attachNetwork(page) {
  const reqs = [];
  const off = page.onEvent((msg) => {
    if (msg.method !== "Network.requestWillBeSent") return;
    const req = msg.params && msg.params.request;
    const u = req && req.url;
    if (typeof u !== "string") return;
    let path = u;
    try {
      const parsed = new URL(u);
      path = parsed.pathname + parsed.search;
    } catch {}
    const short = redactUrl(path.replace(/.*\/plugins\//, "plugins/"));
    reqs.push({
      url: redactUrl(u),
      path: short,
      method: (req && req.method) || "",
      type: msg.params.type,
      t: Date.now(),
      watched: classifyPath(short)
    });
  });
  return {
    reqs,
    stop: off,
    since(t0) { return reqs.filter((r) => r.t >= t0); },
    plugin(t0 = 0) {
      return this.since(t0).filter((r) => /plugins\/dsh-idea|plugins\/dsh-run/.test(r.url + r.path));
    },
    watched(t0 = 0) {
      return this.since(t0).filter((r) => r.watched);
    },
    writes(t0 = 0) {
      return this.since(t0).filter((r) => /\/write$/.test(r.path) || /\/write\?/.test(r.path));
    }
  };
}

export function summarizeReqs(list) {
  const kinds = {};
  const watched = {};
  for (const r of list) {
    kinds[r.path] = (kinds[r.path] || 0) + 1;
    if (r.watched) watched[r.watched] = (watched[r.watched] || 0) + 1;
  }
  return {
    total: list.length,
    paths: kinds,
    watched,
    sample: list.slice(0, 12).map((r) => r.path)
  };
}

/** Official plugin SELF: non-combo /plugins/dsh-idea/ URLs only. */
export function isPluginUrl(url) {
  if (!url) return false;
  if (/\/plugins\/\?\?/.test(url)) return false;
  return /\/plugins\/dsh-idea\//.test(url) || /dsh-idea\/lib\/client/.test(url);
}

export function selfTimes(profile, intervalUs) {
  const rows = [];
  for (const node of profile.nodes || []) {
    const hits = node.hitCount || 0;
    if (hits <= 0) continue;
    const fr = node.callFrame || {};
    rows.push({
      selfMs: hits * intervalUs / 1000,
      hits,
      name: fr.functionName || "(anonymous)",
      url: redactUrl(fr.url || ""),
      line: fr.lineNumber
    });
  }
  rows.sort((a, b) => b.selfMs - a.selfMs);
  return rows;
}

export function summarizeProfile(profile, intervalUs = 100) {
  const rows = selfTimes(profile, intervalUs);
  const plugin = rows.filter((r) => isPluginUrl(r.url));
  const hostish = rows.filter((r) => !isPluginUrl(r.url));
  const compact = (r) => ({ selfMs: Math.round(r.selfMs * 10) / 10, name: r.name, url: r.url, line: r.line });
  return {
    intervalUs,
    samples: (profile.samples || []).length,
    nodes: (profile.nodes || []).length,
    pluginSelfSum: Math.round(plugin.reduce((a, b) => a + b.selfMs, 0) * 10) / 10,
    topSelfSum: Math.round(rows.slice(0, 25).reduce((a, b) => a + b.selfMs, 0) * 10) / 10,
    pluginSelf: plugin.slice(0, 15).map(compact),
    topSelf: rows.slice(0, 15).map(compact),
    hostTop: hostish.slice(0, 10).map(compact)
  };
}

export async function profileAction(page, fn, intervalUs = 100) {
  await page.send("Profiler.enable");
  await page.send("Profiler.setSamplingInterval", { interval: intervalUs });
  await page.send("Profiler.start");
  const result = await fn();
  const prof = await page.send("Profiler.stop");
  return { result, profile: summarizeProfile(prof.profile, intervalUs) };
}

export async function snapshot(page) {
  return page.evaluate(`(() => {
    const pre = document.querySelector("pre.dce-paint");
    const ta = document.querySelector("textarea.dce-input, .dce-root textarea");
    const sc = document.querySelector(".dce-scroller");
    const root = document.querySelector(".dce-root");
    const gitpane = document.querySelector(".dce-gitpane");
    const runpane = document.querySelector(".drun-pane");
    const css = (document.querySelector('style[data-plugin="dsh-idea"]') || {}).textContent || "";
    const highlightRules = (() => {
      const scoped = (css.match(/\\.dce-paint::highlight\\(/g) || []).length;
      const rest = css.replace(/\\.dce-paint::highlight\\(/g, "");
      const bare = (rest.match(/::highlight\\(/g) || []).length;
      return { bare, scoped };
    })();
    const highlightStats = (() => {
      const names = ["dce-k","dce-s","dce-c","dce-n","dce-f","dce-occ","dce-occ-cur","dce-hit","dce-hit-cur"];
      if (!window.CSS || !CSS.highlights) return { api: false };
      const out = { api: true, total: 0 };
      for (const n of names) {
        const h = CSS.highlights.get(n);
        let size = 0;
        if (h) {
          try { size = typeof h.size === "number" ? h.size : [...h].length; } catch { size = -1; }
        }
        out[n] = size;
        if (size > 0) out.total += size;
      }
      return out;
    })();
    return {
      build: window.__dshIdeaBuild || null,
      historyPump: window.__dshIdeaHistoryPump || null,
      historyPumpStorage: (() => { try { return localStorage.getItem("dsh.files.historyPump"); } catch { return "err"; } })(),
      viewport: { w: innerWidth, h: innerHeight },
      nodes: document.getElementsByTagName("*").length,
      sessionRows: document.querySelectorAll(".YDXeBa_sessionRow").length,
      rightOpen: !!document.querySelector("[data-sidebar-right-open]"),
      editorRoots: document.querySelectorAll(".dce-root").length,
      idleRoots: document.querySelectorAll("[data-dce-idle]").length,
      rootHasTree: !!(root && root.querySelector(".dce-tree, .dce-body, .dce-gitpane")),
      paint: document.querySelectorAll("pre.dce-paint").length,
      textarea: document.querySelectorAll("textarea.dce-input, .dce-root textarea").length,
      paintLen: pre ? (pre.textContent || "").length : 0,
      paintNodes: pre ? pre.childNodes.length : 0,
      paintFirstIsText: !!(pre && pre.firstChild && pre.firstChild.nodeType === 3),
      inputLen: ta ? (ta.value || "").length : 0,
      dirty: !!document.querySelector(".dce-dirty"),
      scroller: sc ? { sh: sc.scrollHeight, ch: sc.clientHeight, st: Math.round(sc.scrollTop) } : null,
      gitDock: document.documentElement.dataset.dshGitDock || "0",
      runDock: document.documentElement.dataset.dshRunDock || "0",
      gitPane: document.querySelectorAll(".dce-gitpane").length,
      runPane: document.querySelectorAll(".drun-pane").length,
      gitPaneChildren: gitpane ? gitpane.childElementCount : 0,
      runPaneChildren: runpane ? runpane.childElementCount : 0,
      path: (() => {
        const el = document.querySelector(".dce-path");
        return el ? (el.textContent || "").trim() : "";
      })(),
      cwd: (() => {
        const trees = [...document.querySelectorAll(".dce-treename")];
        const vis = trees.find((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
        });
        const el = vis || trees[trees.length - 1];
        return el ? (el.getAttribute("title") || el.textContent || "") : "";
      })(),
      allCwds: [...document.querySelectorAll(".dce-treename")].map((el) => {
        const r = el.getBoundingClientRect();
        return {
          title: el.getAttribute("title") || el.textContent || "",
          visible: r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight
        };
      }),
      findOpen: !!document.querySelector(".dce-find"),
      findCount: (() => {
        const el = document.querySelector(".dce-findcount");
        return el ? (el.textContent || "").trim() : "";
      })(),
      highlights: highlightStats,
      highlightRules,
      panel: !!(window.__dshEditorPanel),
      panelKeys: window.__dshEditorPanel ? Object.keys(window.__dshEditorPanel) : [],
      gitApi: !!(window.__dshGitPanel),
      runApi: !!(window.__dshRunPanel),
      hotkeys: !!(window.__dshEditorHotkeys),
      hotkeyKeys: window.__dshEditorHotkeys ? Object.keys(window.__dshEditorHotkeys) : []
    };
  })()`);
}

export async function clickExact(page, needle) {
  return page.evaluate(`(() => {
    const needle = ${JSON.stringify(needle)};
    const els = [...document.querySelectorAll("button, [role=button], [aria-label]")];
    const hit = els.find((el) => {
      const label = ((el.getAttribute("aria-label")||"")+" "+(el.getAttribute("title")||"")+" "+(el.textContent||"")).replace(/\\s+/g," ").trim();
      return label === needle || label.includes(needle);
    });
    if (!hit) return { ok: false };
    hit.click();
    return { ok: true, label: ((hit.getAttribute("aria-label")||"")+" "+(hit.getAttribute("title")||"")).trim().slice(0,80) };
  })()`);
}

export async function clickLabel(page, pattern) {
  const source = pattern instanceof RegExp ? pattern.toString() : JSON.stringify(pattern);
  return page.evaluate(`(() => {
    const re = ${source};
    const rx = typeof re === "string" ? new RegExp(re) : re;
    const els = [...document.querySelectorAll("button, [role=button], [role=tab], a, [class*=tab], [class*=chip]")];
    const hit = els.find((el) => {
      const label = ((el.getAttribute("aria-label")||"")+" "+(el.getAttribute("title")||"")+" "+(el.textContent||"")).replace(/\\s+/g," ").trim();
      return rx.test(label);
    });
    if (!hit) return { ok: false };
    hit.click();
    return { ok: true, label: ((hit.getAttribute("aria-label")||"")+" "+(hit.textContent||"")).replace(/\\s+/g," ").trim().slice(0,80) };
  })()`);
}

export async function ensureRightClosed(page) {
  const open = await page.evaluate(`!!document.querySelector("[data-sidebar-right-open]")`);
  if (!open) return { alreadyClosed: true };
  const closed = await clickExact(page, "收起右侧边栏");
  if (!closed.ok) {
    const fallback = await clickLabel(page, /收起右侧边栏|收起右栏|折叠右栏|关闭右侧边栏/);
    await delay(500);
    const stillOpen = await page.evaluate(`!!document.querySelector("[data-sidebar-right-open]")`);
    return { alreadyClosed: false, closed: fallback, stillOpen };
  }
  await delay(500);
  const stillOpen = await page.evaluate(`!!document.querySelector("[data-sidebar-right-open]")`);
  return { alreadyClosed: false, closed, stillOpen };
}

export async function openRightColumn(page) {
  const open = await page.evaluate(`!!document.querySelector("[data-sidebar-right-open]")`);
  if (open) return { alreadyOpen: true };
  const clicked = await clickExact(page, "打开右侧边栏");
  if (!clicked.ok) {
    const fallback = await clickLabel(page, /打开右侧边栏/);
    await delay(600);
    return {
      alreadyOpen: false,
      clicked: fallback,
      open: await page.evaluate(`!!document.querySelector("[data-sidebar-right-open]")`)
    };
  }
  await delay(600);
  return {
    alreadyOpen: false,
    clicked,
    open: await page.evaluate(`!!document.querySelector("[data-sidebar-right-open]")`)
  };
}

export async function switchRound(page, config) {
  // Only clicks existing `.YDXeBa_sessionRow` entries. Never creates a session.
  const n = config.switches;
  const gap = config.switchGapMs;
  const count = await page.evaluate(`document.querySelectorAll(".YDXeBa_sessionRow").length`);
  if (count < 2) {
    throw new Error(
      `Need at least 2 existing sessions to switch (found ${count}). This harness never creates sessions.`
    );
  }
  const seq = [];
  for (let i = 0; i < n; i++) seq.push((i + 1) % count);
  const from = await mark(page);
  const clicks = [];
  for (const wanted of seq) {
    const now = await page.evaluate(`document.querySelectorAll(".YDXeBa_sessionRow").length`);
    const index = now <= 0 ? -1 : Math.min(wanted, now - 1);
    if (index < 0) {
      clicks.push({ wanted, ok: false, error: "no rows" });
      continue;
    }
    try {
      await page.clickCss(".YDXeBa_sessionRow", index);
      clicks.push({ wanted, index, ok: true, n: now });
    } catch (err) {
      clicks.push({ wanted, index, ok: false, n: now, error: String(err.message || err) });
    }
    await delay(gap);
  }
  await delay(config.settleMs);
  return { count, seq, clicks, longTasks: await slice(page, from) };
}

export async function switchOnce(page, index) {
  const n = await page.evaluate(`document.querySelectorAll(".YDXeBa_sessionRow").length`);
  const i = n <= 0 ? 0 : Math.min(index, n - 1);
  try { await page.clickCss(".YDXeBa_sessionRow", i); } catch (err) {
    return { ok: false, n, i, error: String(err.message || err) };
  }
  await delay(600);
  return { ok: true, n, i };
}

export async function openEditor(page) {
  // Opening the right column alone does not mount the editor.
  const api = await page.evaluate(`(() => {
    const p = window.__dshEditorPanel;
    if (!p) return { ok: false, reason: "no-api" };
    if (typeof p.open === "function") { p.open(); return { ok: true, how: "open", keys: Object.keys(p) }; }
    if (typeof p.reveal === "function") { p.reveal(); return { ok: true, how: "reveal", keys: Object.keys(p) }; }
    return { ok: false, reason: "no-open", keys: Object.keys(p) };
  })()`);
  const start = Date.now();
  while (Date.now() - start < 8000) {
    const snap = await snapshot(page);
    if (snap.editorRoots > 0 && snap.idleRoots === 0) return { api, snap, waited: Date.now() - start };
    await delay(150);
  }
  return { api, snap: await snapshot(page), waited: Date.now() - start, timeout: true };
}

export async function callPanel(page, name, method) {
  return page.evaluate(`(() => {
    const api = window[${JSON.stringify(name)}];
    if (!api) return { how: null, has: false };
    if (typeof api[${JSON.stringify(method)}] === "function") {
      api[${JSON.stringify(method)}]();
      return { how: "api.${method}", has: true };
    }
    return { how: null, has: true, keys: Object.keys(api) };
  })()`);
}

export function listChatScrollersExpr() {
  return `(() => {
    const cands = [...document.querySelectorAll("div, section, main")].filter((el) => {
      const s = getComputedStyle(el);
      const oy = s.overflowY;
      return (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 80;
    }).map((el) => ({
      cls: String(el.className || "").slice(0, 80),
      sh: el.scrollHeight,
      ch: el.clientHeight
    }));
    cands.sort((a, b) => (b.sh - b.ch) - (a.sh - a.ch));
    return cands;
  })()`;
}

export async function scrollExistingTranscript(page) {
  return page.evaluate(`(() => {
    const cands = [...document.querySelectorAll("div, section, main")].filter((el) => {
      const s = getComputedStyle(el);
      return (s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 20;
    });
    cands.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    const el = cands[0];
    if (!el) return { none: true };
    const start = el.scrollTop;
    for (const y of [0, 400, 900, 1400, 0, el.scrollHeight]) {
      el.scrollTop = y;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    }
    el.scrollTop = start;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
    return { cls: String(el.className || "").slice(0, 80), sh: el.scrollHeight, ch: el.clientHeight, n: cands.length };
  })()`);
}
