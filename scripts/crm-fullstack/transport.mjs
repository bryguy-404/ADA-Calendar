// Test transport only. Production containers do not import or copy this module.
// Auth, API validation, scheduling and database operations still execute unchanged.
import {readFileSync,writeFileSync} from 'node:fs';
if (process.env.ADA_FULLSTACK_LOCAL_TEST !== 'true') throw new Error('Explicit local integration test flag required.');
const nativeFetch = globalThis.fetch;
const destinations = new Map([
  ['https://ada-crm-integration.supabase.co', 'http://127.0.0.1:55521'],
  ['https://calendar.integration.invalid', 'http://127.0.0.1:3193'],
  ['https://crm.integration.invalid', 'http://127.0.0.1:3194'],
]);
const local = new Set(['http://127.0.0.1:55421', 'http://127.0.0.1:55521', 'http://127.0.0.1:3193', 'http://127.0.0.1:3194']);
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const target = destinations.get(url.origin);
  if (!target && !local.has(url.origin)) throw new Error('Local integration test blocked non-local network access.');
  const faultFile='/private/tmp/ada-crm-fullstack-local/faults.json';
  let fault;try{fault=JSON.parse(readFileSync(faultFile,'utf8'));}catch{}
  const operation=typeof init?.body==='string'?JSON.parse(init.body).operationId:null;
  const matches=fault?.path===url.pathname && (!fault.operationId || fault.operationId===operation);
  if(matches){writeFileSync(faultFile,'{}',{mode:0o600});if(fault.before)throw new Error('Fictional connection interruption before dispatch.');}
  if (!target) return nativeFetch(input, init);
  const address = target + url.pathname + url.search;
  const response=await nativeFetch(input instanceof Request ? new Request(address, input) : address, init);
  if(matches){await response.arrayBuffer();throw new Error('Fictional lost acknowledgement after real response.');}
  return response;
};
