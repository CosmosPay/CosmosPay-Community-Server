import {
  documentsMatch,
  namesMatch,
  normalizeName,
  scoreTransfer,
} from '@/p2p/p2p-transfer-match';

describe('P2P transfer matching', () => {
  it('normalizes names: case, accents, punctuation', () => {
    expect(normalizeName('  Gómez, JUAN-Carlos ')).toEqual([
      'gomez',
      'juan',
      'carlos',
    ]);
  });

  it('matches names the way banks shorten and reorder them', () => {
    expect(namesMatch('GOMEZ JUAN', 'Juan Gómez')).toBe(true);
    expect(namesMatch('JUAN C GOMEZ', 'Juan Gómez')).toBe(true);
    expect(namesMatch('Juan Pérez', 'Juan Gómez')).toBe(false);
    expect(namesMatch('', 'Juan Gómez')).toBe(false);
  });

  it('matches a document by its digits, or a DNI inside a CUIT', () => {
    expect(documentsMatch('20-12345678-6', '20123456786')).toBe(true);
    expect(documentsMatch('12.345.678', '20123456786')).toBe(true);
    expect(documentsMatch('12345679', '20123456786')).toBe(false);
    expect(documentsMatch('123', '123')).toBe(false);
  });

  it('scores the amount, then the name and the document', () => {
    const payer = { name: 'Juan Gómez', document: '20123456786' };
    expect(scoreTransfer({}, payer)).toEqual({
      score: 1,
      matchedOn: ['amount'],
    });
    expect(
      scoreTransfer(
        { payerName: 'GOMEZ JUAN', payerDocument: '12345678' },
        payer,
      ),
    ).toEqual({ score: 3, matchedOn: ['amount', 'name', 'document'] });
    expect(scoreTransfer({ payerName: 'Ana' }, null)).toEqual({
      score: 1,
      matchedOn: ['amount'],
    });
  });
});
