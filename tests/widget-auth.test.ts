import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  generateOtpCode,
  generateWidgetSessionToken,
  hashOtp,
  hashWidgetSessionToken,
  verifyOtpHash,
} from '../api/services/widget-auth';
import { maskPhone, normalizeOrigin, normalizePhoneE164 } from '../api/utils/phone';

const SECRET = 'a-secure-test-secret-with-at-least-32-characters';

test('normalise les formats mobiles français en E.164', () => {
  assert.equal(normalizePhoneE164('06 12 34 56 78'), '+33612345678');
  assert.equal(normalizePhoneE164('07.98.76.54.32'), '+33798765432');
  assert.equal(normalizePhoneE164('+33 6 12 34 56 78'), '+33612345678');
  assert.equal(normalizePhoneE164('33612345678'), '+33612345678');
  assert.equal(normalizePhoneE164('01 23 45 67 89'), null);
  assert.equal(normalizePhoneE164('not-a-phone'), null);
});

test('accepte HTTPS et limite HTTP au développement local', () => {
  assert.equal(normalizeOrigin('https://Koyao.FR/path'), 'https://koyao.fr');
  assert.equal(normalizeOrigin('http://localhost:4321/test'), 'http://localhost:4321');
  assert.equal(normalizeOrigin('http://koyao.fr'), null);
  assert.equal(normalizeOrigin('javascript:alert(1)'), null);
});

test('masque le téléphone sans masquer les deux derniers chiffres', () => {
  assert.equal(maskPhone('+33612345678'), '+336 •• •• 78');
});

test('génère uniquement des OTP à six chiffres', () => {
  for (let index = 0; index < 100; index += 1) {
    assert.match(generateOtpCode(), /^\d{6}$/);
  }
});

test('lie le hash OTP au challenge et au téléphone', () => {
  const hash = hashOtp(SECRET, 'challenge-a', '+33612345678', '123456');
  assert.equal(verifyOtpHash(hash, hashOtp(SECRET, 'challenge-a', '+33612345678', '123456')), true);
  assert.equal(verifyOtpHash(hash, hashOtp(SECRET, 'challenge-b', '+33612345678', '123456')), false);
  assert.equal(verifyOtpHash(hash, hashOtp(SECRET, 'challenge-a', '+33612345679', '123456')), false);
  assert.equal(verifyOtpHash(hash, hashOtp(SECRET, 'challenge-a', '+33612345678', '654321')), false);
  assert.equal(verifyOtpHash('invalid', hash), false);
});

test('génère des sessions opaques, uniques et non stockées en clair', () => {
  const first = generateWidgetSessionToken();
  const second = generateWidgetSessionToken();
  assert.notEqual(first, second);
  assert.ok(first.length >= 40);
  const hash = hashWidgetSessionToken(SECRET, first);
  assert.notEqual(hash, first);
  assert.equal(hash, hashWidgetSessionToken(SECRET, first));
  assert.notEqual(hash, hashWidgetSessionToken(SECRET, second));
});
