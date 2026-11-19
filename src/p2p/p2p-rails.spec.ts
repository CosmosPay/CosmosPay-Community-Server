import {
  isDocumentNumber,
  isPersonName,
  isValidCbu,
  isValidCbuAlias,
  isValidClabe,
  isValidCnpj,
  isValidCpf,
  isValidCuit,
  isValidRut,
  P2P_RAIL_IDS,
  P2P_RAILS,
  railsFor,
  validateRailDetails,
} from '@/p2p/p2p-rails';

/** Flips one digit, so a valid number's checksum stops matching. */
function bump(value: string, index: number): string {
  const d = (Number(value[index]) + 1) % 10;
  return value.slice(0, index) + d + value.slice(index + 1);
}

describe('P2P rails: checksums', () => {
  it('checks both blocks of a CBU / CVU', () => {
    // Bank 285, branch 0590: the widely published example, both checks hold.
    expect(isValidCbu('2850590940090418135201')).toBe(true);
    expect(isValidCbu(bump('2850590940090418135201', 7))).toBe(false);
    expect(isValidCbu(bump('2850590940090418135201', 21))).toBe(false);
    expect(isValidCbu(bump('2850590940090418135201', 12))).toBe(false);
    expect(isValidCbu('285059094009041813520')).toBe(false);
    expect(isValidCbu('285059094009041813520a')).toBe(false);
  });

  it('takes an alias of 6 to 20 lowercase letters, digits, dots and hyphens', () => {
    expect(isValidCbuAlias('mi.alias-123')).toBe(true);
    expect(isValidCbuAlias('corto')).toBe(false);
    expect(isValidCbuAlias('Mayusculas.no')).toBe(false);
    expect(isValidCbuAlias('a'.repeat(21))).toBe(false);
  });

  it('checks a CUIT / CUIL', () => {
    expect(isValidCuit('20123456786')).toBe(true);
    expect(isValidCuit('20123456785')).toBe(false);
    expect(isValidCuit('2012345678')).toBe(false);
  });

  it('checks a CPF and a CNPJ, and refuses repeated digits', () => {
    expect(isValidCpf('52998224725')).toBe(true);
    expect(isValidCpf('52998224726')).toBe(false);
    expect(isValidCpf('11111111111')).toBe(false);
    expect(isValidCnpj('11222333000181')).toBe(true);
    expect(isValidCnpj('11222333000182')).toBe(false);
    expect(isValidCnpj('00000000000000')).toBe(false);
  });

  it('checks a CLABE', () => {
    expect(isValidClabe('002010077777777771')).toBe(true);
    expect(isValidClabe('002010077777777772')).toBe(false);
    expect(isValidClabe(bump('002010077777777771', 3))).toBe(false);
  });

  it('checks a RUT, K included, with or without dots', () => {
    expect(isValidRut('12345678-5')).toBe(true);
    expect(isValidRut('12.345.678-5')).toBe(true);
    expect(isValidRut('12345678-4')).toBe(false);
    // 10.000.013-K: the check digit is K.
    expect(isValidRut('10000013-K')).toBe(true);
    expect(isValidRut('10000013-k')).toBe(true);
  });

  it('takes names and document numbers in the shapes people give them', () => {
    expect(isPersonName('María José Pérez')).toBe(true);
    expect(isPersonName("O'Brien")).toBe(true);
    expect(isPersonName('1abc')).toBe(false);
    expect(isPersonName('x')).toBe(false);
    expect(isDocumentNumber('20.123.456')).toBe(true);
    expect(isDocumentNumber('a b')).toBe(false);
  });
});

