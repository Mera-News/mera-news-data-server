/**
 * The news operations that the news client and the Mera News app send and this
 * API serves, as literal text.
 *
 * Transcribed by hand from the client's service files and from the app's
 * source and publication files, with every fragment and template constant
 * expanded, and updated by hand when those documents change. They are not
 * imported, generated or fetched: the repositories deploy independently, and a
 * check that read the live source would start passing the moment someone
 * changed both sides at once, which is the change that needs review.
 *
 * If a document below no longer matches the sender's, every check built on it
 * is stale. Re-copy it and read the diff.
 *
 * Only documents that validate against this schema are listed. The ones that
 * need fields this API does not serve (canonical topics) are left out on
 * purpose.
 */
export const CLIENT_DOCUMENTS: Record<string, string> = {
  AllCountries: `
  query AllCountries {
    allCountries
  }
`,

  ClusterMembershipsForArticles: `
  query ClusterMembershipsForArticles($articleIds: [ID!]!) {
    clusterMembershipsForArticles(articleIds: $articleIds) {
      articleId
      clusters {
        clusterId
        confidence
        stableClusterId
      }
    }
  }
`,

  GetArticleById: `
  query GetArticleById($id: ID!) {
    articleById(id: $id) {
      _id
      title
      title_en_internal_only
      description
      description_en_internal_only
      pubDate
      article_url
      image_url
      creator
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
      }
    }
  }
`,

  GetArticleIdsForPersona: `
  query GetArticleIdsForPersona($query: PersonaQueryInput!) {
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
  }
`,

  // The app's reachability check sends this under the same operation name as the client's feed document.
  GetArticleIdsForPersonaCheck: `
query GetArticleIdsForPersona($query: PersonaQueryInput!) {
  articleIdsForPersona(query: $query) { topicResults { topicText articleIds } headlineResults { scope countryCode articleIds } }
}
`,

  GetArticlesForCountry: `
  query GetArticlesForCountry($countryCode: String, $first: Int, $after: String) {
    articlesForCountry(countryCode: $countryCode, first: $first, after: $after) {
      articles {
        _id
        title
        title_en_internal_only
        description
        description_en_internal_only
        pubDate
        article_url
        image_url
        creator
        source_uri
        original_language_code
        geo_tags {
          city
          region
          countryCode
        }
        event_type
        entities
        publicationSource {
          _id
          publication_name
          country_code
        }
      }
      pageInfo {
        endCursor
        hasNextPage
        pageSize
      }
    }
  }
`,

  GetArticlesForPublisherNoOrder: `
  query GetArticlesForPublisherNoOrder($newsPublisherId: ID!, $first: Int, $after: String) {
    articlesForPublisher(newsPublisherId: $newsPublisherId, first: $first, after: $after) {

      articles {
        _id
        title
        title_en_internal_only
        description
        description_en_internal_only
        pubDate
        article_url
        image_url
        creator
        source_uri
        original_language_code
        publicationSource {
          _id
          publication_name
          country_code
        }
      }
      pageInfo {
        endCursor
        hasNextPage
        pageSize
      }

    }
  }
`,

  GetArticlesForStories: `
  query GetArticlesForStories($articleIds: [ID!]!) {
    articlesForStories(articleIds: $articleIds) {
      articles {

        _id
        clusters {
          clusterId
          confidence
          stableClusterId
        }
        title_en
        title
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

        story_key
      }
    }
  }
`,

  GetArticlesForStoriesLegacy: `
  query GetArticlesForStoriesLegacy($articleIds: [ID!]!) {
    articlesForStories(articleIds: $articleIds) {
      articles {

        _id
        clusters {
          clusterId
          confidence
          stableClusterId
        }
        title_en
        title
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
    }
  }
`,

  GetArticlesForTopicsByIds: `
  query GetArticlesForTopicsByIds($articleIds: [ID!]!) {
    articlesForTopicsByIds(articleIds: $articleIds) {
      articles {

        _id
        clusters {
          clusterId
          confidence
          stableClusterId
        }
        title_en
        title
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

        story_key
      }
    }
  }
`,

  GetArticlesForTopicsByIdsLegacy: `
  query GetArticlesForTopicsByIdsLegacy($articleIds: [ID!]!) {
    articlesForTopicsByIds(articleIds: $articleIds) {
      articles {

        _id
        clusters {
          clusterId
          confidence
          stableClusterId
        }
        title_en
        title
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
    }
  }
`,

  GetNewsPublishers: `
  query GetNewsPublishers(
    $countryCode: String
    $first: Int
    $after: String
  ) {
    newsPublishers(
      countryCode: $countryCode
      first: $first
      after: $after
    ) {
      newsPublishers {
        _id
        name
        website_url
        country_code
        subscription_uri
        publicationSources {
          _id
          publication_name
          category
          publication_type
          categories
          detected_language_code
        }
      }
      pageInfo {
        endCursor
        hasNextPage
        pageSize
      }
    }
  }
`,

  GetRecentArticleCount: `
  query GetRecentArticleCount {
    recentArticleCount
  }
`,

  GetTopHeadlinesForCountry: `
  query GetTopHeadlinesForCountry($countryCode: String, $first: Int, $after: String) {
    topHeadlinesForCountry(countryCode: $countryCode, first: $first, after: $after) {

      headlines {
        stableClusterId
        clusterSize
        article {
          _id
          title
          title_en_internal_only
          description
          description_en_internal_only
          pubDate
          article_url
          image_url
          creator
          source_uri
          original_language_code
          geo_tags {
            city
            region
            countryCode
          }
          event_type
          entities
          publicationSource {
            _id
            publication_name
            country_code
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
      editionBuiltAt
    }
  }
`,

  GetTopHeadlinesForCountryWindowed: `
  query GetTopHeadlinesForCountryWindowed($countryCode: String, $first: Int, $after: String, $windowHours: Int) {
    topHeadlinesForCountry(countryCode: $countryCode, first: $first, after: $after, windowHours: $windowHours) {

      headlines {
        stableClusterId
        clusterSize
        article {
          _id
          title
          title_en_internal_only
          description
          description_en_internal_only
          pubDate
          article_url
          image_url
          creator
          source_uri
          original_language_code
          geo_tags {
            city
            region
            countryCode
          }
          event_type
          entities
          publicationSource {
            _id
            publication_name
            country_code
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
      editionBuiltAt
    }
  }
`,

  GetWorldHeadlines: `
  query GetWorldHeadlines($countryCode: String, $first: Int, $after: String, $windowHours: Int, $canonicalTopicIds: [ID!]) {
    worldHeadlines(countryCode: $countryCode, first: $first, after: $after, windowHours: $windowHours, canonicalTopicIds: $canonicalTopicIds) {

      headlines {
        stableClusterId
        clusterSize
        article {
          _id
          title
          title_en_internal_only
          description
          description_en_internal_only
          pubDate
          article_url
          image_url
          creator
          source_uri
          original_language_code
          geo_tags {
            city
            region
            countryCode
          }
          event_type
          entities
          publicationSource {
            _id
            publication_name
            country_code
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
      editionBuiltAt
      facets {
        topicId
        count
      }
    }
  }
`,

  PlaceSearch: `
  query PlaceSearch($query: String!, $limit: Int) {
    placeSearch(query: $query, limit: $limit) {
      _id
      city
      region
      countryCode
      displayName
      normalized
      population
      search_keys
    }
  }
`,

  PublicationSourcesForNewsPublisher: `
  query PublicationSourcesForNewsPublisher($publisherId: ID!) {
    publicationSourcesForNewsPublisher(publisherId: $publisherId) {
      publicationSources {
        _id
        publication_name
      }
    }
  }
`,

  SearchPublishers: `
  query SearchPublishers(
    $query: String!
    $first: Int
    $after: String
  ) {
    searchPublishers(query: $query, first: $first, after: $after) {
      publishers {
        _id
        name
        website_url
        country_code
        country_name
        subscription_uri
        matchingSources {
          _id
          publication_name
          category
          publication_type
          categories
          detected_language_code
        }
      }
      pageInfo {
        endCursor
        hasNextPage
        pageSize
      }
    }
  }
`,

  GetArticlesForPublisher: `
  query GetArticlesForPublisher(
    $newsPublisherId: ID!
    $first: Int
    $after: String
    $order: PublisherArticleOrder
  ) {
    articlesForPublisher(newsPublisherId: $newsPublisherId, first: $first, after: $after, order: $order) {

      articles {
        _id
        title
        title_en_internal_only
        description
        description_en_internal_only
        pubDate
        article_url
        image_url
        creator
        source_uri
        original_language_code
        publicationSource {
          _id
          publication_name
          country_code
        }
      }
      pageInfo {
        endCursor
        hasNextPage
        pageSize
      }

    }
  }
`,

  GetNewsClusterForArticle: `
  query GetNewsClusterForArticle($articleId: ID!, $first: Int, $after: String) {
    newsClusterForArticle(articleId: $articleId) {
      _id
      stableClusterId
      clusterSize
      createdAt
      updatedAt
      articles(first: $first, after: $after) {
        articles {
          _id
          title
          title_en_internal_only
          description
          description_en_internal_only
          pubDate
          article_url
          image_url
          creator
          source_uri
          original_language_code
          clusterConfidence
          publicationSource {
            _id
            publication_name
            publication_url
            country_code
            country_name
            category
            detected_language_code
            feed_language_code
          }
        }
        pageInfo {
          endCursor
          hasNextPage
          pageSize
        }
      }
    }
  }
`,

  GetRelatedArticlesPage: `
  query GetRelatedArticlesPage(
    $articleId: ID!
    $stableClusterId: String
    $sortMode: RelatedSortMode
    $context: RelatedArticlesContextInput
    $excludeIds: [ID!]
    $first: Int
    $after: String
  ) {
    relatedArticlesPage(
      articleId: $articleId
      stableClusterId: $stableClusterId
      sortMode: $sortMode
      context: $context
      excludeIds: $excludeIds
      first: $first
      after: $after
    ) {
      articles {
        _id
        title_en
        title_original
        description_en
        article_url
        image_url
        country_code
        publication_name
        language_code
        pubDate
      }
      pageInfo {
        endCursor
        hasNextPage
        pageSize
      }
      restarted
    }
  }
`,

  GetRelatedArticlesPageFiltered: `
  query GetRelatedArticlesPageFiltered(
    $articleId: ID!
    $stableClusterId: String
    $sortMode: RelatedSortMode
    $context: RelatedArticlesContextInput
    $excludeIds: [ID!]
    $first: Int
    $after: String
    $countries: [String!]
    $languages: [String!]
  ) {
    relatedArticlesPage(
      articleId: $articleId
      stableClusterId: $stableClusterId
      sortMode: $sortMode
      context: $context
      excludeIds: $excludeIds
      first: $first
      after: $after
      countries: $countries
      languages: $languages
    ) {
      articles {
        _id
        title_en
        title_original
        description_en
        article_url
        image_url
        country_code
        publication_name
        language_code
        pubDate
      }
      pageInfo {
        endCursor
        hasNextPage
        pageSize
      }
      restarted
      facets {
        countries {
          code
          count
        }
        languages {
          code
          count
        }
      }
    }
  }
`,

  GetRelatedArticlesPageLegacy: `
  query GetRelatedArticlesPageLegacy(
    $articleId: ID!
    $stableClusterId: String
    $sortMode: RelatedSortMode
    $context: RelatedArticlesContextInput
    $excludeIds: [ID!]
    $first: Int
    $after: String
  ) {
    relatedArticlesPage(
      articleId: $articleId
      stableClusterId: $stableClusterId
      sortMode: $sortMode
      context: $context
      excludeIds: $excludeIds
      first: $first
      after: $after
    ) {
      articles {
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
      pageInfo {
        endCursor
        hasNextPage
        pageSize
      }
      restarted
    }
  }
`,

  PublicationProfile: `
  query PublicationProfile(
    $newsPublisherId: ID
    $name: String
    $countryCode: String
    $language: String
  ) {
    publicationProfile(
      newsPublisherId: $newsPublisherId
      name: $name
      countryCode: $countryCode
      language: $language
    ) {
      newsPublisherId
      name
      displayName
      homepageUrl
      publicationType
      categories
      languages
      isOfficial
      countryCode
      countryName
      sourceNames
      subscriptionUri
    }
  }
`,

  SearchNews: `
  query SearchNews($query: String!, $limit: Int) {
    searchNews(query: $query, limit: $limit) {
      _id
      title_en
      image_url
      publication_name
      country_code
      pubDate
      score
    }
  }
`,
  NewsServerStatus: `
  query NewsServerStatus {
    newsServerStatus {
      placesSeeded
      lastArticleAt
      lastClusteringAt
      lastTopicLinkAt
      headlineEditionsBuilt
      vectorIndexState
      embeddingModel
    }
  }
`,
};
