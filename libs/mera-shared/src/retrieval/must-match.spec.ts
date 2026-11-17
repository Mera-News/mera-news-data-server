import {
  filterByMustMatch,
  groundNamesInText,
  normalizeMustMatch,
} from './must-match';

type Row = { title: string; description?: string | null };
const text = (r: Row) => ({ titleEn: r.title, descriptionEn: r.description });

describe('must-match', () => {
  describe('filterByMustMatch', () => {
    const names = normalizeMustMatch(['Web Summit', 'WebSummit']);

    describe('dash and space variants of one name', () => {
      const keptTitles = (name: string, titles: string[]) =>
        filterByMustMatch(
          normalizeMustMatch([name]),
          titles.map((title) => ({ title })),
          text,
        ).kept.map((r) => r.title);

      it('matches a hyphenated name written with an en dash, spaced or not, or an em dash', () => {
        const titles = [
          'Putin opens the Russia–Africa Summit in Sochi',
          'Leaders arrive for the Russia – Africa summit',
          'Russia—Africa Summit: what to expect',
          'Russia Africa Summit draws 40 leaders',
          'Russia−Africa Summit (minus sign)',
        ];
        expect(keptTitles('Russia-Africa Summit', titles)).toEqual(titles);
      });

      it('lets "Web Summit" match WebSummit and Web-Summit', () => {
        const titles = [
          'WebSummit opens in Lisbon',
          'Web-Summit opens in Lisbon',
        ];
        expect(keptTitles('Web Summit', titles)).toEqual(titles);
      });

      it('still keeps the letter boundary at both ends', () => {
        expect(
          keptTitles('Web Summit', [
            'Cobweb Summit draws spider enthusiasts',
            'Web Summiteers gather',
          ]),
        ).toEqual([]);
      });
    });

    it('keeps the followed story and drops other "Summit 2026" events', () => {
      const onTopic = [
        {
          title:
            'Apple’s European government affairs chief to speak at Web Summit 2026',
        },
        { title: 'Mission takes ten startups from Rio to Web Summit Lisbon' },
      ];
      const offTopic = [
        {
          title:
            'Vibrant Goa Summit 2026 Brings Global Business Leaders to Goa',
        },
        {
          title:
            'LOGIPACK 2026 brings together solutions and technologies transforming packaging and logistics in Lisbon',
        },
      ];

      const out = filterByMustMatch(names, [...onTopic, ...offTopic], text);

      expect(out.kept).toEqual(onTopic);
      expect(out.removed).toBe(2);
      expect(out.names).toEqual(['Web Summit', 'WebSummit']);
    });

    it('requires no letter or digit on either side of the match', () => {
      const rows = [
        { title: 'Cobweb Summit draws spider enthusiasts' },
        { title: 'WebSummit2026 ticket sale opens' },
        { title: 'Web Summiteers gather' },
        { title: 'Inside the Web Summit’s keynote' },
        { title: '(WebSummit) panel recap' },
      ];

      const out = filterByMustMatch(names, rows, text);

      expect(out.kept.map((r) => r.title)).toEqual([
        'Inside the Web Summit’s keynote',
        '(WebSummit) panel recap',
      ]);
    });

    it('matches the description, but never across the title/description join', () => {
      const rows = [
        {
          title: 'Lisbon tech week',
          description: 'Founders head to Web Summit.',
        },
        { title: 'Spiders and the Web', description: 'Summit season is here' },
      ];

      const out = filterByMustMatch(names, rows, text);

      expect(out.kept.map((r) => r.title)).toEqual(['Lisbon tech week']);
    });

    it('drops an article with no text (fail closed)', () => {
      const out = filterByMustMatch(
        names,
        [{ title: '', description: null }],
        text,
      );

      expect(out.kept).toEqual([]);
      expect(out.removed).toBe(1);
    });

    it('treats regex specials in a name literally', () => {
      const rows = [
        { title: 'C++ Summit opens in Prague' },
        { title: 'Cxx Summit opens in Prague' },
        { title: 'U.S. delegation lands' },
        { title: 'USA delegation lands' },
      ];

      const out = filterByMustMatch(
        normalizeMustMatch(['C++ Summit', 'U.S.']),
        rows,
        text,
      );

      expect(out.kept.map((r) => r.title)).toEqual([
        'C++ Summit opens in Prague',
        'U.S. delegation lands',
      ]);
    });

    it('matches a composed name against decomposed article text and back', () => {
      const composed = 'São Paulo';
      const decomposed = 'São Paulo';

      expect(
        filterByMustMatch(
          normalizeMustMatch([composed]),
          [{ title: `${decomposed} startup week` }],
          text,
        ).kept,
      ).toHaveLength(1);
      expect(
        filterByMustMatch(
          normalizeMustMatch([decomposed]),
          [{ title: `${composed} startup week` }],
          text,
        ).kept,
      ).toHaveLength(1);
    });
  });

  describe('normalizeMustMatch', () => {
    it('treats absent and all-blank lists as no names', () => {
      expect(normalizeMustMatch(undefined)).toEqual([]);
      expect(normalizeMustMatch(null)).toEqual([]);
      expect(normalizeMustMatch(['   ', 'ab', ' x '])).toEqual([]);
    });

    it('trims, drops short and over-long entries, dedupes case-insensitively, keeps three', () => {
      const long61 = 'x'.repeat(61);
      const exactly60 = 'y'.repeat(60);

      expect(
        normalizeMustMatch([
          '  Web Summit ',
          'ab',
          long61,
          'web summit',
          'WebSummit',
          exactly60,
          'Lisbon',
        ]),
      ).toEqual(['Web Summit', 'WebSummit', exactly60]);
    });

    it('composes to NFC before measuring and deduping', () => {
      expect(normalizeMustMatch(['São', 'São'])).toEqual(['São']);
    });
  });

  describe('groundNamesInText', () => {
    // Real generator outputs measured on prod.
    it('drops names the topic text never says', () => {
      expect(
        groundNamesInText(
          ['Amsterdam University Medical Center', 'Amsterdam UMC'],
          'Amsterdam child falls window hospital',
        ),
      ).toEqual([]);
      expect(
        groundNamesInText(
          ['SMIC', 'Huawei'],
          'china semiconductor breakthroughs self-sufficiency',
        ),
      ).toEqual([]);
    });

    it('keeps names the topic text says, dropping only the invented ones', () => {
      expect(
        groundNamesInText(
          ['SRFTI', 'Satyajit Ray Film and Television Institute'],
          'SRFTI students authority standoff protest',
        ),
      ).toEqual(['SRFTI']);
      expect(
        groundNamesInText(
          ['GVB', 'Gemeentevervoerbedrijf'],
          'amsterdam transport policy gvb changes',
        ),
      ).toEqual(['GVB']);
    });

    it('matches words regardless of case, order and dashes', () => {
      expect(
        groundNamesInText(
          ['Russia-Africa Summit'],
          'Third Russia Africa Summit Moscow',
        ),
      ).toEqual(['Russia-Africa Summit']);
      expect(
        groundNamesInText(['Big Brother Portugal'], 'Big Brother TVI Portugal'),
      ).toEqual(['Big Brother Portugal']);
    });

    it('does not match a word inside another word', () => {
      expect(groundNamesInText(['ADE'], 'Amsterdam Dance Event music')).toEqual(
        [],
      );
    });
  });
});
