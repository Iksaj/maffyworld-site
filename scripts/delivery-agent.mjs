// Run on the Minecraft server (or a trusted host with private RCON access).
// npm install; API_BASE_URL=... DELIVERY_AGENT_TOKEN=... RCON_HOST=127.0.0.1 ...
// Never commit secrets to GitHub. The agent never retries a command after an
// uncertain response; an ambiguous delivery requires manual review.
import { Rcon } from 'rcon-client';

const vars = ['API_BASE_URL','DELIVERY_AGENT_TOKEN','RCON_HOST','RCON_PORT','RCON_PASSWORD'];
for (const name of vars) if (!process.env[name]) throw new Error('Missing '+name);
const base = new URL(process.env.API_BASE_URL);
if (base.protocol !== 'https:') throw new Error('API_BASE_URL must be HTTPS');
const headers = {
  Authorization: 'Bearer ' + process.env.DELIVERY_AGENT_TOKEN,
  'Content-Type':'application/json'
};
async function post(path, body={}) {
  const res = await fetch(new URL(path, base), {
    method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error(path+' HTTP '+res.status);
  return res.json();
}
function sleep(ms) { return new Promise(resolve=>setTimeout(resolve,ms)); }
async function execute(command) {
  const rcon=await Rcon.connect({
    host:process.env.RCON_HOST,
    port:Number(process.env.RCON_PORT),
    password:process.env.RCON_PASSWORD,
    timeout:6500
  });
  try {
    const reply=String(await rcon.send(command));
    if (/unknown command|error occurred|does not exist|not found|permission denied/i.test(reply))
      throw new Error('Minecraft command rejected: '+reply.slice(0,150));
    return reply.slice(0,250);
  } finally { await rcon.end().catch(()=>{}); }
}
console.log('MaffyWorld delivery agent started (private RCON only)');
for (;;) {
  try {
    const {job}=await post('/api/agent/claim');
    if (job) {
      let ok=false, detail='';
      try {
        detail=await execute(job.command);
        ok=true;
      } catch(error) {
        detail=String(error?.message || 'Unknown RCON error').slice(0,300);
        console.error('Manual review needed for order',job.pay_id,detail);
      }
      try {
        await post('/api/agent/ack',{payId:job.pay_id,ok,detail});
      } catch(error) {
        // DO NOT repeat a command if acknowledgement failed.
        console.error('Acknowledgement failed; inspect order manually:',job.pay_id,error.message);
      }
    }
  } catch(error) { console.error('Agent polling:',error.message); }
  await sleep(5000);
}