describe('P2P rails: details', () => {
  it('has one rail per id, each paying in a currency it lists', () => {
    for (const id of P2P_RAIL_IDS) {
      expect(railsFor(P2P_RAILS[id].currency)).toContain(id);
      expect(P2P_RAILS[id].fields.length).toBeGreaterThan(0);
    }
  });

  it('takes a CBU or an alias (never both) and a valid CUIT in Argentina', () => {
    expect(
      validateRailDetails('ar_bank_transfer', 'ARS', {
        cbu: '2850590940090418135201',
        cuit: '20-12345678-6',
      }),
    ).toEqual({
      ok: true,
      details: { cbu: '2850590940090418135201', cuit: '20123456786' },
    });
    expect(
      validateRailDetails('ar_bank_transfer', 'ARS', {
        alias: 'Mi.Alias',
        cuit: '20123456786',
      }),
    ).toEqual({
      ok: true,
      details: { alias: 'mi.alias', cuit: '20123456786' },
    });
    const both = validateRailDetails('ar_bank_transfer', 'ARS', {
      cbu: '2850590940090418135201',
      alias: 'mi.alias',
      cuit: '20123456786',
    });
    expect(both.ok).toBe(false);
    const bad = validateRailDetails('ar_bank_transfer', 'ARS', {
      cbu: '2850590940090418135202',
      cuit: '20123456785',
    });
    expect(bad).toEqual({
      ok: false,
      errors: [
        'details.cbu is not a valid CBU or CVU (22 digits with check digits)',
        'details.cuit is not a valid CUIT or CUIL',
      ],
    });
  });

  it('checks a PIX key by its type', () => {
    expect(
      validateRailDetails('br_pix', 'BRL', {
        keyType: 'cpf',
        key: '529.982.247-25',
      }),
    ).toEqual({ ok: true, details: { keyType: 'cpf', key: '52998224725' } });
    expect(
      validateRailDetails('br_pix', 'BRL', {
        keyType: 'phone',
        key: '+55 (11) 91234-5678',
      }),
    ).toEqual({
      ok: true,
      details: { keyType: 'phone', key: '+5511912345678' },
    });
    expect(
      validateRailDetails('br_pix', 'BRL', {
        keyType: 'evp',
        key: '123E4567-E89B-12D3-A456-426614174000',
      }).ok,
    ).toBe(true);
    expect(
      validateRailDetails('br_pix', 'BRL', { keyType: 'email', key: 'no-at' })
        .ok,
    ).toBe(false);
    expect(
      validateRailDetails('br_pix', 'BRL', { keyType: 'iban', key: 'x' }).ok,
    ).toBe(false);
  });

  it('refuses another currency, unknown fields and non-objects', () => {
    expect(
      validateRailDetails('mx_spei', 'ARS', { clabe: '002010077777777771' }),
    ).toEqual({ ok: false, errors: ['rail mx_spei pays in MXN, not ARS'] });
    expect(
      validateRailDetails('mx_spei', 'MXN', {
        clabe: '002010077777777771',
        extra: 'x',
      }),
    ).toEqual({
      ok: false,
      errors: ['details.extra is not a field of this rail'],
    });
    expect(validateRailDetails('mx_spei', 'MXN', 'clabe').ok).toBe(false);
    expect(validateRailDetails('mx_spei', 'MXN', null).ok).toBe(false);
  });

  it('checks the Colombian, Peruvian and Chilean bank transfers', () => {
    expect(
      validateRailDetails('co_bank_transfer', 'COP', {
        bank: 'Bancolombia',
        accountType: 'savings',
        accountNumber: '123-456789',
        documentType: 'CC',
        documentNumber: '1020304050',
      }),
    ).toEqual({
      ok: true,
      details: {
        bank: 'Bancolombia',
        accountType: 'savings',
        accountNumber: '123456789',
        documentType: 'CC',
        documentNumber: '1020304050',
      },
    });
    expect(
      validateRailDetails('pe_bank_transfer', 'PEN', {
        cci: '0021 9100 1234 5678 9012',
        documentType: 'DNI',
        documentNumber: '12345678',
      }).ok,
    ).toBe(true);
    expect(
      validateRailDetails('pe_bank_transfer', 'PEN', {
        cci: '123',
        documentType: 'DNI',
        documentNumber: '12345678',
      }).ok,
    ).toBe(false);
    expect(
      validateRailDetails('cl_bank_transfer', 'CLP', {
        bank: 'Banco de Chile',
        accountType: 'vista',
        accountNumber: '00123456',
        rut: '12.345.678-5',
      }),
    ).toEqual({
      ok: true,
      details: {
        bank: 'Banco de Chile',
        accountType: 'vista',
        accountNumber: '00123456',
        rut: '12345678-5',
      },
    });
  });

  it('masks what a summary shows', () => {
    expect(
      P2P_RAILS.ar_bank_transfer.summary({ cbu: '2850590940090418135201' }),
    ).toBe('CBU ••••5201');
    expect(P2P_RAILS.mx_spei.summary({ clabe: '002010077777777771' })).toBe(
      'CLABE ••••7771',
    );
  });
});
