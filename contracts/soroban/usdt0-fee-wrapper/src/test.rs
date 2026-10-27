extern crate std;

use crate::{Fee, Usdt0FeeWrapper, Usdt0FeeWrapperClient};
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, IntoVal, Symbol, Val, Vec,
};

/// The OFT's `send` arguments, as LayerZero's contract shapes them (the
/// wrapper only passes them through).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SendParam {
    pub dst_eid: u32,
    pub amount_ld: i128,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MessagingFee {
    pub native_fee: i128,
    pub zro_fee: i128,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Receipt {
    pub guid: u64,
    pub amount_sent_ld: i128,
}

/// Stands in for the OFT: requires `from`, burns by taking the amount, answers
/// a receipt built from what it was given.
#[contract]
pub struct MockOft;

#[contracttype]
enum MockKey {
    Token,
}

#[contractimpl]
impl MockOft {
    pub fn __constructor(env: Env, token: Address) {
        env.storage().instance().set(&MockKey::Token, &token);
    }

    pub fn send(
        env: Env,
        from: Address,
        send_param: SendParam,
        fee: MessagingFee,
        refund_address: Address,
    ) -> Receipt {
        from.require_auth();
        let token: Address = env.storage().instance().get(&MockKey::Token).unwrap();
        TokenClient::new(&env, &token).transfer(
            &from,
            &env.current_contract_address(),
            &send_param.amount_ld,
        );
        let _ = (fee, refund_address);
        Receipt {
            guid: 42,
            amount_sent_ld: send_param.amount_ld,
        }
    }
}

struct Setup {
    env: Env,
    holder: Address,
    commission: Address,
    merchant: Address,
    token: Address,
    oft: Address,
    wrapper: Usdt0FeeWrapperClient<'static>,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    let issuer = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(issuer).address();
    let holder = Address::generate(&env);
    let commission = Address::generate(&env);
    let merchant = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&holder, &1_000_0000000);
    let oft = env.register(MockOft, (token.clone(),));
    let wrapper_id = env.register(Usdt0FeeWrapper, (oft.clone(), token.clone()));
    let wrapper = Usdt0FeeWrapperClient::new(&env, &wrapper_id);
    Setup {
        env,
        holder,
        commission,
        merchant,
        token,
        oft,
        wrapper,
    }
}

fn params(env: &Env, amount: i128) -> (Val, Val) {
    (
        SendParam {
            dst_eid: 30101,
            amount_ld: amount,
        }
        .into_val(env),
        MessagingFee {
            native_fee: 5,
            zro_fee: 0,
        }
        .into_val(env),
    )
}

fn fee(wallet: &Address, amount: i128) -> Fee {
    Fee {
        wallet: wallet.clone(),
        amount,
    }
}

#[test]
fn pays_each_fee_then_sends_and_answers_the_oft_receipt() {
    let s = setup();
    let (send_param, messaging) = params(&s.env, 100_0000000);
    let fees = vec![&s.env, fee(&s.commission, 5000000), fee(&s.merchant, 2_5000000)];
    let answer = s
        .wrapper
        .send(&s.holder, &fees, &send_param, &messaging, &s.holder);
    let receipt: Receipt = soroban_sdk::FromVal::from_val(&s.env, &answer);
    assert_eq!(
        receipt,
        Receipt {
            guid: 42,
            amount_sent_ld: 100_0000000
        }
    );
    let balances = TokenClient::new(&s.env, &s.token);
    assert_eq!(balances.balance(&s.commission), 5000000);
    assert_eq!(balances.balance(&s.merchant), 2_5000000);
    assert_eq!(balances.balance(&s.oft), 100_0000000);
    assert_eq!(balances.balance(&s.holder), 1_000_0000000 - 103_0000000);
    assert_eq!(balances.balance(&s.wrapper.address), 0);
}

