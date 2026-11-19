"use server";
// Server action: search calls by phone number or text. app/calls/actions.ts
//
// Must: this action and its page sit behind your own sign-in, and each viewer only sees the
// locations they are entitled to. The integration user sees everything it is mapped to; the
// portal must narrow it.
import { FilterError } from "@intelligence-cloud/sdk";
import { ic } from "@/lib/ic";
import { NotSignedInError, requireSignedIn } from "@/lib/auth";

export interface CallRow {
  id: string;
  when: string;
  caller: string | null;
  summary: string | null;
  sentiment: string | null;
}

type State = { rows: CallRow[]; total: number; error?: string };

export async function searchCallsAction(_prev: State, form: FormData): Promise<State> {
  let viewer;
  try {
    viewer = await requireSignedIn(); // first line: no sign-in, no data
  } catch (err) {
    if (err instanceof NotSignedInError) return { rows: [], total: 0, error: "Please sign in." };
    throw err;
  }
  const asked = String(form.get("location_id") ?? "").trim();
  if (asked && !viewer.locationIds.includes(asked)) return { rows: [], total: 0, error: "Not allowed." };
  const locationIds = asked ? [asked] : viewer.locationIds;
  if (locationIds.length === 0) return { rows: [], total: 0 };

  const q = String(form.get("q") ?? "").trim();
  const isPhone = /^[\d\s()+.-]{4,}$/.test(q);
  try {
    const page = await ic.searchCalls({
      ...(q ? (isPhone ? { phone: q } : { text: q }) : {}),
      locationIds,
      dateFrom: new Date(Date.now() - 30 * 86400_000),
      limit: 25,
    });
    return {
      total: page.summary.total_calls ?? 0,
      rows: page.items.map((c) => ({
        id: c.id!,
        when: c.call_date!,
        caller: c.caller_name ?? c.caller_number ?? null,
        summary: c.summary ?? null,
        sentiment: c.sentiment ?? null,
      })),
    };
  } catch (err) {
    if (err instanceof FilterError) return { rows: [], total: 0, error: err.message };
    return { rows: [], total: 0, error: "Search is unavailable right now." };
  }
}
