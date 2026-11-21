// The one-computer setup copies the full server's language detection. This runs
// both on the same texts. It needs the repository's own packages (npm ci at the
// repository root) and is skipped without them.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createLanguageDetector } from '../src/ingest/language.ts';

const fullServer = new URL('../../apps/mera-server-async/src/modules/shared-utilities/language-detection/language-detection.service.ts', import.meta.url);
const rootInstalled = existsSync(new URL('../../node_modules/@nestjs/common/package.json', import.meta.url));

const TEXTS = [
  'Brightwater orders forty electric buses for its city routes after a long council debate',
  'Le conseil municipal a voté l’achat de quarante bus électriques pour les lignes de la ville',
  'Der Stadtrat hat den Kauf von vierzig Elektrobussen für die städtischen Linien beschlossen',
  'El ayuntamiento aprobó la compra de cuarenta autobuses eléctricos para las líneas urbanas',
  'A câmara municipal aprovou a compra de quarenta autocarros elétricos para as linhas urbanas',
  'नगर परिषद ने शहर के मार्गों के लिए चालीस इलेक्ट्रिक बसें खरीदने को मंजूरी दी',
  '東京で新しい電気バスが走り始めた',
  '東京の電気バス運行開始',
  '日本政府の新方針',
  'עיריית תל אביב אישרה רכישת אוטובוסים חשמליים',
  '东京开始运行新的电动公交车，乘客表示车内非常安静',
  '서울시는 시내 노선에 전기버스 40대를 도입한다고 밝혔다',
  'ไฟฟ้าดับในกรุงเทพฯ หลายพื้นที่เมื่อคืนนี้',
  'Городской совет одобрил покупку сорока электробусов для городских маршрутов',
  'وافق مجلس المدينة على شراء أربعين حافلة كهربائية لخطوط المدينة',
  'ok',
  '',
  '12:30',
];

describe('language detection, against the full server', () => {
  it('gives the same answer on every text', { skip: rootInstalled ? false : 'run npm ci at the repository root to compare' }, async () => {
    const { LanguageDetectionService } = await import(fullServer.href);
    const theirs = new LanguageDetectionService();
    await theirs.onModuleInit();
    const ours = await createLanguageDetector();
    for (const text of TEXTS) assert.equal(ours.detect(text), theirs.detectLanguage(text), `for ${JSON.stringify(text)}`);
  });

  it('finds the full server file to compare against', () => {
    assert.ok(existsSync(fullServer), 'the copied service moved; update the copy and this path');
  });
});
