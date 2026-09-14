"use client";
import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Save, UserPlus } from "lucide-react";
import type { AppState } from "@/lib/types";
import { sortClientsByName } from "@/lib/clients";
import { api, Field } from "./ui";
import { CrmSettings } from "./crm-settings";

const parseAliases = (text: string) =>
  text.split(",").map((alias) => alias.trim()).filter(Boolean);

export function SettingsPanel({
  state,
  onState,
}: {
  state: AppState;
  onState: (s: AppState) => void;
}) {
  const [tab, setTab] = useState("hours");
  const [settings, setSettings] = useState(state.settings);
  const [clients, setClients] = useState(state.clients);
  // Keep rows still while typing; refresh their display order on add/save.
  const [clientOrder, setClientOrder] = useState(() => sortClientsByName(state.clients).map(client => client.id));
  const displayClients = clientOrder.flatMap(id => clients.filter(client => client.id === id));
  // Keep partially typed spaces and separators until the directory is saved.
  const [aliasDrafts, setAliasDrafts] = useState<Record<string, string>>({});
  const [priorities, setPriorities] = useState(state.priorities);
  const [clientName, setClientName] = useState("");
  const [aliases, setAliases] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("requester");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const saveInFlight = useRef(false);
  async function save(body: unknown, route = "admin") {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    setBusy(true);
    setMessage("");
    try {
      const next = (await api(route, body)).state;
      onState(next);
      setMessage(
        state.mode === "demo" && route === "members/invite"
          ? "Demo member saved. No invitation was sent."
          : "Saved.",
      );
      return next;
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      saveInFlight.current = false;
      setBusy(false);
    }
  }
  function newClient() {
    return {
      id: crypto.randomUUID(),
      name: clientName.trim(),
      aliases: parseAliases(aliases),
    };
  }
  async function saveDirectory() {
    if (saveInFlight.current) return;
    if (!clientName.trim() && aliases.trim()) {
      setMessage("Enter a new client name for these aliases before saving.");
      return;
    }
    // Submit the typed draft directly, not a stale React state update.
    const editedClients = clients.map((client) => ({
      ...client,
      aliases: aliasDrafts[client.id] === undefined
        ? client.aliases
        : parseAliases(aliasDrafts[client.id]),
    }));
    const directory = clientName.trim() ? [...editedClients, newClient()] : editedClients;
    const next = await save({ type: "clients", clients: directory });
    if (next) {
      setClients(next.clients);
      setClientOrder(sortClientsByName(next.clients).map(client => client.id));
      setAliasDrafts({});
      setClientName("");
      setAliases("");
    }
  }
  return (
    <div className="settings-panel">
      <div className="tabs">
        {["hours", "clients", "priorities", "team", "CRM"].map((t) => (
          <button
            key={t}
            className={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "hours" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save({ type: "settings", settings });
          }}
        >
          <h3>Protect your workday</h3>
          <p className="muted">
            These settings define real capacity. Changing them never silently
            moves existing work.
          </p>
          <div className="form-grid">
            <Field label="Day starts">
              <input
                type="time"
                step="900"
                value={settings.dayStart}
                onChange={(e) =>
                  setSettings({ ...settings, dayStart: e.target.value })
                }
              />
            </Field>
            <Field label="Day ends">
              <input
                type="time"
                step="900"
                value={settings.dayEnd}
                onChange={(e) =>
                  setSettings({ ...settings, dayEnd: e.target.value })
                }
              />
            </Field>
            <Field label="Lunch starts">
              <input
                type="time"
                step="900"
                value={settings.lunchStart}
                onChange={(e) =>
                  setSettings({ ...settings, lunchStart: e.target.value })
                }
              />
            </Field>
            <Field label="Lunch ends">
              <input
                type="time"
                step="900"
                value={settings.lunchEnd}
                onChange={(e) =>
                  setSettings({ ...settings, lunchEnd: e.target.value })
                }
              />
            </Field>
            <Field label="Reserve starts">
              <input
                type="time"
                step="900"
                value={settings.reserveStart}
                onChange={(e) =>
                  setSettings({ ...settings, reserveStart: e.target.value })
                }
              />
            </Field>
            <Field label="Reserve minutes" hint="Set to 0 to make this time available for planned work. You can add unexpected work when it comes up.">
              <input
                type="number"
                min="0"
                max="240"
                step="15"
                value={settings.reserveMinutes}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    reserveMinutes: Number(e.target.value),
                  })
                }
              />
            </Field>
          </div>
          <Field label="Workspace timezone">
            <input
              value={settings.timeZone}
              onChange={(e) =>
                setSettings({ ...settings, timeZone: e.target.value })
              }
            />
          </Field>
          <div className="weekday-choices">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d, i) => (
              <label className="check" key={d}>
                <input
                  type="checkbox"
                  checked={settings.weekdays.includes(i + 1)}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      weekdays: e.target.checked
                        ? [...settings.weekdays, i + 1]
                        : settings.weekdays.filter((n) => n !== i + 1),
                    })
                  }
                />
                {d}
              </label>
            ))}
          </div>
          <h3>Weekly overview & AI allowance</h3>
          <div className="form-grid">
            <Field label="Overview day">
              <select
                value={settings.weeklyDay}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    weeklyDay: Number(e.target.value),
                  })
                }
              >
                {[
                  "Monday",
                  "Tuesday",
                  "Wednesday",
                  "Thursday",
                  "Friday",
                  "Saturday",
                  "Sunday",
                ].map((d, i) => (
                  <option key={d} value={i + 1}>
                    {d}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Overview time">
              <input
                type="time"
                value={settings.weeklyTime}
                onChange={(e) =>
                  setSettings({ ...settings, weeklyTime: e.target.value })
                }
              />
            </Field>
            <Field label="AI warning (USD/month)">
              <input
                type="number"
                min="0"
                value={settings.aiWarningUsd}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    aiWarningUsd: Number(e.target.value),
                  })
                }
              />
            </Field>
            <Field label="AI pause threshold (USD/month)">
              <input
                type="number"
                min="0"
                value={settings.aiLimitUsd}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    aiLimitUsd: Number(e.target.value),
                  })
                }
              />
            </Field>
          </div>
          <p className="micro muted">
            Current tracked usage: ${state.aiUsageUsd.toFixed(2)}. Manual
            scheduling stays available at the limit.
          </p>
          <button className="primary" disabled={busy}>
            <Save size={16} />
            Save settings
          </button>
        </form>
      )}
      {tab === "clients" && (
        <form
          onChange={() => setMessage("")}
          onSubmit={(e) => {
            e.preventDefault();
            void saveDirectory();
          }}
        >
          <h3>Your client directory</h3>
          <p className="muted">
            Aliases are optional and help ADA recognize the names you use in
            conversation. Save directory also saves the new client entered below.
          </p>
          <div className="client-editor-list">
            {displayClients.map((c) => (
              <div key={c.id}>
                <input
                  disabled={busy}
                  aria-label={`Name for ${c.name}`}
                  value={c.name}
                  onChange={(e) =>
                    setClients(
                      clients.map((x) =>
                        x.id === c.id ? { ...x, name: e.target.value } : x,
                      ),
                    )
                  }
                />
                <input
                  disabled={busy}
                  aria-label={`Aliases for ${c.name}`}
                  value={aliasDrafts[c.id] ?? c.aliases.join(", ")}
                  placeholder="Aliases, separated by commas"
                  onChange={(e) =>
                    setAliasDrafts({ ...aliasDrafts, [c.id]: e.target.value })
                  }
                />
              </div>
            ))}
          </div>
          <div className="inset">
            <Field label="New client name">
              <input
                disabled={busy}
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
              />
            </Field>
            <Field label="Aliases">
              <input
                disabled={busy}
                value={aliases}
                onChange={(e) => setAliases(e.target.value)}
              />
            </Field>
            <button
              type="button"
              className="secondary"
              disabled={busy || !clientName.trim()}
              onClick={() => {
                const nextClients = [...clients, newClient()];
                setClients(nextClients);
                setClientOrder(sortClientsByName(nextClients).map(client => client.id));
                setClientName("");
                setAliases("");
                setMessage("");
              }}
            >
              <Plus size={16} />
              Add client
            </button>
            <p className="micro muted">
              Adding several? Add client stages another entry; Save directory
              saves them all.
            </p>
          </div>
          <button
            className="primary"
            disabled={busy}
            type="submit"
          >
            Save directory
          </button>
        </form>
      )}
      {tab === "priorities" && (
        <div>
          <h3>Priority order</h3>
          <p className="muted">
            Higher in this list means earlier consideration. Urgency alone never
            overrides protected sessions.
          </p>
          {priorities.map((p, i) => (
            <div className="priority-editor" key={p.id}>
              <span>{i + 1}</span>
              <input
                aria-label={`Priority ${i + 1} name`}
                value={p.label}
                onChange={(e) =>
                  setPriorities(
                    priorities.map((x) =>
                      x.id === p.id ? { ...x, label: e.target.value } : x,
                    ),
                  )
                }
              />
              <button
                className="icon-button"
                aria-label={`Move ${p.label} up`}
                disabled={i === 0}
                onClick={() => {
                  const copy = [...priorities];
                  [copy[i - 1], copy[i]] = [copy[i], copy[i - 1]];
                  setPriorities(copy);
                }}
              >
                <ArrowUp size={15} />
              </button>
              <button
                className="icon-button"
                aria-label={`Move ${p.label} down`}
                disabled={i === priorities.length - 1}
                onClick={() => {
                  const copy = [...priorities];
                  [copy[i + 1], copy[i]] = [copy[i], copy[i + 1]];
                  setPriorities(copy);
                }}
              >
                <ArrowDown size={15} />
              </button>
            </div>
          ))}
          <div className="form-actions">
            <button
              className="secondary"
              onClick={() =>
                setPriorities([
                  ...priorities,
                  {
                    id: crypto.randomUUID(),
                    label: "New priority",
                    rank: priorities.length,
                  },
                ])
              }
            >
              <Plus size={15} />
              Add priority
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                save({
                  type: "priorities",
                  priorities: priorities.map((p, i) => ({ ...p, rank: i })),
                })
              }
            >
              Save priorities
            </button>
          </div>
        </div>
      )}
      {tab === "CRM" && <CrmSettings state={state} />}
      {tab === "team" && (
        <div>
          <h3>Shared visibility, clear boundaries</h3>
          <p className="muted">
            Everyone sees the agency workload. Requesters may book clean-fit
            work. Only Bryan can change existing commitments.
          </p>
          {state.members.map((m) => (
            <div className="member-row" key={m.id}>
              <span className="avatar">{m.name[0]}</span>
              <span>
                {m.name}
                <small>{m.email}</small>
              </span>
              <span className="status-pill">{m.role}</span>
            </div>
          ))}
          <form
            className="inset"
            onSubmit={(e) => {
              e.preventDefault();
              void save({ name, email, role }, "members/invite");
            }}
          >
            <Field label="Teammate name">
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Email address">
              <input
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Role">
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="requester">Requester</option>
                <option value="viewer">Viewer</option>
              </select>
            </Field>
            <button className="primary" disabled={busy}>
              <UserPlus size={16} />
              Invite teammate
            </button>
          </form>
        </div>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
