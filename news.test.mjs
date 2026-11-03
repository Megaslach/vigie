// node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanUrl, cluster, looksFrench, parseFeed, parseTranslation } from './news.mjs';

test('traduction : forme exacte exigée, sinon refus', () => {
  assert.deepEqual(parseTranslation('["Un", " Deux "]', 2), ['Un', 'Deux']);
  assert.deepEqual(parseTranslation('```json\n["Un"]\n```', 1), ['Un']);
  assert.throws(() => parseTranslation('["Un"]', 2));
  assert.throws(() => parseTranslation('{"a":1}', 1));
  assert.throws(() => parseTranslation('Voici la traduction', 1));
  assert.throws(() => parseTranslation('[""]', 1));
});

test('détection du français sur les titres', () => {
  assert.equal(looksFrench('La RTX 5070 baisse encore'), true);
  assert.equal(looksFrench('Résultats décevants'), true);
  assert.equal(looksFrench('NVIDIA RTX 5070 price drops again'), false);
});

test('RSS : CDATA, entités, image dans le HTML, marchand Dealabs', () => {
  const [item] = parseFeed(`<rss xmlns:pepper="x"><channel><title>Flux</title><item>
    <title><![CDATA[RTX 5070 &agrave; 499 &euro; &amp; plus]]></title>
    <link>https://exemple.fr/a?utm_source=rss&id=1#top</link>
    <pubDate>Tue, 03 Nov 2026 10:00:00 +0100</pubDate>
    <description><![CDATA[<p>Super <b>offre</b></p><img src="https://exemple.fr/i.jpg">]]></description>
    <pepper:merchant name="Amazon" price="499€"/>
  </item></channel></rss>`);
  assert.equal(item.title, 'RTX 5070 à 499 € & plus');
  assert.equal(item.url, 'https://exemple.fr/a?id=1');
  assert.equal(item.ts, Date.parse('2026-11-03T09:00:00Z'));
  assert.equal(item.img, 'https://exemple.fr/i.jpg');
  assert.equal(item.summary, 'Super offre');
  assert.equal(item.merchant, 'Amazon');
  assert.equal(item.price, '499€');
});

test('Atom : lien alternate, pas self ; miniature YouTube ; vidéo ignorée comme image', () => {
  const [item] = parseFeed(`<feed><title>Chaîne</title><entry>
    <title>Une vidéo</title>
    <link rel="self" href="https://exemple.fr/self"/>
    <link rel="alternate" href="https://youtube.com/watch?v=abc"/>
    <published>2026-11-03T08:00:00Z</published>
    <media:group>
      <media:content url="https://youtube.com/v/abc" type="application/x-shockwave-flash"/>
      <media:thumbnail url="https://i.ytimg.com/vi/abc/hqdefault.jpg"/>
    </media:group>
  </entry></feed>`);
  assert.equal(item.url, 'https://youtube.com/watch?v=abc');
  assert.equal(item.img, 'https://i.ytimg.com/vi/abc/hqdefault.jpg');
});

test('les liens dangereux ou sans date valable ne cassent rien', () => {
  assert.equal(cleanUrl('javascript:alert(1)'), null);
  assert.equal(cleanUrl('data:text/html,x'), null);
  assert.deepEqual(parseFeed('<item><title>x</title><link>javascript:alert(1)</link></item>'), []);
  assert.equal(parseFeed('<item><title>x</title><link>https://a.fr</link><pubDate>hier</pubDate></item>')[0].ts, null);
});

test('post sans titre (Bluesky) : le texte devient le titre, sans doublon en résumé', () => {
  const [item] = parseFeed('<item><link>https://bsky.app/p/1</link><description>Un post court</description><pubDate>Tue, 03 Nov 2026 10:00:00 +0000</pubDate></item>');
  assert.equal(item.title, 'Un post court');
  assert.equal(item.summary, '');
});

test('cluster : même histoire entre deux sources, pas au sein d\'une seule', () => {
  const base = { ts: Date.now(), img: null };
  const out = cluster([
    { ...base, title: 'Nvidia annonce la RTX 5090 Super avec 32 Go', source: 'A', url: 'a', weight: 1 },
    { ...base, title: 'Nvidia annonce la RTX 5090 Super : 32 Go', source: 'B', url: 'b', weight: 1.5, img: 'i' },
    { ...base, title: 'Le prochain Zelda arrive sur Switch 2', source: 'C', url: 'c', weight: 1 },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].source, 'B');
  assert.deepEqual(out[0].also, [{ source: 'A', url: 'a' }]);
});
