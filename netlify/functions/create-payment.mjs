import { randomInt } from 'node:crypto';
import {
  PRODUCTS, anypayConfigReady, groupFor, orderStore, responseJSON,
  sha256, siteOrigin, validNick
} from './_lib/common.mjs';

export default async (request) => {
  if (request.method !== 'POST') return responseJSON({ error: 'Используйте POST' }, 405);
  // Safety: No live invoice if RCON auto-delivery or AnyPay API verification is not configured.
  if (!anypayConfigReady()) return responseJSON({
    error: 'Оплата пока не активирована администратором. Настройте AnyPay и автовыдачу.'
  }, 503);
  let payload;
  try { payload = await request.json(); }
  catch { return responseJSON({ error: 'Неверный формат запроса' }, 400); }
  const id = Number(payload?.productId);
  const product = PRODUCTS[id];
  const nick = typeof payload?.nickname === 'string' ? payload.nickname.trim() : '';
  const group = groupFor(id);
  if (!product || !group) return responseJSON({ error: 'Выдача привилегии не настроена.' }, 400);
  if (!validNick(nick)) return responseJSON({ error: 'Ник Minecraft должен содержать 3–16 символов (латиница, цифры, _).' }, 400);

  const store = orderStore();
  let payId, saved, order;
  try {
    // AnyPay order identifiers must be numeric, up to 15 digits. Retry on collision.
    for (let attempt=0; attempt<5; attempt++) {
      payId = String(randomInt(100_000_000_000, 999_999_999_999));
      order = {
        payId, productId:id, title:product.title, amount:product.amount,
        nickname:nick, group, state:'awaiting-payment',
        createdAt:new Date().toISOString()
      };
      saved = await store.setJSON(`orders/${payId}`,order,{onlyIfNew:true});
      if (saved.modified) break;
    }
    if (!saved?.modified) throw new Error('Failed to create unique order');

    // AnyPay SCI SHA256 form signature: merchant_id:pay_id:amount:currency:
    // desc:success_url:fail_url:secret_key
    // https://anypay.io/doc/sci
    const merchantId = process.env.ANYPAY_PROJECT_ID;
    const amount = product.amount.toFixed(2);
    const currency = 'RUB';
    const desc = `MaffyWorld: ${product.title} (${nick})`;
    const successUrl = `${siteOrigin()}/?payment=return`;
    const failUrl = `${siteOrigin()}/?payment=failed`;
    const sign = sha256([
      merchantId, payId, amount, currency, desc, successUrl,
      failUrl, process.env.ANYPAY_SECRET_KEY
    ].join(':'));
    const url = new URL('https://anypay.io/merchant');
    for (const [key,value] of Object.entries({
      merchant_id:merchantId, pay_id:payId, amount, currency,
      desc, success_url:successUrl, fail_url:failUrl, lang:'ru',sign
    })) url.searchParams.set(key,value);
    return responseJSON({ payment_url:url.href });
  } catch(error) {
    console.error('AnyPay create-payment:', error instanceof Error ? error.message : 'unknown');
    return responseJSON({ error: 'Не удалось подготовить оплату. Попробуй позже.' }, 503);
  }
};
