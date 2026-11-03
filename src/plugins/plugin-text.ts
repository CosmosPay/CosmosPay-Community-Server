/**
 * Text a plugin chose, made safe for a log line or an error message: every
 * C0/C1 control and both Unicode line separators become a space (no forged
 * log entries, no terminal escape sequences), and it is cut at `max`
 * characters, so a plugin cannot spend megabytes of the log per call.
 */
export function oneLine(text: unknown, max: number): string {
  const line = String(text)
    // eslint-disable-next-line no-control-regex -- removing control characters is the point
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, ' ');
  return line.length > max ? `${line.slice(0, max)}...` : line;
}
