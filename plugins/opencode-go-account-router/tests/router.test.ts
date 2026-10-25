import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import { parseQuota, quotaBlockedUntil, retryAt } from '../src/quota.js';
import plugin from '../src/index.js';
import type { Fetch } from '../src/types.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const NOW = Date.parse('2026-10-25T10:00:00Z');
const healthy = (percent = 1) => ({ usage: Object.fromEntries(['rolling', 'weekly', 'monthly'].map(name => [name, {
  percent, status: 'ok', resetsAt: new Date(NOW + 3600_000).toISOString(),
}])) });
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'go-router-'));t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);const a = await store.add('A', 'test-key-A');const b = await store.add('B', 'test-key-B');
  return { dir, store, a, b };
}
const request = (session = 'session-1', model = 'test-model') => new Request('https://opencode.ai/zen/go/v1/chat/completions', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-opencode-session': session, 'x-native-header': 'preserved' },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }] }),
});
function transport(infer: (request: Request) => Response | Promise<Response>, usage = (_key: string) => healthy()): Fetch {
  return async (input, init) => {
    const req = new Request(input, init);
    if (req.url.endsWith('/usage')) return Response.json(usage(req.headers.get('authorization') || ''));
    return infer(req);
  };
}

test('all three windows are parsed and the latest exhausted reset governs', () => {
  const data = healthy();data.usage.weekly.percent = 100;data.usage.monthly.percent = 100;
  data.usage.monthly.resetsAt = new Date(NOW + 10 * 86400_000).toISOString();
  const quota = parseQuota(data, NOW)!;
  assert.equal(quotaBlockedUntil(quota, NOW), NOW + 10 * 86400_000);
  assert.equal(quotaBlockedUntil(quota, NOW + 11 * 86400_000), 0);
  assert.equal(parseQuota({ usage: {} }, NOW), null);
  assert.equal(retryAt('90', NOW), NOW + 90_000);
  assert.equal(retryAt(new Date(NOW + 30_000).toUTCString(), NOW), NOW + 30_000);
});

for (const window of ['rolling', 'weekly', 'monthly']) {
  test(`proactively skips A when its ${window} quota is exhausted`, async t => {
    const {store,a,b}=await fixture(t);const calls:string[]=[];
    const send=transport(req=>{calls.push(req.headers.get('authorization')!);return new Response('ok');},key=>{
      const data=healthy();if(key.endsWith('A'))data.usage[window].percent=100;return data;
    });
    const router=new Router(store,{fetch:send,now:()=>NOW});
    assert.equal(await(await router.fetch(request())).text(),'ok');
    assert.deepEqual(calls,['Bearer test-key-B']);
    assert.equal((await store.snapshot()).sessions['session-1'].accountId,b);
    assert.equal((await store.snapshot()).quotas[a][window as 'weekly'].percent,100);
  });
}

test('429 switches accounts and preserves request body, session and native headers', async t=>{
  const {store}=await fixture(t);const attempts:Array<{key:string;body:string;session:string;header:string}>=[];
  const router=new Router(store,{now:()=>NOW,fetch:transport(async req=>{
    attempts.push({key:req.headers.get('authorization')!,body:await req.text(),session:req.headers.get('x-opencode-session')!,header:req.headers.get('x-native-header')!});
    return attempts.length===1?new Response('quota reached',{status:429,headers:{'Retry-After':'300'}}):new Response('stream data',{headers:{'Content-Type':'text/event-stream'}});
  })});
  const result=await router.fetch(request());assert.equal(await result.text(),'stream data');
  assert.equal(attempts.length,2);assert.equal(attempts[0].body,attempts[1].body);
  assert.equal(attempts[1].session,'session-1');assert.equal(attempts[1].header,'preserved');
  assert.deepEqual(attempts.map(a=>a.key),['Bearer test-key-A','Bearer test-key-B']);
});

test('Anthropic API-key authentication follows the selected Go account',async t=>{
  const {store}=await fixture(t);const keys:string[]=[];
  const router=new Router(store,{now:()=>NOW,fetch:transport(req=>{
    keys.push(req.headers.get('x-api-key')!);assert.equal(req.headers.get('anthropic-version'),'2023-06-01');
    return keys.length===1?new Response('',{status:429}):new Response('ok');
  })});
  const req=new Request('https://opencode.ai/inference/go/anthropic/v1/messages',{
    method:'POST',headers:{'Content-Type':'application/json','x-api-key':'seed','anthropic-version':'2023-06-01'},
    body:JSON.stringify({model:'minimax-m3',messages:[{role:'user',content:'hello'}]}),
  });
  assert.equal(await(await router.fetch(req)).text(),'ok');assert.deepEqual(keys,['test-key-A','test-key-B']);
});

