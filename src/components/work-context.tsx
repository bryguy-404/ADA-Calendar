"use client";
import type { WebsiteWorkContext } from "@/lib/types";
import { emptyWorkContext } from "@/lib/work-context";
import { Field } from "./ui";

export function WorkContextFields({ value, onChange }: { value?: WebsiteWorkContext; onChange: (value: WebsiteWorkContext) => void }) {
  const context = value ?? emptyWorkContext();
  const patch = (change: Partial<WebsiteWorkContext>) => onChange({ ...context, ...change });
  return <details className="inset">
    <summary>Website work context (optional)</summary>
    <p className="muted">Identify the site and requested result. Keep original emails/documents in Links or email references and upload materials under Files &amp; references.</p>
    <Field label="Website URL"><input aria-label="Website URL" type="url" value={context.websiteUrl} onChange={e => patch({ websiteUrl: e.target.value })} maxLength={2000} /></Field>
    <Field label="Project or repository URL"><input aria-label="Project or repository URL" type="url" value={context.projectUrl} onChange={e => patch({ projectUrl: e.target.value })} maxLength={2000} /></Field>
    <Field label="Requested result"><textarea aria-label="Requested result" rows={3} value={context.requestedResult} onChange={e => patch({ requestedResult: e.target.value })} maxLength={4000} /></Field>
    <Field label="Requirements"><select aria-label="Requirements" value={context.requirementsStatus} onChange={e => patch({ requirementsStatus: e.target.value as WebsiteWorkContext["requirementsStatus"] })}>
      <option value="tentative">Tentative — needs clarification</option><option value="confirmed">Confirmed by the person saving this work</option>
    </select></Field>
    <Field label="Current progress"><textarea aria-label="Current progress" rows={2} value={context.progressNote} onChange={e => patch({ progressNote: e.target.value })} maxLength={4000} /></Field>
    <Field label="Materials"><select aria-label="Materials" value={context.materialsStatus} onChange={e => patch({ materialsStatus: e.target.value as WebsiteWorkContext["materialsStatus"] })}>
      <option value="not_checked">Not checked</option><option value="ready">Ready according to the saved notes</option><option value="missing">Some materials are missing</option><option value="inaccessible">Some materials cannot be accessed</option>
    </select></Field>
    <Field label="Materials notes"><textarea aria-label="Materials notes" rows={2} value={context.materialsNote} onChange={e => patch({ materialsNote: e.target.value })} maxLength={2000} placeholder="Identify missing files, access problems, or which source each instruction came from." /></Field>
    <label className="check"><input type="checkbox" checked={context.manualOnly} onChange={e => patch({ manualOnly: e.target.checked })} />Keep this work under manual coordination</label>
    <p className="micro muted">Software projects always stay manual. Notes and source links do not grant access or mark work complete.</p>
  </details>;
}

export function WorkContextDetails({ context }: { context: WebsiteWorkContext }) {
  return <section className="detail-section work-context">
    <h3>Website work context</h3>
    <dl className="detail-dates">
      <div><dt>Website</dt><dd>{context.websiteUrl || "Not specified"}</dd></div>
      <div><dt>Project / repository</dt><dd>{context.projectUrl || "Not specified"}</dd></div>
      <div><dt>Requirements</dt><dd>{context.requirementsStatus === "confirmed" ? "Confirmed in Calendar" : "Tentative — needs clarification"}</dd></div>
      <div><dt>Materials</dt><dd>{context.materialsStatus.replaceAll("_", " ")} (reported)</dd></div>
    </dl>
    {context.requestedResult && <p><strong>Requested result:</strong> {context.requestedResult}</p>}
    {context.progressNote && <p><strong>Current progress:</strong> {context.progressNote}</p>}
    {context.materialsNote && <p><strong>Materials notes:</strong> {context.materialsNote}</p>}
    {context.manualOnly && <p>Manual coordination only.</p>}
    <p className="micro muted">These saved notes do not verify a website change or complete the project. Source links require their own access.</p>
  </section>;
}
