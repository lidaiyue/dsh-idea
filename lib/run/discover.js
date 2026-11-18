import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { loadRuns } from "./config.js";

/** Directories that never hold project sources worth scanning. */
const SKIP_DIRS = new Set([
  "node_modules", "target", "build", "out", "dist", "bin", "obj", "coverage",
  "vendor", "__pycache__",
  ".git", ".idea", ".gradle", ".dsh", ".next", ".nuxt", ".turbo", ".venv",
  ".deliver-worktrees"
]);
/** npm lifecycle hooks are not something a person runs on purpose. */
const PACKAGE_NOISE = new Set(["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly"]);
/** Exact script names, in preference order, for the one start entry a frontend project may expose. */
const PREFERRED_SCRIPTS = ["dev", "start", "serve"];
const MAX_JAVA_FILES = 3000;
const MAX_RUNS = 40;
/** Maven reactors nest aggregator poms; a single pass has to follow `<module>` without looping. */
const MAX_MODULE_DEPTH = 8;
const MAX_MODULE_VISITS = 80;
/** A parent folder such as a `code/` directory holds several projects a few levels down. */
const MAX_NEST_DEPTH = 5;
const MAX_WALK_DIRS = 2000;
/** Discovery walks a source tree, so the panel's polling must not repeat it per tick. */
const CACHE_MS = 10_000;

const cache = new Map();

async function textOf(file) {
  try { return await readFile(file, "utf8"); } catch { return undefined; }
}

async function isDir(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

/** A real directory, with symlinks resolved, or undefined: sandbox roots reject dangling ones. */
async function realDir(path) {
  try {
    const real = await realpath(path);
    return (await stat(real)).isDirectory() ? real : undefined;
  } catch { return undefined; }
}

/** Workspace-relative path with forward slashes, for stable ids across platforms. */
function relPosix(from, to) {
  const value = relative(from, to);
  if (value === "") return ".";
  return value.split(sep).join("/");
}

/** Collect `.java` files under `dir`, bounded in both depth and count. */
async function javaFiles(dir, out, depth = 0) {
  if (depth > 12 || out.length >= MAX_JAVA_FILES) return;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (out.length >= MAX_JAVA_FILES) return;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      await javaFiles(join(dir, entry.name), out, depth + 1);
    } else if (entry.name.endsWith(".java")) {
      out.push(join(dir, entry.name));
    }
  }
}

/** The simple name of the class carrying `@SpringBootApplication`, which is what IDEA labels the app. */
async function springAppName(javaRoot) {
  const files = [];
  await javaFiles(javaRoot, files);
  for (const file of files) {
    const text = await textOf(file);
    if (text === undefined) continue;
    const at = text.indexOf("@SpringBootApplication");
    if (at < 0) continue;
    const match = /class\s+([A-Za-z_$][\w$]*)/.exec(text.slice(at));
    if (match !== null) return match[1];
  }
  return undefined;
}

/** `server.port` from `application.properties`, or the `port` under a `server:` block in YAML. */
async function portFromResources(resources) {
  const properties = await textOf(join(resources, "application.properties"));
  if (properties !== undefined) {
    const match = /^\s*server\.port\s*[=:]\s*(\d{2,5})\s*$/m.exec(properties);
    if (match !== null) return Number(match[1]);
  }
  for (const name of ["application.yml", "application.yaml"]) {
    const text = await textOf(join(resources, name));
    if (text === undefined) continue;
    let inServer = false;
    for (const line of text.split("\n")) {
      if (/^\S/.test(line)) { inServer = /^server\s*:/.test(line); continue; }
      if (!inServer) continue;
      const match = /^\s+port\s*:\s*(\d{2,5})\s*$/.exec(line);
      if (match !== null) return Number(match[1]);
    }
  }
  return undefined;
}

/** A package manager's cache is a real write target for a build tool, and lives outside the project. */
async function cacheRoot(name) {
  return realDir(join(homedir(), name));
}

function moduleNames(pom) {
  return [...pom.matchAll(/<module>\s*([^<\s]+)\s*<\/module>/g)].map((match) => match[1]);
}

