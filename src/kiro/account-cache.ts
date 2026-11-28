// What Kiro says about an account (its feature configuration, its model
// list), read once per interval. As the IDE keeps its feature configuration:
// a value lasts `ttlMs` per sign-in (token and profile); when it can't be
// read, the last one read stays in use and the read is tried again after
// `retryMs`. Requests arriving during a read share it.

type Entry<T> = {
  identity: string;
  value: T | undefined;
  until: number;
  pending?: Promise<void>;
};

export class AccountCache<T> {
  private readonly entries = new Map<number, Entry<T>>();

  constructor(
    // Names the value in the warning logged when it can't be read.
    private readonly what: string,
    private readonly ttlMs: number,
    private readonly retryMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** The account's value; undefined while none has been read for this sign-in. */
  async get(accountId: number, identity: string, load: () => Promise<T>): Promise<T | undefined> {
    let entry = this.entries.get(accountId);
    if (!entry || entry.identity !== identity) {
      entry = { identity, value: undefined, until: 0 };
      this.entries.set(accountId, entry);
    }
    if (this.now() >= entry.until) {
      const current = entry;
      current.pending ??= load()
        .then((value) => {
          current.value = value;
          current.until = this.now() + this.ttlMs;
        })
        .catch((error) => {
          current.until = this.now() + this.retryMs;
          console.warn(
            `[kiro] ${this.what} for account ${accountId} unavailable: ${(error as Error).message}`,
          );
        })
        .finally(() => {
          current.pending = undefined;
        });
      await current.pending;
    }
    return entry.value;
  }
}
