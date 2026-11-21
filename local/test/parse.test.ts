// The feed-item rules (image choice, description fallback, clean-up) are a copy
// of the full server's, which cannot be loaded outside its framework. These
// fixtures pin what the copy does, so a change to it is at least visible.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeFeed, parseFeed } from '../src/ingest/parse.ts';

const encode = (xml: string) => new TextEncoder().encode(xml);

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>Harbour Gazette</title><language>en-gb</language>
  <item>
    <title>Council &amp; port agree &lt;b&gt;new&lt;/b&gt; deal</title>
    <link> https://harbour.example.test/deal </link>
    <description><![CDATA[<p>The <strong>port</strong> and the council agreed a new deal.</p><img src="x.jpg"/>]]></description>
    <pubDate>Sat, 21 Nov 2026 09:30:00 +0100</pubDate>
    <media:content url="https://img.example.test/small.jpg" width="320"/>
    <media:content url="https://img.example.test/large.jpg" width="1280"/>
    <media:thumbnail url="https://img.example.test/thumb.jpg"/>
    <enclosure url="https://img.example.test/enclosure.jpg" type="image/jpeg"/>
  </item>
  <item>
    <title>Ferry timetable changes from Monday</title>
    <link>https://harbour.example.test/ferry</link>
    <enclosure url="https://img.example.test/ferry.jpg" type="image/jpeg"/>
    <media:thumbnail url="https://img.example.test/ferry-thumb.jpg"/>
  </item>
  <item>
    <title>Lighthouse open day</title>
    <link>https://harbour.example.test/lighthouse</link>
    <description>Visitors can climb the tower on Saturday.</description>
    <media:thumbnail url="https://img.example.test/lh-thumb.jpg"/>
  </item>
  <item>
    <title></title>
    <link>https://harbour.example.test/no-title</link>
  </item>
  <item>
    <title>An item with no link</title>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Daily</title>
  <entry><title>Atom headline about the bridge</title><link href="https://atom.example.test/bridge"/><updated>2026-11-21T08:00:00Z</updated><summary>The bridge reopens.</summary></entry>
</feed>`;

describe('feed items, as the full server reads them', () => {
  it('picks the widest media:content, then an enclosure, then a thumbnail', async () => {
    const { items } = await parseFeed(encode(RSS), 'application/rss+xml; charset=utf-8');
    assert.deepEqual(
      items.map((i) => [i.link, i.imageUrl]),
      [
        ['https://harbour.example.test/deal', 'https://img.example.test/large.jpg'],
        ['https://harbour.example.test/ferry', 'https://img.example.test/ferry.jpg'],
        ['https://harbour.example.test/lighthouse', 'https://img.example.test/lh-thumb.jpg'],
      ],
    );
  });

  it('cleans markup out of titles and descriptions, and falls back to the title', async () => {
    const { items } = await parseFeed(encode(RSS), null);
    assert.equal(items[0]!.title, 'Council & port agree new deal');
    assert.equal(items[0]!.description, 'The port and the council agreed a new deal.');
    assert.equal(items[1]!.description, 'Ferry timetable changes from Monday');
    assert.equal(items[2]!.description, 'Visitors can climb the tower on Saturday.');
  });

  it('trims the link, keeps the date as given, and leaves out items with no title or link', async () => {
    const parsed = await parseFeed(encode(RSS), null);
    assert.equal(parsed.items[0]!.link, 'https://harbour.example.test/deal');
    assert.equal(parsed.items[0]!.pubDate, 'Sat, 21 Nov 2026 09:30:00 +0100');
    assert.equal(parsed.items.length, 3);
    assert.equal(parsed.skipped, 2);
    assert.equal(parsed.language, 'en-gb');
  });

  it('reads Atom, without its summary, as the full server does', async () => {
    const { items } = await parseFeed(encode(ATOM), 'application/atom+xml');
    // The parser puts an Atom summary in a field neither server reads, so the title stands in.
    assert.deepEqual(items.map((i) => [i.title, i.link, i.description]), [['Atom headline about the bridge', 'https://atom.example.test/bridge', 'Atom headline about the bridge']]);
  });

  it('decodes by the header charset, else the XML prolog, else UTF-8', () => {
    const latin = Uint8Array.from([...'<?xml version="1.0" encoding="ISO-8859-1"?><t>'].map((c) => c.charCodeAt(0)).concat([0xe9], [...'</t>'].map((c) => c.charCodeAt(0))));
    assert.match(decodeFeed(latin, null), /<t>é<\/t>/);
    assert.match(decodeFeed(latin, 'text/xml; charset=latin1'), /<t>é<\/t>/);
    assert.match(decodeFeed(encode('<t>é</t>'), 'text/xml'), /<t>é<\/t>/);
  });

  it('refuses a page that is not a feed, and a feed with no items', async () => {
    await assert.rejects(parseFeed(encode('<html><body>hi</body></html>'), 'text/html'), (e: Error & { code?: string }) => e.code === 'not_rss' || e.code === 'empty_feed');
    await assert.rejects(parseFeed(encode('<rss version="2.0"><channel><title>t</title></channel></rss>'), null), (e: Error & { code?: string }) => e.code === 'empty_feed');
  });
});
