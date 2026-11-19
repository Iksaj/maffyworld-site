import { createHash, timingSafeEqual } from 'node:crypto';
import { getStore } from '@netlify/blobs';

export const PRODUCTS = Object.freeze({
  1: { title: 'Сержант', amount: 29 },
  2: { title: 'Доктор', amount: 49 },
  3: { title: 'Шериф', amount: 89 },
  4: { title: 'Бандит', amount: 129 },
  5: { title: 'Страж', amount: 169 },
  6: { title: 'Дентик', amount: 209 },
  7: { title: 'Мафиша', amount: 309 }
});

export function responseJSON(payload, status = 200) {
  return Response.json(payload, { status, headers: {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  }});
}
export function responseText(payload, status = 200) {
  return new Response(payload, { status, headers: {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8'
  }});
}
export function orderStore() {
  return getStore({ name: 'maffyworld-anypay-orders', consistency: 'strong' });
}
export function groupFor(id) {
  let mapping;
  try { mapping = JSON.parse(process.env.RANK_GROUPS_JSON || '{}'); }
  catch { return null; }
  const group = mapping?.[String(id)];
  return typeof group === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(group) ? group : null;
}
export function validNick(nickname) {
  return typeof nickname === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(nickname);
}
export function siteOrigin() {
  const url = new URL(process.env.PUBLIC_SITE_URL || 'https://maffyworld.ru');
  if (url.protocol !== 'https:') throw new Error('Site URL must be HTTPS');
  return url.origin;
}
export function anypayConfigReady() {
  return process.env.ENABLE_PAYMENTS === 'true' &&
    process.env.ENABLE_AUTO_GRANT === 'true' &&
    /^\d+$/.test(process.env.ANYPAY_PROJECT_ID || '') &&
    !!process.env.ANYPAY_SECRET_KEY &&
    /^\d+$/.test(process.env.ANYPAY_API_ID || '') &&
    !!process.env.ANYPAY_API_KEY &&
    !!process.env.RCON_HOST && !!process.env.RCON_PORT && !!process.env.RCON_PASSWORD;
}
export function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
export function matchingHex(a,b){
  if (typeof a!=='string'||!/^[a-f0-9]{64}$/i.test(a)||typeof b!=='string'||!/^[a-f0-9]{64}$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a.toLowerCase(),'hex'),Buffer.from(b.toLowerCase(),'hex'));
}

// Verify independently with AnyPay API; never trust the browser success redirect.
// https://anypay.io/doc/api/payments
export async function verifyPaidWithAnyPay(payId, transactionId) {
  const apiId = process.env.ANYPAY_API_ID;
  const projectId = process.env.ANYPAY_PROJECT_ID;
  const apiKey = process.env.ANYPAY_API_KEY;
  const sign = sha256(`payments${apiId}${projectId}${apiKey}`);
  const form = new FormData();
  form.set('project_id', projectId);
  form.set('pay_id', String(payId));
  form.set('sign', sign);
  const res = await fetch(`https://anypay.io/api/payments/${encodeURIComponent(apiId)}`, {
    method: 'POST', headers: { Accept: 'application/json' }, body: form,
    signal: AbortSignal.timeout(9500)
  });
  if (!res.ok) throw new Error(`AnyPay API HTTP ${res.status}`);
  const data = await res.json();
  const payments = data?.result?.payments;
  if (!payments || typeof payments !== 'object') throw new Error('AnyPay API returned no payments');
  const matching = Object.values(payments).find(p =>
    String(p?.pay_id) === String(payId) &&
    String(p?.transaction_id) === String(transactionId));
  if (!matching) throw new Error('Payment is absent from API');
  return matching;
}
