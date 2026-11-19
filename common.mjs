import { getStore } from '@netlify/blobs';

export const PRODUCT_PRICES = Object.freeze({
  1: { title: 'Сержант', amount: 29 },
  2: { title: 'Доктор', amount: 49 },
  3: { title: 'Шериф', amount: 89 },
  4: { title: 'Бандит', amount: 129 },
  5: { title: 'Страж', amount: 169 },
  6: { title: 'Дентик', amount: 209 },
  7: { title: 'Мафиша', amount: 309 }
});

export const result = (data, status = 200) => Response.json(data, {
  status,
  headers: {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  }
});

export function orderStore() {
  // Persistent across site deploys; strong reads needed for webhook/retry handling.
  return getStore({ name: 'maffyworld-coinso-orders', consistency: 'strong' });
}

export function rankGroup(productId) {
  // Intentionally NO guessed internal LuckPerms group names.
  const map = JSON.parse(process.env.RANK_GROUPS_JSON || '{}');
  const group = map[String(productId)];
  return typeof group === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(group)
    ? group : null;
}

export function validNickname(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(name);
}

export function configured() {
  return process.env.ENABLE_PAYMENTS === 'true' &&
    process.env.ENABLE_AUTO_GRANT === 'true' &&
    !!process.env.COINSO_SECRET_KEY &&
    /^\d+$/.test(process.env.COINSO_PROJECT_ID || '') &&
    !!process.env.RCON_HOST &&
    Number.isInteger(Number(process.env.RCON_PORT)) &&
    Number(process.env.RCON_PORT) > 0 &&
    !!process.env.RCON_PASSWORD;
}

export function publicSite() {
  const domain = process.env.PUBLIC_SITE_URL || 'https://maffyworld.ru';
  const url = new URL(domain);
  if (url.protocol !== 'https:') throw new Error('PUBLIC_SITE_URL must be https');
  return url.origin;
}

export async function coinsoStatus(invoiceId) {
  if (typeof invoiceId !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(invoiceId))
    throw new Error('Incorrect invoice ID');
  const url = `https://coinso.io/api/payment/status?uuid=${encodeURIComponent(invoiceId)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(7000) });
  if (!response.ok) throw new Error(`Coinso status HTTP ${response.status}`);
  const data = await response.json();
  if (!data || data.success !== true) throw new Error('Coinso status not confirmed');
  return data;
}
