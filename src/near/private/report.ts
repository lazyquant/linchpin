import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { checkPrivateExportPath } from '../../review/position/export';
import { PositionRejected } from '../../review/position/book';
export function writeLocalReport(path: string, text: string): void {
  const destination = checkPrivateExportPath(path);
  try { mkdirSync(dirname(destination), { recursive: true, mode: 0o700 }); writeFileSync(destination, text, { mode: 0o600 }); chmodSync(destination, 0o600); }
  catch { throw new PositionRejected('private-export-write-failed'); }
}
