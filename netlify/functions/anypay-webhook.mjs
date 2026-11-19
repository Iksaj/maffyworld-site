import { Rcon } from 'rcon-client';
import {
  groupFor, matchingHex, orderStore, responseText, sha256,
  verifyPaidWithAnyPay
} from './_lib/common.mjs';

async function deliver(order) {
  let rcon;
  try {
    rcon = await Rcon.connect({
      host:process.env.RCON_HOST,
      port:Number(process.env.RCON_PORT),
      password:process.env.RCON_PASSWORD,
      timeout:6500
    });
    const text = String(await rcon.send(`lp user ${order.nickname} parent add ${order.group}`));
    if (/unknown command|error occurred|does not exist|not found|permission denied/i.test(text))
      throw new Error('LuckPerms rejected the group command');
    return text.slice(0,250);
  } finally { if (rcon) try { await rcon.end(); } catch {} }
}

const ANYPAY_IPS = new Set(['185.162.128.38', '185.162.128.39', '185.162.128.88']);

export default async (request, context) => {
  // Provider-signed webhook AND verified Netlify client IP (not a spoofable header).
  if (!ANYPAY_IPS.has(context?.ip)) return responseText('Invalid source',403);
  if (!['GET','POST'].includes(request.method)) return responseText('GET/POST only',405);
  const body = request.method==='POST' ? await request.text() : '';
  if (body.length > 25_000) return responseText('Body too large',413);
  let event;
  try {
    if (request.method==='GET') event=Object.fromEntries(new URL(request.url).searchParams);
    else if (request.headers.get('content-type')?.includes('application/json')) event=JSON.parse(body);
    else event=Object.fromEntries(new URLSearchParams(body));
  } catch { return responseText('Bad request',400); }
  const { merchant_id, pay_id, amount, currency, status, sign, transaction_id, test }=event||{};
  if (!/^\d{1,15}$/.test(String(pay_id||'')) ||
      String(merchant_id)!==String(process.env.ANYPAY_PROJECT_ID))
    return responseText('Invalid merchant/order',400);
  // AnyPay SCI callback SHA256 = currency:amount:pay_id:merchant_id:status:secret
  // https://anypay.io/doc/sci/notification
  const expected = sha256([
    currency,amount,pay_id,merchant_id,status,process.env.ANYPAY_SECRET_KEY || ''
  ].join(':'));
  if (!matchingHex(sign,expected)) return responseText('Invalid signature',401);
  // A valid callback with non-paid status is not a delivery request.
  if (String(status)!=='paid') return responseText('OK');

  const store=orderStore(), key=`orders/${pay_id}`;
  try {
    const entry=await store.getWithMetadata(key,{type:'json',consistency:'strong'});
    if (!entry?.data) return responseText('Order missing; retry',503);
    const order=entry.data;
    if (order.payId!==String(pay_id) ||
        !Number.isFinite(Number(amount)) || Number(amount)!==order.amount ||
        String(currency).toUpperCase()!=='RUB' ||
        !/^\d+$/.test(String(transaction_id||''))) return responseText('Order mismatch',400);

    // test=1 callbacks never issue live ranks, even if someone enables auto-grant.
    if (String(test)==='1') {
      if (order.state!=='test-paid') await store.setJSON(key,{...order,state:'test-paid'}, {onlyIfMatch:entry.etag});
      return responseText('OK');
    }
    if (String(test)!=='0') return responseText('Missing transaction mode',400);
    if (order.state==='delivered') return responseText('OK');
    if (order.state==='processing' && Date.now()-Date.parse(order.claimedAt)<120_000)
      return responseText('Busy, retry',503);
    if (process.env.ENABLE_AUTO_GRANT!=='true') return responseText('Delivery disabled; retry',503);
    if (order.group!==groupFor(order.productId)) return responseText('Group mapping changed; retry',503);

    // Critical: independent verification of status and exact amount/currency through API.
    const provider=await verifyPaidWithAnyPay(pay_id,transaction_id);
    if (String(provider.status)!=='paid' ||
        Number(provider.amount)!==order.amount ||
        String(provider.currency).toUpperCase()!=='RUB')
      return responseText('Unverified payment; retry',503);

    const lock=await store.setJSON(key,{
      ...order,state:'processing',claimedAt:new Date().toISOString(),
      transactionId:String(transaction_id)
    },{onlyIfMatch:entry.etag});
    if (!lock.modified) return responseText('Concurrent request; retry',503);
    try {
      const rconReply=await deliver(order);
      const done=await store.setJSON(key,{
        ...order,state:'delivered',claimedAt:new Date().toISOString(),
        transactionId:String(transaction_id),deliveredAt:new Date().toISOString(),rconReply
      },{onlyIfMatch:lock.etag});
      if (!done.modified) throw new Error('Failed to record successful delivery');
      return responseText('OK');
    } catch(error) {
      console.error('AnyPay RCON delivery:',error instanceof Error ? error.message : 'unknown');
      await store.setJSON(key,{...order,state:'delivery-error'}, {onlyIfMatch:lock.etag});
      return responseText('Delivery failed; retry',503);
    }
  } catch(error) {
    console.error('AnyPay webhook:',error instanceof Error ? error.message : 'unknown');
    return responseText('Temporary failure; retry',503);
  }
};
