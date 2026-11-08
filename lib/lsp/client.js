import { EventEmitter } from "node:events";
import { encodeMessage, MessageDecoder } from "./jsonrpc.js";
import { pathToUri, spawnServer } from "./servers.js";

let nextId = 1;

/**
 * LSP Client for a single language server instance.
 * Handles JSON-RPC communication over stdio.
 */
export class LspClient extends EventEmitter {
  /**
   * @param {object} server - Server config from servers.js
   * @param {string} root - Workspace root path
   */
  constructor(server, root) {
    super();
    this.server = server;
    this.root = root;
    this.proc = null;
    this.decoder = new MessageDecoder();
    this.pending = new Map(); // id -> { resolve, reject, timeout }
    this.initialized = false;
    this.openDocs = new Map(); // uri -> { version, languageId, text }
    this.stopped = false;
    this.shutdownSent = false;
    this.killTimer = null;
  }

  /**
   * Start the language server and initialize.
   * @returns {Promise<void>}
   */
  async start() {
    if (this.proc) return;

    this.proc = spawnServer(this.server, this.root);

    this.proc.stdout.on("data", (chunk) => {
      const messages = this.decoder.feed(chunk);
      for (const msg of messages) {
        this.handleMessage(msg);
      }
    });

    this.proc.stderr.on("data", (chunk) => {
      this.emit("stderr", chunk.toString());
    });

    this.proc.on("error", (err) => {
      this.emit("error", err);
      this.stop(true);
    });

    this.proc.on("exit", (code) => {
      this.emit("exit", code);
      // Process is already gone: skip graceful shutdown, fail fast
      this.stop(true, code);
    });

    // Initialize handshake
    const initResult = await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToUri(this.root),
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, willSave: false, didSave: false },
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          hover: { dynamicRegistration: false }
        },
        workspace: {
          configuration: true,
          workspaceFolders: true
        }
      },
      workspaceFolders: [{
        uri: pathToUri(this.root),
        name: "workspace"
      }]
    }, 30000);

    this.serverCapabilities = initResult?.capabilities || {};

    await this.notify("initialized", {});
    this.initialized = true;
  }

  /**
   * Handle incoming JSON-RPC message.
   */
  handleMessage(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      // Response to our request
      const pending = this.pending.get(msg.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(msg.id);
        if (msg.error) {
          pending.reject(new LspError(msg.error.message || "LSP error", msg.error.code));
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if (msg.method && msg.id !== undefined) {
      // Request from server - must respond
      this.handleServerRequest(msg);
    } else if (msg.method) {
      // Notification from server
      this.emit("notification", msg);
    }
  }

  /**
   * Handle requests from the server that require a response.
   */
  handleServerRequest(msg) {
    let result = null;
    let error = null;

    switch (msg.method) {
      case "workspace/configuration":
        // Return empty config for each requested item
        result = msg.params?.items?.map(() => ({})) || [];
        break;
      case "window/workDoneProgress/create":
        // Acknowledge progress creation
        result = null;
        break;
      case "client/registerCapability":
      case "client/unregisterCapability":
        // Acknowledge capability registration
        result = null;
        break;
      case "workspace/workspaceFolders":
        result = [{ uri: pathToUri(this.root), name: "workspace" }];
        break;
      default:
        // Unknown request - respond with method not found
        error = { code: -32601, message: `Method not supported: ${msg.method}` };
    }

    const response = { jsonrpc: "2.0", id: msg.id };
    if (error) {
      response.error = error;
    } else {
      response.result = result;
    }

    try {
      this.proc?.stdin?.write(encodeMessage(response));
    } catch {
      // Ignore write errors
    }
  }

  /**
   * Send a request and wait for response.
   * @param {string} method
   * @param {object} params
   * @param {number} timeoutMs
   * @returns {Promise<any>}
   */
  request(method, params, timeoutMs = 10000) {
    if (this.stopped || !this.proc) {
      return Promise.reject(new LspError("Client stopped", "CLIENT_STOPPED"));
    }

    const id = nextId++;
    const message = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        // Send cancellation
        this.notify("$/cancelRequest", { id });
        reject(new LspError(`Request ${method} timed out`, "TIMEOUT"));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });

      try {
        this.proc.stdin.write(encodeMessage(message));
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Send a notification (no response expected).
   * @param {string} method
   * @param {object} params
   */
  notify(method, params) {
    if (this.stopped || !this.proc) return;
    const message = { jsonrpc: "2.0", method, params };
    try {
      this.proc.stdin.write(encodeMessage(message));
    } catch {
      // Ignore write errors on notifications
    }
  }

  /**
   * Open or update a document in the language server.
   * @param {string} uri - file:// URI
   * @param {string} languageId
   * @param {string} text - Current document text
   */
  async didOpen(uri, languageId, text) {
    const existing = this.openDocs.get(uri);
    if (existing) {
      // Only send didChange if text actually changed
      if (existing.text === text) return;

      existing.version++;
      existing.text = text;
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: existing.version },
        contentChanges: [{ text }]
      });
      return;
    }

    this.openDocs.set(uri, { version: 1, languageId, text });
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text }
    });
  }

  /**
   * Close a document.
   * @param {string} uri
   */
  didClose(uri) {
    if (!this.openDocs.has(uri)) return;
    this.openDocs.delete(uri);
    this.notify("textDocument/didClose", {
      textDocument: { uri }
    });
  }

  /**
   * Request definition at position.
   * @param {string} uri
   * @param {number} line - 0-based
   * @param {number} character - 0-based
   * @returns {Promise<object[]>}
   */
  async definition(uri, line, character) {
    const result = await this.request("textDocument/definition", {
      textDocument: { uri },
      position: { line, character }
    });
    return normalizeLocations(result);
  }

  /**
   * Request implementations at position.
   * @param {string} uri
   * @param {number} line - 0-based
   * @param {number} character - 0-based
   * @returns {Promise<object[]>}
   */
  async implementations(uri, line, character) {
    let result;
    try {
      result = await this.request("textDocument/implementation", {
        textDocument: { uri },
        position: { line, character }
      });
    } catch (err) {
      // Servers without implementation support answer MethodNotFound.
      if (err && err.code === -32601) return [];
      throw err;
    }
    return normalizeLocations(result);
  }

  /**
   * Request references at position.
   * @param {string} uri
   * @param {number} line
   * @param {number} character
   * @param {boolean} includeDeclaration
   * @returns {Promise<object[]>}
   */
  async references(uri, line, character, includeDeclaration = true) {
    const result = await this.request("textDocument/references", {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration }
    });
    return normalizeLocations(result);
  }

  /**
   * Gracefully stop the language server.
   * Sends shutdown request, then exit notification, then kills if needed.
   * @param {boolean} exited - True when the process already exited/errored;
   *   skips the graceful handshake and rejects pending requests immediately.
   * @param {number|null} [exitCode]
   */
  async stop(exited = false, exitCode = null) {
    if (this.stopped) return;

    // Try graceful shutdown first (before marking stopped)
    if (!exited && this.proc && !this.shutdownSent) {
      this.shutdownSent = true;
      try {
        // Send shutdown request directly (bypass stopped check)
        const id = nextId++;
        const message = { jsonrpc: "2.0", id, method: "shutdown", params: {} };
        const shutdownPromise = new Promise((resolve) => {
          const timeout = setTimeout(resolve, 2000);
          this.pending.set(id, {
            resolve: () => { clearTimeout(timeout); resolve(); },
            reject: () => { clearTimeout(timeout); resolve(); },
            timeout
          });
        });

        this.proc.stdin.write(encodeMessage(message));
        await shutdownPromise;
      } catch {
        // Ignore shutdown errors
      }

      try {
        // Send exit notification
        this.proc.stdin.write(encodeMessage({ jsonrpc: "2.0", method: "exit", params: {} }));
        this.proc.stdin?.end();
      } catch {
        // Ignore
      }
    }

    // Now mark stopped and reject remaining pending
    this.stopped = true;
    const failure = exited
      ? new LspError(
          `Language server ${this.server.id} exited${exitCode === null ? "" : ` (code ${exitCode})`}`,
          "SERVER_EXITED"
        )
      : new LspError("Client stopped", "CLIENT_STOPPED");
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(failure);
    }
    this.pending.clear();

    // Force kill after grace period. The timer is dropped when the process
    // really exits, so a graceful shutdown does not hold the event loop (and
    // the kill callback does not fire on an already-dead pid).
    if (this.proc) {
      const proc = this.proc;
      this.killTimer = setTimeout(() => {
        this.killTimer = null;
        try { proc.kill("SIGKILL"); } catch {}
      }, 1000);
      proc.once("exit", () => {
        if (this.killTimer !== null) {
          clearTimeout(this.killTimer);
          this.killTimer = null;
        }
      });
    }

    this.openDocs.clear();
    this.initialized = false;
  }
}

/**
 * Normalize LSP location result to array of { uri, range }.
 * LSP can return: Location | Location[] | LocationLink[] | null
 */
function normalizeLocations(result) {
  if (!result) return [];
  const items = Array.isArray(result) ? result : [result];
  const locations = [];

  for (const item of items) {
    if (!item) continue;
    // LocationLink has targetUri/targetRange, Location has uri/range
    const uri = item.uri || item.targetUri;
    const range = item.range || item.targetRange || item.targetSelectionRange;
    if (uri && range) {
      locations.push({ uri, range });
    }
  }

  return locations;
}

export class LspError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "LspError";
    this.code = code;
  }
}
