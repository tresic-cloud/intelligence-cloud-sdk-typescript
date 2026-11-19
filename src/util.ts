/** A random UUID v4 (Idempotency-Key). */
export async function uuid4(): Promise<string> {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  let bytes: Uint8Array;
  if (c && typeof c.getRandomValues === "function") {
    bytes = c.getRandomValues(new Uint8Array(16));
  } else {
    const nodeCrypto = await import("node:crypto");
    bytes = new Uint8Array(nodeCrypto.randomBytes(16));
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface MappingInput {
  connector_id: string;
  monitored_numbers: string[];
}

/** Numbers mapped to one connector. */
export function numbersFor(mappings: readonly { connector_id?: string; monitored_numbers?: string[] }[] | undefined, connectorId: string): string[] {
  const out: string[] = [];
  for (const m of mappings ?? []) if (m.connector_id === connectorId) out.push(...(m.monitored_numbers ?? []));
  return [...new Set(out)];
}

/**
 * Read → merge → write helper for full-replacement number lists. Adds and removes numbers for one
 * connector and keeps every other connector's numbers. Entries left with no numbers are dropped
 * (the API refuses empty lists inside a mapping).
 */
export function mergeMappings(
  current: readonly { connector_id?: string; monitored_numbers?: string[] }[] | undefined,
  connectorId: string,
  add: readonly string[] = [],
  remove: readonly string[] = [],
): MappingInput[] {
  const byConnector = new Map<string, string[]>();
  for (const m of current ?? []) {
    if (!m.connector_id) continue;
    const list = byConnector.get(m.connector_id) ?? [];
    list.push(...(m.monitored_numbers ?? []));
    byConnector.set(m.connector_id, list);
  }
  const drop = new Set(remove);
  const mine = (byConnector.get(connectorId) ?? []).filter((n) => !drop.has(n));
  for (const n of add) if (!mine.includes(n)) mine.push(n);
  byConnector.set(connectorId, mine);
  const out: MappingInput[] = [];
  for (const [connector_id, nums] of byConnector) {
    const uniq = [...new Set(nums)];
    if (uniq.length) out.push({ connector_id, monitored_numbers: uniq });
  }
  return out;
}

export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

export function diff(current: readonly string[], target: readonly string[]): { add: string[]; remove: string[] } {
  const c = new Set(current);
  const t = new Set(target);
  return { add: [...t].filter((x) => !c.has(x)), remove: [...c].filter((x) => !t.has(x)) };
}
