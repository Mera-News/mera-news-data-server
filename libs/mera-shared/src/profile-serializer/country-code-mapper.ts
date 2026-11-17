import { customList } from 'country-codes-list';
import * as countries from 'i18n-iso-countries';
import * as en from 'i18n-iso-countries/langs/en.json';

// Register English locale for country name lookups
countries.registerLocale(en);

/**
 * Maps country names to ISO 3166-1 country codes
 * Uses the country-codes-list and i18n-iso-countries packages
 */
export class CountryCodeMapper {
  private static countryCodeMap: Record<string, string> | null = null;

  /**
   * Initialize the country code map from country-codes-list package
   */
  private static initializeMap(): void {
    if (this.countryCodeMap !== null) {
      return;
    }

    // Create a map with country names as keys and country codes as values
    // Using customList to get all countries with their names and codes
    const countryList = customList('countryNameEn', '{countryCode}');
    this.countryCodeMap = { ...countryList };

    // Add common aliases and variations
    const aliases: Record<string, string> = {
      USA: 'US',
      'United States': 'US',
      'United States of America': 'US',
      UK: 'GB',
      'United Kingdom': 'GB',
      England: 'GB',
      Scotland: 'GB',
      Wales: 'GB',
      'Northern Ireland': 'GB',
      'South Korea': 'KR',
      Korea: 'KR',
      'North Korea': 'KP',
      UAE: 'AE',
      'Czech Republic': 'CZ',
      Russia: 'RU',
    };

    // Merge aliases into the main map
    Object.assign(this.countryCodeMap, aliases);
  }

  /**
   * Convert country name to ISO 3166-1 alpha-3 country code
   * @param countryName - The full country name
   * @returns The 3-letter country code or null if not found
   */
  static getCountryCode(countryName: string): string | null {
    if (!countryName) {
      return null;
    }

    // Initialize map if not already done
    this.initializeMap();

    const normalizedName = countryName.trim();

    // Try exact match first (case-insensitive)
    for (const [name, alpha2Code] of Object.entries(this.countryCodeMap!)) {
      if (name.toLowerCase() === normalizedName.toLowerCase()) {
        return countries.alpha2ToAlpha3(alpha2Code) || null;
      }
    }

    // Try partial match (country name contains the search term)
    for (const [name, alpha2Code] of Object.entries(this.countryCodeMap!)) {
      if (normalizedName.toLowerCase().includes(name.toLowerCase())) {
        return countries.alpha2ToAlpha3(alpha2Code) || null;
      }
    }

    // Not found
    return null;
  }

  /**
   * Convert ISO 3166-1 country code to country name
   * @param countryCode - Alpha-2 (e.g., "US") or alpha-3 (e.g., "USA") country code
   * @returns The country name in English or null if not found
   */
  static getCountryName(countryCode: string): string | null {
    if (!countryCode) {
      return null;
    }

    const normalizedCode = countryCode.trim().toUpperCase();

    // Use i18n-iso-countries to get the country name in English
    const countryName = countries.getName(normalizedCode, 'en');

    return countryName || null;
  }

  /**
   * Convert any country code format to ISO 3166-1 alpha-3.
   * Handles alpha-2 input, alpha-3 passthrough, and the "GLOBAL" sentinel.
   * @param code - Country code (alpha-2, alpha-3, or "GLOBAL")
   * @returns The alpha-3 country code, "GLOBAL" for the sentinel, or null if invalid
   */
  static toAlpha3(code: string): string | null {
    if (!code) {
      return null;
    }

    const normalized = code.trim().toUpperCase();

    if (normalized === 'GLOBAL') {
      return 'GLOBAL';
    }

    if (normalized.length === 2) {
      return countries.alpha2ToAlpha3(normalized) || null;
    }

    if (normalized.length === 3) {
      return normalized in countries.getAlpha3Codes() ? normalized : null;
    }

    return null;
  }

  /**
   * Convert any country code format to ISO 3166-1 alpha-2 (UPPERCASE).
   * Handles alpha-2 passthrough and alpha-3 → alpha-2 mapping.
   * @param code - Country code (alpha-2 or alpha-3)
   * @returns The alpha-2 country code, or null if invalid/unmappable
   */
  static toAlpha2(code: string): string | null {
    if (!code) {
      return null;
    }

    const normalized = code.trim().toUpperCase();

    if (normalized.length === 2) {
      return countries.isValid(normalized) ? normalized : null;
    }

    if (normalized.length === 3) {
      return countries.alpha3ToAlpha2(normalized) || null;
    }

    return null;
  }

  /**
   * Get the full mapping of country names to codes
   */
  static getFullMapping(): Record<string, string> {
    this.initializeMap();
    return { ...this.countryCodeMap! };
  }
}
