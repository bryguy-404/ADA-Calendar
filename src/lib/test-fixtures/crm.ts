/** Fictional CRM fixtures only. No provider requests, real identities or credentials. */
import { createDemoState } from "../fixtures";
import { crmTaskInputSchema, type CrmAuthenticatedContext, type CrmTaskInput } from "../crm-integration";
import type { AppState } from "../types";

export const crmTestNow = "2026-09-15T12:00:00Z", crmTestDay = "2026-09-15";
export const crmTestContext: CrmAuthenticatedContext = {
  connection: { id: "20000000-0000-4000-8000-000000000001", workspaceId: "20000000-0000-4000-8000-000000000002", principalUserId: "20000000-0000-4000-8000-000000000003",
    crmOrigin: "https://crm.example.invalid", crmAuthUrl: "https://fictional.supabase.co", crmPublicKey: "sb_publishable_fixture", credentialHash: "a".repeat(64), agencyDomain: "example.invalid", enabled: true },
  requester: { subject: "20000000-0000-4000-8000-000000000004", email: "teammate@example.invalid", name: "teammate@example.invalid" },
};
export const crmTestPreviewId = "20000000-0000-4000-8000-000000000005";
export function crmTestState(): AppState {
  const state = createDemoState(crmTestNow);
  state.workspaceId = crmTestContext.connection.workspaceId; state.items = []; state.sessions = []; state.blocks = [];
  state.settings.reserveMinutes = 0; state.clients = [{ id: "calendar-client", name: "Fictional Client", aliases: ["PRIVATE_ALIAS"] }];
  return state;
}
export function crmTestInput(scheduling: CrmTaskInput["scheduling"] = { mode: "day", date: crmTestDay }): CrmTaskInput {
  return crmTaskInputSchema.parse({ externalTaskId: "crm-task", externalClientId: "crm-client", title: "New CRM task", category: "web", webKind: "edit", estimatedMinutes: 60, description: "PRIVATE_DESCRIPTION", scheduling });
}
