/**
 * Rank tool catalog entries against a search query: whole phrase first (exact name → prefix →
 * token-prefix → name substring → description substring), then deduplicated multi-word hits as
 * a deterministic fallback preserving manifest order on ties.
 */
export function rankToolsByQuery<
  T extends { readonly name: string; readonly description: string },
>(query: string, entries: readonly T[]): T[] {
  const phrase = rankByPhrase(query, entries);
  return phrase.length > 0 ? phrase : rankByWords(query, entries);
}

function rankByWords<T extends { readonly name: string; readonly description: string }>(
  query: string,
  entries: readonly T[],
): T[] {
  const words = [
    ...new Set(
      query
        .trim()
        .toLocaleLowerCase()
        .split(/\s+/u)
        .filter((word) => word.length > 0),
    ),
  ];
  // One word is one phrase: it already had its turn in rankByPhrase.
  if (words.length < 2) return [];
  return entries
    .map((entry, order) => {
      const haystack = `${entry.name} ${entry.description}`.toLocaleLowerCase();
      const hits = words.filter((word) => haystack.includes(word)).length;
      return { entry, order, hits };
    })
    .filter((item) => item.hits > 0)
    .sort((left, right) => right.hits - left.hits || left.order - right.order)
    .map((item) => item.entry);
}

function rankByPhrase<T extends { readonly name: string; readonly description: string }>(
  query: string,
  entries: readonly T[],
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return [];
  return entries
    .map((entry, order) => {
      const name = entry.name.toLocaleLowerCase();
      const description = entry.description.toLocaleLowerCase();
      const score =
        name === needle
          ? 0
          : name.startsWith(needle)
            ? 1
            : name.split(/[_-]/u).some((token) => token.startsWith(needle))
              ? 2
              : name.includes(needle)
                ? 3
                : description.includes(needle)
                  ? 4
                  : 5;
      return { entry, order, score };
    })
    .filter((item) => item.score < 5)
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .map((item) => item.entry);
}
