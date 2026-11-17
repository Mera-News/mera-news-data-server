import { decode } from 'he';
import { stripHtml } from 'string-strip-html';

/**
 * Sanitizes text by:
 * 1. Extracting content from CDATA sections
 * 2. Stripping HTML tags
 * 3. Decoding HTML entities
 * 4. Normalizing whitespace
 *
 * @param text - The text to sanitize (may contain CDATA, HTML entities and tags)
 * @returns Sanitized plain text string, or empty string if input is undefined/null
 *
 * @example
 * sanitizeText('<![CDATA[<p>Hello</p>]]>') // Returns: "Hello"
 * sanitizeText('&#8216;Hello&#8217;') // Returns: "'Hello'"
 * sanitizeText('<p>Hello <strong>world</strong></p>') // Returns: "Hello world"
 * sanitizeText('  Multiple   spaces  ') // Returns: "Multiple spaces"
 * sanitizeText(undefined) // Returns: ""
 */
export function sanitizeText(text: string | undefined): string {
  if (!text) {
    return '';
  }

  // Step 1: Extract content from CDATA sections if present
  // Matches <![CDATA[...content...]]> and extracts the content
  let sanitized = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1');

  // Step 2: Strip all HTML tags
  sanitized = stripHtml(sanitized).result;

  // Step 3: Decode HTML entities (e.g., &#8216; -> ', &quot; -> ", &amp; -> &)
  sanitized = decode(sanitized);

  // Step 4: Normalize whitespace and trim
  sanitized = sanitized.replace(/\s+/g, ' ').trim();

  return sanitized;
}
