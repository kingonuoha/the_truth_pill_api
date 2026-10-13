/**
 * The public-search ranked scorer — a verbatim port of the frozen
 * `web/convex/articles.ts:293-430` JavaScript ranking
 * (`data-migration-findings.md` §7.2, DEV-008).
 *
 * This is deliberately NOT a Postgres relevance-ranked full-text search: that
 * is a different ranking model and would silently reorder every result (DEV-008).
 * The normalisation, the 83-word stopword list, and the additive weights are
 * ported character-for-character from the frozen source, including the known
 * limitation that normalisation deletes every non-ASCII character.
 *
 * The ONLY registered change is the candidate-set order (the legacy
 * `.order("desc").take(300)` is a no-op on the single-field `by_status` index —
 * §7.2); the cap is dropped and the caller supplies rows in
 * `publishedAt DESC NULLS LAST` order. The scoring below is unchanged.
 */

/** Lowercase → strip non `[a-z0-9\s]` → collapse whitespace → trim. Ported verbatim (`:299-304`). */
export function normalizeSearchText(input: string | null | undefined): string {
  return (input || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The 83-word stopword list from `web/convex/articles.ts:312-322`, verbatim. */
export const SEARCH_STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with',
  'at', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'this',
  'that', 'it', 'its', 'you', 'your', 'how', 'what', 'when', 'where',
  'who', 'whom', 'will', 'would', 'can', 'could', 'should', 'do', 'does',
  'did', 'done', 'have', 'has', 'had', 'not', 'no', 'nor', 'but', 'if',
  'so', 'than', 'then', 'there', 'they', 'their', 'them', 'too', 'very',
  'just', 'about', 'into', 'from', 'up', 'out', 'over', 'under', 'again',
  'off', 'only', 'own', 'same', 'such', 'more', 'most', 'some', 'any',
  'all', 'also', 'why', 'after', 'before', 'between', 'through',
]);

/** Split the normalised query into scoreable tokens: length > 1, not a stopword (`:324-326`). */
export function tokenizeSearchQuery(normalizedQuery: string): string[] {
  return normalizedQuery
    .split(' ')
    .filter((token) => token.length > 1 && !SEARCH_STOPWORDS.has(token));
}

/** The scoring inputs for one candidate article (normalisation happens here). */
export interface SearchScorableArticle {
  title: string;
  slug: string;
  metaTitle: string | null;
  focusKeyword: string | null;
  excerpt: string | null;
  tags: string[];
  topics: string[];
}

/** Pre-normalised category/pillar names resolved for the candidate. */
export interface SearchScoringContext {
  /** The normalised query. */
  nQuery: string;
  /** The hyphenated query, matched against the RAW slug (`:365`). */
  slugifiedQuery: string;
  /** Tokens from `tokenizeSearchQuery`. */
  tokens: string[];
  /** Normalised category name, `''` when unresolved. */
  nCategoryName: string;
  /** Normalised pillar name, `''` when unresolved. */
  nPillarName: string;
}

/**
 * The additive score of one article for one query (`:348-386`), exactly:
 * +100 exact title, +60 title contains, +50 raw-slug contains the hyphenated
 * query, +30 metaTitle contains, +25 focusKeyword contains, then per token
 * +10 title / +7 meta-or-focus / +6 tags / +5 topics / +4 excerpt /
 * +4 category / +4 pillar, plus +15 when every token hit the title.
 */
export function scoreSearchArticle(
  article: SearchScorableArticle,
  ctx: SearchScoringContext,
): number {
  const nTitle = normalizeSearchText(article.title);
  const nMeta = normalizeSearchText(article.metaTitle);
  const nFocus = normalizeSearchText(article.focusKeyword);
  const nExcerpt = normalizeSearchText(article.excerpt);
  const nTags = article.tags.map(normalizeSearchText);
  const nTopics = article.topics.map(normalizeSearchText);

  let score = 0;

  // Whole-phrase matches (pasted title, quoted phrase).
  if (nTitle === ctx.nQuery) score += 100;
  else if (nTitle.includes(ctx.nQuery)) score += 60;
  if (article.slug.includes(ctx.slugifiedQuery)) score += 50;
  if (nMeta.includes(ctx.nQuery)) score += 30;
  if (nFocus.includes(ctx.nQuery)) score += 25;

  // Token overlap.
  let titleHits = 0;
  for (const token of ctx.tokens) {
    if (nTitle.includes(token)) {
      score += 10;
      titleHits += 1;
    }
    if (nMeta.includes(token) || nFocus.includes(token)) score += 7;
    if (nTags.some((tag) => tag.includes(token))) score += 6;
    if (nTopics.some((topic) => topic.includes(token))) score += 5;
    if (nExcerpt.includes(token)) score += 4;
    if (ctx.nCategoryName.includes(token)) score += 4;
    if (ctx.nPillarName.includes(token)) score += 4;
  }
  if (ctx.tokens.length > 0 && titleHits === ctx.tokens.length) score += 15;

  return score;
}

/**
 * Public-search result ordering: `score DESC, viewCount DESC LIMIT 8` (`:389-392`).
 * Ties beyond `(score, viewCount)` are unstated in the frozen source ("must not
 * be treated as a contract"); a deterministic `id` tie-break is added so tests
 * are reproducible.
 */
export const SEARCH_RESULT_LIMIT = 8;

export function rankSearchResults<
  T extends { id: string; score: number; viewCount: number },
>(scored: T[]): T[] {
  return scored
    .filter((row) => row.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || b.viewCount - a.viewCount || (a.id < b.id ? -1 : 1),
    )
    .slice(0, SEARCH_RESULT_LIMIT);
}
