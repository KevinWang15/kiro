import { createHash } from "node:crypto";
import type { AppDatabase } from "../db.ts";

// Display omission must not remove the signed text needed on the next turn.
// Keep this separate from token-cache simulation: resumed conversations must
// still replay correctly after that cache expires or the adapter restarts.
export interface ReasoningReplayStore {
  get(signature: string): string | undefined;
  set(signature: string, thinking: string): void;
}

export class InMemoryReasoningReplayStore implements ReasoningReplayStore {
  private readonly entries = new Map<string, string>();

  get(signature: string): string | undefined {
    return this.entries.get(signature);
  }

  set(signature: string, thinking: string): void {
    if (!this.entries.get(signature)) this.entries.set(signature, thinking);
  }
}

export class SqliteReasoningReplayStore implements ReasoningReplayStore {
  constructor(private readonly database: AppDatabase) {}

  get(signature: string): string | undefined {
    const row = this.database.connection
      .prepare("SELECT thinking FROM reasoning_replay WHERE signatureHash = ?")
      .get(this.key(signature)) as { thinking: string } | undefined;
    return row?.thinking;
  }

  set(signature: string, thinking: string): void {
    this.database.connection
      .prepare(
        `INSERT INTO reasoning_replay(signatureHash, thinking) VALUES (?, ?)
         ON CONFLICT(signatureHash) DO UPDATE SET thinking = excluded.thinking
         WHERE reasoning_replay.thinking = ''`,
      )
      .run(this.key(signature), thinking);
  }

  private key(signature: string): string {
    return createHash("sha256").update(signature).digest("hex");
  }
}
