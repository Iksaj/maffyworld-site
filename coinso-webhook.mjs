import { createHmac, timingSafeEqual } from 'node:crypto';
import { Rcon } from 'rcon-client';
import { result, coinsoStatus, orderStore } from './_lib/common.mjs';

function verifySignature(raw, signature, secret) {
  if (!secret || !/^[a-f0-9]{64}$/i.test(signature || '')) return false;
  const expected = createHmac('sha256', secret).update(raw, 'utf8').digest();
  const got = Buffer.from(signature, 'hex');
  return expected.length === got.length && timingSafeEqual(expected, got);
}

async function deliverRank(order) {
  const host = process.env.RCON_HOST;
  const port = Number(process.env.RCON_PORT);
  const password = process.env.RCON_PASSWORD;
  if (!host || !port || !password) throw new Error('Missing RCON environment');
  let connection;
  try {
    connection = await Rcon.connect({ host, port, password, timeout: 6500 });
    // All tokens come from previously validated values; no user-provided commands.
    const response = String(await connection.send(`lp user ${order.nickname} parent add ${order.group}`));
    if (/unknown command|error occurred|does not exist|not found|permission denied/i.test(response)) {
      throw new Error('LuckPerms rejected command');
    }
    return response.slice(0, 300);
  } finally {
    if (connection) try { await connection.end(); } catch {}
  }
}

export default async (request) => {
  if (request.method !== 'POST') return result({ error: 'POST only' }, 405);
  const raw = await request.text();
  if (raw.length > 64_000) return result({ error: 'Body too large' }, 413);
  if (!verifySignature(raw, request.headers.get('x-signature'), process.env.COINSO_SECRET_KEY))
    return result({ error: 'Invalid signature' }, 401);

  let incoming;
  try { incoming = JSON.parse(raw); }
  catch { return result({ error: 'Invalid JSON' }, 400); }
  if (incoming.event !== 'payment.success') return result({ ok: true, ignored: true });
  const orderId = incoming.custom;
  if (typeof orderId !== 'string' || !/^[0-9a-f-]{36}$/.test(orderId))
    return result({ error: 'Invalid order identifier' }, 400);

  const store = orderStore();
  const key = `orders/${orderId}`;
  try {
    let entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
    if (!entry?.data?.invoiceId) return result({ error: 'Order unavailable; retry' }, 503);
    const order = entry.data;
    if (order.id !== orderId || order.invoiceId !== incoming.invoice_id)
      return result({ error: 'Invoice mismatch' }, 400);

    // Never trust webhook contents alone. Check the actual invoice with Coinso.
    const payment = await coinsoStatus(order.invoiceId);
    if (payment.status !== 'paid' || payment.invoice_id !== order.invoiceId ||
        payment.custom !== order.id || Number(payment.amount) !== order.amount) {
      return result({ error: 'Payment not verified' }, 503);
    }
    if (payment.test_mode === true || incoming.test_mode === true) {
      if (order.state !== 'test-success') await store.setJSON(key, {
        ...order, state: 'test-success', confirmedAt: new Date().toISOString()
      }, { onlyIfMatch: entry.etag });
      return result({ ok: true, test: true });
    }
    if (order.state === 'delivered') return result({ ok: true, duplicate: true });

    // Conditional write is the per-order concurrency guard. For ranks, re-adding
    // the same LuckPerms parent after a crash is idempotent.
    if (order.state === 'processing' && Date.now() - Date.parse(order.claimedAt) < 120000)
      return result({ error: 'Order is being processed' }, 503);
    if (process.env.ENABLE_AUTO_GRANT !== 'true')
      return result({ error: 'Delivery temporarily disabled' }, 503);
    const claim = await store.setJSON(key, {
      ...order, state: 'processing', claimedAt: new Date().toISOString()
    }, { onlyIfMatch: entry.etag });
    if (!claim.modified) return result({ error: 'Concurrent delivery' }, 503);
    try {
      const response = await deliverRank(order);
      const completed = await store.setJSON(key, {
        ...order, state: 'delivered', claimedAt: new Date().toISOString(),
        deliveredAt: new Date().toISOString(), rconReply: response
      }, { onlyIfMatch: claim.etag });
      if (!completed.modified) throw new Error('Cannot record completed grant');
      return result({ ok: true });
    } catch (error) {
      console.error('RCON delivery failed for invoice', order.invoiceId, error instanceof Error ? error.message : 'error');
      await store.setJSON(key, {
        ...order, state: 'delivery-error', claimedAt: new Date().toISOString()
      }, { onlyIfMatch: claim.etag });
      return result({ error: 'Delivery failed; retry' }, 503);
    }
  } catch (error) {
    console.error('webhook handler failure:', error instanceof Error ? error.message : 'unknown');
    return result({ error: 'Temporary failure; retry' }, 503);
  }
};
