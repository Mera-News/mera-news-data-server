import { BadRequestException } from '@nestjs/common';

/** The reader's language as the app sends it: a base tag of two or three letters. Null when absent or empty. */
export function parseReaderLanguage(
  value: string | null | undefined,
): string | null {
  if (value == null || value.trim() === '') return null;
  const tag = value.trim().toLowerCase();
  if (!/^[a-z]{2,3}$/.test(tag)) {
    throw new BadRequestException(
      'language must be a base language tag of two or three letters',
    );
  }
  return tag;
}
