/**
 * Shared paginated response convention (D5). Every list endpoint returns this
 * shape so the frontend never has to special-case a domain.
 *
 * Domain-specific item types are interpolated at the use site, e.g.
 * `Paginated<ArticleSummary>`.
 */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** Derive the pagination metadata fields from a total and a page window. */
export function paginate<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number,
): Paginated<T> {
  return {
    items,
    total,
    page,
    pageSize,
    totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
  };
}
