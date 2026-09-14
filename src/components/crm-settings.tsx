"use client";
import { useEffect, useRef, useState } from "react";
import type { AppState } from "@/lib/types";
import { suggestCrmClients, type CrmOwnerSetup } from "@/lib/crm-setup";
import { api, Field } from "./ui";

export function CrmSettings({ state }: { state: AppState }) {
  const [setup, setSetup] = useState<CrmOwnerSetup | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [credential, setCredential] = useState("");
  const [crmOrigin, setCrmOrigin] = useState("");
  const [crmAuthUrl, setCrmAuthUrl] = useState("");
  const [crmPublicKey, setCrmPublicKey] = useState("");
  const [agencyDomain, setAgencyDomain] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [externalClientId, setExternalClientId] = useState("");
  const [externalName, setExternalName] = useState("");
  const [calendarClientId, setCalendarClientId] = useState("");
  const suggestions = suggestCrmClients(externalName, state.clients);
  useEffect(() => {
    if (state.mode === "demo") return;
    const controller = new AbortController();
    fetch("/api/admin/crm", { cache: "no-store", signal: controller.signal }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load CRM settings.");
      if (!controller.signal.aborted) setSetup(data);
    }).catch(cause => { if (!controller.signal.aborted) setError((cause as Error).message); });
    return () => controller.abort();
  }, [state.mode]);
  async function save(input: unknown) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const result = await api<{ ok: true; credential?: string }>("admin/crm", input);
      if (result.credential) setCredential(result.credential);
      setMessage("Saved.");
      const response = await fetch("/api/admin/crm", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error("Saved, but settings could not refresh. Keep the key shown here and reload afterward.");
      setSetup(data);
    } catch (cause) { setError((cause as Error).message); }
    finally { pending.current = false; setBusy(false); }
  }
  if (state.mode === "demo") return <section><h3>Connect ADA CRM</h3><p className="notice">CRM setup is available in the owner’s signed-in Calendar. This demo cannot create or enable a connection.</p></section>;
  return <section className="work-form">
    <h3>Connect ADA CRM</h3>
    <p className="muted">CRM checks your availability before assigning work. You approve requests that would move another commitment.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {message && <p className="notice" role="status">{message}</p>}
    {credential && <div className="inset"><Field label="New connection key" hint="Shown once. Store this in the CRM server’s protected configuration."><textarea readOnly value={credential} autoComplete="off" /></Field><button type="button" className="secondary" onClick={() => setCredential("")}>I saved the key</button></div>}
    {!setup ? <p className="muted">Loading connection settings…</p> : <>
      <p className="notice">{setup.bookingEnabled ? "Calendar’s booking API is enabled." : "New CRM bookings are disabled on the Calendar server."} {!setup.integrationEnabled && "The server connection is also disabled."}</p>
      {setup.connections.map(connection => <div className="inset" key={connection.id}>
        <h4>{connection.crmOrigin}</h4><p className="micro">{connection.agencyDomain} · Connection {connection.enabled ? "enabled" : "disabled"}</p>
        <div className="form-actions"><button className="secondary" disabled={busy || !!credential} onClick={() => void save({ type: "rotate", connectionId: connection.id })}>Replace connection key</button>
          <button className="secondary" disabled={busy} onClick={() => void save({ type: "set_enabled", connectionId: connection.id, enabled: !connection.enabled })}>{connection.enabled ? "Disable connection" : "Enable connection"}</button></div>
      </div>)}
      <details className="inset"><summary>Add a CRM connection</summary>
        <form onSubmit={event => { event.preventDefault(); void save({ type: "create", crmOrigin, crmAuthUrl, crmPublicKey, agencyDomain }); }}>
          <Field label="CRM website"><input required type="url" value={crmOrigin} onChange={event => setCrmOrigin(event.target.value.trim())} placeholder="https://alphadogcrm.com" /></Field>
          <Field label="CRM Supabase URL"><input required type="url" value={crmAuthUrl} onChange={event => setCrmAuthUrl(event.target.value.trim())} placeholder="https://project.supabase.co" /></Field>
          <Field label="CRM public or publishable key"><input required autoComplete="off" value={crmPublicKey} onChange={event => setCrmPublicKey(event.target.value.trim())} /></Field>
          <Field label="Agency email domain"><input required value={agencyDomain} onChange={event => setAgencyDomain(event.target.value.trim().toLowerCase())} placeholder="alphadogagency.com" /></Field>
          <button className="primary" disabled={busy || !!credential}>Create disabled connection</button>
        </form>
      </details>
      {setup.connections.length > 0 && <form className="inset" onSubmit={event => { event.preventDefault(); void save({ type: "map", connectionId, externalClientId, calendarClientId }); }}>
        <h4>Confirm a client match</h4><p className="micro">Use the client ID from CRM. A name suggestion becomes a match only after you confirm it.</p>
        <Field label="CRM connection"><select required value={connectionId} onChange={event => { setConnectionId(event.target.value); setCalendarClientId(""); }}><option value="">Choose connection</option>{setup.connections.map(connection => <option key={connection.id} value={connection.id}>{connection.crmOrigin}</option>)}</select></Field>
        <Field label="CRM client ID"><input required value={externalClientId} onChange={event => { setExternalClientId(event.target.value.trim()); setCalendarClientId(""); }} /></Field>
        <Field label="CRM client name (for suggestions)"><input value={externalName} onChange={event => setExternalName(event.target.value)} /></Field>
        {suggestions.length > 0 && <p className="micro">Suggested: {suggestions.map(client => client.name).join(", ")}</p>}
        <Field label="Calendar client"><select required value={calendarClientId} onChange={event => setCalendarClientId(event.target.value)}><option value="">Choose the matching client</option>{state.clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select></Field>
        <button className="primary" disabled={busy}>Confirm client match</button>
      </form>}
      {setup.mappings.length > 0 && <div className="inset"><h4>Confirmed client matches</h4>{setup.mappings.map(mapping => <p key={`${mapping.connectionId}/${mapping.externalClientId}`}>{mapping.externalClientId} → {state.clients.find(client => client.id === mapping.calendarClientId)?.name ?? mapping.calendarClientId}</p>)}</div>}
    </>}
  </section>;
}
