//! Pays the fees on a USDT0 transfer (Cosmos Pay's plan commission and an
//! organization's merchant fee) and sends it through LayerZero's OFT, in the
//! one Soroban invocation a holder signs.
//!
//! A Soroban transaction carries one operation, and the USDT0 transfer is that
//! operation (`send` on the OFT), so a fee has no room of its own. This
//! contract is the operation instead: `send` takes each fee from `from` in the
//! USDT0 token and pays it to its wallet, then calls the OFT's own `send` with
//! the same arguments and answers what it answers (the messaging and OFT
//! receipts, so the transfer is tracked by the same guid).
//!
//! `from` authorizes this call; the simulation records each token transfer and
//! the OFT's `send` (with everything it requires of `from`) as sub-invocations
//! of it, so one source-account signature covers the whole tree. The contract
//! is fixed at construction to one OFT and one token, calls nothing else, and
//! holds nothing: it never receives the fees or the tokens being sent.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, token, Address, Env,
    IntoVal, Symbol, Val, Vec,
};

/// The most fees one transfer pays: the plan commission and a merchant fee,
/// with room to spare; a bound so a call cannot grow without limit.
const MAX_FEES: u32 = 4;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Oft,
    Token,
}

/// One fee: `amount` of the token from the holder to `wallet`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Fee {
    pub wallet: Address,
    pub amount: i128,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// A fee below zero.
    NegativeFee = 1,
    /// A fee's wallet is the account the fee comes from.
    FeeToSelf = 2,
    /// More fees than [`MAX_FEES`].
    TooManyFees = 3,
}

#[contract]
pub struct Usdt0FeeWrapper;

#[contractimpl]
impl Usdt0FeeWrapper {
    /// Fixes the OFT this contract sends through and the token its fees are paid in.
    pub fn __constructor(env: Env, oft: Address, token: Address) {
        env.storage().instance().set(&DataKey::Oft, &oft);
        env.storage().instance().set(&DataKey::Token, &token);
    }

    /// The OFT every `send` goes through.
    pub fn oft(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Oft).unwrap()
    }

    /// The token the fees are paid in (USDT0's Stellar Asset Contract).
    pub fn token(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Token).unwrap()
    }

    /// Pays each fee of the token from `from` to its wallet, then calls the
    /// OFT's `send(from, send_param, messaging_fee, refund_address)` and
    /// answers its return value. `send_param` and `messaging_fee` are passed
    /// through as the OFT defines them. A fee of zero pays nothing.
    pub fn send(
        env: Env,
        from: Address,
        fees: Vec<Fee>,
        send_param: Val,
        messaging_fee: Val,
        refund_address: Address,
    ) -> Val {
        from.require_auth();
        if fees.len() > MAX_FEES {
            panic_with_error!(&env, Error::TooManyFees);
        }
        let token = token::Client::new(&env, &Self::token(env.clone()));
        for fee in fees.iter() {
            if fee.amount < 0 {
                panic_with_error!(&env, Error::NegativeFee);
            }
            if fee.amount == 0 {
                continue;
            }
            if fee.wallet == from {
                panic_with_error!(&env, Error::FeeToSelf);
            }
            token.transfer(&from, &fee.wallet, &fee.amount);
        }
        let args: Vec<Val> = (from, send_param, messaging_fee, refund_address).into_val(&env);
        env.invoke_contract::<Val>(&Self::oft(env.clone()), &Symbol::new(&env, "send"), args)
    }
}

#[cfg(test)]
mod test;
