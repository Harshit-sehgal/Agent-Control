/** A warning when the secrets file is readable by other local users, or null. The file holds the AI key and the
 * dashboard password, so any group or other bit is a finding. A missing file is not a warning here. */
import fsSync from 'node:fs';
export function envModeWarning(file, fs = fsSync) {
  let mode;
  try { mode = fs.statSync(file).mode & 0o777; } catch { return null; }
  if (!(mode & 0o077)) return null;
  return `config: ${file} is readable by other users (mode ${mode.toString(8)}). Run chmod 600 on it.`;
}
