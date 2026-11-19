// Your sign-in check for the portal pages and server actions. lib/auth.ts
//
// Server actions are public POST endpoints: every action that reads conversation data must call
// requireSignedIn() first. This placeholder FAILS CLOSED: it refuses everyone until you wire it to
// your own sign-in (your session library, identity provider or SSO).
import "server-only";

export interface Viewer {
  id: string;
  /** The Intelligence Cloud location ids this viewer may see. The integration user sees more. */
  locationIds: string[];
}

export class NotSignedInError extends Error {}

export async function requireSignedIn(): Promise<Viewer> {
  // Example once wired:
  //   const session = await getSession();             // your auth library
  //   if (!session) throw new NotSignedInError("Not signed in.");
  //   return { id: session.userId, locationIds: await locationsFor(session.userId) };
  throw new NotSignedInError("Not signed in: wire requireSignedIn() in lib/auth.ts to your own sign-in.");
}
