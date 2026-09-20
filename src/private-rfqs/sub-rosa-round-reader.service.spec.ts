import {
  decodeRevealedPrivateQuote,
  SubRosaRoundReadError,
  SubRosaRoundReader,
} from '@/private-rfqs/sub-rosa-round-reader.service';

describe('SubRosaRoundReader', () => {
  it('loads the published ESM SDK and rejects non-canonical contracts', async () => {
    const reader = new SubRosaRoundReader();

    await expect(
      reader.read('testnet', `C${'A'.repeat(55)}`, '1'),
    ).rejects.toBeInstanceOf(SubRosaRoundReadError);
  });

  it('fails a malformed application payload closed without aborting the RFQ read', () => {
    const sdk = {
      decodePayloadEnvelope: jest.fn().mockReturnValue({
        amount: 25n,
        payload: new Uint8Array([1, 2, 3]),
      }),
      decodeSealedProposal: jest.fn(() => {
        throw new Error('proposal payload must be valid JSON');
      }),
    };

    expect(
      decodeRevealedPrivateQuote(sdk, 'GPROVIDER', {
        revealed_envelope: Buffer.from([1]),
        valid: true,
      } as any),
    ).toEqual({
      provider: 'GPROVIDER',
      revealed: true,
      valid: false,
      amount: null,
      proposal: null,
    });
  });
});
