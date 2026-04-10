import 'server-only';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { CURRENT_SHA } from '@/lib/version';
import { DEFAULT_UPDATE_STATE, type UpdateState } from './types';

const STATE_DIR = resolve(process.cwd(), '.update-state');
const STATE_FILE = resolve(STATE_DIR, 'state.json');
const TMP_FILE = resolve(STATE_DIR, 'state.json.tmp');

/**
 * Cross-process state store for the self-update pipeline.
 *
 * Writes are atomic: write-to-tmp + rename. Never leaves a partial file even
 * if the process is killed mid-write (tmp file is orphaned but state.json
 * remains whichever side of the rename boundary it was on).
 *
 * The bash updater script in Phase 9 reads this same file — JSON is the
 * lingua franca between Node and shell.
 */
export class UpdateStateStore {
  /**
   * Called from server.ts main() before HttpPollingService boots.
   * Creates .update-state/ and seeds state.json with DEFAULT_UPDATE_STATE +
   * currentSha = CURRENT_SHA. NEVER overwrites an existing file — if state.json
   * already exists, init() is a no-op beyond verifying it parses.
   */
  static init(): UpdateStateStore {
    mkdirSync(STATE_DIR, { recursive: true });
    const store = new UpdateStateStore();
    if (!existsSync(STATE_FILE)) {
      const initial: UpdateState = {
        ...DEFAULT_UPDATE_STATE,
        currentSha: CURRENT_SHA,
      };
      store.writeAtomic(initial);
      console.log(
        `[UpdateStateStore] initialized ${STATE_FILE} with currentSha=${CURRENT_SHA.slice(0, 7)}`,
      );
    } else {
      // Verify it parses. If corrupted, throw — the operator needs to see this,
      // we do NOT silently overwrite a user's persisted state.
      store.read();
    }
    return store;
  }

  read(): UpdateState {
    const raw = readFileSync(STATE_FILE, 'utf8');
    // Intentionally unvalidated — the writer is always ourselves (or the
    // Phase 9 bash script, which writes the same shape). A zod schema here
    // buys nothing because any corruption means human intervention anyway.
    return JSON.parse(raw) as UpdateState;
  }

  write(patch: Partial<UpdateState>): UpdateState {
    const current = this.read();
    const next: UpdateState = { ...current, ...patch };
    this.writeAtomic(next);
    return next;
  }

  /**
   * Atomic write: tmp + rename. rename(2) is atomic on POSIX filesystems,
   * so state.json is always either the old or new content — never partial.
   */
  private writeAtomic(state: UpdateState): void {
    writeFileSync(TMP_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
    renameSync(TMP_FILE, STATE_FILE);
  }
}
