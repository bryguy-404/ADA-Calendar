/** Clean, portable artifact rehearsal using fictional local credentials only. */
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {randomUUID,createHmac} from 'node:crypto';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {CalendarReadClient,signIn,saveSession} from '../src/lib/mcp/client.ts';
export async function exercisePortableRequester({requester,password,origin,future,workspaceId,api,output,evidence,config:authConfig}) {
  const directory=realpathSync(mkdtempSync(path.join(tmpdir(),'ada-portable-requester-')));
  const root=path.join(directory,'installed');
  const cleanEnv=Object.fromEntries(['PATH','HOME','USER','TMPDIR','SHELL','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  let client;
  try {
    execFileSync(process.execPath,['scripts/build-mcp-package.mjs'],{stdio:'pipe'});
    execFileSync('tar',['-xzf','.data/mcp-package/ada-calendar-mcp-1.3.0.tgz','-C',directory]);
    const install=path.join(directory,'ada-calendar-mcp-1.3.0','install.mjs');
    const result=JSON.parse(execFileSync(process.execPath,[install,'--directory',root],{cwd:directory,env:cleanEnv,encoding:'utf8'}));
    assert.equal(result.configurationChanged,false);
    assert.throws(()=>execFileSync(process.execPath,[install,'--directory',root],{cwd:directory,env:cleanEnv,stdio:'pipe'}));
    const adapter=path.join(result.installed,'ada.mjs'),session=path.join(root,'session.json');
    const env={...cleanEnv,ADA_CALENDAR_URL:origin,ADA_CALENDAR_ALLOW_LOCAL:'1'};
    execFileSync('python3',[path.resolve('scripts/mcp-package/login-pty-check.py'),process.execPath,adapter],{cwd:directory,env,input:JSON.stringify({email:requester.email,password}),stdio:['pipe','pipe','pipe']});
    const verified=JSON.parse(execFileSync(process.execPath,[adapter,'verify',future],{cwd:directory,env,encoding:'utf8'}));
    assert.equal(verified.actor.id,requester.id);assert.equal(verified.actor.role,'requester');assert.equal(verified.workspaceId,workspaceId);
    client=new Client({name:'portable-requester-check',version:'1.0.0'});
    await client.connect(new StdioClientTransport({command:process.execPath,args:[adapter,'start'],cwd:directory,env,stderr:'pipe'}));
    assert.equal((await client.listTools()).tools.length,8);
    const read=await client.callTool({name:'find_calendar_items',arguments:{kind:'clients'}});assert.notEqual(read.isError,true);
    await client.close();client=null;
    // Fresh login for the native host: never share a refresh file with another running process.
    await saveSession(session,await signIn(origin,requester.email,password,true));
    const config=JSON.parse(readFileSync(path.join(result.installed,'claude-mcp.json'),'utf8'));
    config.mcpServers['ada-calendar-requester'].env={ADA_CALENDAR_URL:origin,ADA_CALENDAR_ALLOW_LOCAL:'1'};
    const configFile=path.join(directory,'fictional-claude-mcp.json');writeFileSync(configFile,JSON.stringify(config),{mode:0o600});
    const operationId=randomUUID();
    const prompt=`This is an explicitly authorized fictional acceptance test in a local ADA Calendar. Use only the ada-calendar-requester MCP tools. First discover the exact FICTIONAL verification client and read Bryan's shared availability for ${future}. Then create and submit one task titled "FICTIONAL portable Claude requester ${operationId}": web edit, description "Fictional portable integration test; no real work", estimate 30 minutes, references ["https://example.test/brief"], windowStart ${future}, windowEnd null, targetDate null, deadline null, minimumSessionMinutes 15. Book 30 total minutes on ${future}. Use operationId ${operationId}, exact discovered workspaceId and fresh scheduleVersion. Omit requesterId. Prepare, inspect, then commit without another permission question. Report booked/pending from the receipt. Do not change any existing work, use owner capabilities, or call other services. This authorized test is solely fictional local data.`;
    const args=['-p',prompt,'--strict-mcp-config','--mcp-config',configFile,'--tools','','--allowedTools','mcp__ada-calendar-requester__find_calendar_items','mcp__ada-calendar-requester__get_available_slots','mcp__ada-calendar-requester__prepare_schedule_change','mcp__ada-calendar-requester__commit_schedule_change','--max-turns','12','--output-format','json','--no-session-persistence','--disable-slash-commands'];
    const logs=[];const child=spawn('claude',args,{cwd:directory,env:cleanEnv,stdio:['ignore','pipe','pipe']});
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>logs.push(chunk));
    const timer=setTimeout(()=>child.kill('SIGTERM'),240000);
    const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});clearTimeout(timer);
    mkdirSync(output,{recursive:true});writeFileSync(path.join(output,'native-requester-claude.json'),Buffer.concat(logs),{mode:0o600});
    assert.equal(code,0,'Native Claude requester rehearsal failed; inspect private evidence.');
    const after=await api('state'),saved=after.items.find(i=>i.id===operationId);
    assert.ok(saved,'Native Claude did not finish the fictional submission.');assert.equal(saved.requesterId,requester.id);
    assert.equal(after.sessions.filter(s=>s.workItemId===operationId&&s.status==='planned').length,1);
    assert.equal(after.events.filter(e=>e.operationId===operationId).length,1);
    // Validly signed but expired local access token, with unusable refresh token.
    // This fictional session must fail closed through the actual authenticated API.
    const expired=await signIn(origin,requester.email,password,true);
    const keys=Object.keys(expired.cookies).sort(),cookie=keys.map(k=>expired.cookies[k]).join('');
    assert.ok(cookie.startsWith('base64-'));
    const payload=JSON.parse(Buffer.from(cookie.slice(7),'base64url').toString());
    const body=payload.access_token.split('.')[1];
    const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
    assert.ok(authConfig.JWT_SECRET);
    const originalClaims=JSON.parse(Buffer.from(body,'base64url'));
    const validUnsigned=header+'.'+Buffer.from(JSON.stringify(originalClaims)).toString('base64url');
    const validToken=validUnsigned+'.'+createHmac('sha256',authConfig.JWT_SECRET).update(validUnsigned).digest('base64url');
    const valid=await fetch(authConfig.API_URL+'/auth/v1/user',{headers:{apikey:authConfig.ANON_KEY,Authorization:'Bearer '+validToken}});
    assert.equal(valid.status,200,'The local legacy signing key must be accepted before testing expiry.');
    const claims={...originalClaims,exp:1};
    const unsigned=header+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url');
    payload.access_token=unsigned+'.'+createHmac('sha256',authConfig.JWT_SECRET).update(unsigned).digest('base64url');
    payload.refresh_token='fictional-expired-refresh';payload.expires_at=1;payload.expires_in=0;
    expired.cookies={[keys[0].replace(/\.\d+$/,'')]:'base64-'+Buffer.from(JSON.stringify(payload)).toString('base64url')};
    const expiredFile=path.join(root,'expired-fictional-session.json');await saveSession(expiredFile,expired);
    await assert.rejects(()=>new CalendarReadClient(origin,expiredFile,true).state(),error=>error.code==='access_denied');
    evidence.portableRequester={passed:true,cleanInstall:true,bundledDependencies:true,readVerification:true,interactivePasswordHidden:true,expiredSessionDenied:true,nativeClaudeCode:true,fictionalActor:true,bookedTaskId:operationId,hostConfigurationChanged:false};
  } finally {await client?.close();rmSync(directory,{recursive:true,force:true});}
}
