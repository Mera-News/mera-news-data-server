import { ConfigService } from '@nestjs/config';
import { http, HttpResponse } from 'msw';
import { JobLogger } from '../../../../libs/mera-shared/src/job-logger/job-logger';
import { GeminiTranslationService } from '../../../../libs/mera-shared/src/translation/gemini-translation.service';
import { server } from '../../../harness/msw';

const URL_ =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-test-model:generateContent';
const config = {
  get: (key: string, fallback?: unknown) =>
    (
      ({
        GEMINI_TRANSPORT: 'developer',
        GEMINI_API_KEY: 'test-key',
        GEMINI_TRANSLATION_MODEL: 'gemini-test-model',
        GEMINI_FALLBACK_MODELS: '',
      }) as Record<string, string>
    )[key] ?? fallback,
} as unknown as ConfigService;
const service = () =>
  new GeminiTranslationService(
    config,
    new JobLogger({ job: 'test', level: 'error', write: () => undefined }),
  );
const item = {
  id: 'a1',
  title: 'Hola',
  description: 'Mundo',
  sourceLang: 'es',
};
const reply = (text: string) =>
  HttpResponse.json({ candidates: [{ content: { parts: [{ text }] } }] });

describe('Gemini translation adapter (developer transport)', () => {
  it('posts the generateContent request and parses the reply into the stored fields', async () => {
    const seen: { key: string | null; auth: string | null; body: any }[] = [];
    server.use(
      http.post(URL_, async ({ request }) => {
        seen.push({
          key: new URL(request.url).searchParams.get('key'),
          auth: request.headers.get('authorization'),
          body: await request.json(),
        });
        return reply(
          JSON.stringify([
            { id: 'a1', title_en: 'Hello', description_en: 'World' },
          ]),
        );
      }),
    );

    const out = await service().translateBatch([item]);

    expect(out).toEqual([
      { title_en: 'Hello', description_en: 'World', skipped: false },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0].key).toBe('test-key');
    expect(seen[0].auth).toBeNull();
    const { contents, generationConfig, safetySettings } = seen[0].body;
    expect(contents[0].role).toBe('user');
    expect(contents[0].parts[0].text).toContain(
      JSON.stringify([{ id: 'a1', title: 'Hola', description: 'Mundo' }]),
    );
    expect(generationConfig.responseMimeType).toBe('application/json');
    expect(generationConfig.responseSchema.items.required).toEqual([
      'id',
      'title_en',
      'description_en',
    ]);
    expect(generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(safetySettings).toHaveLength(4);
  });

  it('keeps the original text and marks the article skipped when the reply is not the schema', async () => {
    server.use(http.post(URL_, () => reply('Sorry, I cannot do that.')));

    const out = await service().translateBatch([item]);

    expect(out).toEqual([
      {
        title_en: 'Hola',
        description_en: 'Mundo',
        skipped: true,
        reason: 'id_misalignment',
      },
    ]);
  });
});
