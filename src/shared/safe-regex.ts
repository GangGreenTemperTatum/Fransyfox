export const MAX_USER_REGEX_PATTERN_CHARS = 512;
export const MAX_USER_REGEX_INPUT_CHARS = 64 * 1024;
export const MAX_USER_REGEX_REPETITIONS = 25;
export const MAX_USER_REGEX_GROUP_DEPTH = 20;
export const MAX_USER_REGEX_REPEAT_BOUND = 10_000;
export const MAX_USER_REGEX_RULES = 50;

interface GroupState {
  hasAlternation: boolean;
  hasRepetition: boolean;
  lookaround: boolean;
  startIndex: number;
  lastAtom: string | null;
  variableAtoms: Set<string>;
}

interface Quantifier {
  end: number;
  upperBound: number | null;
  variable: boolean;
}

export interface SafeRegexCompileResult {
  regex: RegExp | null;
  error: string | null;
}

function readQuantifier(pattern: string, index: number): Quantifier | null {
  const token = pattern[index];
  if (token === '*' || token === '+') {
    return { end: pattern[index + 1] === '?' ? index + 1 : index, upperBound: null, variable: true };
  }
  if (token === '?') {
    return { end: index, upperBound: 1, variable: true };
  }
  if (token !== '{') return null;
  const close = pattern.indexOf('}', index + 1);
  if (close < 0 || close - index > 24) return null;
  const body = pattern.slice(index + 1, close);
  const match = /^(\d+)(?:,(\d*))?$/.exec(body);
  if (!match) return null;
  const upperBound = match[2] === undefined
    ? Number(match[1])
    : match[2] === ''
      ? null
      : Number(match[2]);
  return {
    end: pattern[close + 1] === '?' ? close + 1 : close,
    upperBound,
    variable: match[2] !== undefined && (match[2] === '' || Number(match[1]) !== upperBound)
  };
}

/**
 * Rejects regex structures that can make JavaScript's backtracking engine do
 * unbounded or highly nonlinear work. This is intentionally conservative:
 * users can rewrite a rejected expression into a non-nested form.
 */