for(const auth of ['header','query'])test(`Google ${auth} authentication and URL model follow account failover`,async t=>{
  const {store,a}=await fixture(t);const keys:string[]=[];
  const router=new Router(store,{now:()=>NOW,fetch:transport(req=>{
    keys.push(auth==='header'?req.headers.get('x-goog-api-key')!:new URL(req.url).searchParams.get('key')!);
    assert.equal(new URL(req.url).searchParams.get('alt'),'sse');
    return keys.length===1?new Response('',{status:429}):new Response('ok');
  })});
  const req=new Request('https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse'+(auth==='query'?'&key=seed':''),{
    method:'POST',headers:{'Content-Type':'application/json',...(auth==='header'?{'x-goog-api-key':'seed'}:{})},
    body:JSON.stringify({contents:[{role:'user',parts:[{text:'hello'}]}]}),
  });
  assert.equal(await(await router.fetch(req)).text(),'ok');assert.deepEqual(keys,['test-key-A','test-key-B']);
  assert.equal((await store.snapshot()).blocks[a]['gemini-4-argon'].reason,'quota_or_rate_limit');
});

test('cooldown and account selection survive a new CloudCLI process/router',async t=>{
  const {store,dir,b}=await fixture(t);let first=true;const keys:string[]=[];
  const send=transport(req=>{const key=req.headers.get('authorization')!;keys.push(key);if(first){first=false;return new Response('',{status:429,headers:{'Retry-After':'3600'}});}return new Response('ok');});
  await new Router(store,{fetch:send,now:()=>NOW}).fetch(request());
  await new Router(new Store(dir),{fetch:send,now:()=>NOW+1000}).fetch(request());
  assert.deepEqual(keys,['Bearer test-key-A','Bearer test-key-B','Bearer test-key-B']);
  assert.equal((await store.snapshot()).sessions['session-1'].accountId,b);
});

test('expired cooldown makes A eligible for a new session while existing B stays sticky',async t=>{
  const {store}=await fixture(t);let now=NOW;let first=true;const keys:string[]=[];
  const send=transport(req=>{const key=req.headers.get('authorization')!;keys.push(key);if(first){first=false;return new Response('',{status:429,headers:{'Retry-After':'60'}});}return new Response('ok');});
  const router=new Router(store,{fetch:send,now:()=>now});await router.fetch(request());now+=61_000;
  await router.fetch(request('session-1'));await router.fetch(request('new-session'));
  assert.deepEqual(keys,['Bearer test-key-A','Bearer test-key-B','Bearer test-key-B','Bearer test-key-A']);
});

test('all exhausted returns one bounded error and the earliest useful retry time',async t=>{
  const {store}=await fixture(t);let calls=0;
  const router=new Router(store,{now:()=>NOW,fetch:transport(()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':calls===1?'600':'120'}});})});
  const result=await router.fetch(request());assert.equal(result.status,429);assert.equal(calls,2);
  assert.equal(result.headers.get('Retry-After'),'120');
  assert.equal((await result.json()).error.code,'all_go_accounts_unavailable');
});

for(const code of [402,403])test(`explicit quota rejection ${code} switches to B`,async t=>{
  const {store}=await fixture(t);let calls=0;
  const router=new Router(store,{now:()=>NOW,fetch:transport(()=>++calls===1?new Response('usage quota exceeded',{status:code}):new Response('ok'))});
  assert.equal(await(await router.fetch(request())).text(),'ok');assert.equal(calls,2);
});

for(const code of [400,403,500])test(`ordinary ${code} errors pass through once`,async t=>{
  const {store}=await fixture(t);let calls=0;const response=new Response('region unavailable',{status:code});
  const router=new Router(store,{now:()=>NOW,fetch:transport(()=>{calls++;return response;})});
  assert.equal(await router.fetch(request()),response);assert.equal(calls,1);
});

test('ambiguous network failure is propagated without replay',async t=>{
  const {store}=await fixture(t);let calls=0;
  const router=new Router(store,{now:()=>NOW,fetch:transport(()=>{calls++;throw new Error('network reset');})});
  await assert.rejects(router.fetch(request()),/network reset/);assert.equal(calls,1);
});

test('a successful partial stream is returned untouched',async t=>{
  const {store}=await fixture(t);let calls=0;
  const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('first'));controller.close();}});
  const response=new Response(stream);const router=new Router(store,{now:()=>NOW,fetch:transport(()=>{calls++;return response;})});
  const actual=await router.fetch(request());assert.equal(actual,response);assert.equal(await actual.text(),'first');assert.equal(calls,1);
});

