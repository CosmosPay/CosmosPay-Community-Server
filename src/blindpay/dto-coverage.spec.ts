import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateReceiverDto } from '../kyc/receivers/dto/create-receiver.dto';
import { CreateBankAccountDto } from '../kyc/bank-accounts/dto/create-bank-account.dto';
import { CreatePayinQuoteDto } from '../onramp/dto/create-payin-quote.dto';
import { CreatePayoutQuoteDto } from '../offramp/dto/create-payout-quote.dto';

/**
 * Proves every BlindPay-backed DTO supports the full range of inputs — a minimal
 * (required-only) payload AND a maximal (every documented field) payload — under
 * the SAME pipe the app runs (whitelist + forbidNonWhitelisted). The maximal
 * cases would fail with `forbidNonWhitelisted` if a field were undeclared, so
 * this guards against the DTO drifting behind the API surface. Unknown fields
 * must still be rejected.
 */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const run = (metatype: any, value: unknown) =>
  pipe.transform(value, { type: 'body', metatype, data: '' });

describe('BlindPay DTOs — minimum-to-maximum parameter coverage', () => {
  describe('CreateReceiverDto', () => {
    it('accepts the minimal payload', async () => {
      await expect(
        run(CreateReceiverDto, {
          type: 'individual',
          kyc_type: 'standard',
          email: 'a@b.com',
          country: 'US',
        }),
      ).resolves.toBeDefined();
    });

    it('accepts the maximal payload (every field, incl. owners)', async () => {
      await expect(
        run(CreateReceiverDto, {
          type: 'business',
          kyc_type: 'enhanced',
          email: 'a@b.com',
          country: 'US',
          first_name: 'Jane',
          last_name: 'Doe',
          date_of_birth: '1990-01-15T00:00:00.000Z',
          tax_id: '123456789',
          occupation: 'Engineer',
          id_doc_country: 'US',
          id_doc_type: 'PASSPORT',
          id_doc_front_file: 'https://f/1',
          id_doc_back_file: 'https://f/2',
          selfie_file: 'https://f/3',
          account_purpose: 'receiving_payments',
          account_purpose_other: 'n/a',
          source_of_funds_doc_type: 'employment',
          source_of_funds_doc_file: 'https://f/4',
          source_of_wealth: 'salary',
          sole_proprietor_doc_type: 'bank_statement',
          proof_of_address_doc_type: 'UTILITY_BILL',
          proof_of_address_doc_file: 'https://f/5',
          recipient_relationship: 'self',
          purpose_of_transactions: 'business_transactions',
          purpose_of_transactions_explanation: 'because',
          legal_name: 'Acme Inc.',
          alternate_name: 'Acme',
          business_type: 'cooperative',
          business_industry: '541511',
          business_description: 'software',
          formation_date: '2015-01-01T00:00:00.000Z',
          estimated_annual_revenue: '1000000_4999999',
          publicly_traded: false,
          website: 'https://acme.com',
          incorporation_doc_file: 'https://f/6',
          proof_of_ownership_doc_file: 'https://f/7',
          owners: [
            {
              role: 'beneficial_owner',
              first_name: 'Jane',
              last_name: 'Doe',
              date_of_birth: '1985-04-12T00:00:00.000Z',
              tax_id: '123-45-6789',
              tax_type: 'ssn',
              country: 'US',
              address_line_1: '123 Main St',
              address_line_2: 'Apt 1',
              city: 'NYC',
              state_province_region: 'NY',
              postal_code: '10001',
              ownership_percentage: 25.5,
              title: 'Director',
              id_doc_country: 'US',
              id_doc_type: 'PASSPORT',
              id_doc_front_file: 'https://f/8',
              id_doc_back_file: 'https://f/9',
              proof_of_address_doc_type: 'UTILITY_BILL',
              proof_of_address_doc_file: 'https://f/10',
            },
          ],
          address_line_1: '123 Main St',
          address_line_2: 'Apt 1',
          city: 'NYC',
          state_province_region: 'NY',
          postal_code: '10001',
          phone_number: '+12025550123',
          ip_address: '127.0.0.1',
          external_id: 'ext_1',
          image_url: 'https://f/11',
          tos_id: 'to_000000000000',
        }),
      ).resolves.toBeDefined();
    });

    it('rejects an unknown field', async () => {
      await expect(
        run(CreateReceiverDto, {
          type: 'individual',
          kyc_type: 'standard',
          email: 'a@b.com',
          country: 'US',
          not_a_real_field: 'x',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('CreateBankAccountDto', () => {
    it('accepts the minimal payload (pix)', async () => {
      await expect(
        run(CreateBankAccountDto, {
          type: 'pix',
          name: 'min',
          pix_key: 'a@b.com',
        }),
      ).resolves.toBeDefined();
    });

    it('accepts the maximal payload (ach, all fields)', async () => {
      await expect(
        run(CreateBankAccountDto, {
          type: 'ach',
          name: 'max',
          account_class: 'business',
          account_type: 'checking',
          beneficiary_name: 'Acme LLC',
          recipient_relationship: 'vendor_or_supplier',
          account_number: '123456789',
          routing_number: '021000021',
          business_industry: '541511',
          phone_number: '+12025550123',
          tax_id: '123456789',
          address_line_1: '1 Main',
          address_line_2: 'Ste 2',
          city: 'NYC',
          state_province_region: 'NY',
          country: 'US',
          postal_code: '10001',
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('CreatePayinQuoteDto', () => {
    it('accepts the minimal payload', async () => {
      await expect(
        run(CreatePayinQuoteDto, {
          blockchain_wallet_id: 'w1',
          currency_type: 'sender',
          payment_method: 'pix',
          token: 'USDB',
          request_amount: 50000,
        }),
      ).resolves.toBeDefined();
    });

    it('accepts the maximal payload (incl. payer_rules)', async () => {
      await expect(
        run(CreatePayinQuoteDto, {
          blockchain_wallet_id: 'w1',
          currency_type: 'sender',
          payment_method: 'transfers',
          token: 'USDB',
          request_amount: 50000,
          cover_fees: true,
          is_otc: false,
          partner_fee_id: 'pf_1',
          wallet_id: 'cw_1',
          payer_rules: {
            transfers_allowed_tax_id: '20123456786',
            pse_full_name: 'Jane Doe',
            pse_document_type: 'CC',
            pse_document_number: '123456789',
            pse_email: 'a@b.com',
            pse_phone: '+573001234567',
            pse_bank_code: '9',
            pix_allowed_tax_ids: ['12345678909'],
            pse_allowed_tax_ids: ['12345678909'],
          },
        }),
      ).resolves.toBeDefined();
    });

    it('rejects an invalid payment_method (payout rail with _bitso)', async () => {
      await expect(
        run(CreatePayinQuoteDto, {
          blockchain_wallet_id: 'w1',
          currency_type: 'sender',
          payment_method: 'spei_bitso',
          token: 'USDB',
          request_amount: 50000,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('CreatePayoutQuoteDto', () => {
    it('accepts the minimal payload', async () => {
      await expect(
        run(CreatePayoutQuoteDto, {
          bank_account_id: 'ba1',
          currency_type: 'sender',
          cover_fees: false,
          request_amount: 10000,
          network: 'stellar_testnet',
          token: 'USDB',
        }),
      ).resolves.toBeDefined();
    });

    it('accepts the maximal payload', async () => {
      await expect(
        run(CreatePayoutQuoteDto, {
          bank_account_id: 'ba1',
          currency_type: 'sender',
          cover_fees: false,
          request_amount: 10000,
          network: 'stellar_testnet',
          token: 'USDB',
          description: 'rent',
          partner_fee_id: 'pf_1',
        }),
      ).resolves.toBeDefined();
    });
  });
});
