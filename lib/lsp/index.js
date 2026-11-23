import { readFile } from "node:fs/promises";
import { LspClient, LspError } from "./client.js";
import { commandExists, findProjectRoot, languageOf, pathToUri, resolveServer, serversFor } from "./servers.js";

/**
 * LSP Service - manages language server instances and routes queries.
 */
const IDLE_MS = 5 * 60 * 1000;
const SWEEP_MS = 30 * 1000;

export class LspService {
  constructor() {
    /** @type {Map<string, LspClient>} key: `${serverId}:${root}` */
    this.clients = new Map();
    /** @type {Map<string, Promise<LspClient>>} */
    this.starting = new Map();
    /** @type {Map<string, number>} key -> epoch ms of the last request that used it */
    this.lastUsed = new Map();
    this.reaper = null;
    this.stopped = false;
  }

  /** Restart the idle clock for one server. */
  touch(key) {
    this.lastUsed.set(key, Date.now());
  }

  /** Start the idle sweep once, unref'd so it never holds the host process open. */
  armReaper() {
    if (this.reaper !== null || this.stopped) return;
    this.reaper = setInterval(() => { this.reap(); }, SWEEP_MS);
    if (typeof this.reaper.unref === "function") this.reaper.unref();
  }

  /**
   * Stop servers that have had no request for IDLE_MS.
   *
   * A server is started by the first query (or a warmup) for a language/root,
   * and until now it lived for the life of the page — a jdtls or clangd indexing
   * a large project kept consuming CPU and memory long after the reader moved on.
   * The next query starts it again; that cold start is the trade for not holding
   * idle processes.
   */
  reap() {
    if (this.stopped) return;
    const now = Date.now();
    for (const [key, client] of this.clients) {
      if (now - (this.lastUsed.get(key) ?? 0) < IDLE_MS) continue;
      this.clients.delete(key);
      this.lastUsed.delete(key);
      try { void client.stop().catch(() => {}); } catch {}
    }
    if (this.clients.size === 0 && this.reaper !== null) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
  }

  /**
   * Get or start a client for the given file.
   * @param {string} filePath - Absolute file path
   * @param {string} root - Workspace root
   * @returns {Promise<LspClient>}
   */
  async clientFor(filePath, root) {
    const language = languageOf(filePath);
    if (!language) {
      throw new LspError("Unsupported file type", "LSP_UNAVAILABLE");
    }

    const server = await resolveServer(language);
    if (!server) {
      const names = serversFor(language).map((s) => s.command);
      if (names.length === 0) {
        throw new LspError(`No language server for ${language}`, "LSP_UNAVAILABLE");
      }
      throw new LspError(
        `Language server '${names.join("' or '")}' not found in PATH`,
        "LSP_UNAVAILABLE"
      );
    }

    const projectRoot = await findProjectRoot(filePath, server.rootFiles, root);
    const key = `${server.id}:${projectRoot}`;
    const existing = this.clients.get(key);
    if (existing && !existing.stopped) {
      this.touch(key);
      return existing;
    }

    // Check if already starting
    const starting = this.starting.get(key);
    if (starting) {
      return starting;
    }

    // Start new client
    const promise = this.startClient(server, projectRoot, key);
    this.starting.set(key, promise);

    try {
      const client = await promise;
      // stop() may have completed while the handshake was in flight. Never
      // re-add a client to a stopped service -- it would be an orphan process.
      if (this.stopped) {
        await client.stop().catch(() => {});
        throw new LspError("service stopped", "LSP_STOPPED");
      }
      this.clients.set(key, client);
      this.touch(key);
      this.armReaper();
      return client;
    } finally {
      this.starting.delete(key);
    }
  }