/** Prefix a discovered id when the project root is nested under the workspace. */
function prefixId(prefix, id) {
  if (prefix === undefined || prefix === "" || prefix === ".") return id;
  const colon = id.indexOf(":");
  if (colon < 0) return `${prefix}/${id}`;
  const kind = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  if (rest === "." || rest === "") return `${kind}:${prefix}`;
  return `${kind}:${prefix}/${rest}`;
}

/** True when `child` is a real path strictly inside `parent`. */
function isInsideDir(parent, child) {
  const value = relative(parent, child);
  return value !== "" && !isAbsolute(value) && !value.split(sep).some((part) => part === "..");
}

/**
 * A JS monorepo root: a workspace file, a turbo/lerna/nx config, or a
 * `package.json` `workspaces` field. A lone `packageManager` field is not
 * enough — single packages often declare one.
 */
async function isJsMonorepoRoot(dir, pkg) {
  for (const name of ["pnpm-workspace.yaml", "pnpm-workspace.yml", "turbo.json", "lerna.json", "nx.json"]) {
    if (await textOf(join(dir, name)) !== undefined) return true;
  }
  if (pkg === null || typeof pkg !== "object") return false;
  const workspaces = pkg.workspaces;
  return workspaces !== undefined && workspaces !== null
    && (Array.isArray(workspaces) || typeof workspaces === "object");
}

async function packageManagerOf(root, pkg) {
  let manager = "npm";
  if (pkg !== null && typeof pkg === "object" && typeof pkg.packageManager === "string") {
    const name = pkg.packageManager.split("@")[0];
    if (name === "pnpm" || name === "yarn" || name === "npm") manager = name;
  }
  if (manager === "npm" && (await textOf(join(root, "pnpm-lock.yaml"))) !== undefined) manager = "pnpm";
  if (manager === "npm" && (await textOf(join(root, "yarn.lock"))) !== undefined) manager = "yarn";
  return manager;
}

/** The last path or scope segment of a package or script name. */
function packageLeaf(name) {
  if (typeof name !== "string" || name === "") return "";
  return name.split(/[\\/]/).pop();
}

/** `antd` from `dev:antd`; unsuffixed names are returned as-is. */
function scriptLeaf(name) {
  const match = /^(dev|start|serve)[:_-](.+)$/i.exec(name);
  return match === null ? name : match[2];
}

/**
 * Docs, playgrounds, mocks, and build/test/lint jobs are not something the
 * run panel should start as an application.
 */
function isSkippedAppName(name) {
  const skip = /^(docs?|doc|playground|play|storybook|stories|mock|backend-mock|e2e|test|tests|lint|build|analy[sz]e?|preview)([-_].*)?$/i;
  const leaf = packageLeaf(name);
  if (leaf !== "" && skip.test(leaf)) return true;
  const script = scriptLeaf(name);
  return script !== "" && script !== name && skip.test(script);
}

/** `turbo-run` (and the same binary invoked via pnpm/npx) is an interactive selector. */
function isInteractiveCommand(command) {
  return typeof command === "string" && /\bturbo-run\b/.test(command);
}

function isDevScriptName(name) {
  return /^(dev|start|serve)([:_-].+)?$/i.test(name);
}

function isPrefixedDevScript(name) {
  return /^(dev|start|serve)[:_-].+$/i.test(name);
}

/**
 * Tokens interpolated into `bash -c` command lines. Anything outside these
 * shapes is dropped rather than quoted, so a crafted package or module name
 * cannot close the shell command.
 */
const SAFE_SCRIPT = /^[A-Za-z0-9][A-Za-z0-9._:*-]*$/;
const SAFE_PACKAGE = /^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;
const SAFE_MODULE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const SAFE_GRADLE = /^[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+)*$/;

function isSafeScriptName(name) {
  return typeof name === "string" && SAFE_SCRIPT.test(name);
}

function isSafePackageName(name) {
  return typeof name === "string" && SAFE_PACKAGE.test(name);
}

function isSafeModulePath(name) {
  return typeof name === "string" && SAFE_MODULE.test(name);
}

function isSafeGradleName(name) {
  return typeof name === "string" && SAFE_GRADLE.test(name);
}

/**
 * Module names from a Gradle `include` line. `include ':app', ':core'` and
 * `include(":app")` are both common; a leading colon is the project path, not
 * part of the directory name. Quoted names after the first on the same
 * statement are included too.
 */
