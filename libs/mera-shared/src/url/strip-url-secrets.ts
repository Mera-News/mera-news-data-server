/**
 * A feed address can carry a credential in its query string or userinfo, so
 * any address that is logged, stored as a copy or served goes through here.
 */

/** Stands in for an address that cannot be parsed, so the raw text is never kept. */
export const ADDRESS_WITHHELD = '(address withheld)';

/** Origin plus path: no userinfo, query string or fragment. Empty when it is not a web URL. */
export function stripUrlSecrets(value: string): string {
  try {
    const url = new URL(value);
    return url.origin === 'null' ? '' : url.origin + url.pathname;
  } catch {
    return '';
  }
}

/** `stripUrlSecrets`, or `ADDRESS_WITHHELD` when the value is not a web URL. */
export function redactAddress(value: string): string {
  return stripUrlSecrets(value) || ADDRESS_WITHHELD;
}

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>()]+/gi;

/** Redacts every address inside free text, such as an HTTP client's error message. */
export function scrubUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => redactAddress(match));
}
