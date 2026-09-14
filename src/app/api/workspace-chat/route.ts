import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { workspaceChatRequestSchema, type WorkspaceChatResponse } from "@/lib/workspace-chat";
import { currentActor, demoEnabled, store } from "@/lib/server/service";
import { listNotes } from "@/lib/server/notes";
import { localDate } from "@/lib/time";
import { PreviewChangedError } from "@/lib/server/preview";
import {
  assertChatProposal, deterministicChatAnswer, interpretWorkspaceChat, previewWorkspaceOrder,
  readWorkspaceChatRecord, workspaceChatContext, workspaceChatMessageDate, workspaceChatCommandDate, WorkspaceChatError,
  workspaceChatRecord, workspaceChatReservationUsd, type WorkspaceChatRecord,
} from "@/lib/server/workspace-chat";

export const runtime = "nodejs";
export const maxDuration = 120;
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });
async function boundedJson(req: NextRequest) {
  if (Number(req.headers.get("content-length") || 0) > 40_000) throw new WorkspaceChatError("This chat message is too long.", 413);
  const reader = req.body?.getReader();
  if (!reader) throw new WorkspaceChatError("Enter a chat message.");
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 40_000) { await reader.cancel(); throw new WorkspaceChatError("This chat message is too long.", 413); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new WorkspaceChatError("Enter a valid chat request."); }
}