function gradleModuleNames(settings) {
  const names = [];
  const seen = new Set();
  const stmt = /include\b([^;\n]*)/g;
  let match;
  while ((match = stmt.exec(settings)) !== null) {
    for (const quoted of match[1].matchAll(/['"]([^'"]+)['"]/g)) {
      const name = quoted[1].replace(/^:+/, "");
      if (!isSafeGradleName(name) || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
      if (names.length >= 20) return names;
    }
  }
  return names;
}

function isUsableScript(name, command) {
  if (!isDevScriptName(name) || !isSafeScriptName(name)) return false;
  if (isSkippedAppName(name)) return false;
  if (isInteractiveCommand(command)) return false;
  return typeof command === "string";
}

/**
 * One script per standalone package.json: `dev`, then `start`, then `serve`,
 * then the plainest remaining name that looks like a dev server. Interactive
 * selectors such as `turbo-run` are skipped so a concrete `dev:antd` can win.
 * Build, test, lint, and docs scripts are never chosen.
 */
function pickScriptName(names, scripts) {
  const table = scripts === null || typeof scripts !== "object" ? {} : scripts;
  const usable = (name) => isUsableScript(name, table[name]);
  for (const preferred of PREFERRED_SCRIPTS) {
    if (names.includes(preferred) && usable(preferred)) return preferred;
  }
  const likes = names.filter(usable);
  if (likes.length === 0) return undefined;
  const scored = likes.map((name, index) => ({
    name,
    index,
    kind: /^(dev)([:_-]|$)/i.test(name) ? 0 : /^(start)([:_-]|$)/i.test(name) ? 1 : 2,
    plain: /^[A-Za-z]+$/.test(name) ? 0 : 1,
    length: name.length
  }));
  scored.sort((a, b) => a.kind - b.kind || a.plain - b.plain || a.length - b.length || a.index - b.index);
  return scored[0].name;
}

function addCoverage(covered, value) {
  if (typeof value !== "string" || value === "") return;
  covered.add(value.toLowerCase());
  const leaf = packageLeaf(value);
  if (leaf !== "") covered.add(leaf.toLowerCase());
  const script = scriptLeaf(value);
  if (script !== "") covered.add(script.toLowerCase());
}

function filtersInCommand(command) {
  if (typeof command !== "string") return [];
  const found = [];
  const pattern = /(?:-F|--filter|-w)\s+(\S+)|(?:^|\s)workspace\s+(\S+)/g;
  let match;
  while ((match = pattern.exec(command)) !== null) {
    const raw = match[1] ?? match[2];
    found.push(String(raw).replace(/^['"]|['"]$/g, ""));
  }
  return found;
}

function coversPackage(covered, pkgName, dirName) {
  const aliases = [pkgName, packageLeaf(pkgName), dirName].filter((value) => typeof value === "string" && value !== "");
  return aliases.some((alias) => covered.has(alias.toLowerCase()));
}

function filterRunCommand(manager, pkgName, script) {
  if (manager === "pnpm") return `pnpm -F ${pkgName} run ${script}`;
  if (manager === "yarn") return `yarn workspace ${pkgName} run ${script}`;
  return `npm run ${script} -w ${pkgName}`;
}

function scriptEntry(id, name, command, cwd) {
  return { id, name, command, cwd, sandbox: "workspace-write", source: "package.json" };
}

/**
 * Concrete apps in a JS monorepo: root `dev:<name>` scripts that are not
 * interactive selectors, plus `apps/*` packages that those scripts do not
 * already cover. Commands always run from the monorepo root.
 */
async function fromJsMonorepo(root, runs, scripts, manager) {
  const covered = new Set();
  const names = Object.keys(scripts).filter((name) => !PACKAGE_NOISE.has(name) && typeof scripts[name] === "string");
  for (const name of names) {
    if (!isPrefixedDevScript(name) && !PREFERRED_SCRIPTS.includes(name)) continue;
    if (!isUsableScript(name, scripts[name])) continue;
    runs.push(scriptEntry(`script:${name}`, name, `${manager} run ${name}`, root));
    addCoverage(covered, name);
    for (const filter of filtersInCommand(scripts[name])) addCoverage(covered, filter);
  }
  for (const folder of ["apps", "applications"]) {
    const appsDir = join(root, folder);
    let entries;
    try { entries = await readdir(appsDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (isSkippedAppName(entry.name)) continue;
      const raw = await textOf(join(appsDir, entry.name, "package.json"));
      if (raw === undefined) continue;
      let pkg;
      try { pkg = JSON.parse(raw); } catch { continue; }
      const pkgScripts = pkg === null || typeof pkg !== "object" ? undefined : pkg.scripts;
      if (pkgScripts === null || typeof pkgScripts !== "object" || Array.isArray(pkgScripts)) continue;
      const pkgName = pkg !== null && typeof pkg === "object" && typeof pkg.name === "string" && pkg.name !== ""
        ? pkg.name
        : entry.name;
      if (isSkippedAppName(pkgName) || !isSafePackageName(pkgName)) continue;
      if (coversPackage(covered, pkgName, entry.name)) continue;
      const scriptNames = Object.keys(pkgScripts).filter((name) => !PACKAGE_NOISE.has(name) && typeof pkgScripts[name] === "string");
      const script = pickScriptName(scriptNames, pkgScripts);
      if (script === undefined) continue;
      runs.push(scriptEntry(`script:${entry.name}`, entry.name, filterRunCommand(manager, pkgName, script), root));
      addCoverage(covered, pkgName);
      addCoverage(covered, entry.name);
    }
  }
}

async function fromPackageJson(root, runs, jsMonorepos) {
  const real = await realDir(root);
  if (real !== undefined && jsMonorepos !== undefined) {
    for (const mono of jsMonorepos) {
      if (isInsideDir(mono, real)) return;
    }
  }
  const raw = await textOf(join(root, "package.json"));
  if (raw === undefined) return;
  let pkg;
  try { pkg = JSON.parse(raw); } catch { return; }
  const monorepo = await isJsMonorepoRoot(root, pkg);
  if (monorepo && real !== undefined && jsMonorepos !== undefined) jsMonorepos.add(real);
  const scripts = pkg === null || typeof pkg !== "object" ? undefined : pkg.scripts;
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) return;
  const manager = await packageManagerOf(root, pkg);
  if (monorepo) {
    await fromJsMonorepo(root, runs, scripts, manager);
    return;
  }
  const names = Object.keys(scripts).filter((name) => !PACKAGE_NOISE.has(name) && typeof scripts[name] === "string");
  const name = pickScriptName(names, scripts);
  if (name === undefined) return;
  runs.push(scriptEntry(`script:${name}`, name, `${manager} run ${name}`, root));
}

async function fromMaven(root, runs, claimed) {
  const pom = await textOf(join(root, "pom.xml"));
  if (pom === undefined) return false;
  const realRoot = await realDir(root);
  if (realRoot !== undefined && claimed !== undefined && claimed.has(realRoot)) return false;
  const launcher = (await textOf(join(root, "mvnw"))) === undefined ? "mvn" : "./mvnw";
  const m2 = await cacheRoot(".m2");
  let visits = 0;

  async function walk(dir, modulePath, depth) {
    if (depth > MAX_MODULE_DEPTH || visits >= MAX_MODULE_VISITS) return;
    visits += 1;
    const real = await realDir(dir);
    if (real !== undefined && claimed !== undefined) {
      if (depth > 0 && claimed.has(real)) return;
      claimed.add(real);
    }
    const app = await springAppName(join(dir, "src", "main", "java"));
    if (app !== undefined && (modulePath === "." || isSafeModulePath(modulePath))) {
      const port = await portFromResources(join(dir, "src", "main", "resources"));
      runs.push({
        id: `maven:${modulePath}`,
        name: app,
        command: modulePath === "." ? `${launcher} spring-boot:run` : `${launcher} -pl ${modulePath} spring-boot:run`,
        cwd: root,
        sandbox: "workspace-write",
        ...(port === undefined ? {} : { port }),
        ...(m2 === undefined ? {} : { writableRoots: [m2] }),
        source: "pom.xml"
      });
    }
    const text = depth === 0 ? pom : await textOf(join(dir, "pom.xml"));
    if (text === undefined) return;
    for (const unit of moduleNames(text)) {
      const base = unit.split(/[\\/]/).filter((part) => part !== "" && part !== ".");
      if (base.length === 0 || base.some((part) => SKIP_DIRS.has(part) || part === "..")) continue;
      const child = join(dir, ...base);
      const childPath = modulePath === "." ? base.join("/") : `${modulePath}/${base.join("/")}`;
      if (!isSafeModulePath(childPath)) continue;
      await walk(child, childPath, depth + 1);
    }
  }

  await walk(root, ".", 0);
  return true;
}

/** Spring Boot in a Gradle build: the wrapper when the project has one, the root task or a subproject's. */
async function fromGradle(root, runs) {
  const wrapper = (await textOf(join(root, "gradlew"))) === undefined ? "gradle" : "./gradlew";
  const settings = (await textOf(join(root, "settings.gradle"))) ?? (await textOf(join(root, "settings.gradle.kts")));
  const gradleHome = await cacheRoot(".gradle");
  const extra = (port, cwd) => ({
    cwd,
    sandbox: "workspace-write",
    ...(port === undefined ? {} : { port }),
    ...(gradleHome === undefined ? {} : { writableRoots: [gradleHome] }),
    source: "build.gradle"
  });
  if (settings !== undefined) {
    const names = gradleModuleNames(settings);
    for (const name of names) {
      const dir = join(root, name.replaceAll(":", "/"));
      const build = (await textOf(join(dir, "build.gradle"))) ?? (await textOf(join(dir, "build.gradle.kts")));
      if (build === undefined || !/spring-boot|org\.springframework\.boot/.test(build)) continue;
      const app = await springAppName(join(dir, "src", "main", "java"));
      if (app === undefined) continue;
      const port = await portFromResources(join(dir, "src", "main", "resources"));
      runs.push({ id: `gradle:${name}`, name: app, command: `${wrapper} :${name}:bootRun`, ...extra(port, dir) });
    }
    return true;
  }
  const build = (await textOf(join(root, "build.gradle"))) ?? (await textOf(join(root, "build.gradle.kts")));
  if (build === undefined) return false;
  const app = await springAppName(join(root, "src", "main", "java"));
  if (app === undefined) return false;
  const port = await portFromResources(join(root, "src", "main", "resources"));
  runs.push({ id: "gradle:bootRun", name: app, command: `${wrapper} bootRun`, ...extra(port, root) });
  return true;
}

async function fromCompose(root, runs) {
  for (const name of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
    if ((await textOf(join(root, name))) === undefined) continue;
    runs.push({ id: "compose:up", name: "compose", command: "docker compose up", cwd: root, sandbox: "workspace-write", source: name });
    return;
  }
}

const DETECTORS = [
  ["package.json", fromPackageJson],
  ["pom.xml", fromMaven],
  ["build.gradle", fromGradle],
  ["compose", fromCompose]
];

const PROJECT_MARKERS = [
  "package.json", "pom.xml",
  "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
  "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"
];

function isProjectRoot(names) {
  return PROJECT_MARKERS.some((name) => names.has(name));
}

/**
 * Project roots under `root`, shallowest first, excluding `root` itself.
 * Hidden and skip directories are not entered; the walk is also bounded by
 * depth and entry count so a large unrelated tree cannot stall the panel.
 */
async function nestedProjectRoots(root) {
  const found = [];
  const seen = new Set();
  const origin = await realDir(root);
  if (origin !== undefined) seen.add(origin);
  let walked = 0;

  async function walk(dir, depth) {
    if (depth > MAX_NEST_DEPTH || walked >= MAX_WALK_DIRS) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    walked += 1;
    const names = new Set(entries.map((entry) => entry.name));
    if (depth > 0 && isProjectRoot(names)) {
      const rel = relPosix(root, dir);
      if (rel === "." || isSafeModulePath(rel)) found.push(dir);
    }
    if (depth >= MAX_NEST_DEPTH) return;
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const child = join(dir, entry.name);
      const real = await realDir(child);
      if (real === undefined || seen.has(real)) continue;
      seen.add(real);
      await walk(child, depth + 1);
    }
  }

  await walk(root, 0);
  found.sort((a, b) => {
    const depthA = relPosix(root, a).split("/").length;
    const depthB = relPosix(root, b).split("/").length;
    return depthA - depthB || a.localeCompare(b);
  });
  return found;
}

/** Spring Boot and compose stay ahead of start-like scripts; test/lint scripts go last when trimming. */
function runPriority(run) {
  if (run.source === "pom.xml" || run.source === "build.gradle") return 0;
  if (typeof run.source === "string" && run.source.includes("compose")) return 1;
  if (run.source === "package.json" && /^(start|dev|serve|develop|preview|run)$/i.test(run.name)) return 2;
  return 3;
}

function trimRuns(runs) {
  if (runs.length <= MAX_RUNS) return runs;
  const ranked = runs.map((run, index) => ({ run, index, rank: runPriority(run) }));
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  const kept = ranked.slice(0, MAX_RUNS);
  kept.sort((a, b) => a.index - b.index);
  return kept.map((item) => item.run);
}

async function detectAt(dir, runs, sources, claimed, prefix, jsMonorepos) {
  for (const [label, detector] of DETECTORS) {
    const before = runs.length;
    try {
      const found = label === "pom.xml"
        ? await fromMaven(dir, runs, claimed)
        : label === "package.json"
          ? await fromPackageJson(dir, runs, jsMonorepos)
          : await detector(dir, runs);
      if (found !== false && runs.length > before) {
        if (prefix !== undefined) {
          for (let i = before; i < runs.length; i += 1) {
            runs[i].id = prefixId(prefix, runs[i].id);
          }
        }
        if (!sources.includes(label)) sources.push(label);
      }
    } catch {
      // A malformed project file is not an error the panel can act on: discovery
      // simply contributes nothing from that detector.
    }
  }
}

/**
 * Infer run configurations from the project itself.
 *
 * Every detector is independent and best-effort: a project is usually one or
 * two kinds, and a detector that throws must not hide the others. The result is
 * cached briefly because the panel polls its list, and a Maven tree walk is far
 * more expensive than the list read that triggers it.
 *
 * Detectors run on the workspace root first, then on nested project roots a
 * few levels down, so a parent `code/` folder still finds each repo inside it.
 * Maven module trees are followed from the reactor that declared them, and a
 * child pom already claimed as a module is not treated as a second reactor.
 * A JS monorepo (pnpm/yarn workspaces, turbo, lerna, or nx) contributes
 * concrete, non-interactive apps: root `dev:<name>` scripts, plus `apps/*`
 * packages that those scripts do not already cover. Interactive selectors
 * such as `turbo-run`, and docs/playground/mock packages, are skipped.
 * Commands run from the monorepo root. Sibling frontends that are not
 * inside a monorepo still each contribute one non-interactive script.
 *
 * @param root - absolute workspace root.
 * @param fresh - bypass the cache, for an explicit reload.
 * @returns discovered entries plus the files they came from.
 */
export async function discover(root, fresh) {
  const cached = cache.get(root);
  if (fresh !== true && cached !== undefined && Date.now() - cached.at < CACHE_MS) return cached.value;
  const runs = [];
  const sources = [];
  const claimed = new Set();
  const jsMonorepos = new Set();
  await detectAt(root, runs, sources, claimed, undefined, jsMonorepos);
  for (const dir of await nestedProjectRoots(root)) {
    // A module of a reactor already walked must not be started from its own pom.
    // Other markers in that directory (a frontend package.json, for example) are still fair game,
    // unless the directory sits inside a JS monorepo that already claimed the tree.
    await detectAt(dir, runs, sources, claimed, relPosix(root, dir), jsMonorepos);
  }
  const value = { runs: trimRuns(runs), sources };
  cache.set(root, { at: Date.now(), value });
  return value;
}

/**
 * The configurations one workspace can run: the file's declarations first, then
 * whatever discovery found under ids the file did not already claim.
 *
 * An explicit file never loses to a guess, and an entry it declares under a
 * discovered id replaces that entry rather than duplicating it.
 *
 * @param root - absolute workspace root.
 * @param fresh - bypass the discovery cache.
 */
export async function resolveRuns(root, fresh) {
  const declared = await loadRuns(root);
  const found = await discover(root, fresh);
  const taken = new Set(declared.runs.map((run) => run.id));
  return {
    file: declared.file,
    runs: [...declared.runs, ...found.runs.filter((run) => !taken.has(run.id))],
    sources: found.sources,
    declared: declared.runs.length
  };
}
