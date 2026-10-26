//! Pays an organization's merchant fee and sends USDT0 through LayerZero's OFT,
//! in the one Soroban invocation a holder signs.
//!
//! A Soroban transaction carries one operation, and the USDT0 transfer is that
//! operation (`send` on the OFT), so a merchant fee has no room of its own. This
//! contract is the operation instead: `send` takes the fee from `from` in the
//! USDT0 token, pays it to `fee_wallet`, then calls the OFT's own `send` with
//! the same arguments and answers what it answers (the messaging and OFT
//! receipts, so the transfer is tracked by the same guid).
//!
//! `from` authorizes this call; the simulation records the token transfer and
//! the OFT's `send` (with everything it requires of `from`) as sub-invocations
//! of it, so one source-account signature covers the whole tree. The contract
//! is fixed at construction to one OFT and one token, calls nothing else, and
//! holds nothing: it never receives the fee or the tokens being sent.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, token, Address, Env,
    IntoVal, Symbol, Val, Vec,
};

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Oft,
    Token,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// A fee below zero.
    NegativeFee = 1,
    /// The fee's wallet is the account the fee comes from.
    FeeToSelf = 2,
}

#[contract]
pub struct MerchantFeeOft;

#[contractimpl]
impl MerchantFeeOft {
    /// Fixes the OFT this contract sends through and the token its fee is paid in.
    pub fn __constructor(env: Env, oft: Address, token: Address) {
        env.storage().instance().set(&DataKey::Oft, &oft);
        env.storage().instance().set(&DataKey::Token, &token);
    }

    /// The OFT every `send` goes through.
    pub fn oft(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Oft).unwrap()
    }

    /// The token the merchant fee is paid in (USDT0's Stellar Asset Contract).
    pub fn token(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Token).unwrap()
    }

    /// Pays `fee` of the token from `from` to `fee_wallet`, then calls the OFT's
    /// `send(from, send_param, messaging_fee, refund_address)` and answers its
    /// return value. `send_param` and `messaging_fee` are passed through as the
    /// OFT defines them.
    pub fn send(
        env: Env,
        from: Address,
        fee_wallet: Address,
        fee: i128,
        send_param: Val,
        messaging_fee: Val,
        refund_address: Address,
    ) -> Val {
        from.require_auth();
        if fee < 0 {
            panic_with_error!(&env, Error::NegativeFee);
        }
        if fee > 0 {
            if fee_wallet == from {
                panic_with_error!(&env, Error::FeeToSelf);
            }
            token::Client::new(&env, &Self::token(env.clone())).transfer(&from, &fee_wallet, &fee);
        }
        let args: Vec<Val> = (from, send_param, messaging_fee, refund_address).into_val(&env);
        env.invoke_contract::<Val>(&Self::oft(env.clone()), &Symbol::new(&env, "send"), args)
    }
}

#[cfg(test)]
mod test;
