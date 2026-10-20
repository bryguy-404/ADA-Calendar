import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState, DEMO_MEMBERS } from "./fixtures";
import { newWorkItem } from "./work";
import { localDateTime } from "./time";
import { undoUnavailableReason } from "./undo";
import type { AppState, WorkCommand } from "./types";

// Isolated fictional demo data only. The real database, AI and mail providers
// cannot be used by these authenticated command/undo route regressions.
vi.mock("server-only",()=>({}));
vi.mock("next/headers",()=>({cookies:async()=>({get:()=>({value:"bryan"}),set:vi.fn()})}));
vi.mock("./server/supabase",()=>({getSupabaseAdminClient:vi.fn(()=>{throw new Error("No live database in undo tests");}),getSupabaseServerClient:vi.fn(()=>{throw new Error("No live database in undo tests");}),clearSupabaseSessionCookies:vi.fn()}));
vi.mock("./server/assistant",()=>({interpretInput:vi.fn(()=>{throw new Error("No model calls in undo tests");}),assistantReservationUsd:vi.fn(()=>0),inspectAudioRecording:vi.fn(),transcribeAudio:vi.fn()}));
vi.mock("./server/service",async()=>{
  const demo=await import("./server/demo-store");
  return {currentActor:vi.fn(async()=>DEMO_MEMBERS[0]),demoEnabled:()=>true,store:{getState:vi.fn(async(id:string)=>demo.getDemoState(demo.demoActor(id))),commit:vi.fn(demo.commitDemoProposal),undo:vi.fn(demo.undoDemoEvent),request:vi.fn(demo.submitDemoRequest)}};
});
import { POST } from "../app/api/[...path]/route";
import { currentActor } from "./server/service";
import { demoTransaction, getDemoState } from "./server/demo-store";

const origin="http://localhost:3000",owner=DEMO_MEMBERS[0],date="2026-09-09",next="2026-09-10";
const at=(clock:string,day=date)=>localDateTime(day,clock,"America/Indiana/Indianapolis");
const resize:WorkCommand={type:"resize_booking",sessionId:"build-session",minutes:60};
const add:WorkCommand={type:"add_booking",itemId:"build",request:{startDate:next,endDate:next,minutes:60,distribution:"total"}};
const transfer:WorkCommand={type:"move_booking",sessionId:"build-session",date:next,minutes:60};
let filename:string;
async function send(route:string,body:unknown,requestOrigin=origin){
  return POST(new NextRequest(`${origin}/api/${route}`,{method:"POST",headers:{origin:requestOrigin,"content-type":"application/json"},body:JSON.stringify(body)}),{params:Promise.resolve({path:[route]})});
}
async function save(command:WorkCommand,operationId=`test-${command.type}`):Promise<AppState>{
  const response=await send("commands",{commands:[command],operationId,action:"preview"});expect(response.status).toBe(200);
  const {proposal}=await response.json();expect(proposal.status,JSON.stringify(proposal.conflicts)).toBe("ready");
  const saved=await send("commands",{commands:[command],operationId,action:"commit",baseVersion:proposal.baseVersion,reviewFingerprint:proposal.reviewFingerprint});expect(saved.status).toBe(200);return (await saved.json()).state;
}
async function notes(){return JSON.parse(await readFile(filename,"utf8")).personalNotes;}
beforeEach(async()=>{
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(at("08:00")));
  vi.stubEnv("ADA_DEMO_MODE","true");vi.stubEnv("APP_URL",origin);
  const directory=await mkdtemp(path.join(tmpdir(),"ada-chat-undo-fixture-"));vi.stubEnv("ADA_DATA_DIR",directory);
  for(const key of ["OPENAI_API_KEY","RESEND_API_KEY","SUPABASE_SERVICE_ROLE_KEY","NEXT_PUBLIC_SUPABASE_URL","NEXT_PUBLIC_SUPABASE_ANON_KEY"])vi.stubEnv(key,"");
  const fixture=createDemoState();fixture.items=[newWorkItem(owner,date,{id:"build",clientId:"fixture-client",title:"Fictional website build",estimatedMinutes:240,remainingMinutes:240,minimumSessionMinutes:120,windowEnd:"2026-12-31"}),newWorkItem(owner,date,{id:"other",clientId:"fixture-client",title:"Other fictional project",estimatedMinutes:60,remainingMinutes:60,minimumSessionMinutes:60})];
  fixture.clients=[{id:"fixture-client",name:"Fictional client",aliases:[]}];fixture.settings.reserveMinutes=0;fixture.blocks=[];fixture.events=[];fixture.notifications=[];fixture.requests=[];fixture.version=0;
  fixture.sessions=[{id:"build-session",workItemId:"build",start:at("09:00"),end:at("11:00"),status:"planned",protected:false,usesReserve:false},{id:"other-session",workItemId:"other",start:at("09:00",next),end:at("10:00",next),status:"planned",protected:true,usesReserve:false}];
  const personalNotes=[{workspaceId:fixture.workspaceId,authorId:owner.id,note:{id:"private-note",title:"Fictional personal note",body:"Keep this note unchanged",version:1,createdAt:at("07:00"),updatedAt:at("07:00")}}];
  filename=path.join(directory,"ada-demo.json");await writeFile(filename,JSON.stringify({...fixture,personalNotes}),{mode:0o600});vi.mocked(currentActor).mockResolvedValue(owner);
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();vi.clearAllMocks();});

