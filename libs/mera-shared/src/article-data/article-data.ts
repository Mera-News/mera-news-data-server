/**
 * Embedding-input builder — constructs the exact text fed to the embedding
 * models so the retrieval and text-matching vectors stay consistent across the
 * pipeline.
 *
 * Two call shapes:
 *  - WITH country + category  → the `retrieval.passage` vector (topic/feed search)
 *  - WITHOUT (country=category=null) → the `text-matching` vector (clustering)
 *
 * `general_news` is passed through as a category value but suppressed from the
 * intro sentence (it carries no topical signal).
 */
export function buildArticleData(
  titleEn: string,
  descriptionEn: string | null | undefined,
  countryName: string | null | undefined,
  category: string | null | undefined,
): string {
  const hasCountry = !!countryName?.trim();
  const hasCategory = !!category?.trim() && category.trim() !== 'general_news';

  let intro: string;
  if (hasCountry && hasCategory) {
    intro = `News article from a publisher based out of ${countryName!.trim()} about ${category!.trim()}`;
  } else if (hasCountry) {
    intro = `News article from a publisher based out of ${countryName!.trim()}`;
  } else if (hasCategory) {
    intro = `News article about ${category!.trim()}`;
  } else {
    intro = 'News article';
  }

  const parts: string[] = [intro, `Title: ${titleEn}`];

  if (descriptionEn?.trim()) {
    parts.push(`Description: ${descriptionEn.trim()}`);
  }

  return parts.join('. ') + '.';
}