export function getRegexSafetyError(pattern: string): string | null {
  if (typeof pattern !== 'string' || !pattern.length) return 'Pattern is empty.';
  if (pattern.length > MAX_USER_REGEX_PATTERN_CHARS) {
    return `Pattern exceeds ${MAX_USER_REGEX_PATTERN_CHARS} characters.`;
  }

  const groups: GroupState[] = [{
    hasAlternation: false,
    hasRepetition: false,
    lookaround: false,
    startIndex: -1,
    lastAtom: null,
    variableAtoms: new Set()
  }];
  let inCharacterClass = false;
  let characterClassStart = -1;
  let repetitionCount = 0;

  function noteQuantifier(group: GroupState, atom: string | null, quantifier: Quantifier): string | null {
    group.hasRepetition = true;
    if (quantifier.variable && atom) {
      if (group.variableAtoms.has(atom)) {
        return 'Repeated variable-width matching of the same token is not allowed.';
      }
      group.variableAtoms.add(atom);
    }
    return null;
  }

  for (let index = 0; index < pattern.length; index++) {
    const token = pattern[index];
    if (token === '\\') {
      const escaped = pattern[index + 1] || '';
      if (!inCharacterClass && (/^[1-9]$/.test(escaped) || (escaped === 'k' && pattern[index + 2] === '<'))) {
        return 'Backreferences are not allowed in user regex patterns.';
      }
      if (!inCharacterClass) {
        groups[groups.length - 1].lastAtom = `escape:${escaped}`;
      }
      index += 1;
      continue;
    }
    if (token === '[' && !inCharacterClass) {
      inCharacterClass = true;
      characterClassStart = index;
      continue;
    }
    if (token === ']' && inCharacterClass) {
      inCharacterClass = false;
      groups[groups.length - 1].lastAtom = `class:${pattern.slice(characterClassStart, index + 1)}`;
      continue;
    }
    if (inCharacterClass) continue;

    if (token === '(') {
      let lookaround = false;
      if (pattern[index + 1] === '?') {
        const marker = pattern[index + 2];
        if (marker === '=' || marker === '!') {
          lookaround = true;
          index += 2;
        }
        else if (marker === '<' && (pattern[index + 3] === '=' || pattern[index + 3] === '!')) {
          lookaround = true;
          index += 3;
        }
        else if (marker === ':') {
          index += 2;
        }
        else if (marker === '<') {
          const nameEnd = pattern.indexOf('>', index + 3);
          if (nameEnd > 0) index = nameEnd;
        }
      }
      if (lookaround) {
        return 'Lookaround is not allowed in user regex patterns.';
      }
      groups.push({
        hasAlternation: false,
        hasRepetition: false,
        lookaround,
        startIndex: index,
        lastAtom: null,
        variableAtoms: new Set()
      });
      if (groups.length - 1 > MAX_USER_REGEX_GROUP_DEPTH) {
        return `Pattern exceeds ${MAX_USER_REGEX_GROUP_DEPTH} nested groups.`;
      }
      continue;
    }

    if (token === '|') {
      groups[groups.length - 1].hasAlternation = true;
      groups[groups.length - 1].lastAtom = null;
      groups[groups.length - 1].variableAtoms.clear();
      continue;
    }

    if (token === ')' && groups.length > 1) {
      const group = groups.pop() as GroupState;
      const parent = groups[groups.length - 1];
      const quantifier = readQuantifier(pattern, index + 1);
      if (quantifier) {
        repetitionCount += 1;
        if (group.hasRepetition) {
          return 'Nested repetition is not allowed in user regex patterns.';
        }
        if (group.hasAlternation) {
          return 'Repeated alternation is not allowed in user regex patterns.';
        }
        if (group.lookaround) {
          return 'Repeated lookaround is not allowed in user regex patterns.';
        }
        if (quantifier.upperBound !== null && quantifier.upperBound > MAX_USER_REGEX_REPEAT_BOUND) {
          return `Repeat bounds cannot exceed ${MAX_USER_REGEX_REPEAT_BOUND}.`;
        }
        const repeatedAtom = `group:${pattern.slice(group.startIndex, index + 1)}`;
        const repetitionError = noteQuantifier(parent, repeatedAtom, quantifier);
        if (repetitionError) return repetitionError;
        parent.lastAtom = repeatedAtom;
        index = quantifier.end;
      }
      else {
        parent.hasRepetition = parent.hasRepetition || group.hasRepetition;
        parent.hasAlternation = parent.hasAlternation || group.hasAlternation;
        for (const atom of group.variableAtoms) {
          parent.variableAtoms.add(atom);
        }
        parent.lastAtom = `group:${pattern.slice(group.startIndex, index + 1)}`;
      }
      continue;
    }

    const quantifier = readQuantifier(pattern, index);
    if (quantifier) {
      repetitionCount += 1;
      const group = groups[groups.length - 1];
      const repetitionError = noteQuantifier(group, group.lastAtom, quantifier);
      if (repetitionError) return repetitionError;
      if (quantifier.upperBound !== null && quantifier.upperBound > MAX_USER_REGEX_REPEAT_BOUND) {
        return `Repeat bounds cannot exceed ${MAX_USER_REGEX_REPEAT_BOUND}.`;
      }
      index = quantifier.end;
      continue;
    }

    if (token !== '^' && token !== '$') {
      groups[groups.length - 1].lastAtom = token === '.' ? 'any' : `literal:${token}`;
    }
  }

  if (repetitionCount > MAX_USER_REGEX_REPETITIONS) {
    return `Pattern exceeds ${MAX_USER_REGEX_REPETITIONS} repetition operators.`;
  }

  return null;
}

export function compileSafeRegex(pattern: string, flags = ''): SafeRegexCompileResult {
  const safetyError = getRegexSafetyError(pattern);
  if (safetyError) return { regex: null, error: safetyError };
  try {
    return { regex: new RegExp(pattern, flags), error: null };
  }
  catch (error) {
    return {
      regex: null,
      error: error instanceof Error ? error.message : 'Invalid regular expression.'
    };
  }
}

export function limitRegexInput(value: string, maxChars = MAX_USER_REGEX_INPUT_CHARS): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}
