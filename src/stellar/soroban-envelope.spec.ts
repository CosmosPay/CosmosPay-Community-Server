import {
  Account,
  Address,
  Keypair,
  nativeToScVal,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import {
  type BuiltEnvelopeLimits,
  checkSingleContractCall,
  rootAuthorizationRefusal,
  rootSubInvocations,
} from '@/stellar/soroban-envelope';

const PASSPHRASE = Networks.TESTNET;
const SOURCE = Keypair.random().publicKey();
const STRANGER = Keypair.random().publicKey();
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 3));
const ARGS = [nativeToScVal(5n, { type: 'i128' })];

const invocation = (
  fn = 'call',
  args = ARGS,
  subs: xdr.SorobanAuthorizedInvocation[] = [],
) =>
  new xdr.SorobanAuthorizedInvocation({
    function:
      xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(CONTRACT).toScAddress(),
          functionName: fn,
          args,
        }),
      ),
    subInvocations: subs,
  });

const sourceEntry = (root = invocation()) =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: root,
  });

function envelope(
  auth = [sourceEntry()],
  { source = SOURCE, soroban = true } = {},
): string {
  let builder = new TransactionBuilder(new Account(source, '7'), {
    fee: '100',
    networkPassphrase: PASSPHRASE,
  }).addOperation(
    Operation.invokeContractFunction({
      contract: CONTRACT,
      function: 'call',
      args: ARGS,
      auth,
    }),
  );
  if (soroban) {
    builder = builder.setSorobanData(
      new SorobanDataBuilder().setResourceFee(1_000).build(),
    );
  }
  return builder.setTimeout(300).build().toXDR();
}

const limits = (): BuiltEnvelopeLimits => ({
  maxFeeStroops: 1_000_000n,
  maxValidityMs: 15 * 60_000,
  clockSkewMs: 60_000,
  now: new Date(),
});

describe('checkSingleContractCall', () => {
  it('takes one plain contract call apart', () => {
    const result = checkSingleContractCall(
      envelope(),
      PASSPHRASE,
      SOURCE,
      limits(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.call).toMatchObject({ contract: CONTRACT, function: 'call' });
    expect(result.auth).toHaveLength(1);
  });

  it('refuses another source, and an envelope without Soroban resources', () => {
    expect(
      checkSingleContractCall(
        envelope(undefined, { source: STRANGER }),
        PASSPHRASE,
        SOURCE,
        limits(),
      ),
    ).toEqual({ ok: false, reason: 'its source is not the caller' });
    expect(
      checkSingleContractCall(
        envelope(undefined, { soroban: false }),
        PASSPHRASE,
        SOURCE,
        limits(),
      ),
    ).toEqual({ ok: false, reason: 'it carries no Soroban resources' });
  });
});

describe('rootAuthorizationRefusal', () => {
  const call = { contract: CONTRACT, function: 'call', args: ARGS };

  it('accepts the signer’s one entry rooted at the call, and reads what is under it', () => {
    const sub = invocation('inner');
    const entries = [sourceEntry(invocation('call', ARGS, [sub]))] as never;
    expect(rootAuthorizationRefusal(entries, SOURCE, call)).toBeNull();
    expect(rootSubInvocations(entries)).toHaveLength(1);
  });

  it('refuses two entries and a root that is another call', () => {
    expect(
      rootAuthorizationRefusal(
        [sourceEntry(), sourceEntry()] as never,
        SOURCE,
        call,
      ),
    ).toBe('it carries 2 authorization entries, not one');
    expect(
      rootAuthorizationRefusal(
        [sourceEntry(invocation('other'))] as never,
        SOURCE,
        call,
      ),
    ).toBe('its authorization is not for the requested call');
  });
});
