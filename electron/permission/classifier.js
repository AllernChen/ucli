import { checkBlacklist } from './blacklist.js'

/**
 * User rule patterns. We support a Claude-inspired matcher syntax so rules
 * transfer cleanly to the generated Claude settings.json, plus a bare regex
 * escape hatch:
 *
 *   Bash(rm:*)                  Bash command whose first token is `rm`
 *   Bash(git push --force:*)    Bash command starting with `git push --force`
 *   Bash(re:git\s+push.*--force) regex tested against the full command
 *   Edit(src/**)                 glob on the edited file path
 *   Write(~/.ssh/**)             glob (home-expanded) on the written path
 *   Read(/etc/**)                glob on the read path
 *   WebFetch(github.com)         host suffix match
 *   re:<regex>                   regex on command (any tool)
 *   <glob>                       glob on path (any file tool)
 *
 * @typedef {{ tool: string, spec: string, kind: 'prefix'|'regex'|'glob'|'host' }} ParsedPattern
 */

/** Convert a glob to a RegExp. Supports *, **, ?, and treats / and \ as separators. */
function globToRegex(glob) {
  let s = glob.replace(/\\/g, '/')
  let re = '^'
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '*') {
      if (s[i + 1] === '*') {
        i++
        // **/  → match across separators; **  → match anything
        if (s[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+()[]{}^$|'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  re += '$'
  return new RegExp(re, 'i')
}

function expandHome(p) {
  if (!p) return p
  if (p === '~') return process.env.HOME || process.env.USERPROFILE || '~'
  if (p.startsWith('~/')) return (process.env.HOME || process.env.USERPROFILE || '~') + p.slice(1)
  if (p.startsWith('~\\')) return (process.env.USERPROFILE || process.env.HOME || '~') + p.slice(1)
  return p
}

/**
 * Parse a user pattern string.
 * @param {string} str
 * @returns {ParsedPattern | null}
 */
export function parsePattern(str) {
  const s = str.trim()
  if (!s) return null
  const m = s.match(/^([A-Za-z_]+)\((.*)\)$/)
  if (m) {
    const tool = m[1]
    const spec = m[2]
    if (spec.startsWith('re:')) return { tool, spec: spec.slice(3), kind: 'regex' }
    if (spec.endsWith(':*')) return { tool, spec: spec.slice(0, -2).trim(), kind: 'prefix' }
    if (tool === 'WebFetch') return { tool, spec, kind: 'host' }
    // Edit/Write/Read/etc. → glob on path
    return { tool, spec, kind: 'glob' }
  }
  if (s.startsWith('re:')) return { tool: '*', spec: s.slice(3), kind: 'regex' }
  // bare glob → any file tool
  return { tool: '*', spec: s, kind: 'glob' }
}

function matchOne(parsed, { tool, command, path, host }) {
  if (parsed.tool !== '*' && parsed.tool.toLowerCase() !== (tool || '').toLowerCase()) {
    // Bash rule can also apply to codex shell executions reported as 'Bash'
    return false
  }
  if (parsed.kind === 'prefix') {
    if (!command) return false
    // Match if the command starts with the prefix (as a leading command fragment).
    return command.trim().startsWith(parsed.spec)
  }
  if (parsed.kind === 'regex') {
    const re = new RegExp(parsed.spec, 'i')
    return command ? re.test(command) : (path ? re.test(path) : false)
  }
  if (parsed.kind === 'host') {
    if (!host) return false
    return host === parsed.spec || host.endsWith('.' + parsed.spec) || host.includes(parsed.spec)
  }
  if (parsed.kind === 'glob') {
    if (!path) return false
    const normalized = expandHome(path).replace(/\\/g, '/')
    const re = globToRegex(parsed.spec)
    const base = normalized.split('/').pop()
    // Match against the full path (for ~/... style globs) or the basename
    // (for relative globs like `.env*` or `Read(*)`).
    return re.test(normalized) || re.test(base)
  }
  return false
}

/**
 * Classify a tool call against the blacklist + a ruleset.
 *
 * @param {{ tool: string, command?: string, path?: string, host?: string }} input
 * @param {{ deny?: string[], highRisk?: string[], allow?: string[] }} ruleset
 * @returns {{ classification: 'blacklist'|'deny'|'high-risk'|'allow'|'default', matched?: string }}
 */
export function classify(input, ruleset = {}) {
  const bl = checkBlacklist({ command: input.command, path: input.path })
  if (bl.hit) return { classification: 'blacklist', matched: bl.pattern }

  const scan = (list) => {
    if (!list) return null
    for (const raw of list) {
      const p = parsePattern(raw)
      if (p && matchOne(p, input)) return raw
    }
    return null
  }

  const deny = scan(ruleset.deny)
  if (deny) return { classification: 'deny', matched: deny }

  const high = scan(ruleset.highRisk)
  if (high) return { classification: 'high-risk', matched: high }

  const allow = scan(ruleset.allow)
  if (allow) return { classification: 'allow', matched: allow }

  return { classification: 'default' }
}

/** Normalize a raw adapter tool call into the classifier input shape. */
export function toClassifierInput(tool, rawInput) {
  const inp = rawInput || {}
  const out = { tool }
  if (typeof inp.command === 'string') out.command = inp.command
  if (typeof inp.file_path === 'string') out.path = inp.file_path
  else if (typeof inp.path === 'string') out.path = inp.path
  else if (typeof inp.notebook_path === 'string') out.path = inp.notebook_path
  if (typeof inp.url === 'string') {
    try {
      out.host = new URL(inp.url).host
    } catch {
      out.host = inp.url
    }
  }
  return out
}
