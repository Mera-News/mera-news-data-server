import {
  editionProjectionForWindow,
  pickEditionEntries,
} from './headline-window';

describe('pickEditionEntries', () => {
  const edition = {
    entries: ['d24'],
    views: [
      { windowHours: 6, entries: ['d6'] },
      { windowHours: 48, entries: ['d48'] },
    ],
  };

  it('serves entries for 24h and the matching view otherwise', () => {
    expect(pickEditionEntries(edition, 24)).toEqual(['d24']);
    expect(pickEditionEntries(edition, 6)).toEqual(['d6']);
    expect(pickEditionEntries(edition, 48)).toEqual(['d48']);
  });

  it('falls back to entries when the edition predates views or lacks the view', () => {
    expect(pickEditionEntries({ entries: ['d24'] }, 6)).toEqual(['d24']);
    expect(pickEditionEntries(edition, 12)).toEqual(['d24']);
    expect(pickEditionEntries({}, 24)).toEqual([]);
  });
});

describe('editionProjectionForWindow', () => {
  it('skips views for 24h and picks one view otherwise', () => {
    expect(editionProjectionForWindow(24)).toBe('-views');
    expect(editionProjectionForWindow(12)).toMatchObject({
      entries: 1,
      builtAt: 1,
      views: { $elemMatch: { windowHours: 12 } },
    });
  });
});
