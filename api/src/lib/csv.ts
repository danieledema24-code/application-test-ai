/**
 * One CSV cell. Text starting with = + - @ (or tab/CR) is prefixed with ' so spreadsheet apps show it
 * instead of evaluating it as a formula (OWASP CSV injection); quotes, commas and line breaks are quoted.
 */
export function csvCell(v: unknown): string {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
