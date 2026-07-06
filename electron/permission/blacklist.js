/**
 * Hard, non-bypassable blacklist.
 *
 * These patterns ALWAYS result in a deny, in every tier (including
 * ALWAYS_AGREE). They catch system-wide data destruction that no user should
 * accidentally auto-approve. The list is built-in and not user-editable; users
 * add their own deny / high-risk rules in the Rules view.
 *
 * Patterns are RegExp tested against the full command string (case-insensitive)
 * or, for file ops, against the absolute target path.
 */

// Command-form destructive patterns. Anchored loosely; we test with .test().
const COMMAND_PATTERNS = [
  // rm -rf against root / home / system roots
  /\brm\s+(?:-[a-z]*r[a-z]*\s+(?:-[a-z]+\s+)*|(?:--recursive\b[^&|;]*))\s*(?:\/|\/\*|~|\$HOME|\$HOME\/|\$PWD|\/c\/|C:\\?|C:\\Users|C:\\Windows)/i,
  /\brm\s+-[a-z]*f[a-z]*\s+(?:-[a-z]+\s+)*\s*(?:\/|~|\$HOME)\b/i,
  // Windows recursive delete on system roots
  /\bdel\s+\/[sS].*C:\\(Windows|Users|Program Files|System32)/i,
  /\bdel\s+\/[sS].*C:\\?\s*$/i,
  /\brmdir\s+\/s.*C:\\(Windows|Users|Program Files)/i,
  // Disk formatting / filesystem creation
  /\bformat\s+[A-Z]:/i,
  /\bmkfs\b/i,
  // dd to a block device
  /\bdd\b.*\bof=\/dev\/(?:sd|nvme|hd|vd|disk)/i,
  // Redirect to a raw block device
  />\s*\/dev\/(?:sd|nvme|hd|vd|disk)/i,
  // Fork bomb
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  // chmod -R 777 on root / home
  /\bchmod\s+-R\s+777\s+(?:\/|~|\$HOME)\b/i,
  // diskpart clean (wipes disk) — bare 'clean' after diskpart is hard to scope; catch the pipe form
  /\bdiskpart\b.*\bclean\b/i,
  // shred / wipe on system roots
  /\bshred\s+.*(?:\/|~|\$HOME|C:\\)\s*$/i,
  // rm -rf with force + recursive combined on root variants
  /\brm\s+--no-preserve-root\b/i
]

// File-op targets that are always denied (overwriting/wiping system dirs).
// Tested against the absolute target path of Edit/Write/MultiEdit.
const PATH_PATTERNS = [
  /^\/(?:etc|usr|bin|sbin|boot|proc|sys)\b/i,
  /^\/(?:root|home\/[^/]+\/\.ssh)\b/i,
  /^[A-Z]:\\(?:Windows|System32|Program Files|Program Files \(x86\)|Users\\[^\\]+\\\.ssh)\b/i
]

/**
 * @param {{ command?: string, path?: string }} input
 * @returns {{ hit: boolean, pattern?: string }}
 */
export function checkBlacklist({ command, path }) {
  if (command) {
    for (const re of COMMAND_PATTERNS) {
      if (re.test(command)) return { hit: true, pattern: re.source }
    }
  }
  if (path) {
    for (const re of PATH_PATTERNS) {
      if (re.test(path)) return { hit: true, pattern: re.source }
    }
  }
  return { hit: false }
}

/** Exposed read-only to the Rules view so users can see what's enforced. */
export function describeBlacklist() {
  return {
    commands: COMMAND_PATTERNS.map((r) => r.source),
    paths: PATH_PATTERNS.map((r) => r.source)
  }
}
