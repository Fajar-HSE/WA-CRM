import { describe, expect, it } from 'vitest'

import { membersToCsv } from './csv'

describe('membersToCsv', () => {
  it('writes a header and one line per member', () => {
    expect(
      membersToCsv(
        [
          { phone: '6281111111111', admin: true },
          { phone: '6282222222222', admin: false },
        ],
        'Peserta K3',
      ),
    ).toBe('phone,group,admin\r\n6281111111111,Peserta K3,yes\r\n6282222222222,Peserta K3,no\r\n')
  })

  it('quotes cells that contain commas or quotes', () => {
    expect(membersToCsv([{ phone: '1', admin: false }], 'A, "B"')).toContain('"A, ""B"""')
  })

  it('defuses spreadsheet formulas in the group name', () => {
    expect(membersToCsv([{ phone: '1', admin: false }], '=HYPERLINK("x")')).toContain("'=HYPERLINK")
  })
})