test('external endpoints and pre-aborted input receive no credentials or fetch',async t=>{
  const {store}=await fixture(t);let calls=0;const router=new Router(store,{fetch:async()=>{calls++;return new Response('');}});
  await assert.rejects(router.fetch('https://example.com/zen/go/v1/chat/completions'),/untrusted/);
  await assert.rejects(router.fetch(new Request(request(),{signal:AbortSignal.abort()})));
  assert.equal(calls,0);
});

test('invalid keys cool down globally and disabled accounts are excluded',async t=>{
  const {store,a,b}=await fixture(t);const keys:string[]=[];
  const router=new Router(store,{now:()=>NOW,fetch:transport(req=>{const key=req.headers.get('authorization')!;keys.push(key);return key.endsWith('A')?new Response('',{status:401}):new Response('ok');})});
  await router.fetch(request());await router.fetch(request('other','another-model'));
  assert.deepEqual(keys,['Bearer test-key-A','Bearer test-key-B','Bearer test-key-B']);
  assert.equal((await store.snapshot()).blocks[a]['*'].reason,'credential_rejected');
  await store.change(b,'disable');assert.equal((await router.fetch(request('third'))).status,429);
});

test('concurrent state writers preserve every account and private permissions',async t=>{
  const {dir,store}=await fixture(t);await Promise.all(Array.from({length:15},(_,i)=>new Store(dir).add('extra-'+i,'fake-key-'+i)));
  assert.equal((await store.snapshot()).accounts.length,17);
  assert.equal((await stat(store.filename)).mode&0o777,0o600);
  assert.equal((await stat(dir)).mode&0o777,0o700);
  await assert.rejects(store.add('duplicate','test-key-A'),/already/);
});

test('independent CLI processes initialize and update one shared account store',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'go-router-processes-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const storeModule=new URL('../src/store.js',import.meta.url).href;
  const execute=promisify(execFile);
  await Promise.all(Array.from({length:8},(_,i)=>execute(process.execPath,['--input-type=module','-e',
    `import {Store} from ${JSON.stringify(storeModule)}; await new Store(process.argv[1]).add(process.argv[2],process.argv[3]);`,
    dir,'account-'+i,'fake-key-'+i])));
  const state=await new Store(dir).snapshot();assert.equal(state.accounts.length,8);
  assert.equal(new Set(state.accounts.map(a=>a.apiKey)).size,8);
});

test('manual preference changes new sessions and retains the account of an existing session',async t=>{
  const {store,b}=await fixture(t);const keys:string[]=[];
  const router=new Router(store,{now:()=>NOW,fetch:transport(req=>{keys.push(req.headers.get('authorization')!);return new Response('ok');})});
  await router.fetch(request('existing'));await store.prefer(b);
  await router.fetch(request('new'));await router.fetch(request('existing'));
  assert.deepEqual(keys,['Bearer test-key-A','Bearer test-key-B','Bearer test-key-A']);
});

test('OpenCode plugin exposes the Go loader and stable session header',async t=>{
  const {dir}=await fixture(t);const hooks=await plugin.server({} as never,{stateDir:dir});
  assert.equal(hooks.auth?.provider,'opencode-go');
  const loaded=await hooks.auth!.loader!(async()=>({type:'api',key:'seed'}),{} as never);
  assert.equal(typeof loaded.fetch,'function');assert.equal(loaded.apiKey,'go-account-router');
  const output={headers:{}} as {headers:Record<string,string>};
  await hooks['chat.headers']!({sessionID:'native-session',model:{providerID:'opencode-go'}} as never,output);
  assert.equal(output.headers['x-opencode-session'],'native-session');
});
