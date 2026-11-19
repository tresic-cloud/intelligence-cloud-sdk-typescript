/** Access and refresh tokens. `expiresAt` is epoch milliseconds. */
export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/**
 * Where the client keeps its tokens. The default keeps them in memory, for one client.
 * A refresh token is single use: `set` is always called with the new pair BEFORE the new access
 * token is used.
 *
 * Sharing one integration user's tokens between processes (several workers, serverless instances)
 * is safe only when the store implements `withLock`: without a lock, two processes can read the
 * same refresh token, both renew, and the second renewal ends the session everywhere. Use
 * `FileTokenStore` on one machine, or implement `withLock` over your shared cache.
 */
export interface TokenStore {
  get(): Tokens | null | Promise<Tokens | null>;
  set(tokens: Tokens | null): void | Promise<void>;
  /**
   * Optional: run `fn` while holding a lock that every process sharing this store respects.
   * The client signs in and renews inside it, and re-reads the store first, so a pair another
   * process just renewed is reused.
   */
  withLock?<T>(fn: () => Promise<T>): Promise<T>;
}

export class MemoryTokenStore implements TokenStore {
  private tokens: Tokens | null = null;
  get(): Tokens | null {
    return this.tokens;
  }
  set(tokens: Tokens | null): void {
    this.tokens = tokens;
  }
}

/**
 * Tokens in a file (mode 0600), shared safely by every process on one machine. The lock is a
 * `<path>.lock` file created exclusively; a lock older than `staleMs` (30 s) is taken over.
 * Writes go to a temporary file that replaces the old one. Node.js only.
 *
 *     const store = new FileTokenStore("/var/lib/my-app/ic-tokens.json");
 *     const ic = new Client({ email, password, tokenStore: store });
 */
export class FileTokenStore implements TokenStore {
  private readonly staleMs: number;
  private readonly retryMs: number;

  constructor(
    readonly path: string,
    options: { staleMs?: number; retryMs?: number } = {},
  ) {
    this.staleMs = options.staleMs ?? 30_000;
    this.retryMs = options.retryMs ?? 50;
  }

  async get(): Promise<Tokens | null> {
    const fs = await import("node:fs/promises");
    let text: string;
    try {
      text = await fs.readFile(this.path, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return null;
      throw err;
    }
    try {
      const t = JSON.parse(text) as Partial<Tokens> | null;
      if (!t || typeof t.accessToken !== "string" || typeof t.refreshToken !== "string") return null;
      return { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: Number(t.expiresAt) || 0 };
    } catch {
      return null;
    }
  }

  async set(tokens: Tokens | null): Promise<void> {
    const fs = await import("node:fs/promises");
    if (tokens === null) {
      await fs.rm(this.path, { force: true });
      return;
    }
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(tokens), { mode: 0o600 });
    await fs.rename(tmp, this.path);
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const fs = await import("node:fs/promises");
    const lock = `${this.path}.lock`;
    for (;;) {
      try {
        const h = await fs.open(lock, "wx", 0o600);
        await h.close();
        break;
      } catch (err) {
        if ((err as { code?: string }).code !== "EEXIST") throw err;
        try {
          const st = await fs.stat(lock);
          if (Date.now() - st.mtimeMs > this.staleMs) {
            await fs.rm(lock, { force: true });
            continue;
          }
        } catch {
          continue; // released between open and stat
        }
        await new Promise((r) => setTimeout(r, this.retryMs));
      }
    }
    try {
      return await fn();
    } finally {
      await fs.rm(lock, { force: true });
    }
  }
}
