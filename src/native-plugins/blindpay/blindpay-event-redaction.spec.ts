import { redactProviderEvent } from '@/blindpay/blindpay-event-redaction';

/**
 * The dossier must not leave the platform in a webhook body. Closing the
 * read-back path (`omit: { payload: true }`) was not enough: subscribing to
 * `RECEIVER_UPDATED` needs only `webhooks:write`, so a key with no KYC scope
 * could have every receiver's dossier pushed to a host it controls.
 */
describe('redactProviderEvent', () => {
  const dossier = {
    id: 're_123',
    external_id: 'cust_1',
    type: 'individual',
    kyc_type: 'standard',
    kyc_status: 'approved',
    country: 'AR',
    created_at: '2026-06-01T00:00:00.000Z',
    // Everything below is the dossier and must never be forwarded.
    tax_id: '20-12345678-9',
    date_of_birth: '1980-01-01',
    first_name: 'Ada',
    last_name: 'Lovelace',
    email: 'ada@example.test',
    phone_number: '+541100000000',
    address_line_1: 'Av. Siempre Viva 742',
    id_doc_front_file: 'https://files.blindpay.test/front.png',
    selfie_file: 'https://files.blindpay.test/selfie.png',
    owners: [{ tax_id: '27-87654321-0', first_name: 'Grace' }],
  };

  it('forwards identity and KYC state, never the dossier', () => {
    const out = redactProviderEvent('RECEIVER_UPDATED', dossier);

    expect(out).toEqual({
      id: 're_123',
      external_id: 'cust_1',
      type: 'individual',
      kyc_type: 'standard',
      kyc_status: 'approved',
      country: 'AR',
      created_at: '2026-06-01T00:00:00.000Z',
    });
    // Belt and braces: nothing sensitive survives serialization either.
    const wire = JSON.stringify(out);
    for (const secret of [
      '20-12345678-9',
      '1980-01-01',
      'Siempre Viva',
      'front.png',
      'selfie.png',
      '27-87654321-0',
      '+541100000000',
    ]) {
      expect(wire).not.toContain(secret);
    }
  });

  it('is an allowlist, so a field the provider adds later is not forwarded', () => {
    // BlindPay can extend its payload without telling us; a denylist would
    // forward the new field by default.
    const out = redactProviderEvent('RECEIVER_UPDATED', {
      ...dossier,
      newly_added_biometric_hash: 'deadbeef',
    });

    expect(out).not.toHaveProperty('newly_added_biometric_hash');
  });

  it('keeps payin amounts and rails but drops funding credentials', () => {
    const out = redactProviderEvent('PAYIN_COMPLETED', {
      id: 'pi_1',
      status: 'completed',
      token: 'USDC',
      network: 'stellar',
      payment_method: 'pix',
      sender_amount: '10000',
      receiver_amount: '9950',
      // Funding instructions carry the payer's identity and bank credentials.
      pix_code: '00020126...',
      clabe: '012345678901234567',
      cbu: '0170099220000067797871',
      pse_tax_id: '900123456',
      pse_full_name: 'Ada Lovelace',
      blindpay_bank_details: { account_number: '123456789' },
    });

    expect(out).toMatchObject({
      id: 'pi_1',
      status: 'completed',
      sender_amount: '10000',
      receiver_amount: '9950',
    });
    for (const key of [
      'pix_code',
      'clabe',
      'cbu',
      'pse_tax_id',
      'pse_full_name',
      'blindpay_bank_details',
    ]) {
      expect(out).not.toHaveProperty(key);
    }
  });

  it('drops payout bank credentials', () => {
    const out = redactProviderEvent('PAYOUT_COMPLETED', {
      id: 'po_1',
      status: 'completed',
      sender_amount: '100',
      bank_account_id: 'ba_1',
      blindpay_bank_details: { iban: 'DE89370400440532013000' },
      tax_id: '20-12345678-9',
    });

    expect(out).toMatchObject({ id: 'po_1', bank_account_id: 'ba_1' });
    expect(JSON.stringify(out)).not.toContain('DE89370400440532013000');
    expect(out).not.toHaveProperty('tax_id');
  });

  it('leaves Stellar-native events untouched — they are built from our own rows', () => {
    const swap = { id: 'swap_1', status: 'SUCCEEDED', amount: '10' };

    expect(redactProviderEvent('SWAP_SUCCEEDED', swap)).toBe(swap);
    expect(redactProviderEvent('PAYMENT_INTENT_SUCCEEDED', swap)).toBe(swap);
    expect(redactProviderEvent('LIQUIDITY_SUCCEEDED', swap)).toBe(swap);
  });

  it('omits absent fields rather than emitting nulls', () => {
    const out = redactProviderEvent('RECEIVER_UPDATED', {
      id: 're_1',
      kyc_status: null,
      country: undefined,
    });

    expect(out).toEqual({ id: 're_1' });
  });
});
