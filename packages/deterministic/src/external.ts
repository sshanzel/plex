import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export interface ExternalTools {
  semgrep: boolean;
  astGrep: boolean;
}

export async function isAvailable(bin: string, arg = '--version'): Promise<boolean> {
  try {
    await pexec(bin, [arg]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect optional external scanners. When present they become additional deterministic
 * sources (extension point: parse their JSON output into Finding[] and merge). The
 * built-in TS checks (builtin.ts) are the always-available baseline, so the product
 * never depends on these being installed.
 */
export async function detectExternalTools(): Promise<ExternalTools> {
  const [semgrep, astGrep] = await Promise.all([isAvailable('semgrep'), isAvailable('ast-grep')]);
  return { semgrep, astGrep };
}
