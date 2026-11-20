// MaffyWorld Cloudflare Worker. Payments are OFF unless explicitly enabled.
// Do not expose AnyPay secrets or delivery agent credentials in public assets.
const CATALOG = Object.freeze({
  1: ['Сержант', 29], 2: ['Доктор', 49], 3: ['Шериф', 89],
  4: ['Бандит', 129], 5: ['Страж', 169], 6: ['Дентик', 209],
  7: ['Мафиша', 309], 11: ['Донат-Кейс', 35],
  12: ['Кейс с игровой валютой', 20],
  13: ['Кейс с MaffyCoins', 45],
  14: ['Кейс с донат-вещами', 75]
});
// Case IDs match the public shop catalog. RCON commands omit the leading "/" used in-game.
const CASE_KEYS = Object.freeze({
  11: 'donate', // Донат-Кейс
  12: 'money',  // Игровая валюта
  13: 'tokens', // Маффи токены
  14: 'items'   // Донат-вещи
});
const NICK_RE = /^[A-Za-z0-9_]{3,16}$/;
const ID_RE = /^\d{1,15}$/;

function json(data, status = 200) {
  return Response.json(data, {status, headers: {'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'}});
}
function plain(data, status = 200) {
  return new Response(data, {status, headers: {'Content-Type':'text/plain; charset=utf-8', 'Cache-Control':'no-store'}});
}
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const hashed = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hashed), b => b.toString(16).padStart(2,'0')).join('');
}
export function commandFor(env, id, nickname, quantity) {
  if (!NICK_RE.test(nickname) || !Number.isInteger(quantity) || quantity < 1 || quantity > 50)
    return null;
  // Only these four confirmed crate keys can be issued. Never take a command from the customer.
  if (Object.hasOwn(CASE_KEYS, id))
    return `cases givekey ${nickname} ${CASE_KEYS[id]} ${quantity}`;
  let commands;
  try { commands = JSON.parse(env.DELIVERY_COMMANDS_JSON || '{}'); }
  catch { return null; }
  const template = commands && commands[String(id)];
  if (typeof template !== 'string' || template.length > 200 ||
      !/^[\w .{}:-]+$/.test(template) || !template.includes('{nickname}') ||
      /[{}]/.test(template.replaceAll('{nickname}','').replaceAll('{quantity}',''))) return null;
  return template.replaceAll('{nickname}', nickname).replaceAll('{quantity}', String(quantity));
}
function configReady(env) {
  return env.ENABLE_PAYMENTS === 'true' && !!env.ORDERS &&
    /^\d+$/.test(env.ANYPAY_PROJECT_ID || '') &&
    /^\d+$/.test(env.ANYPAY_API_ID || '') &&
    !!env.ANYPAY_SECRET_KEY && !!env.ANYPAY_API_KEY &&
    typeof env.DELIVERY_AGENT_TOKEN === 'string' && env.DELIVERY_AGENT_TOKEN.length >= 32;
}
async function recentAgent(env) {
  const agent = await env.ORDERS.prepare('SELECT seen_at FROM agent_status WHERE id=1').first();
  return !!agent && Date.now() - Date.parse(agent.seen_at) < 180000;
}
function siteOrigin(env, request) {
  // During migration, redirects can point to the Cloudflare preview until the custom domain is ready.
  const url = new URL(env.PUBLIC_SITE_URL || new URL(request.url).origin);
  if (url.protocol !== 'https:') throw new Error('PUBLIC_SITE_URL requires HTTPS');
  return url.origin;
}
async function createPayment(request, env) {
  if (request.method !== 'POST') return json({error:'Используйте POST.'}, 405);
  if (!configReady(env)) return json({error:'Оплата пока не включена администратором.'}, 503);
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) return json({error:'Нужен JSON.'}, 415);
  let input;
  try {
    const raw = await request.text();
    if (raw.length > 2048) return json({error:'Слишком большой запрос.'}, 413);
    input = JSON.parse(raw);
  } catch { return json({error:'Некорректный JSON.'},400); }
  const id = input?.productId;
  // Accept only numeric catalog IDs; never allow inherited object properties.
  const product = Number.isInteger(id) && Object.hasOwn(CATALOG, id) ? CATALOG[id] : null;
  const nick = typeof input?.nickname === 'string' ? input.nickname.trim() : '';
  const qty = id >= 11 && id <= 14 ? (input?.quantity ?? 1) : 1;
  if (!product || !NICK_RE.test(nick) || !Number.isInteger(qty) || qty < 1 || qty > 50)
    return json({error:'Проверь товар, количество и ник Minecraft (3–16 символов).'},400);
  const command = commandFor(env, id, nick, qty);
  if (!command) return json({error:'Выдача выбранного товара ещё не настроена.'},503);
  const amount = product[1] * qty;
  try {
    if (!await recentAgent(env)) return json({error:'Система выдачи на Minecraft-сервере временно недоступна.'},503);
    let payId;
    for (let i=0; i<5; i++) {
      // Numeric payment ID; collisions are rejected by the D1 primary key.
      const number = crypto.getRandomValues(new Uint32Array(2));
      payId = String(100000000000 + (number[0] * 65536 + (number[1] & 65535)) % 900000000000);
      const inserted = await env.ORDERS.prepare(
        'INSERT OR IGNORE INTO orders(pay_id,product_id,title,nickname,quantity,amount,command,state,created_at) VALUES(?,?,?,?,?,?,?,?,?)'
      ).bind(payId,id,product[0],nick,qty,amount,command,'awaiting-payment',new Date().toISOString()).run();
      if (inserted.meta.changes === 1) break;
      payId = null;
    }
    if (!payId) throw new Error('Order collision');
    const origin = siteOrigin(env, request);
    const merchant = env.ANYPAY_PROJECT_ID;
    const desc = 'MaffyWorld: ' + product[0] + ' x' + qty + ' (' + nick + ')';
    const success = origin + '/?payment=return';
    const fail = origin + '/?payment=failed';
    const value = amount.toFixed(2);
    // AnyPay SCI SHA-256 merchant form signature. Compare with the active SCI settings.
    const sign = await sha256([merchant,payId,value,'RUB',desc,success,fail,env.ANYPAY_SECRET_KEY].join(':'));
    const url = new URL('https://anypay.io/merchant');
    for (const [key,val] of Object.entries({
      merchant_id:merchant,pay_id:payId,amount:value,currency:'RUB',
      desc,success_url:success,fail_url:fail,lang:'ru',sign
    })) url.searchParams.set(key,val);
    return json({payment_url:url.toString()});
  } catch (error) {
    console.error('Create payment failed:',error instanceof Error ? error.message : 'unknown');
    return json({error:'Не удалось создать заказ. Попробуй позже.'},503);
  }
}
async function verifyAnyPay(env, payId, transactionId) {
  const apiId = env.ANYPAY_API_ID;
  const sign = await sha256('payments' + apiId + env.ANYPAY_PROJECT_ID + env.ANYPAY_API_KEY);
  const form = new FormData();
  form.set('project_id',env.ANYPAY_PROJECT_ID);
  form.set('pay_id',payId);
  form.set('sign',sign);
  const response = await fetch('https://anypay.io/api/payments/' + encodeURIComponent(apiId), {
    method:'POST',body:form,headers:{Accept:'application/json'},signal:AbortSignal.timeout(9000)
  });
  if (!response.ok) throw new Error('AnyPay HTTP ' + response.status);
  const payload = await response.json();
  const payments = payload?.result?.payments;
  if (!payments || typeof payments !== 'object') throw new Error('AnyPay payments missing');
  return Object.values(payments).find(p => String(p?.pay_id) === payId &&
    String(p?.transaction_id) === transactionId);
}
async function anypayWebhook(request, env) {
  if (!['GET','POST'].includes(request.method)) return plain('Method not allowed',405);
  if (!env.ORDERS || !env.ANYPAY_SECRET_KEY || !env.ANYPAY_PROJECT_ID) return plain('Not configured',503);
  let fields;
  try {
    const raw = request.method === 'POST' ? await request.text() : '';
    if (raw.length > 25000) return plain('Too large',413);
    fields = request.method === 'GET' ? Object.fromEntries(new URL(request.url).searchParams) :
      request.headers.get('content-type')?.includes('application/json') ? JSON.parse(raw) :
      Object.fromEntries(new URLSearchParams(raw));
  } catch { return plain('Bad request',400); }
  const {merchant_id,pay_id,amount,currency,status,sign,transaction_id,test} = fields || {};
  if (!ID_RE.test(String(pay_id || '')) ||
      String(merchant_id) !== env.ANYPAY_PROJECT_ID ||
      typeof sign !== 'string' || !/^[a-f0-9]{64}$/i.test(sign)) return plain('Invalid request',400);
  // AnyPay SCI notification signature, independently verified before querying D1.
  const expected = await sha256([currency,amount,pay_id,merchant_id,status,env.ANYPAY_SECRET_KEY].join(':'));
  if (!equal(sign.toLowerCase(), expected)) return plain('Invalid signature',401);
  if (status !== 'paid') return plain('OK');
  const payId = String(pay_id);
  try {
    const order = await env.ORDERS.prepare('SELECT * FROM orders WHERE pay_id=?').bind(payId).first();
    if (!order || Number(amount) !== order.amount ||
        String(currency).toUpperCase() !== 'RUB') return plain('Order mismatch',400);
    if (String(test) === '1') {
      await env.ORDERS.prepare("UPDATE orders SET state='test-paid' WHERE pay_id=? AND state='awaiting-payment'").bind(payId).run();
      return plain('OK');
    }
    if ((test !== undefined && String(test) !== '0') || !ID_RE.test(String(transaction_id || ''))) return plain('Invalid mode',400);
    if (['paid','claimed','delivered','manual-review'].includes(order.state) &&
        order.transaction_id === String(transaction_id)) return plain('OK');
    if (order.state !== 'awaiting-payment') return plain('Order state mismatch',409);
    if (!configReady(env)) return plain('Payments not ready',503);
    // The payment provider's API must independently confirm transaction, amount and currency.
    const provider = await verifyAnyPay(env,payId,String(transaction_id));
    if (!provider || String(provider.status) !== 'paid' ||
        Number(provider.amount) !== order.amount ||
        String(provider.currency).toUpperCase() !== 'RUB') return plain('Payment not verified',503);
    const result = await env.ORDERS.prepare(
      "UPDATE orders SET state='paid',transaction_id=? WHERE pay_id=? AND state='awaiting-payment'"
    ).bind(String(transaction_id),payId).run();
    if (result.meta.changes !== 1) return plain('Concurrent update',503);
    return plain('OK');
  } catch (error) {
    console.error('AnyPay webhook failed:',error instanceof Error ? error.message : 'unknown');
    return plain('Temporary failure',503);
  }
}
async function agentAuthorized(request, env) {
  const bearer = request.headers.get('Authorization') || '';
  const token = env.DELIVERY_AGENT_TOKEN;
  if (!token || token.length < 32 || !bearer.startsWith('Bearer ')) return false;
  // Compare hashes to avoid variable-length token comparison.
  return equal(await sha256(bearer.slice(7)),await sha256(token));
}
async function deliveryClaim(request, env) {
  if (request.method !== 'POST') return json({error:'POST only'},405);
  if (!await agentAuthorized(request,env)) return json({error:'Unauthorized'},401);
  if (!env.ORDERS) return json({error:'Database missing'},503);
  try {
    const now = new Date().toISOString();
    await env.ORDERS.prepare(
      'INSERT INTO agent_status(id,seen_at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET seen_at=excluded.seen_at'
    ).bind(now).run();
    // Atomic claim: no re-claim after an uncertain RCON outcome; manual review instead.
    const job = await env.ORDERS.prepare(
      "UPDATE orders SET state='claimed',claimed_at=? WHERE pay_id=(SELECT pay_id FROM orders WHERE state='paid' ORDER BY created_at LIMIT 1) AND state='paid' RETURNING pay_id,nickname,command"
    ).bind(now).first();
    return json({job:job || null});
  } catch (error) {
    console.error('Delivery claim failed:',error instanceof Error ? error.message : 'unknown');
    return json({error:'Temporary database failure'},503);
  }
}
async function deliveryAck(request, env) {
  if (request.method !== 'POST') return json({error:'POST only'},405);
  if (!await agentAuthorized(request,env)) return json({error:'Unauthorized'},401);
  if (!env.ORDERS) return json({error:'Database missing'},503);
  let input;
  try {
    const raw=await request.text();
    if (raw.length>2000) return json({error:'Too large'},413);
    input=JSON.parse(raw);
  } catch { return json({error:'Bad JSON'},400); }
  if (!ID_RE.test(String(input?.payId || '')) || typeof input?.ok !== 'boolean')
    return json({error:'Bad acknowledgement'},400);
  const state = input.ok ? 'delivered' : 'manual-review';
  const detail = typeof input.detail === 'string' ? input.detail.slice(0,300) : '';
  try {
    const updated = await env.ORDERS.prepare(
      "UPDATE orders SET state=?,delivered_at=?,delivery_note=? WHERE pay_id=? AND state='claimed'"
    ).bind(state,input.ok?new Date().toISOString():null,detail,String(input.payId)).run();
    return updated.meta.changes === 1 ? json({ok:true}) : json({error:'Order not claimed'},409);
  } catch (error) {
    console.error('Delivery ack failed:',error instanceof Error ? error.message : 'unknown');
    return json({error:'Temporary database failure'},503);
  }
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/api/health') {
      let databaseReady = false;
      try {
        if (env.ORDERS) {
          const tables = await env.ORDERS.prepare(
            "SELECT COUNT(DISTINCT name) AS count FROM sqlite_master WHERE type='table' AND name IN ('orders','agent_status')"
          ).first();
          databaseReady = Number(tables?.count) === 2;
        }
      } catch (error) {
        console.error('D1 health check failed:', error instanceof Error ? error.message : 'unknown');
      }
      return json({
        site: 'MaffyWorld',
        api: true,
        databaseReady,
        paymentsConfigured: databaseReady && configReady(env)
      });
    }
    if (path === '/api/create-payment' || path === '/.netlify/functions/create-payment')
      return createPayment(request,env);
    if (path === '/api/anypay-webhook' || path === '/.netlify/functions/anypay-webhook')
      return anypayWebhook(request,env);
    if (path === '/api/agent/claim') return deliveryClaim(request,env);
    if (path === '/api/agent/ack') return deliveryAck(request,env);
    if (path.startsWith('/api/') || path.startsWith('/.netlify/functions/')) return plain('Not found',404);
    return env.ASSETS.fetch(request);
  }
};