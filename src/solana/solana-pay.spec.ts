import { solanaPayUri } from '@/solana/solana-pay';

describe('solanaPayUri', () => {
  it('builds a transfer request with its reference', () => {
    const uri = solanaPayUri({
      recipient: 'mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN',
      amount: '1.5',
      splToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      reference: '82ZJ7nbGpixjeDCmEhUcmwXYfvurzAgGdtSMuHnUgyny',
      message: 'Order #24',
      memo: '42',
    });
    const url = new URL(uri);
    expect(url.protocol).toBe('solana:');
    expect(url.pathname).toBe('mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN');
    expect(url.searchParams.get('amount')).toBe('1.5');
    expect(url.searchParams.get('spl-token')).toBe(
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );
    expect(url.searchParams.get('reference')).toBe(
      '82ZJ7nbGpixjeDCmEhUcmwXYfvurzAgGdtSMuHnUgyny',
    );
    expect(url.searchParams.get('message')).toBe('Order #24');
    expect(url.searchParams.get('memo')).toBe('42');
  });

  it('leaves out what was not asked for: an open amount, SOL', () => {
    const uri = solanaPayUri({ recipient: 'R', reference: 'REF' });
    expect(uri).toBe('solana:R?reference=REF');
  });

  it('leaves out the reference where the payee needs none (a one-off deposit address)', () => {
    expect(solanaPayUri({ recipient: 'R', amount: '0.5' })).toBe(
      'solana:R?amount=0.5',
    );
  });
});