#[test]
fn one_authorization_of_the_holder_covers_every_fee_and_the_send() {
    let s = setup();
    let (send_param, messaging) = params(&s.env, 10_0000000);
    let fees = vec![&s.env, fee(&s.commission, 1000000), fee(&s.merchant, 1000000)];
    s.wrapper
        .send(&s.holder, &fees, &send_param, &messaging, &s.holder);
    let auths = s.env.auths();
    assert_eq!(auths.len(), 1);
    let (who, invocation) = &auths[0];
    assert_eq!(who, &s.holder);
    let AuthorizedInvocation {
        function,
        sub_invocations,
    } = invocation;
    match function {
        AuthorizedFunction::Contract((contract, name, _)) => {
            assert_eq!(contract, &s.wrapper.address);
            assert_eq!(name, &Symbol::new(&s.env, "send"));
        }
        _ => panic!("the root is not the wrapper"),
    }
    let names: std::vec::Vec<(Address, Symbol)> = sub_invocations
        .iter()
        .map(|sub| match &sub.function {
            AuthorizedFunction::Contract((contract, name, _)) => (contract.clone(), name.clone()),
            _ => panic!("not a contract call"),
        })
        .collect();
    assert_eq!(
        names,
        std::vec![
            (s.token.clone(), Symbol::new(&s.env, "transfer")),
            (s.token.clone(), Symbol::new(&s.env, "transfer")),
            (s.oft.clone(), Symbol::new(&s.env, "send")),
        ]
    );
}

#[test]
fn no_fees_or_a_zero_fee_only_sends() {
    let s = setup();
    let (send_param, messaging) = params(&s.env, 10_0000000);
    s.wrapper
        .send(&s.holder, &Vec::new(&s.env), &send_param, &messaging, &s.holder);
    // A zero fee pays nothing, even to the holder.
    let zero = vec![&s.env, fee(&s.holder, 0)];
    s.wrapper
        .send(&s.holder, &zero, &send_param, &messaging, &s.holder);
    assert_eq!(TokenClient::new(&s.env, &s.token).balance(&s.oft), 20_0000000);
}

#[test]
fn refuses_a_negative_fee_a_fee_to_the_holder_and_too_many_fees() {
    let s = setup();
    let (send_param, messaging) = params(&s.env, 10_0000000);
    let negative = vec![&s.env, fee(&s.commission, -1)];
    assert!(s
        .wrapper
        .try_send(&s.holder, &negative, &send_param, &messaging, &s.holder)
        .is_err());
    let to_self = vec![&s.env, fee(&s.holder, 1)];
    assert!(s
        .wrapper
        .try_send(&s.holder, &to_self, &send_param, &messaging, &s.holder)
        .is_err());
    let mut many = Vec::new(&s.env);
    for _ in 0..5 {
        many.push_back(fee(&s.commission, 1));
    }
    assert!(s
        .wrapper
        .try_send(&s.holder, &many, &send_param, &messaging, &s.holder)
        .is_err());
}

#[test]
fn answers_the_oft_and_token_it_was_built_with() {
    let s = setup();
    assert_eq!(s.wrapper.oft(), s.oft);
    assert_eq!(s.wrapper.token(), s.token);
}

#[test]
fn needs_the_holders_authorization() {
    let env = Env::default();
    let issuer = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(issuer).address();
    let holder = Address::generate(&env);
    env.mock_all_auths();
    StellarAssetClient::new(&env, &token).mint(&holder, &1_0000000);
    let oft = env.register(MockOft, (token.clone(),));
    let wrapper = Usdt0FeeWrapperClient::new(
        &env,
        &env.register(Usdt0FeeWrapper, (oft.clone(), token.clone())),
    );
    // No authorization mocked from here on: the holder signed nothing.
    env.set_auths(&[]);
    let (send_param, messaging) = params(&env, 1);
    let fees = vec![&env, fee(&Address::generate(&env), 1)];
    assert!(wrapper
        .try_send(&holder, &fees, &send_param, &messaging, &holder)
        .is_err());
}
