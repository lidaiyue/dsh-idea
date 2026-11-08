import { readFile } from "node:fs/promises";
import { LspClient, LspError } from "./client.js";
import { commandExists, languageOf, pathToUri, serverFor } from "./servers.js";

/**
 * LSP Service - manages language server instances and routes queries.
 */
export class LspService {
  constructor() {
    /** @type {Map<string, LspClient>} key: `${serverId}:${root}` */
    this.clients = new Map();
    /** @type {Map<string, Promise<LspClient>>} */
    this.starting = new Map();
    this.stopped = false;
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

    const server = serverFor(language);
    if (!server) {
      throw new LspError(`No language server for ${language}`, "LSP_UNAVAILABLE");
    }

    const key = `${server.id}:${root}`;
    const existing = this.clients.get(key);
    if (existing && !existing.stopped) {
      return existing;
    }

    // Check if already starting
    const starting = this.starting.get(key);
    if (starting) {
      return starting;
    }

    // Start new client
    const promise = this.startClient(server, root, key);
    this.starting.set(key, promise);

    try {
      const client = await promise;
      this.clients.set(key, client);
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
      this.clients.delete(key);
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
          // IDEA-style: when the definition lands on an interface or
          // abstract method (Spring-style service injection), keep going to
          // its implementation(s) so the jump ends in the impl class.
          if (locations.length === 1) {
            try {
              const head = locations[0];
              const impls = await client.implementations(head.uri, head.range.start.line, head.range.start.character);
              if (impls.length > 0) locations = impls;
            } catch {
              // Implementation probe failed: keep the plain definition.
            }
          }
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
    const stops = [];
    for (const client of this.clients.values()) {
      stops.push(client.stop().catch(() => {}));
    }
    await Promise.allSettled(stops);
    this.clients.clear();
  }
}

export { LspError } from "./client.js";
