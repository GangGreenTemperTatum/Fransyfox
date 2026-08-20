// Precompiled extension-blacklist matcher.
//
// Replaces the per-call pattern of lowercasing the haystack and running a
// regex replace (`normalizeForMatcher`) per token per invocation. Tokens are
// compiled once into a single alternation regex; matching a value is then a
// single regex test with no intermediate string allocation.
//
// Semantics preserved from the original matcher: a value matched when its
// lowercased form contained the token, OR when both sides stripped of
// non-alphanumerics contained the token. The stripped ("compact") check is a
// strict superset of the literal check, so each token compiles to its compact
// characters joined by `[^a-zA-Z0-9]*`. Tokens with no alphanumeric
// characters at all fall back to an escaped literal alternative.
//
// This module is a pure ES module (no chrome APIs, no globals) so it can be
// inlined by the bundler into both the MAIN-world content script and the
// service worker.

export interface CompiledBlacklist {
  regex: RegExp | null;
}

const EXTENSION_URL_REGEX = /\b(?:chrome|moz)-extension:\/\/[a-z0-9-]{8,}/i;

export function hasExtensionUrl(value: string): boolean {
  return EXTENSION_URL_REGEX.test(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenToPattern(token: string): string | null {
  if (!token) return null;
  const compact = token.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!compact) {
    return escapeRegex(token);
  }
  return compact.split('').join('[^a-zA-Z0-9]*');
}

export function compileBlacklist(tokens: readonly string[]): CompiledBlacklist {
  const patterns: string[] = [];
  for (const token of tokens) {
    if (typeof token !== 'string') continue;
    const pattern = tokenToPattern(token);
    if (pattern) {
      patterns.push(pattern);
    }
  }
  if (patterns.length === 0) {
    return { regex: null };
  }
  return { regex: new RegExp(patterns.join('|'), 'i') };
}

export function matchesBlacklistText(
  compiled: CompiledBlacklist,
  value: string,
  includeExtensionUrl = true
): boolean {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  if (includeExtensionUrl && hasExtensionUrl(value)) {
    return true;
  }
  return compiled.regex ? compiled.regex.test(value) : false;
}
