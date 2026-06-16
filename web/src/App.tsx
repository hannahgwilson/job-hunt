import { useEffect, useState, type FormEvent } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import Dashboard from "./pages/Dashboard";
import Pipeline from "./pages/Pipeline";
import ActionQueue from "./pages/ActionQueue";
import Funnel from "./pages/Funnel";
import RoleDetail from "./pages/RoleDetail";
import Profile from "./pages/Profile";

function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) setError(error.message);
    else setSent(true);
  }

  return (
    <div className="login">
      <div className="card login-card">
        <h1>Job Hunt</h1>
        <p className="muted">Your search, as a pipeline.</p>
        {sent ? (
          <p>Check your email for a magic link to sign in.</p>
        ) : (
          <form onSubmit={signIn}>
            <input
              type="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button type="submit">Send magic link</button>
            {error && <p className="error">{error}</p>}
          </form>
        )}
      </div>
    </div>
  );
}

const NAV: { to: string; label: string; end: boolean }[] = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/pipeline", label: "Pipeline", end: false },
  { to: "/queue", label: "Action Queue", end: false },
  { to: "/funnel", label: "Funnel", end: false },
  { to: "/resume", label: "Resume", end: false },
];

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (loading) return <div className="loading">Loading…</div>;
  if (!session) return <Login />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Job Hunt</div>
        <nav>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <button className="ghost" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/pipeline" element={<Pipeline />} />
          <Route path="/queue" element={<ActionQueue />} />
          <Route path="/funnel" element={<Funnel />} />
          <Route path="/resume" element={<Profile />} />
          <Route path="/role/:id" element={<RoleDetail />} />
        </Routes>
      </main>
    </div>
  );
}
