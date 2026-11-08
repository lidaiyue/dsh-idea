// Credential-shaped paths, in one place so every reader agrees on them.
//
// Content search (nav/search.js) must not echo a secret from a repository that
// never wrote a .gitignore, and the file routes must not serve the git config or
// an SSH material directory that happens to sit inside the workspace. Both need
// the same tables; duplicating them is how the two policies drift apart.

export const SECRET_FILE_NAMES = [
  ".env", ".npmrc", ".netrc", ".pgpass", ".htpasswd", "credentials",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"
];

export const SECRET_FILE_EXTENSIONS = ["pem", "key", "p12", "pfx", "jks", "keystore"];

export const SECRET_DIR_NAMES = [".ssh", ".aws", ".gnupg"];

// VCS internals are not credentials by name, but `.git/config` carries remote
// URLs with embedded tokens and `.git/config` is never a legitimate editing
// target — the file tree already hides `.git`.
export const SECRET_INTERNAL_DIRS = [".git"];

/** Whether `name` is a credential file. */
export function isSecretFile(name) {
  const lower = String(name == null ? "" : name).toLowerCase();
  if (SECRET_FILE_NAMES.indexOf(lower) >= 0 || lower.indexOf(".env.") === 0) return true;
  const dot = lower.lastIndexOf(".");
  return dot > 0 && SECRET_FILE_EXTENSIONS.indexOf(lower.slice(dot + 1)) >= 0;
}

/** Whether a `/`-separated relative path sits under a credentials directory. */
export function isSecretPath(rel) {
  const parts = String(rel == null ? "" : rel).split("/");
  for (let i = 0; i < parts.length; i++) {
    if (SECRET_DIR_NAMES.indexOf(parts[i].toLowerCase()) >= 0) return true;
  }
  return false;
}

/**
 * Whether a relative path must be refused by the file routes: credentials or
 * VCS-internal directories, all of which the tree hides already. Plain `.env`
 * and `*.pem` stay readable — editing them is a normal thing to do, and the
 * search engine's silence about them is about passive scanning, not access.
 */
export function isForbiddenPath(rel) {
  if (isSecretPath(rel)) return true;
  const parts = String(rel == null ? "" : rel).split("/");
  for (let i = 0; i < parts.length; i++) {
    if (SECRET_INTERNAL_DIRS.indexOf(parts[i].toLowerCase()) >= 0) return true;
  }
  return false;
}
