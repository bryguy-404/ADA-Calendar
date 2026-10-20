import "server-only";
import { cookies } from "next/headers";
import { demoActor, demoEnabled, getDemoState, commitDemoProposal, submitDemoRequest, resolveDemoRequest, undoDemoEvent, mutateDemoAdmin, beginDemoAIOperation, finishDemoAIOperation, getDemoAIOperation, hasCommittedDemoOperation } from "./demo-store";
import { getLiveActor } from "./auth";
import { getLiveState, commitLiveProposal, submitLiveRequest, resolveLiveRequest, undoLiveEvent, mutateLiveAdmin, beginLiveAIOperation, finishLiveAIOperation, getLiveAIOperation, hasCommittedLiveOperation } from "./live-store";

export { demoEnabled };
export async function currentActor() {
  return demoEnabled() ? demoActor((await cookies()).get("ada-demo-actor")?.value) : getLiveActor();
}
export const store = {
  getState: async (...args: Parameters<typeof getLiveState>) => demoEnabled() ? getDemoState(demoActor(args[0])) : getLiveState(...args),
  hasCommittedOperation: async (...args: Parameters<typeof hasCommittedLiveOperation>) => demoEnabled() ? hasCommittedDemoOperation(...args) : hasCommittedLiveOperation(...args),
  commit: async (...args: Parameters<typeof commitLiveProposal>) => demoEnabled() ? commitDemoProposal(args[0], args[1]) : commitLiveProposal(...args),
  request: async (...args: Parameters<typeof submitLiveRequest>) => demoEnabled() ? submitDemoRequest(args[0], args[1], args[2]) : submitLiveRequest(...args),
  resolve: async (...args: Parameters<typeof resolveLiveRequest>) => demoEnabled() ? resolveDemoRequest(...args) : resolveLiveRequest(...args),
  undo: async (...args: Parameters<typeof undoLiveEvent>) => demoEnabled() ? undoDemoEvent(...args) : undoLiveEvent(...args),
  admin: async (...args: Parameters<typeof mutateLiveAdmin>) => demoEnabled() ? mutateDemoAdmin(...args) : mutateLiveAdmin(...args),
  beginAI: async (...args: Parameters<typeof beginDemoAIOperation>) => demoEnabled() ? beginDemoAIOperation(...args) : beginLiveAIOperation(...args),
  getAI: async (...args: Parameters<typeof getDemoAIOperation>) => demoEnabled() ? getDemoAIOperation(...args) : getLiveAIOperation(...args),
  finishAI: async (...args: Parameters<typeof finishDemoAIOperation>) => demoEnabled() ? finishDemoAIOperation(...args) : finishLiveAIOperation(...args),
};
