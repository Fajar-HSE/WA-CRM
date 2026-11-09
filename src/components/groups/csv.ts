/** One cell of a CSV file: quoted when it holds a comma, quote or line break. */
function cell(value: string): string {
  // A leading =, +, - or @ makes spreadsheets run the cell as a formula.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function membersToCsv(rows: { phone: string; admin: boolean }[], group: string): string {
  const lines = ['phone,group,admin']
  for (const r of rows) lines.push([cell(r.phone), cell(group), r.admin ? 'yes' : 'no'].join(','))
  return lines.join('\r\n') + '\r\n'
}
