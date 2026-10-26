extern crate std;

use crate::{MerchantFeeOft, MerchantFeeOftClient};
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation},
    token::{StellarAssetClient, TokenClient},
    Address, Env, IntoVal, Symbol, Val,
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
    fee_wallet: Address,
    token: Address,
    oft: Address,
    wrapper: MerchantFeeOftClient<'static>,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    let issuer = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(issuer).address();
    let holder = Address::generate(&env);
    let fee_wallet = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&holder, &1_000_0000000);
    let oft = env.register(MockOft, (token.clone(),));
    let wrapper_id = env.register(MerchantFeeOft, (oft.clone(), token.clone()));
    let wrapper = MerchantFeeOftClient::new(&env, &wrapper_id);
    Setup {
        env,
        holder,
        fee_wallet,
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

#[test]
fn pays_the_fee_then_sends_and_answers_the_oft_receipt() {
    let s = setup();
    let (send_param, fee) = params(&s.env, 100_0000000);
    let answer = s.wrapper.send(
        &s.holder,
        &s.fee_wallet,
        &2_5000000,
        &send_param,
        &fee,
        &s.holder,
    );
    let receipt: Receipt = soroban_sdk::FromVal::from_val(&s.env, &answer);
    assert_eq!(
        receipt,
        Receipt {
            guid: 42,
            amount_sent_ld: 100_0000000
        }
    );
    let balances = TokenClient::new(&s.env, &s.token);
    assert_eq!(balances.balance(&s.fee_wallet), 2_5000000);
    assert_eq!(balances.balance(&s.oft), 100_0000000);
    assert_eq!(balances.balance(&s.holder), 1_000_0000000 - 102_5000000);
    assert_eq!(balances.balance(&s.wrapper.address), 0);
}

#[test]
fn one_authorization_of_the_holder_covers_the_fee_and_the_send() {
    let s = setup();
    let (send_param, fee) = params(&s.env, 10_0000000);
    s.wrapper.send(&s.holder, &s.fee_wallet, &1_0000000, &send_param, &fee, &s.holder);
    let auths = s.env.auths();
    assert_eq!(auths.len(), 1);
    let (who, invocation) = &auths[0];
    assert_eq!(who, &s.holder);
    // The root is the wrapper's send; the token transfer and the OFT's send
    // (with its own transfer) hang under it.
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
            (s.oft.clone(), Symbol::new(&s.env, "send")),
        ]
    );
}

#[test]
fn a_zero_fee_only_sends() {
    let s = setup();
    let (send_param, fee) = params(&s.env, 10_0000000);
    s.wrapper.send(&s.holder, &s.fee_wallet, &0, &send_param, &fee, &s.holder);
    assert_eq!(TokenClient::new(&s.env, &s.token).balance(&s.fee_wallet), 0);
}

#[test]
fn refuses_a_negative_fee_and_a_fee_to_the_holder() {
    let s = setup();
    let (send_param, fee) = params(&s.env, 10_0000000);
    assert!(s
        .wrapper
        .try_send(&s.holder, &s.fee_wallet, &-1, &send_param, &fee, &s.holder)
        .is_err());
    assert!(s
        .wrapper
        .try_send(&s.holder, &s.holder, &1, &send_param, &fee, &s.holder)
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
    let wrapper = MerchantFeeOftClient::new(
        &env,
        &env.register(MerchantFeeOft, (oft.clone(), token.clone())),
    );
    // No authorization mocked from here on: the holder signed nothing.
    env.set_auths(&[]);
    let (send_param, fee) = params(&env, 1);
    assert!(wrapper
        .try_send(&holder, &Address::generate(&env), &1, &send_param, &fee, &holder)
        .is_err());
}
