import { Types } from 'mongoose';
import {
  EditionCardLike,
  orderEditionForLanguage,
  pickEditionCard,
  readingRank,
} from './reading-rank';

const ids = new Map<string, Types.ObjectId>();
const id = (name: string): Types.ObjectId => {
  let value = ids.get(name);
  if (!value) {
    value = new Types.ObjectId();
    ids.set(name, value);
  }
  return value;
};
const card = (
  name: string,
  lang?: string,
  score?: number,
): EditionCardLike => ({
  articleId: id(name),
  ...(lang !== undefined ? { lang } : {}),
  ...(score !== undefined ? { score } : {}),
});
const entry = (stored: string, cards?: EditionCardLike[]) => ({
  articleId: id(stored),
  story: stored,
  ...(cards ? { cards } : {}),
});
const shown = (entries: { articleId: Types.ObjectId }[]) =>
  entries.map((e) => [...ids].find(([, v]) => v.equals(e.articleId))![0]);

describe('readingRank', () => {
  it('ranks an unscored report 0 in any language', () => {
    expect(readingRank(null, true)).toBe(0);
    expect(readingRank(undefined, false)).toBe(0);
    expect(readingRank(Number.NaN, true)).toBe(0);
  });

  it('adds the reader-language tier only at 50 or more', () => {
    expect(readingRank(49, true)).toBe(49);
    expect(readingRank(50, true)).toBe(1050);
    expect(readingRank(100, false)).toBe(100);
    expect(readingRank(0, true)).toBe(0);
  });
});

describe('pickEditionCard', () => {
  const cards = [card('en70', 'en', 70), card('fr60', 'fr', 60)];

  it('keeps the stored article without a language, cards or any score', () => {
    expect(pickEditionCard(entry('rep', cards), null)).toEqual(id('rep'));
    expect(pickEditionCard(entry('rep'), 'fr')).toEqual(id('rep'));
    expect(
      pickEditionCard(entry('rep', [card('x', 'fr'), card('y', 'de')]), 'de'),
    ).toEqual(id('rep'));
  });

  it('shows a reader-language report of 50 or more over a score-100 one in another language', () => {
    const e = entry('o100', [card('o100', 'en', 100), card('r50', 'fr', 50)]);
    expect(pickEditionCard(e, 'fr')).toEqual(id('r50'));
  });

  it('gives a reader-language report under 50 no head start', () => {
    const e = entry('r49', [card('r49', 'fr', 49), card('o70', 'en', 70)]);
    expect(pickEditionCard(e, 'fr')).toEqual(id('o70'));
    const low = entry('o30', [card('o30', 'en', 30), card('r45', 'fr', 45)]);
    expect(pickEditionCard(low, 'fr')).toEqual(id('r45'));
  });

  it('keeps the stored card order on equal ranks', () => {
    const a = card('a70', 'en', 70);
    const b = card('b70', 'de', 70);
    expect(pickEditionCard(entry('a70', [a, b]), 'fr')).toEqual(id('a70'));
    expect(pickEditionCard(entry('b70', [b, a]), 'fr')).toEqual(id('b70'));
  });

  it('gives an unscored reader-language report no language effect', () => {
    const zero = card('z0', 'de', 0);
    const none = card('wfr', 'fr');
    expect(pickEditionCard(entry('z0', [zero, none]), 'fr')).toEqual(id('z0'));
    expect(pickEditionCard(entry('wfr', [none, zero]), 'fr')).toEqual(
      id('wfr'),
    );
  });
});

describe('orderEditionForLanguage', () => {
  it('returns the same list without a language or without any score', () => {
    const plain = [
      entry('p1', [card('p1', 'en')]),
      entry('p2', [card('p2', 'fr')]),
    ];
    expect(orderEditionForLanguage(plain, null)).toBe(plain);
    expect(orderEditionForLanguage(plain, 'fr')).toBe(plain);
    const legacy = [entry('l1'), entry('l2')];
    expect(orderEditionForLanguage(legacy, 'fr')).toBe(legacy);
  });

  it('puts qualifying reader-language stories first and keeps edition order in both tiers', () => {
    const edition = [
      entry('big', [card('big', 'en', 10)]),
      entry('other100', [card('other100', 'de', 100)]),
      entry('frLow', [card('frLow', 'fr', 40), card('enLow', 'en', 30)]),
      entry('fr55', [card('fr55', 'fr', 55)]),
      entry('legacy'),
      entry('enRep', [card('enRep', 'en', 20), card('fr95', 'fr', 95)]),
    ];
    const ordered = orderEditionForLanguage(edition, 'fr');
    expect(ordered.map((e) => e.story)).toEqual([
      'fr55',
      'enRep',
      'big',
      'other100',
      'frLow',
      'legacy',
    ]);
    expect(shown(ordered)).toEqual([
      'fr55',
      'fr95',
      'big',
      'other100',
      'frLow',
      'legacy',
    ]);
  });

  it('copies entries and leaves the input as it was', () => {
    const edition = [
      entry('en', [card('en', 'en', 20)]),
      entry('stored', [card('stored', 'en', 10), card('fr80', 'fr', 80)]),
    ];
    const before = edition.map((e) => ({ ...e }));
    const ordered = orderEditionForLanguage(edition, 'fr');
    expect(edition).toEqual(before);
    expect(ordered[0]).not.toBe(edition[1]);
    expect(shown(ordered)).toEqual(['fr80', 'en']);
  });
});
