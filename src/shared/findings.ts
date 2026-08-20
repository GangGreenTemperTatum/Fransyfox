(() => {
  'use strict';

  const RULESET_VERSION = 3;

  type RuleSeverity = 'high' | 'medium' | 'low';

  type ListenerLike = {
    listener?: unknown;
    [key: string]: unknown;
  };

  type RuleContext = {
    code: string;
    codeLower: string;
    listener: ListenerLike;
  };

  type Finding = {
    id: string;
    details?: string;
    [key: string]: unknown;
  };

  type RuleFindingShape = Omit<Finding, 'id'>;

  type RuleResult = true | null | RuleFindingShape | RuleFindingShape[];

  type RuleDefinition = {
    id: string;
    title: string;
    description: string;
    severity: RuleSeverity;
    check: (ctx: RuleContext) => RuleResult;
  };

  function normalizeCode(code: unknown): string {
    return typeof code === 'string' ? code : '';
  }

  function extractOriginRegexPatterns(code: string): string[] {
    const patterns: string[] = [];
    const literalTest = /\/((?:\\.|[^/])+)\/[gimsuy]*\s*\.test\s*\(\s*[^)]*origin\b/gi;
    const originMatch = /origin\b[^;]*?\.(?:match|search)\s*\(\s*\/((?:\\.|[^/])+)\/[gimsuy]*/gi;
    const regExpTest = /new\s+RegExp\(\s*(['"])(.*?)\1\s*(?:,\s*['"][gimsuy]*['"])?\s*\)\s*\.test\s*\(\s*[^)]*origin\b/gi;
    const originMatchRegExp = /origin\b[^;]*?\.(?:match|search)\s*\(\s*new\s+RegExp\(\s*(['"])(.*?)\1/gi;

    let match: RegExpExecArray | null;
    while ((match = literalTest.exec(code)) !== null) {
      patterns.push(match[1]);
    }
    while ((match = originMatch.exec(code)) !== null) {
      patterns.push(match[1]);
    }
    while ((match = regExpTest.exec(code)) !== null) {
      patterns.push(match[2]);
    }
    while ((match = originMatchRegExp.exec(code)) !== null) {
      patterns.push(match[2]);
    }

    return Array.from(new Set(patterns.filter(Boolean)));
  }

  function hasUnescapedDot(pattern: string): boolean {
    if (!pattern) return false;
    let inClass = false;
    for (let i = 0; i < pattern.length; i += 1) {
      const ch = pattern[i];
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === '[') {
        inClass = true;
        continue;
      }
      if (ch === ']') {
        inClass = false;
        continue;
      }
      if (ch === '.' && !inClass) {
        return true;
      }
    }
    return false;
  }

  function hasUnescapedEndAnchor(pattern: string): boolean {
    if (!pattern || pattern.length === 0) return false;
    if (pattern[pattern.length - 1] !== '$') return false;
    let backslashes = 0;
    for (let i = pattern.length - 2; i >= 0 && pattern[i] === '\\'; i -= 1) {
      backslashes += 1;
    }
    return backslashes % 2 === 0;
  }

  function usesMessageData(codeLower: string): boolean {
    return /\b(?:event|e|message|msg|evt)\s*\.data\b/.test(codeLower);
  }

  function mentionsOrigin(codeLower: string): boolean {
    return /\borigin\b/.test(codeLower);
  }

  function findEvalOnData(code: string): string | null {
    const patterns = [
      /\beval\s*\(\s*[^)]*\.data\b/i,
      /\bnew\s+Function\s*\(\s*[^)]*\.data\b/i,
      /\bFunction\s*\(\s*[^)]*\.data\b/i
    ];
    for (const pattern of patterns) {
      const match = code.match(pattern);
      if (match && match[0]) {
        return match[0];
      }
    }
    return null;
  }

  function findDomSinkOnData(code: string): string | null {
    const patterns = [
      /\b(?:innerHTML|outerHTML)\s*=\s*[^;]*\.data\b/i,
      /\binsertAdjacentHTML\s*\(\s*[^,]+,\s*[^)]*\.data\b/i,
      /\bdocument\.write\s*\(\s*[^)]*\.data\b/i
    ];
    for (const pattern of patterns) {
      const match = code.match(pattern);
      if (match && match[0]) {
        return match[0];
      }
    }
    return null;
  }

  function findPostMessageWildcard(code: string): string | null {
    const pattern = /\bpostMessage\s*\([^,]+,\s*(['"])\*\1/i;
    const match = code.match(pattern);
    if (match && match[0]) {
      return match[0];
    }
    return null;
  }

  function findLocationAssignmentOnData(code: string): string | null {
    const pattern = /\b(?:window\.|document\.)?location(?:\.href)?\s*=\s*[^;]*\.data\b/i;
    const match = code.match(pattern);
    if (match && match[0]) {
      return match[0];
    }
    return null;
  }

  function usesMessageDataProperty(codeLower: string): boolean {
    return /\b(?:event|e|message|msg|evt)\s*\.data\s*(?:\.|\[)/.test(codeLower);
  }

  // Origin compared via substring/prefix/suffix containment or loose equality.
  // These are the classic origin-validation bypasses (e.g. evil-example.com
  // passes origin.indexOf('example.com') !== -1).
  function findWeakOriginCheck(code: string): string | null {
    const patterns = [
      /\borigin\b\s*\.\s*(?:indexOf|includes|search|startsWith|endsWith)\s*\([^)]*\)/i,
      /\.\s*(?:indexOf|includes)\s*\(\s*[^)]*\borigin\b[^)]*\)/i,
      /\borigin\b\s*(?:==|!=)(?!=)/i
    ];
    for (const pattern of patterns) {
      const match = code.match(pattern);
      if (match && match[0]) {
        return match[0].trim();
      }
    }
    return null;
  }

  // event.data aliased to a local that then flows into a dangerous sink. The
  // direct-sink rules only match `<sink> ... .data`; this catches the common
  // `const html = e.data; el.innerHTML = html;` pattern they would miss.
  function findTaintedSinkFlow(code: string): string | null {
    const aliasRe = /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?(?:event|e|message|msg|evt)\s*\.\s*data\b/g;
    const aliases: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = aliasRe.exec(code)) !== null) {
      if (match[1]) aliases.push(match[1]);
    }
    if (!aliases.length) return null;
    for (const alias of aliases) {
      const a = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const sinkPatterns = [
        new RegExp(`\\beval\\s*\\(\\s*[^)]*\\b${a}\\b`, 'i'),
        new RegExp(`\\bnew\\s+Function\\s*\\(\\s*[^)]*\\b${a}\\b`, 'i'),
        new RegExp(`\\b(?:innerHTML|outerHTML)\\s*=\\s*[^;]*\\b${a}\\b`, 'i'),
        new RegExp(`\\binsertAdjacentHTML\\s*\\([^,]+,\\s*[^)]*\\b${a}\\b`, 'i'),
        new RegExp(`\\bdocument\\.write\\s*\\(\\s*[^)]*\\b${a}\\b`, 'i'),
        new RegExp(`\\b(?:window\\.|document\\.)?location(?:\\.href)?\\s*=\\s*[^;]*\\b${a}\\b`, 'i')
      ];
      for (const pattern of sinkPatterns) {
        const sinkMatch = code.match(pattern);
        if (sinkMatch && sinkMatch[0]) {
          return sinkMatch[0].trim();
        }
      }
    }
    return null;
  }

  function hasDataTypeGuard(codeLower: string): boolean {
    return (
      /typeof\s+[^;]*\.data\b/.test(codeLower) ||
      /Array\.isArray\s*\([^)]*\.data\b/.test(codeLower) ||
      /instanceof\s+\w+/.test(codeLower) ||
      /JSON\.parse\s*\([^)]*\.data\b/.test(codeLower)
    );
  }

  const RULES: RuleDefinition[] = [
    {
      id: 'origin-regex-unescaped-dot',
      title: 'Origin regex has unescaped dot',
      description: 'Origin validation uses a regex with unescaped dots, which can match unintended domains.',
      severity: 'medium',
      check: (ctx: RuleContext) => {
        const patterns = extractOriginRegexPatterns(ctx.code);
        for (const pattern of patterns) {
          if (hasUnescapedDot(pattern)) {
            return { details: `Regex: /${pattern}/` };
          }
        }
        return null;
      }
    },
    {
      id: 'origin-regex-missing-anchor',
      title: 'Origin regex missing end anchor',
      description: 'Origin validation uses a regex without a trailing `$`, allowing suffixes to bypass.',
      severity: 'medium',
      check: (ctx: RuleContext) => {
        const patterns = extractOriginRegexPatterns(ctx.code);
        for (const pattern of patterns) {
          if (!hasUnescapedEndAnchor(pattern)) {
            return { details: `Regex: /${pattern}/` };
          }
        }
        return null;
      }
    },
    {
      id: 'missing-origin-check',
      title: 'No origin check before using message data',
      description: 'Listener processes message data without checking event.origin.',
      severity: 'high',
      check: (ctx: RuleContext) => {
        if (usesMessageData(ctx.codeLower) && !mentionsOrigin(ctx.codeLower)) {
          return true;
        }
        return null;
      }
    },
    {
      id: 'eval-on-message-data',
      title: 'eval on message data',
      description: 'Listener uses eval/Function on message data.',
      severity: 'high',
      check: (ctx: RuleContext) => {
        const match = findEvalOnData(ctx.code);
        if (match) {
          return { details: match };
        }
        return null;
      }
    },
    {
      id: 'postmessage-wildcard-target',
      title: 'postMessage with wildcard target',
      description: 'Listener posts messages using targetOrigin "*", which can leak data.',
      severity: 'medium',
      check: (ctx: RuleContext) => {
        const match = findPostMessageWildcard(ctx.code);
        if (match) {
          return { details: match };
        }
        return null;
      }
    },
    {
      id: 'location-assignment-from-data',
      title: 'Location assignment from message data',
      description: 'Listener assigns message data to window/document location, which can enable redirects.',
      severity: 'high',
      check: (ctx: RuleContext) => {
        const match = findLocationAssignmentOnData(ctx.code);
        if (match) {
          return { details: match };
        }
        return null;
      }
    },
    {
      id: 'missing-data-type-guard',
      title: 'Message data used without type guard',
      description: 'Listener accesses message data properties without checking type or parsing.',
      severity: 'low',
      check: (ctx: RuleContext) => {
        if (usesMessageDataProperty(ctx.codeLower) && !hasDataTypeGuard(ctx.codeLower)) {
          return true;
        }
        return null;
      }
    },
    {
      id: 'xss-sink-on-message-data',
      title: 'DOM sink on message data',
      description: 'Listener writes message data into DOM sinks (innerHTML, insertAdjacentHTML, document.write).',
      severity: 'high',
      check: (ctx: RuleContext) => {
        const match = findDomSinkOnData(ctx.code);
        if (match) {
          return { details: match };
        }
        return null;
      }
    },
    {
      id: 'weak-origin-check',
      title: 'Weak origin validation',
      description: 'Origin is validated with substring/prefix/suffix containment or loose equality, which is bypassable (e.g. evil-example.com passes origin.indexOf("example.com")).',
      severity: 'medium',
      check: (ctx: RuleContext) => {
        const match = findWeakOriginCheck(ctx.code);
        if (match) {
          return { details: match };
        }
        return null;
      }
    },
    {
      id: 'tainted-data-to-sink',
      title: 'Message data flows to a sink via a variable',
      description: 'Message data is aliased to a local variable that is later passed to eval/Function, a DOM HTML sink, or a location assignment.',
      severity: 'high',
      check: (ctx: RuleContext) => {
        const match = findTaintedSinkFlow(ctx.code);
        if (match) {
          return { details: match };
        }
        return null;
      }
    }
  ];

  const RULES_BY_ID: Record<string, RuleDefinition> = {};
  RULES.forEach((rule) => {
    RULES_BY_ID[rule.id] = rule;
  });

  function normalizeFinding(rule: RuleDefinition, result: RuleResult): Finding[] {
    if (!result) return [];
    if (result === true) return [{ id: rule.id }];
    if (Array.isArray(result)) {
      return result.map((item) => Object.assign({ id: rule.id }, item || {}));
    }
    if (typeof result === 'object') {
      return [Object.assign({ id: rule.id }, result)];
    }
    return [];
  }

  function evaluateListener(listener: ListenerLike): { findings: Finding[]; errors: Array<{ ruleId: string; message: string }> } {
    const code = normalizeCode(listener && listener.listener);
    if (!code) return { findings: [], errors: [] };
    const ctx: RuleContext = {
      code,
      codeLower: code.toLowerCase(),
      listener
    };
    const findings: Finding[] = [];
    const errors: Array<{ ruleId: string; message: string }> = [];
    for (const rule of RULES) {
      let result: RuleResult = null;
      try {
        result = rule.check(ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ ruleId: rule.id, message });
        console.warn(`[Fransceiver] Rule "${rule.id}" threw:`, message);
      }
      const normalized = normalizeFinding(rule, result);
      if (normalized.length) {
        findings.push(...normalized);
      }
    }
    return { findings, errors };
  }

  function getRuleById(id: string): RuleDefinition | null {
    return RULES_BY_ID[id] || null;
  }

  function listRules(): RuleDefinition[] {
    return RULES.slice();
  }

  type FransceiverFindingsType = {
    rules: RuleDefinition[];
    version: number;
    getRuleById: typeof getRuleById;
    listRules: typeof listRules;
    evaluateListener: typeof evaluateListener;
  };

  const globalObj = globalThis as typeof globalThis & {
    FransceiverFindings?: Partial<FransceiverFindingsType>;
  };

  globalObj.FransceiverFindings = Object.assign(globalObj.FransceiverFindings || {}, {
    rules: RULES,
    version: RULESET_VERSION,
    getRuleById,
    listRules,
    evaluateListener
  });
})();
