import {
  accountReady,
  accountStatusOf,
  merchantSlug,
  NO_TRANSFER_ACCOUNT,
  parseTaxId,
  toTransferAccount,
  type TransferAccountRow,
} from '@/native-plugins/koywe/transfer-account';

const ROW: TransferAccountRow = {
  id: 'acct1',
  type: 'person',
  name: 'Juan Pérez',
  status: 'pending',
  reason: 'old reason',
  verificationUrl: 'https://verify.example/form/1',
  providerMerchantId: 'mrc_1',
  alias: 'juan.perez.cp',
  cvu: '0000003100000000000001',
  bank: 'A bank',
  updatedAt: new Date('2026-11-12T12:00:00.000Z'),
};

describe('a seller’s bank transfer account', () => {
  it('takes a person’s CUIL or CUIT and a company’s CUIT, each with a valid check digit', () => {
    expect(parseTaxId('person', '20-12345678-6')).toEqual({
      digits: '20123456786',
      hint: '786',
    });
    expect(parseTaxId('person', '27123456780')).not.toBeNull();
    expect(parseTaxId('company', '30-71234567-1')).toEqual({
      digits: '30712345671',
      hint: '671',
    });
    // A company's CUIT is not a person's, nor the other way round.
    expect(parseTaxId('company', '20-12345678-6')).toBeNull();
    expect(parseTaxId('person', '30-71234567-1')).toBeNull();
    for (const bad of ['20-12345678-5', '12345678', '', 'x', '2012345678']) {
      expect(parseTaxId('person', bad)).toBeNull();
    }
  });

  it('reads the provider’s KYB statuses', () => {
    expect(accountStatusOf('CREATED')).toBe('pending');
    expect(accountStatusOf('PENDING')).toBe('pending');
    expect(accountStatusOf('IN_PROGRESS')).toBe('in_review');
    expect(accountStatusOf('MANUAL_REVIEW')).toBe('in_review');
    expect(accountStatusOf('approved')).toBe('approved');
    expect(accountStatusOf('REJECTED')).toBe('rejected');
    expect(accountStatusOf('FAILED')).toBe('rejected');
    // One added later is under review, never approved by accident.
    expect(accountStatusOf('SOMETHING_NEW')).toBe('in_review');
    expect(accountStatusOf(null)).toBe('in_review');
  });

  it('names the merchant after the account, not the seller', () => {
    expect(merchantSlug('acct1')).toBe('cosmospay-acct1');
  });

  it('answers the link while verifying, the reason once rejected, the deposit account once approved', () => {
    expect(toTransferAccount(null)).toEqual(NO_TRANSFER_ACCOUNT);
    expect(toTransferAccount(ROW)).toEqual({
      status: 'pending',
      type: 'person',
      name: 'Juan Pérez',
      verificationUrl: 'https://verify.example/form/1',
      reason: null,
      alias: null,
      cvu: null,
      bank: null,
      updatedAt: '2026-11-12T12:00:00.000Z',
    });
    expect(toTransferAccount({ ...ROW, status: 'rejected' })).toMatchObject({
      verificationUrl: null,
      reason: 'old reason',
      cvu: null,
    });
    expect(toTransferAccount({ ...ROW, status: 'approved' })).toMatchObject({
      verificationUrl: null,
      reason: null,
      alias: 'juan.perez.cp',
      cvu: '0000003100000000000001',
      bank: 'A bank',
    });
    const view = JSON.stringify(toTransferAccount(ROW));
    expect(view).not.toContain('mrc_1');
  });

  it('sends payers only to an approved account with its CVU and alias', () => {
    expect(accountReady({ ...ROW, status: 'approved' })).toBe(true);
    expect(accountReady(ROW)).toBe(false);
    expect(accountReady({ ...ROW, status: 'approved', cvu: null })).toBe(false);
    expect(
      accountReady({ ...ROW, status: 'approved', providerMerchantId: null }),
    ).toBe(false);
  });
});
