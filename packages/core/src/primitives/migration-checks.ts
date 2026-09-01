export interface SourceText {
  readonly path: string;
  readonly text: string;
}

export interface SourceRisk {
  readonly path: string;
  readonly line: number;
  readonly kind: 'money-number' | 'manual-owner-filter';
  readonly excerpt: string;
}

function lineNumber(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
}

function excerptAt(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset) + 1;
  const end = text.indexOf('\n', offset);
  return text.slice(start, end === -1 ? undefined : end).trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Find decimal formatting applied to caller-named monetary identifiers. */
export function scanMoneyNumberRisks(
  sources: readonly SourceText[],
  identifiers: readonly string[] = ['amount', 'money', 'price', 'total'],
): readonly SourceRisk[] {
  const risks: SourceRisk[] = [];
  for (const source of sources) {
    for (const identifier of identifiers) {
      const pattern = new RegExp(
        `\\b${escapeRegExp(identifier)}\\b[^\\n;]{0,120}\\.toFixed\\(\\s*2\\s*\\)`,
        'gi',
      );
      for (const match of source.text.matchAll(pattern)) {
        if (match.index === undefined) continue;
        risks.push({
          path: source.path,
          line: lineNumber(source.text, match.index),
          kind: 'money-number',
          excerpt: excerptAt(source.text, match.index),
        });
      }
    }
  }
  return risks;
}

/** Find caller-named owner keys manually embedded in data-query calls. */
export function scanOwnerFilterRisks(
  sources: readonly SourceText[],
  ownerKeys: readonly string[] = ['ownerId'],
): readonly SourceRisk[] {
  const risks: SourceRisk[] = [];
  for (const source of sources) {
    for (const ownerKey of ownerKeys) {
      // Two ways this scan was wrong, and they pull in opposite directions.
      //
      // It required a colon, so the ES2015 shorthand (`{ ownerId }`) — roughly
      // one filter in ten in the trees this exists for — was invisible, and a
      // report that is short still reads as complete.
      //
      // And its window spanned any 500 characters, so it reached PAST the end
      // of the call into the next statement: an unrelated `{ ownerId }` two
      // lines below counted as this query's filter. A statement terminator now
      // closes the window, because a call's arguments do not contain one.
      const key = escapeRegExp(ownerKey);
      const pattern = new RegExp(
        `\\.(?:findMany|findFirst|count|aggregate|groupBy)\\s*\\([^;]{0,500}?\\b${key}\\s*(?::|[,}])`,
        'g',
      );
      for (const match of source.text.matchAll(pattern)) {
        if (match.index === undefined) continue;
        risks.push({
          path: source.path,
          line: lineNumber(source.text, match.index),
          kind: 'manual-owner-filter',
          excerpt: excerptAt(source.text, match.index),
        });
      }
    }
  }
  return risks;
}
