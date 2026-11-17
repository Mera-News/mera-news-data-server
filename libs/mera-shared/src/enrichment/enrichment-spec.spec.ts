import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DESCRIPTION_MAX_CHARS,
  EVENT_TYPE_DESCRIPTIONS,
  GENRES,
  GEO_SCOPES,
  SYSTEM_PROMPT,
  TONES,
  buildUserPayload,
} from './enrichment-spec';
import { EVENT_TYPES } from './gemini-enrichment.service';

describe('enrichment-spec', () => {
  it('SYSTEM_PROMPT is byte-identical to the bake-off prompt the probes measured', () => {
    // Fixture = JSON.stringify(SYSTEM_PROMPT) exported from
    // apps/mera-scripts/eval-data/enrichment-bakeoff/lib/vertex.mjs.
    const fixture = JSON.parse(
      readFileSync(
        join(__dirname, '__fixtures__/bakeoff-system-prompt.json'),
        'utf8',
      ),
    ) as string;
    expect(SYSTEM_PROMPT).toBe(fixture);
    expect(SYSTEM_PROMPT).not.toMatch(/\/Arts & Entertainment\/Celebrities/);
  });

  it('shares the event-type vocabulary with the Gemini adapter', () => {
    expect(Object.keys(EVENT_TYPE_DESCRIPTIONS)).toEqual([...EVENT_TYPES]);
  });

  it('declares the closed vocabularies', () => {
    expect(GEO_SCOPES).toEqual([
      'global',
      'multi_country',
      'national',
      'regional',
      'city',
      'neighbourhood',
      'none',
    ]);
    expect(GENRES).toEqual([
      'news',
      'opinion',
      'analysis',
      'press_release',
      'sponsored',
      'not_news',
    ]);
    expect(TONES).toEqual(['positive', 'neutral', 'negative', 'distressing']);
  });

  it('payload is only [{id,title,description}], description cut at 1,500 chars', () => {
    const long = 'x'.repeat(DESCRIPTION_MAX_CHARS + 50);
    const payload = JSON.parse(
      buildUserPayload([
        { id: 'a', title_en: 'T', description_en: long },
        { id: 'b', title_en: 'U', description_en: '' },
      ]),
    ) as { id: string; title: string; description: string }[];
    expect(payload).toEqual([
      { id: 'a', title: 'T', description: 'x'.repeat(1500) },
      { id: 'b', title: 'U', description: '' },
    ]);
  });
});
