import { buildArticleCopyKeys } from './article-copy-keys';

/**
 * Fixed URL -> keys table. The calibration script's JS port of these rules
 * must produce the same table (parity fixture), so change both together.
 */
const FIXTURES: Array<[string, string[]]> = [
  [
    'https://www.ad.nl/binnenland/koningin-maxima-en-prinses-alexia~ab5cc397/',
    [
      'url:https://ad.nl/binnenland/koningin-maxima-en-prinses-alexia~ab5cc397',
      'dpg:ab5cc397',
    ],
  ],
  [
    'https://www.pzc.nl/binnenland/koningin-maxima-en-prinses-alexia~ab5cc397/?utm_source=rss',
    [
      'url:https://pzc.nl/binnenland/koningin-maxima-en-prinses-alexia~ab5cc397',
      'dpg:ab5cc397',
    ],
  ],
  [
    'https://www.volkskrant.nl/nieuws-achtergrond/kabinet-valt~b21360e9/',
    [
      'url:https://volkskrant.nl/nieuws-achtergrond/kabinet-valt~b21360e9',
      'dpg:b21360e9',
    ],
  ],
  // Live blog: one id, a new headline per update. Never a dpg key.
  [
    'https://www.ed.nl/buitenland/live-rellen-frankrijk-franse-regering-houdt-crisisoverleg~ac3f389f/',
    [
      'url:https://ed.nl/buitenland/live-rellen-frankrijk-franse-regering-houdt-crisisoverleg~ac3f389f',
    ],
  ],
  // Same tilde shape on a non-DPG host: no dpg key.
  [
    'https://zpravy.aktualne.cz/domaci/neco~a1b2c3d4/',
    ['url:https://zpravy.aktualne.cz/domaci/neco~a1b2c3d4'],
  ],
  [
    'https://www.telegraaf.nl/buitenland/canadese-gevangene-smokkelt/163263216.html',
    [
      'url:https://telegraaf.nl/buitenland/canadese-gevangene-smokkelt/163263216.html',
      'telegraaf.nl:163263216',
    ],
  ],
  [
    'https://www.omroepbrabant.nl/nieuws/6031443/oudere-man-valt-in-gat',
    [
      'url:https://omroepbrabant.nl/nieuws/6031443/oudere-man-valt-in-gat',
      'omroepbrabant.nl:6031443',
    ],
  ],
  [
    'https://sport.rbc.ua/ukr/tennis/bitva-vseredini-elina-svitolina-ogolosila-1792396546.html',
    [
      'url:https://sport.rbc.ua/ukr/tennis/bitva-vseredini-elina-svitolina-ogolosila-1792396546.html',
      'sport.rbc.ua:1792396546',
    ],
  ],
  [
    'https://www.Example.com/News/Story?b=2&a=1&fbclid=x',
    ['url:https://example.com/news/story?a=1&b=2'],
  ],
  ['not a url', ['url:not a url']],
];

describe('buildArticleCopyKeys', () => {
  it.each(FIXTURES)('%s', (url, expected) => {
    expect(buildArticleCopyKeys(url)).toEqual(expected);
  });

  it('gives two regional DPG copies a shared key and different url keys', () => {
    const a = buildArticleCopyKeys(FIXTURES[0][0]);
    const b = buildArticleCopyKeys(FIXTURES[1][0]);
    expect(a.filter((k) => b.includes(k))).toEqual(['dpg:ab5cc397']);
  });

  it('joins rbc.ua language editions of one article', () => {
    const rus = buildArticleCopyKeys(
      'https://sport.rbc.ua/rus/tennis/bitva-vseredini-elina-svitolina-ogolosila-1792396546.html',
    );
    expect(rus).toContain('sport.rbc.ua:1792396546');
  });

  it('never keys a telegraaf URL without the trailing numeric page id', () => {
    expect(
      buildArticleCopyKeys('https://www.telegraaf.nl/sport/2026/10/24/uitslag'),
    ).toEqual(['url:https://telegraaf.nl/sport/2026/10/24/uitslag']);
  });
});
