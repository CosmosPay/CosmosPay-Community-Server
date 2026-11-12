import {
  cuitCheckDigitValid,
  documentHash,
  documentHintLabel,
  parsePayerDocument,
  readDepositorDocument,
} from '@/native-plugins/koywe/bank-transfer-document';

const PEPPER = 'a-pepper-of-at-least-thirty-two-characters';

describe('the payer document', () => {
  it('verifies a CUIT/CUIL check digit, and never accepts a computed 10', () => {
    expect(cuitCheckDigitValid('20123456786')).toBe(true);
    expect(cuitCheckDigitValid('27123456780')).toBe(true);
    expect(cuitCheckDigitValid('27123456781')).toBe(false);
    expect(cuitCheckDigitValid('20123456785')).toBe(false);
    expect(cuitCheckDigitValid('30712345671')).toBe(true);
    // Weighted sum 144, 144 mod 11 = 1, so 11 - 1 = 10: no digit is valid.
    for (const digit of '0123456789') {
      expect(cuitCheckDigitValid(`2012345676${digit}`)).toBe(false);
    }
    expect(cuitCheckDigitValid('2012345678')).toBe(false);
    expect(cuitCheckDigitValid('2012345678x')).toBe(false);
  });

  it('reads a CUIT/CUIL with or without separators down to its DNI part', () => {
    for (const typed of [
      '20-12345678-6',
      '20123456786',
      '20.12345678.6',
      ' 20 12345678 6 ',
    ]) {
      expect(parsePayerDocument(typed)).toEqual({
        kind: 'cuit',
        dniPart: '12345678',
        hint: '786',
      });
    }
  });

  it('reads a DNI of 7 or 8 digits, without leading zeros', () => {
    expect(parsePayerDocument('12.345.678')).toEqual({
      kind: 'dni',
      dniPart: '12345678',
      hint: '678',
    });
    expect(parsePayerDocument('1234567')).toMatchObject({
      dniPart: '1234567',
    });
    expect(parsePayerDocument('01234567')).toMatchObject({
      dniPart: '1234567',
      hint: '567',
    });
    // A CUIT whose DNI has a leading zero names the same person.
    expect(parsePayerDocument('20-01234567-5')).toMatchObject({
      kind: 'cuit',
      dniPart: '1234567',
    });
  });

  it('refuses anything else', () => {
    for (const typed of [
      '',
      '123456',
      '123456789',
      '1234567890',
      '20123456785',
      '20-12345678-X',
      '20/12345678/6',
      '00000000',
      'abcdefg',
      '201234567861',
    ]) {
      expect(parsePayerDocument(typed)).toBeNull();
    }
    expect(parsePayerDocument(12345678 as unknown as string)).toBeNull();
  });

  it('hashes the DNI part under the pepper: a CUIT and a DNI of one person agree, nothing else does', () => {
    const cuit = parsePayerDocument('20-12345678-6')!;
    const dni = parsePayerDocument('12345678')!;

    expect(documentHash(PEPPER, cuit.dniPart)).toBe(
      documentHash(PEPPER, dni.dniPart),
    );
    expect(documentHash(PEPPER, cuit.dniPart)).toMatch(/^[0-9a-f]{64}$/);
    expect(documentHash(PEPPER, cuit.dniPart)).not.toContain('12345678');
    expect(documentHash(`${PEPPER}x`, cuit.dniPart)).not.toBe(
      documentHash(PEPPER, cuit.dniPart),
    );
    expect(documentHash(PEPPER, '12345679')).not.toBe(
      documentHash(PEPPER, cuit.dniPart),
    );
  });

  it('reads a depositor’s document leniently: the bank said it', () => {
    // A check digit that does not verify is still the depositor's DNI.
    expect(readDepositorDocument('20123456785')).toMatchObject({
      dniPart: '12345678',
    });
    expect(readDepositorDocument(12345678)).toMatchObject({
      dniPart: '12345678',
    });
    expect(readDepositorDocument('20-12345678-6')).toMatchObject({
      dniPart: '12345678',
      hint: '786',
    });
    for (const raw of [undefined, null, '', '12345', 'n/a', 1.5, {}]) {
      expect(readDepositorDocument(raw)).toBeNull();
    }
  });

  it('shows the hint back with an ellipsis', () => {
    expect(documentHintLabel('786')).toBe('…786');
  });
});
