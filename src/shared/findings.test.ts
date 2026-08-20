import { describe, expect, test } from 'vitest';

import './findings';

type FindingsEngine = {
  evaluateListener: (listener: { listener?: string }) => { findings: Array<{ id: string }> };
};

function engine(): FindingsEngine | undefined {
  return (globalThis as { FransyfoxFindings?: FindingsEngine }).FransyfoxFindings;
}

function findingIds(code: string): string[] {
  const result = engine()?.evaluateListener({ listener: code });
  return (result?.findings || []).map((finding) => finding.id);
}

describe('shared/findings', () => {
  test('returns finding when origin check is missing', () => {
    const ids = findingIds('function(evt){ const x = evt.data; console.log(x); }');
    expect(ids).toContain('missing-origin-check');
  });

  test('flags weak origin check via indexOf', () => {
    const ids = findingIds(
      'function(e){ if (e.origin.indexOf("example.com") !== -1) { run(e.data); } }'
    );
    expect(ids).toContain('weak-origin-check');
  });

  test('flags weak origin check via loose equality', () => {
    const ids = findingIds(
      'function(e){ if (e.origin == "https://example.com") { run(e.data); } }'
    );
    expect(ids).toContain('weak-origin-check');
  });

  test('does not flag weak origin check for strict equality', () => {
    const ids = findingIds(
      'function(e){ if (e.origin === "https://example.com") { run(e.data); } }'
    );
    expect(ids).not.toContain('weak-origin-check');
  });

  test('flags data aliased to a variable that reaches a DOM sink', () => {
    const ids = findingIds(
      'function(e){ if (e.origin === "https://x.com"){ var html = e.data; el.innerHTML = html; } }'
    );
    expect(ids).toContain('tainted-data-to-sink');
  });

  test('flags data aliased to a variable that reaches eval', () => {
    const ids = findingIds(
      'function(e){ const payload = e.data; eval(payload); }'
    );
    expect(ids).toContain('tainted-data-to-sink');
  });
});