export async function POST(req: NextRequest) {
  let retryWithNewOperation = false;
  try {
    const expectedOrigin = new URL(process.env.APP_URL || req.url).origin;
    const origin = req.headers.get("origin");
    if (!origin || origin !== expectedOrigin && !(demoEnabled() && origin === new URL(req.url).origin)) throw new WorkspaceChatError("Request origin could not be verified.", 403);
    const input = workspaceChatRequestSchema.parse(await boundedJson(req));
    const actor = await currentActor();
    if (actor.role === "viewer") throw new WorkspaceChatError("This helper is available to the owner and requesters. Viewers can read the calendar directly.", 403);
    const state = await store.getState(actor.id);
    const now = new Date().toISOString();
    if (input.action === "confirm") {
      if (actor.role !== "owner") throw new WorkspaceChatError("Only Bryan can confirm changes to existing sessions.", 403);
      const operation = await store.getAI(actor, input.operationId);
      if (operation.kind !== "assistant" || operation.status !== "completed") throw new WorkspaceChatError("That preview is not available to confirm.", 409);
      const saved = readWorkspaceChatRecord(operation.result, actor, state, now);
      if (!saved.command || saved.response.reply.kind !== "preview" || !saved.response.reply.proposal) throw new WorkspaceChatError("This chat message has no booking preview to confirm.", 409);
      assertChatProposal(saved.response.reply.proposal, actor);
      const contextDate = workspaceChatCommandDate(saved.command, state);
      const prior = state.events.find(event => event.operationId === saved.response.reply.proposal!.operationId);
      if (prior || state.version > saved.response.reply.proposal.baseVersion) {
        // The underlying store checks durable idempotency, actor and exact command.
        try {
          const latest = await store.commit(actor, saved.response.reply.proposal);
          return respond({ reply: { kind: "answer", message: "That booking change was already saved. No duplicate changes were made.", sources: saved.response.reply.sources }, operationId: input.operationId, stateVersion: latest.version, asOf: now, contextDate, state: latest, proposal: saved.response.reply.proposal } satisfies WorkspaceChatResponse);
        } catch (error) {
          // If not committed before, its old baseVersion guarantees no new write.
          // Continue only for that expected stale-plan rejection.
          if (prior || !(error instanceof Error) || !/changed|fresh|review/i.test(error.message)) throw error;
        }
      }
      const freshReply = previewWorkspaceOrder(state, actor, saved.command, input.operationId, now);
      const fresh = freshReply.proposal;
      if (!fresh || fresh.status !== "ready" || fresh.requiresApproval || input.baseVersion !== state.version || input.reviewFingerprint !== fresh.reviewFingerprint) {
        return respond({ reply: freshReply, operationId: input.operationId, stateVersion: state.version, asOf: now, contextDate, state,
          error: "The calendar or available times changed. Review the refreshed result before confirming." } satisfies WorkspaceChatResponse, 409);
      }
      assertChatProposal(fresh, actor);
      try {
        const latest = await store.commit(actor, fresh);
        return respond({ reply: { kind: "answer", message: saved.command.type === "reorder_day" ? "The order is saved. The same tasks and session lengths were preserved; no tasks were created or deleted." : "The booking changes are saved. No projects were created or deleted, and project effort estimates were left unchanged.", sources: freshReply.sources }, operationId: input.operationId, stateVersion: latest.version, asOf: new Date().toISOString(), contextDate, state: latest, proposal: fresh } satisfies WorkspaceChatResponse);
      } catch (error) {
        // Re-read after a racing calendar edit or clock boundary; never substitute
        // a plan the owner has not reviewed and never retry a write automatically.
        const latest = await store.getState(actor.id);
        if (error instanceof PreviewChangedError || latest.version !== state.version || error instanceof Error && /changed|fresh|review/i.test(error.message)) {
          return respond({ reply: previewWorkspaceOrder(latest, actor, saved.command, input.operationId, new Date().toISOString()), operationId: input.operationId, stateVersion: latest.version, asOf: new Date().toISOString(), contextDate, state: latest, error: "The calendar changed while saving. Review the refreshed result." } satisfies WorkspaceChatResponse, 409);
        }
        throw error;
      }
    }
    let previous: WorkspaceChatRecord | undefined;
    if (input.replyToOperationId) {
      if (input.replyToOperationId === input.operationId) throw new WorkspaceChatError("A chat message cannot reply to itself.");
      const parent = await store.getAI(actor, input.replyToOperationId);
      if (parent.kind !== "assistant" || parent.status !== "completed") throw new WorkspaceChatError("Wait for the previous message to finish, or start a new chat.", 409, true);
      previous = readWorkspaceChatRecord(parent.result, actor, state, now);
    }
    const resolved = workspaceChatMessageDate(input.text, localDate(now, state.settings.timeZone), input.date ?? previous?.response.contextDate ?? previous?.turns.at(-1)?.date ?? localDate(now, state.settings.timeZone), previous);
    const direct = deterministicChatAnswer(input.text, state, resolved.date, previous, localDate(now, state.settings.timeZone), now);
    const notes = actor.role === "owner" && !direct && !resolved.error ? await listNotes(actor) : [];
    const context = !direct && !resolved.error ? workspaceChatContext(state, actor, notes, input.text, resolved.date, now) : undefined;
    if (context && !demoEnabled() && !process.env.OPENAI_API_KEY) throw new WorkspaceChatError("The AI helper is not connected. Your calendar has not changed. Daily agendas and weekly workload questions remain available.", 503);
    // Parent linkage is bound to the identity hash and checked with actor-private
    // getAI above. The old parentId column is reserved for Ask ADA clarification
    // consumption; this separate chat must not alter that endpoint's behavior.
    const identity = { namespace: "ada-workspace-chat-v1", text: input.text, date: input.date ?? null, replyToOperationId: input.replyToOperationId ?? null };
    const operation = await store.beginAI(actor, { id: input.operationId, kind: "assistant", inputHash: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
      reserveUsd: demoEnabled() ? 0 : context ? workspaceChatReservationUsd(input.text, context, previous) : .01 });
    if (operation.status === "processing") throw new WorkspaceChatError("That message is still processing. Retry with the same operation ID.", 409);
    if (operation.status === "failed") { retryWithNewOperation = true; throw new WorkspaceChatError("That attempt did not finish. Send the message again to try a new attempt; no changes were made.", 409); }
    if (operation.status === "completed") return respond(readWorkspaceChatRecord(operation.result, actor, state, now).response);
    try {
      const result = resolved.error ? { reply: { kind: "clarification" as const, message: resolved.error, sources: [] }, intent: "reorder", costUsd: 0, command: undefined }
        : await interpretWorkspaceChat(input.text, state, actor, notes, { date: resolved.date, now, operationId: input.operationId, demo: demoEnabled(), previous });
      // Inference can take time: proposals always use the latest clock/snapshot.
      const freshState = result.command ? await store.getState(actor.id) : state;
      const asOf = result.command ? new Date().toISOString() : now;
      const reply = result.command ? previewWorkspaceOrder(freshState, actor, result.command, input.operationId, asOf) : result.reply;
      if (reply.message.length > 7900) reply.message = `${reply.message.slice(0, 7700)}\n\nThis answer is shortened. Open All work or the calendar for the complete list.`;
      reply.sources = reply.sources.slice(0, 100);
      const response: WorkspaceChatResponse = { reply, operationId: input.operationId, stateVersion: freshState.version, asOf, contextDate: result.command ? workspaceChatCommandDate(result.command, freshState) : resolved.date };
      const record = workspaceChatRecord(actor, freshState, response, input.text, resolved.date, result.intent, previous, result.command, "pendingReorder" in result ? result.pendingReorder : undefined);
      await store.finishAI(actor, input.operationId, record, demoEnabled() ? undefined : result.costUsd);
      return respond(response);
    } catch (error) {
      await store.finishAI(actor, input.operationId, null, undefined, "Workspace chat did not complete. No automatic calendar mutation was attempted.");
      retryWithNewOperation = true;
      throw error;
    }
  } catch (error) {
    const message = error instanceof z.ZodError ? "The chat request is invalid. Use the chat controls and try again." : error instanceof Error ? error.message : "ADA could not complete that request.";
    return respond({ error: message, ...(retryWithNewOperation ? { retryWithNewOperation: true } : {}), ...(error instanceof WorkspaceChatError && error.resetNeeded ? { resetNeeded: true } : {}) }, error instanceof WorkspaceChatError ? error.status : 400);
  }
}
