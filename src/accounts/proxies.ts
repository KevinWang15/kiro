import type { AppDatabase } from "../db.ts";
import { testProxyConnectivity } from "../proxy.ts";
import type { ProxyRecord } from "./types.ts";

export class ProxyRepository {
  constructor(private readonly database: AppDatabase) {}

  list(): ProxyRecord[] {
    return this.database.connection
      .prepare("SELECT * FROM proxies ORDER BY id DESC")
      .all() as unknown as ProxyRecord[];
  }

  get(id: number | null | undefined): ProxyRecord | null {
    if (!id) return null;
    return (
      (this.database.connection
        .prepare("SELECT * FROM proxies WHERE id = ?")
        .get(id) as unknown as ProxyRecord | undefined) ?? null
    );
  }

  create(input: Partial<ProxyRecord>): ProxyRecord {
    if (!input.name?.trim() || !input.url?.trim())
      throw new Error("Proxy name and URL are required");
    const now = new Date().toISOString();
    const result = this.database.connection
      .prepare(
        `
      INSERT INTO proxies(name, type, url, basicAuthUsername, basicAuthPassword, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        input.name.trim(),
        input.type || "HTTPS_CONNECT",
        input.url.trim(),
        input.basicAuthUsername || null,
        input.basicAuthPassword || null,
        now,
        now,
      );
    return this.get(Number(result.lastInsertRowid))!;
  }

  update(id: number, input: Partial<ProxyRecord>): ProxyRecord | null {
    const current = this.get(id);
    if (!current) return null;
    this.database.connection
      .prepare(
        `
      UPDATE proxies SET name = ?, type = ?, url = ?, basicAuthUsername = ?, basicAuthPassword = ?, updatedAt = ? WHERE id = ?
    `,
      )
      .run(
        input.name?.trim() || current.name,
        input.type || current.type,
        input.url?.trim() || current.url,
        input.basicAuthUsername === undefined
          ? current.basicAuthUsername
          : input.basicAuthUsername || null,
        input.basicAuthPassword === undefined
          ? current.basicAuthPassword
          : input.basicAuthPassword || null,
        new Date().toISOString(),
        id,
      );
    return this.get(id);
  }

  delete(id: number): boolean {
    return (
      this.database.connection
        .prepare("DELETE FROM proxies WHERE id = ?")
        .run(id).changes > 0
    );
  }

  test(id: number) {
    const proxy = this.get(id);
    if (!proxy) throw new Error("Proxy not found");
    return testProxyConnectivity(proxy);
  }

  async findWorking(): Promise<ProxyRecord[]> {
    const checks = await Promise.all(
      this.list().map(async (proxy) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if ((await testProxyConnectivity(proxy)).success) return proxy;
        }
        return null;
      }),
    );
    return checks.filter((proxy): proxy is ProxyRecord => proxy !== null);
  }
}