  async startClient(server, root, key) {
    // Check if command exists (cached)
    const exists = await commandExists(server.command);
    if (!exists) {
      throw new LspError(
        `Language server '${server.command}' not found in PATH`,
        "LSP_UNAVAILABLE"
      );
    }

    const client = new LspClient(server, root);

    client.on("error", (err) => {
      console.error(`[dsh-idea] LSP ${server.id} error:`, err.message);
    });

    client.on("exit", () => {
      // An old client's exit can arrive after a replacement was registered.
      // Only evict the map entry if it still points at this instance.
      if (this.clients.get(key) === client) {
        this.clients.delete(key);
        this.lastUsed.delete(key);
      }
    });

    try {
      await client.start();
    } catch (err) {
      // The process is already spawned: an initialize timeout or a failed
      // handshake must not leak it. Stop tears the child down (kill timer
      // backstopped by SIGKILL) and rejects any pending requests.
      await client.stop().catch(() => {});
      throw err;
    }
    return client;
  }

  /**
   * Ensure document is open and synchronized in the language server.
   * @param {LspClient} client
   * @param {string} filePath
   * @param {string|undefined} text - Current text from editor, or undefined to read from disk
   * @returns {Promise<string>} - Document URI
   */
  async ensureOpen(client, filePath, text) {
    const uri = pathToUri(filePath);
    const language = languageOf(filePath);

    // If text not provided, read from disk
    let content = text;
    if (content === undefined) {
      try {
        content = await readFile(filePath, "utf8");
      } catch (err) {
        throw new LspError(`Cannot read file: ${err.message}`, "FILE_ERROR");
      }
    }

    await client.didOpen(uri, language, content);
    return uri;
  }

  /**
   * Start the server for a file and sync its document, without running a
   * query. Used to pre-warm a language server so the first jump is fast.
   * @returns {Promise<boolean>} false when no server exists for the language
   */
  async warm(filePath, root) {
    try {
      const client = await this.clientFor(filePath, root);
      await this.ensureOpen(client, filePath);
      return true;
    } catch (err) {
      if (err && err.code === "LSP_UNAVAILABLE") return false;
      throw err;
    }
  }

  /**
   * Query the language server.
   * @param {object} params
   * @param {string} params.operation - "goToDefinition" | "findReferences" | "goToImplementation"
   * @param {string} params.filePath - Absolute file path
   * @param {string} params.workspaceRoot - Workspace root
   * @param {object} params.position - { line, character } (0-based)
   * @param {string} [params.text] - Current document text from editor
   * @returns {Promise<{ kind: "locations", locations: object[] }>}
   */
  async query({ operation, filePath, workspaceRoot, position, text }) {
    if (this.stopped) {
      throw new LspError("Service stopped", "LSP_UNAVAILABLE");
    }

    // Retry once with a fresh server when the previous one died mid-request,
    // so a single crash does not surface "Language server exited" to the user.
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      let client;
      try {
        client = await this.clientFor(filePath, workspaceRoot);
      } catch (err) {
        if (attempt === 0 && (err.code === "SERVER_EXITED" || err.code === "CLIENT_STOPPED")) {
          lastError = err;
          continue;
        }
        throw err;
      }

      const uri = await this.ensureOpen(client, filePath, text);

      try {
        let locations;
        if (operation === "goToDefinition") {
          locations = await client.definition(uri, position.line, position.character);
        } else if (operation === "goToImplementation") {
          locations = await client.implementations(uri, position.line, position.character);
        } else if (operation === "findReferences") {
          locations = await client.references(uri, position.line, position.character);
        } else {
          throw new LspError(`Unknown operation: ${operation}`, "BAD_OPERATION");
        }
        return { kind: "locations", locations };
      } catch (err) {
        if (attempt === 0 && (err.code === "SERVER_EXITED" || err.code === "CLIENT_STOPPED")) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  /**
   * Stop all language servers.
   */
  async stop() {
    this.stopped = true;
    if (this.reaper !== null) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
    const stops = [];
    for (const client of this.clients.values()) {
      stops.push(client.stop().catch(() => {}));
    }
    await Promise.allSettled(stops);
    this.clients.clear();
    this.lastUsed.clear();
  }
}

export { LspError } from "./client.js";
