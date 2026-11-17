/**
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ELEVEN GraphQL DOCUMENTS THE NEWS CLIENT'S `MeraNewsAdapter` CAN SEND
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Transcribed BY HAND from
 * the client's `mera-news.documents.ts`,
 * and updated by hand when that file changes. They are not imported,
 * generated, or fetched: the two repos deploy independently, and a check that
 * read the live source would silently start passing the moment someone changed
 * both sides at once — which is exactly the change that needs review.
 *
 * If a document below no longer matches the adapter's, every check built on it
 * is stale and lying. Re-copy it, and read the diff.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A MODULE AND NOT A CONST INSIDE THE SPEC
 *
 * Two things need these documents and they must never disagree:
 * `internal-news.contract.spec.ts` validates each one against the generated
 * schema without a server, and `scripts/news-api-probe.ts` EXECUTES each one
 * against a running service. A second transcription is a second thing to
 * update by hand, and the one that gets forgotten is the one still reporting
 * green. One copy, two readers.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Verbatim from the adapter's `NEWS_ARTICLE_SELECTION`. */
export const NEWS_ARTICLE_SELECTION = `
    _id
    title
    title_en
    description
    description_en
    pubDate
    article_url
    image_url
    source_uri
    original_language_code
    category
    entities
    event_type
    geo_tags {
      city
      region
      countryCode
    }
    publicationSource {
      _id
      publication_name
      publication_url
      country_code
      country_name
      category
      detected_language_code
      feed_language_code
      newsPublisherId
    }`;

export const ADAPTER_DOCUMENTS: Record<string, string> = {
  MeraResolveTopics: `
query MeraResolveTopics($query: PersonaQueryInput!) {
  articleIdsForPersona(query: $query) {
    topicResults {
      topicText
      articleIds
      matchMeta {
        articleId
        vectorScore
        textScore
        stableClusterId
      }
      nextCursor
      hasNextPage
    }
    headlineResults {
      scope
      countryCode
      articleIds
      clusterSizes
      stableClusterIds
    }
  }
}`,

  MeraHydrateArticles: `
query MeraHydrateArticles($articleIds: [ID!]!) {
  articlesForTopicsByIds(articleIds: $articleIds) {
    articles {
      _id
      clusters {
        clusterId
        confidence
        stableClusterId
      }
      title
      title_en
      description_en
      article_url
      image_url
      country_code
      publication_name
      language_code
      pubDate
      geo_tags {
        city
        region
        countryCode
      }
      entities
      event_type
      category
      maxClusterSize
    }
    dailyLimitReached
    resetAt
  }
}`,

  MeraArticleById: `
query MeraArticleById($id: ID!) {
  articleById(id: $id) {${NEWS_ARTICLE_SELECTION}
  }
}`,

  MeraTopHeadlinesForCountry: `
query MeraTopHeadlinesForCountry($countryCode: String, $first: Int, $after: String) {
  topHeadlinesForCountry(countryCode: $countryCode, first: $first, after: $after) {
    headlines {
      stableClusterId
      clusterSize
      article {${NEWS_ARTICLE_SELECTION}
      }
    }
    pageInfo {
      endCursor
      hasNextPage
    }
  }
}`,

  MeraArticlesForCountry: `
query MeraArticlesForCountry($countryCode: String, $first: Int, $after: String) {
  articlesForCountry(countryCode: $countryCode, first: $first, after: $after) {
    articles {${NEWS_ARTICLE_SELECTION}
    }
    pageInfo {
      endCursor
      hasNextPage
    }
  }
}`,

  MeraArticlesForPublisher: `
query MeraArticlesForPublisher($newsPublisherId: ID!, $first: Int, $after: String) {
  articlesForPublisher(newsPublisherId: $newsPublisherId, first: $first, after: $after) {
    articles {${NEWS_ARTICLE_SELECTION}
    }
    pageInfo {
      endCursor
      hasNextPage
    }
  }
}`,

  MeraArticlesForSource: `
query MeraArticlesForSource($publicationSourceId: ID!, $first: Int, $after: String) {
  articlesForPublicationSource(publicationSourceId: $publicationSourceId, first: $first, after: $after) {
    articles {${NEWS_ARTICLE_SELECTION}
    }
    pageInfo {
      endCursor
      hasNextPage
    }
  }
}`,

  MeraRelatedArticles: `
query MeraRelatedArticles($articleId: ID!, $stableClusterId: String) {
  relatedArticles(articleId: $articleId, stableClusterId: $stableClusterId) {
    _id
    title_en
    description_en
    article_url
    image_url
    country_code
    publication_name
    language_code
    pubDate
  }
  newsClusterForArticle(articleId: $articleId) {
    _id
    stableClusterId
    clusterSize
    createdAt
    updatedAt
  }
}`,

  MeraNewsPublishers: `
query MeraNewsPublishers($countryCode: String, $first: Int, $after: String) {
  newsPublishers(countryCode: $countryCode, first: $first, after: $after) {
    newsPublishers {
      _id
      name
      website_url
      country_code
      country_name
      publicationSources {
        _id
        publication_name
        feed_url
        category
        detected_language_code
        feed_language_code
      }
    }
    pageInfo {
      endCursor
      hasNextPage
    }
  }
}`,

  MeraAllCountries: `
query MeraAllCountries {
  allCountries
}`,

  // The `$since` variable is the point of this document and it was missing from the
  // first transcription of this document: the no-argument form still validates
  // (the argument is optional), so the check stayed green while never once
  // exercising the argument the adapter actually sends.
  MeraRecentArticleCount: `
query MeraRecentArticleCount($since: DateTime) {
  recentArticleCount(since: $since)
}`,
};
