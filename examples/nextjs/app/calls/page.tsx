"use client";
// app/calls/page.tsx: a search box wired to the server action.
import { useActionState } from "react";
import { searchCallsAction } from "./actions";

export default function CallsPage() {
  const [state, action, pending] = useActionState(searchCallsAction, { rows: [], total: 0 });
  return (
    <main>
      <form action={action}>
        <input name="q" placeholder="Phone number, name or words from the call" />
        <button disabled={pending}>Search</button>
      </form>
      {state.error && <p role="alert">{state.error}</p>}
      <p>{state.total} calls in the last 30 days</p>
      <ul>
        {state.rows.map((r) => (
          <li key={r.id}>
            {new Date(r.when).toLocaleString()} · {r.caller ?? "Unknown"} · {r.sentiment ?? "n/a"}
            <br />
            {r.summary}
          </li>
        ))}
      </ul>
    </main>
  );
}
