import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Keypair } from '@stellar/stellar-sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import {
  DefindexDepositDto,
  DefindexWithdrawDto,
  defindexAmount,
} from '@/native-plugins/defindex/dto/defindex.dto';

const CALLER = Keypair.random().publicKey();
const TOO_BIG = '9007199254740992'; // Number.MAX_SAFE_INTEGER + 1

describe('defindexAmount', () => {
  it('preserves exact protocol minor units inside the SDK safe range', () => {
    expect(defindexAmount('10000000')).toBe(10_000_000);
    expect(defindexAmount('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('refuses an amount the number-based SDK cannot represent exactly, as a 400', () => {
    let refused: unknown;
    try {
      defindexAmount(TOO_BIG);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).getStatus()).toBe(400);
    expect((refused as ApiError).code).toBe(ApiErrorCode.InvalidAmount);
  });
});

describe('DeFindex amounts are validated before DeFindex is called', () => {
  const errorsOf = async (cls: new () => object, body: object) =>
    (await validate(plainToInstance(cls, body))).map((e) => e.property);

  it('accepts amounts within the SDK safe range', async () => {
    expect(
      await errorsOf(DefindexDepositDto, {
        amounts: ['10000000', '9007199254740991'],
        caller: CALLER,
      }),
    ).toEqual([]);
    expect(
      await errorsOf(DefindexWithdrawDto, { shares: '5000', caller: CALLER }),
    ).toEqual([]);
  });

  it('refuses an oversized deposit amount', async () => {
    expect(
      await errorsOf(DefindexDepositDto, {
        amounts: ['1', TOO_BIG],
        caller: CALLER,
      }),
    ).toEqual(['amounts']);
  });

  it('refuses an oversized share count', async () => {
    expect(
      await errorsOf(DefindexWithdrawDto, { shares: TOO_BIG, caller: CALLER }),
    ).toEqual(['shares']);
  });

  it('still refuses what is not a non-negative integer string', async () => {
    for (const amount of ['-1', '1.5', '01', 'abc', '']) {
      expect(
        await errorsOf(DefindexDepositDto, {
          amounts: [amount],
          caller: CALLER,
        }),
      ).toEqual(['amounts']);
    }
  });
});
