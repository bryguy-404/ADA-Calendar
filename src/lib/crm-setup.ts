import { z } from "zod";
import { crmOriginSchema, crmAuthUrlSchema, crmAgencyDomainSchema } from "./crm-integration";
import { idSchema } from "./schemas";
import type { Client } from "./types";
export const crmSetupActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create"), crmOrigin: crmOriginSchema, crmAuthUrl: crmAuthUrlSchema, crmPublicKey: z.string().min(1).max(4096), agencyDomain: crmAgencyDomainSchema }).strict(),
  z.object({ type: z.literal("rotate"), connectionId: z.uuid() }).strict(),
  z.object({ type: z.literal("set_enabled"), connectionId: z.uuid(), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal("map"), connectionId: z.uuid(), externalClientId: idSchema, calendarClientId: idSchema }).strict(),
]);
export const crmOwnerSetupSchema = z.object({
  connections: z.array(z.object({ id: z.uuid(), crmOrigin: crmOriginSchema, crmAuthUrl: crmAuthUrlSchema, agencyDomain: crmAgencyDomainSchema, enabled: z.boolean() })),
  mappings: z.array(z.object({ connectionId: z.uuid(), externalClientId: idSchema, calendarClientId: idSchema, revision: z.number().int().positive() })),
});
export type CrmOwnerSetup = z.infer<typeof crmOwnerSetupSchema> & { bookingEnabled: boolean; integrationEnabled: boolean };
/** Suggestions never persist a mapping. Ambiguous matches stay explicit choices. */
export function suggestCrmClients(name: string, clients: Client[]): Client[] {
  const normalized = name.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
  if (!normalized) return [];
  return clients.filter(client => [client.name, ...client.aliases].some(candidate => candidate.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ") === normalized));
}
