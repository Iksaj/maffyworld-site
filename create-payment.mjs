import { randomUUID } from 'node:crypto';
import {
  PRODUCT_PRICES, result, configured, orderStore, rankGroup,
  validNickname, publicSite
} from './_lib/common.mjs';

export default async (request) => {
  if (request.method !== 'POST') return result({ error: 'Используйте POST' }, 405);
  if (!configured()) return result({ error: 'Оплата пока не активирована администратором.' }, 503);

  let data;
  try { data = await request.json(); }
  catch { return result({ error: 'Неверный формат запроса' }, 400); }

  if (!data || typeof data !== 'object' || Array.isArray(data))
    return result({ error: 'Неверные данные заказа' }, 400);
  const productId = Number(data.productId);
  const nickname = typeof data.nickname === 'string' ? data.nickname.trim() : '';
  const product = PRODUCT_PRICES[productId];
  const group = rankGroup(productId);
  if (!product || !group) return result({ error: 'Выдача этой привилегии ещё не настроена.' }, 400);
  if (!validNickname(nickname)) return result({ error: 'Введите корректный Minecraft-ник (3–16 символов, латиница, цифры, _).' }, 400);
  // Price comes ONLY from the server-side catalog, never from the browser.

  const store = orderStore();
  const orderId = randomUUID();
  const key = `orders/${orderId}`;
  const now = new Date().toISOString();
  const order = {
    id: orderId, productId, title: product.title, amount: product.amount,
    nickname, group, invoiceId: null, state: 'created', createdAt: now
  };
  try {
    const saved = await store.setJSON(key, order, { onlyIfNew: true });
    if (!saved.modified) throw new Error('Cannot reserve order');

    const payload = {
      project_id: Number(process.env.COINSO_PROJECT_ID),
      amount: product.amount,
      description: `MaffyWorld: ${product.title} для ${nickname}`,
      custom: orderId,
      integration_type: 'standard',
      success_url: `${publicSite()}/?payment=return`,
      fail_url: `${publicSite()}/?payment=failed`
    };
    const response = await fetch('https://coinso.io/api/payment/create', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.COINSO_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8500)
    });
    const invoice = await response.json();
    if (!response.ok || invoice.success !== true || typeof invoice.invoice_id !== 'string' ||
        typeof invoice.payment_url !== 'string') {
      const explanation = invoice?.error_description || invoice?.message || 'Создать счёт не удалось';
      // Do not reveal internal API diagnostics or credentials to the buyer.
      console.error('Coinso invoice failed', response.status, invoice?.error_code, explanation);
      return result({ error: 'Coinso не смог создать счёт. Проверьте способы оплаты и ограничения по сумме.' }, 502);
    }
    const url = new URL(invoice.payment_url);
    if (url.protocol !== 'https:' || url.hostname !== 'coinso.io')
      throw new Error('Unexpected payment URL');
    const updated = await store.setJSON(key, {
      ...order, invoiceId: invoice.invoice_id, state: 'awaiting-payment'
    }, { onlyIfMatch: saved.etag });
    if (!updated.modified) throw new Error('Order could not be committed');
    return result({ payment_url: url.href, invoice_id: invoice.invoice_id });
  } catch (error) {
    console.error('create-payment error:', error instanceof Error ? error.message : 'unknown');
    return result({ error: 'Не удалось начать оплату. Попробуйте ещё раз позже.' }, 503);
  }
};