describe("undoing an existing-project chat booking change",()=>{
  it.each([resize,add,transfer])("restores the exact previous project/session bodies for $type, without touching notes",async command=>{
    const before=await getDemoState(owner),originalNotes=await notes(),saved=await save(command),event=saved.events[0];
    expect(undoUnavailableReason(saved,event,at("08:00"))).toBeNull();
    const response=await send("undo",{id:event.id});expect(response.status).toBe(200);const undone:AppState=(await response.json()).state;
    expect(undone.items).toEqual(before.items);expect(undone.sessions).toEqual(before.sessions);expect(undone.blocks).toEqual(before.blocks);expect(undone.items).toHaveLength(2);
    expect(await notes()).toEqual(originalNotes);expect(undone).not.toHaveProperty("personalNotes");
    expect(undone.version).toBe(2);expect(undone.events).toHaveLength(2);expect(undone.events[0].type).toBe("schedule_undone");expect(undone.events[1].undoneBy).toBe(undone.events[0].id);
    expect(undone.notifications.some(n=>n.subject.includes("Change undone"))).toBe(true);expect(undone.notifications.every(n=>n.status==="captured")).toBe(true);
  });
  it("restores waiting status, unknown totals, and the original reason when undoing explicitly resumed added hours",async()=>{
    await demoTransaction(state=>{state.items[0].estimatedMinutes=null;state.items[0].remainingMinutes=null;state.items[0].status="waiting";state.items[0].blockedReason="Waiting for fictional client details";state.sessions=state.sessions.filter(s=>s.workItemId!=="build");});
    const before=await getDemoState(owner),saved=await save({...add,request:{...add.request,resumeWaiting:true}});
    expect(saved.items[0].status).toBe("planned");expect(saved.sessions).toHaveLength(2);
    expect((await send("undo",{id:saved.events[0].id})).status).toBe(200);const undone=await getDemoState(owner);
    expect(undone.items).toEqual(before.items);expect(undone.sessions).toEqual(before.sessions);expect(undone.items[0].remainingMinutes).toBeNull();
  });
  it("restores changed daily quotas without adding obsolete focus metadata",async()=>{
    await demoTransaction(state=>{state.items[0].dailyPlan=[{date,minutes:120}];});
    const before=await getDemoState(owner),saved=await save(transfer);expect(saved.items[0].dailyPlan).toEqual([{date,minutes:60},{date:next,minutes:60}]);
    expect((await send("undo",{id:saved.events[0].id})).status).toBe(200);expect((await getDemoState(owner)).items).toEqual(before.items);
    await demoTransaction(state=>{state.items[0].dailyPlan=undefined;state.items[0].remainingMinutes=180;state.items[0].estimatedMinutes=180;state.sessions.push({...state.sessions[0],id:"short-remainder",start:at("11:00"),end:at("12:00")});});
    const original=await getDemoState(owner),shortened=await save(resize,"short-remainder-resize");expect(shortened.sessions.find(s=>s.id==="short-remainder")?.focusOverrideMinutes).toBeUndefined();
    expect((await send("undo",{id:shortened.events[0].id})).status).toBe(200);expect((await getDemoState(owner)).sessions).toEqual(original.sessions);
  });
  it("preserves a personal note saved after the booking change",async()=>{
    const saved=await save(add);await demoTransaction(state=>{state.personalNotes![0].note.body="A newer private note must survive calendar undo";state.personalNotes![0].note.version++;});
    const latestNotes=await notes();expect((await send("undo",{id:saved.events[0].id})).status).toBe(200);expect(await notes()).toEqual(latestNotes);
  });
  it("cannot undo an older booking change after a different calendar change",async()=>{
    const first=await save(resize),second=await save(add,"later-add"),privateNotes=await notes();
    expect(undoUnavailableReason(second,first.events[0],at("08:00"))).toContain("latest unchanged");
    expect((await send("undo",{id:first.events[0].id})).status).toBe(400);expect(await getDemoState(owner)).toEqual(second);expect(await notes()).toEqual(privateNotes);
  });
  it("does not produce two corrective events when the same undo request is retried",async()=>{
    const saved=await save(transfer),id=saved.events[0].id;
    const results=await Promise.all([send("undo",{id}),send("undo",{id})]);expect(results.map(r=>r.status).sort()).toEqual([200,400]);
    const undone=await getDemoState(owner);expect(undone.version).toBe(2);expect(undone.events.filter(e=>e.type==="schedule_undone")).toHaveLength(1);
    expect((await send("undo",{id})).status).toBe(400);expect(await getDemoState(owner)).toEqual(undone);
  });
  it.each([1,3])("requires authenticated owner authority (fixture %s)",async index=>{
    const saved=await save(resize);vi.mocked(currentActor).mockResolvedValue(DEMO_MEMBERS[index]);
    expect((await send("undo",{id:saved.events[0].id})).status).not.toBe(200);expect(await getDemoState(owner)).toEqual(saved);
  });
  it("rejects unknown event IDs and cross-origin undo",async()=>{
    const saved=await save(resize);expect((await send("undo",{id:"unknown-event"})).status).toBe(400);
    expect((await send("undo",{id:saved.events[0].id},"https://invalid.example.test")).status).toBe(400);expect(await getDemoState(owner)).toEqual(saved);
  });
  it("can undo an unworked added booking after its scheduled start",async()=>{
    const saved=await save({...add,request:{...add.request,startDate:date,endDate:date}});vi.setSystemTime(new Date(at("11:01")));
    expect(undoUnavailableReason(saved,saved.events[0],at("11:01"))).toBeNull();
    const response=await send("undo",{id:saved.events[0].id});expect(response.status).toBe(200);expect((await getDemoState(owner)).sessions).toEqual(saved.events[0].before!.sessions);
  });
  it.each([undefined,60])("can undo a whole/partial move after its planned destination time (%s)",async minutes=>{
    await demoTransaction(state=>{state.sessions[0].start=at("09:00","2026-09-11");state.sessions[0].end=at("11:00","2026-09-11");});
    const saved=await save({type:"move_booking",sessionId:"build-session",date,...(minutes?{minutes}:{})});vi.setSystemTime(new Date(at("09:01")));
    expect((await send("undo",{id:saved.events[0].id})).status).toBe(200);expect((await getDemoState(owner)).sessions).toEqual(saved.events[0].before!.sessions);
  });
  it("can undo resumed waiting-project hours if they remain planned",async()=>{
    await demoTransaction(state=>{state.items[0].estimatedMinutes=null;state.items[0].remainingMinutes=null;state.items[0].status="waiting";state.items[0].blockedReason="Awaiting details";state.sessions=state.sessions.filter(s=>s.workItemId!=="build");});
    const saved=await save({...add,request:{...add.request,startDate:date,endDate:date,resumeWaiting:true}});vi.setSystemTime(new Date(at("09:01")));
    expect((await send("undo",{id:saved.events[0].id})).status).toBe(200);expect((await getDemoState(owner)).sessions).toEqual(saved.events[0].before!.sessions);
  });
  it("can restore the exact original unworked booking after its scheduled time",async()=>{
    const saved=await save({type:"move_booking",sessionId:"build-session",date:next});vi.setSystemTime(new Date(at("09:01")));
    expect(undoUnavailableReason(saved,saved.events[0],at("09:01"))).toBeNull();expect((await send("undo",{id:saved.events[0].id})).status).toBe(200);expect((await getDemoState(owner)).sessions).toEqual(saved.events[0].before!.sessions);
  });
  it("moves missed work after 5 PM and Undo restores the same uncompleted hours",async()=>{
    vi.setSystemTime(new Date(at("18:38")));
    const before=await getDemoState(owner);
    const saved=await save({type:"move_booking",sessionId:"build-session",date:next});
    expect(saved.items[0].remainingMinutes).toBe(before.items[0].remainingMinutes);
    expect((await send("undo",{id:saved.events[0].id})).status).toBe(200);
    const restored=await getDemoState(owner);
    expect(restored.items).toEqual(before.items);expect(restored.sessions).toEqual(before.sessions);
    expect(restored.notifications.every(n=>n.status==="captured")).toBe(true);
  });
  it("does not confuse unchanged historical JSON property order with a booking edit",async()=>{
    await demoTransaction(state=>{state.sessions.push({...state.sessions[0],id:"history",start:at("09:00","2026-09-08"),end:at("11:00","2026-09-08"),status:"completed"});});
    const saved=await save(resize),copy=structuredClone(saved),historical=copy.events[0].before!.sessions.find(s=>s.id==="history")!;
    copy.events[0].before!.sessions=copy.events[0].before!.sessions.map(s=>s.id==="history"?Object.fromEntries(Object.entries(historical).reverse()) as typeof historical:s);
    expect(undoUnavailableReason(copy,copy.events[0],at("08:00"))).toBeNull();expect((await send("undo",{id:saved.events[0].id})).status).toBe(200);
  });
  it("blocks changes to recorded completed/cancelled history regardless of clock time",async()=>{
    const saved=await save(resize);
    for(const status of ["completed","cancelled"] as const){
      const copy=structuredClone(saved);copy.sessions[0].status=status;copy.events[0].before!.sessions[0]={...copy.sessions[0],focusOverrideMinutes:30};
      expect(undoUnavailableReason(copy,copy.events[0],at("09:01"))).toContain("completed or cancelled");
    }
  });
});
