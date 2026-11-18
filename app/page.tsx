"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Activity, ArrowRight, Bell, Check, CheckCheck, ChevronRight, Droplets, ExternalLink, Eye, LogOut, MapPin, Radio, RefreshCw, ShieldCheck, Thermometer, Waves, WifiOff } from "lucide-react";

type User = { username: string; barangay: string; name: string };
type Station = { barangay: string; label: string; type: string; reason: string; level: number | null; temp: number | null; humidity: number | null; quality: string; source: string; updatedAt?: string; updated_at?: string };
type Alert = { id: string; barangay: string; label: string; type: string; reason: string; active: boolean | number; createdAt?: string; created_at?: string; resolvedAt?: string; resolved_at?: string; response?: { decision: string; note: string; createdAt?: string }; decision?: string; note?: string };
type Dashboard = { user: User; station: Station | null; alerts: Alert[]; connection: { online?: boolean; connected?: boolean; lastSeen?: string | null; lastSeenAt?: string | null; updatedAt?: string | null } };
const decisionLabels: Record<string, string> = { acknowledge: "Acknowledged", verify: "Verification requested", escalate: "Escalated for review" };
const schoolNames: Record<string, string> = { "641": "Centro Escolar University Manila", "638": "San Beda University Manila", "404": "University of the East Manila" };

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...options });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw Object.assign(new Error(typeof data.error === "string" ? data.error : "The request could not be completed."), { status: response.status });
  return data as T;
}
function timestamp(value?: string | null) {
  if (!value) return "No readings received";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : date.toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
}
function Brand() {
  return <a className="brand" href="/" aria-label="Bantay Barangay home"><span className="brand-mark"><Waves size={23} strokeWidth={1.8}/></span><span>Bantay<span className="brand-sub">BARANGAY</span></span></a>;
}
function Metric({ name, value, unit, help, icon }: { name: string; value: number | null | undefined; unit: string; help: string; icon: React.ReactNode }) {
  return <article className="metric"><div className="metric-heading"><span>{name}</span><span className="metric-icon">{icon}</span></div><p className="metric-value">{typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "—"}<span>{unit}</span></p><p className="metric-help">{help}</p></article>;
}

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [data, setData] = useState<Dashboard | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginPending, setLoginPending] = useState(false);
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [tab, setTab] = useState("active");
  const [note, setNote] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const [notifications, setNotifications] = useState(false);
  const knownAlerts = useRef<Set<string> | null>(null);
  const mounted = useRef(true);
  const sessionGeneration = useRef(0);
  const sessionUser = useRef<User | null>(null);
  const fetchingGeneration = useRef<number | null>(null);

  useEffect(() => { mounted.current = true; request<{user: User}>("/api/session").then(result => { if (mounted.current) { sessionUser.current = result.user; setUser(result.user); } }).catch(() => {}).finally(() => { if (mounted.current) setInitializing(false); }); return () => { mounted.current = false; }; }, []);
  const refresh = useCallback(async () => {
    const generation = sessionGeneration.current;
    if (!sessionUser.current || fetchingGeneration.current === generation) return;
    fetchingGeneration.current = generation;
    try {
      const next = await request<Dashboard>("/api/dashboard");
      if (!mounted.current || generation !== sessionGeneration.current) return;
      if (knownAlerts.current && notifications && "Notification" in window && Notification.permission === "granted") {
        for (const alert of next.alerts) if (alert.active && !knownAlerts.current.has(alert.id)) new Notification(`Barangay ${next.user.barangay} · ${alert.label}`, { body: alert.reason, tag: alert.id });
      }
      knownAlerts.current = new Set(next.alerts.map(alert => alert.id));
      setData(next); setSyncError("");
    } catch (cause) {
      if (!mounted.current || generation !== sessionGeneration.current) return;
      if ((cause as { status?: number }).status === 401) { sessionGeneration.current++; sessionUser.current = null; knownAlerts.current = null; setUser(null); setData(null); }
      else setSyncError("Connection interrupted. Displaying the last received information. Retrying automatically.");
    } finally {
      if (fetchingGeneration.current === generation) fetchingGeneration.current = null;
    }
  }, [notifications]);
  useEffect(() => {
    if (!user) return;
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 3000);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [user, refresh]);
  const alerts = data?.alerts ?? [];
  const active = alerts.filter(alert => Boolean(alert.active));
  const history = alerts.filter(alert => !alert.active);
  const visibleAlerts = tab === "active" ? active : history;
  const selected = visibleAlerts.find(alert => alert.id === selectedId) ?? visibleAlerts[0];
  const station = data?.station;
  const connected = !syncError && Boolean(data?.connection?.online ?? data?.connection?.connected);
  const lastSeen = data?.connection?.lastSeen ?? data?.connection?.lastSeenAt ?? data?.connection?.updatedAt ?? station?.updatedAt ?? station?.updated_at;

  async function login(event: FormEvent) {
    event.preventDefault(); setError(""); setLoginPending(true);
    try { const result = await request<{user: User}>("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: username.trim(), password }) }); sessionGeneration.current++; sessionUser.current = result.user; setData(null); setSyncError(""); setMessage(""); setSelectedId(null); setTab("active"); setNote(""); setPassword(""); setUser(result.user); knownAlerts.current = null; }
    catch (cause) { setError((cause as Error).message); }
    finally { setLoginPending(false); }
  }
  async function logout() {
    try { await request("/api/logout", { method: "POST" }); sessionGeneration.current++; sessionUser.current = null; setUser(null); setData(null); setNote(""); setMessage(""); setSyncError(""); knownAlerts.current = null; }
    catch { setSyncError("Sign out could not be completed. Try again."); }
  }
  async function respond(decision: string) {
    if (!selected || sending) return;
    const generation = sessionGeneration.current;
    setSending(true); setMessage("");
    try { await request(`/api/alerts/${encodeURIComponent(selected.id)}/respond`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision, note: note.trim(), requestId: crypto.randomUUID() }) }); if (generation !== sessionGeneration.current) return; setMessage(`${decisionLabels[decision]}. Your response is saved for the desktop operator.`); setNote(""); await refresh(); }
    catch (cause) { if (generation !== sessionGeneration.current) return; setMessage((cause as Error).message); await refresh(); }
    finally { setSending(false); }
  }
  async function enableNotifications() {
    if (!("Notification" in window)) { setMessage("This browser does not support desktop notifications. Prompts appear here while this dashboard is open."); return; }
    try { const permission = await Notification.requestPermission(); setNotifications(permission === "granted"); setMessage(permission === "granted" ? "Browser notifications are enabled while this dashboard is open and visible." : "Browser notifications are blocked. You can continue reviewing prompts here."); }
    catch { setMessage("Browser notifications could not be enabled. Prompts are available here."); }
  }

  if (initializing) return <main className="loading-screen"><Brand/><span className="spinner"/><p>Opening your remote desk…</p></main>;
  if (!user) return <main className="login-shell">
    <section className="login-story"><Brand/><div className="login-story-copy"><span className="eyebrow mint">LOCAL EVIDENCE. LOCAL RESPONSE.</span><h1>A closer view.<br/>A timely decision.</h1><p>Your barangay’s monitoring prompts, connected to the Bantay Barangay desktop application.</p><div className="login-network" aria-hidden="true"><div className="network-line"/><span className="network-node"><Radio size={24}/><small>Station</small></span><span className="network-node network-center"><Waves size={32}/><small>Desktop app</small></span><span className="network-node"><Bell size={24}/><small>Your desk</small></span></div></div><p className="login-foot">Bantay Barangay research prototype · Manila, Philippines</p></section>
    <section className="login-side"><div className="login-card"><span className="eyebrow">REMOTE DESK</span><h2>Welcome back.</h2><p className="muted login-intro">Sign in to view the barangay assigned to your account.</p><form onSubmit={login}><label htmlFor="username">Username</label><input id="username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={e => setUsername(e.target.value)} required placeholder="Your assigned username"/><label htmlFor="password">Password</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required placeholder="Enter your password"/>{error && <p className="error" role="alert">{error}</p>}<button className="primary login-button" type="submit" disabled={loginPending}>{loginPending ? "Signing in…" : "Open my dashboard"}<ArrowRight size={17}/></button></form><p className="login-assignment"><ShieldCheck size={18}/><span>Your account opens its assigned barangay automatically. Ask the desktop operator for your credentials.</span></p></div></section>
  </main>;

  return <div className="app-shell">
    <aside className="sidebar"><Brand/><div className="workspace"><span className="eyebrow">YOUR WORKSPACE</span><p><MapPin size={17}/>Barangay {user.barangay}</p><span>Manila, Philippines</span></div><nav aria-label="Dashboard"><button className={tab === "active" ? "nav-item selected" : "nav-item"} onClick={() => { setTab("active"); setSelectedId(null); setNote(""); }}><Activity size={18}/>Overview<span className="nav-count">{active.length}</span></button><button className={tab === "history" ? "nav-item selected" : "nav-item"} onClick={() => { setTab("history"); setSelectedId(null); setNote(""); }}><CheckCheck size={18}/>Alert history</button></nav><div className="sidebar-bottom"><div className="desktop-link"><Radio size={18}/><div><strong>Desktop connection</strong><span className={connected ? "link-online" : "link-offline"}>{connected ? "Receiving updates" : "Awaiting connection"}</span></div></div><div className="account"><span className="avatar">{user.barangay.slice(-2)}</span><div><strong>{user.name || user.username}</strong><span>{user.username}</span></div><button className="icon-button" onClick={logout} aria-label="Sign out" title="Sign out"><LogOut size={17}/></button></div></div></aside>
    <div className="main-shell"><header className="topbar"><span className="breadcrumb">Remote desk<ChevronRight size={14}/><strong>Barangay {user.barangay}</strong></span><div className="topbar-actions"><span className={`connection-pill ${connected ? "online" : "offline"}`}><span/>{connected ? "Connected" : "Waiting for desktop"}</span><button className="icon-button" onClick={() => void refresh()} aria-label="Refresh readings" title="Refresh readings"><RefreshCw size={17}/></button><button className="mobile-signout icon-button" onClick={logout} aria-label="Sign out"><LogOut size={17}/></button></div></header>
    <main className="dashboard"><div className="page-heading"><div><span className="eyebrow">BARANGAY {user.barangay} · MANILA</span><h1>{tab === "active" ? "Monitoring overview" : "Alert history"}</h1><p>{schoolNames[user.barangay] || "Assigned monitoring area"}</p></div><button className={`notification-button ${notifications ? "enabled" : ""}`} onClick={enableNotifications}><Bell size={16}/>{notifications ? "Notifications enabled" : "Enable notifications"}</button></div>
    {syncError && <div className="notice warning" role="alert"><WifiOff size={18}/>{syncError}</div>}
    {message && <div className="notice" role="status"><Check size={18}/>{message}<button aria-label="Dismiss message" onClick={() => setMessage("")}>×</button></div>}
    <section className={`status-banner ${!connected ? "awaiting" : active.length ? "attention" : "clear"}`}><span className="status-symbol">{!connected ? <Radio size={25}/> : active.length ? <Bell size={25}/> : <ShieldCheck size={25}/>}</span><div><h2>{!connected ? "Waiting for the desktop app" : active.length ? `${active.length} active ${active.length === 1 ? "prompt needs" : "prompts need"} your review` : "Monitoring your assigned area"}</h2><p>{!connected ? "Readings and prompts will update when the desktop app connects. Previous records remain available below." : active.length ? "Review the local evidence and send your response to the desktop operator." : "No active prompt is present in the latest desktop update."}</p></div><span className="status-label">{!connected ? "AWAITING INPUT" : station?.label || "MONITOR"}</span></section>
    <div className="section-line"><h2>Latest readings</h2><span>Last received · {timestamp(lastSeen)}</span></div><section className="metrics" aria-label="Latest station readings"><Metric name="Tank water level" value={station?.level} unit="cm" help="Filtered laboratory input" icon={<Waves size={20}/>}/><Metric name="Air temperature" value={station?.temp} unit="°C" help="Reported station temperature" icon={<Thermometer size={20}/>}/><Metric name="Relative humidity" value={station?.humidity} unit="%" help="Reported station humidity" icon={<Droplets size={20}/>}/></section>
    <div className="reading-context"><span><span className={`tiny-dot ${connected ? "live" : ""}`}/>{station?.source || "No source connected"}</span><span>{station?.quality ? `Water evidence · ${station.quality}` : "Awaiting station evidence"}</span></div>
    <section className="review-grid"><div className="alerts-panel"><div className="panel-heading"><h2>Barangay prompts</h2><span className="count-chip">{visibleAlerts.length}</span></div><div className="tabs" role="tablist" aria-label="Prompt status"><button role="tab" aria-selected={tab === "active"} className={tab === "active" ? "active" : ""} onClick={() => { setTab("active"); setSelectedId(null); setNote(""); }}>Active <span>{active.length}</span></button><button role="tab" aria-selected={tab === "history"} className={tab === "history" ? "active" : ""} onClick={() => { setTab("history"); setSelectedId(null); setNote(""); }}>Resolved <span>{history.length}</span></button></div><div className="alert-list">{visibleAlerts.length === 0 ? <div className="empty-state"><span><ShieldCheck size={30}/></span><h3>{tab === "active" ? "No active prompts" : "No resolved prompts yet"}</h3><p>{tab === "active" ? "New prompts for your barangay will appear here automatically." : "Prompts move here when the desktop app reports a recovery."}</p></div> : visibleAlerts.map(alert => <button key={alert.id} className={`alert-row ${selected?.id === alert.id ? "chosen" : ""}`} onClick={() => { setSelectedId(alert.id); setNote(""); setMessage(""); }}><span className={`alert-dot ${alert.active ? alert.type : "resolved"}`}/><span className="alert-row-copy"><strong>{alert.label}</strong><span>{alert.reason}</span><small>{timestamp(alert.createdAt ?? alert.created_at)}</small></span><ChevronRight size={16}/></button>)}</div></div>
    <div className="detail-panel">{selected ? <><div className="panel-heading"><h2>Review prompt</h2><span className={`severity-tag ${selected.active ? selected.type : "resolved"}`}>{selected.active ? selected.type === "alert" ? "ALERT" : "REVIEW" : "RESOLVED"}</span></div><div className="detail-body"><span className="eyebrow">BARANGAY {user.barangay}</span><h3>{selected.label}</h3><p className="detail-reason">{selected.reason}</p><div className="detail-time"><span>Received</span><strong>{timestamp(selected.createdAt ?? selected.created_at)}</strong></div>{!selected.active && <div className="detail-time"><span>Recovered</span><strong>{timestamp(selected.resolvedAt ?? selected.resolved_at)}</strong></div>}{(selected.response || selected.decision) && <div className="saved-response"><CheckCheck size={18}/><div><strong>{decisionLabels[selected.response?.decision ?? selected.decision ?? ""] || "Response saved"}</strong>{(selected.response?.note || selected.note) && <p>{selected.response?.note || selected.note}</p>}</div></div>}{Boolean(selected.active) && <form onSubmit={event => event.preventDefault()} className="response-form"><label htmlFor="response-note">Review note <span>Optional</span></label><textarea id="response-note" maxLength={1000} rows={3} placeholder="Add local observations for the desktop operator…" value={note} onChange={event => setNote(event.target.value)}/><div className="response-buttons"><button className="primary" onClick={() => void respond("acknowledge")} disabled={sending}><CheckCheck size={16}/>{sending ? "Saving…" : "Acknowledge"}</button><button className="secondary" onClick={() => void respond("verify")} disabled={sending}><Eye size={16}/>Request verification</button><button className="escalate-button" onClick={() => void respond("escalate")} disabled={sending}>Escalate for review<ArrowRight size={15}/></button></div><p className="response-footnote">Responses are saved for the desktop operator. The alert clears when the source reports recovery.</p></form>}</div></> : <div className="detail-empty"><div className="empty-orbit"><Bell size={29}/></div><h3>Ready for your next prompt</h3><p>Select a prompt to see its evidence and send a response.</p></div>}</div></section>
    <footer className="dashboard-footer"><span>Research prototype · Keep this dashboard visible for automatic updates</span><a href="https://www.pagasa.dost.gov.ph/" target="_blank" rel="noreferrer">PAGASA advisories<ExternalLink size={12}/></a></footer></main></div></div>;
}

