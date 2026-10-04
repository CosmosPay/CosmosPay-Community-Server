// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

/// @title One payment intent's deposit address.
///
/// The payer pays to the address this contract WILL have: it is deployed with
/// CREATE2 through the deterministic deployment proxy, from a random salt and
/// an init code that embeds the merchant (`destination`), the asset, the relayer
/// and the relayer's fee. Change any of them and the address changes — so the
/// address itself is the commitment, and nobody (Cosmos Pay included) can
/// deploy code at it that sends the money anywhere else.
///
/// Funds sit at the empty address until the relayer deploys the contract. The
/// constructor pays the relayer its fee (the gas it spent, deducted from the
/// payment) and forwards everything else to `destination`. After that the
/// deployed code only ever forwards to `destination`: native coin on receipt,
/// tokens when anyone calls `flushToken`.
///
/// Sends in the constructor never revert: a destination that refuses a
/// transfer must not make the address undeployable forever, which would lock
/// the funds in it. Whatever could not be sent stays here for `flush` /
/// `flushToken`, which do revert on failure.
contract PaymentForwarder {
    /// The merchant. The only account this contract ever pays, besides the
    /// relayer's one-time fee.
    address payable public immutable destination;

    event Forwarded(address indexed token, uint256 amount);

    /// @param destination_ The merchant's account.
    /// @param token        The ERC-20 the intent is paid in; zero for the native coin.
    /// @param relayer      Who deploys this, and is paid `fee` for it.
    /// @param fee          The relayer's fee, in `token` units (or wei); paid only
    ///                     when the deposit covers it.
    constructor(
        address payable destination_,
        address token,
        address payable relayer,
        uint256 fee
    ) {
        destination = destination_;
        if (token == address(0)) {
            uint256 balance = address(this).balance;
            if (fee != 0 && balance >= fee && _sendNative(relayer, fee)) {
                balance -= fee;
            }
            if (balance != 0 && _sendNative(destination_, balance)) {
                emit Forwarded(address(0), balance);
            }
        } else {
            uint256 balance = _balanceOf(token);
            if (fee != 0 && balance >= fee && _sendToken(token, relayer, fee)) {
                balance -= fee;
            }
            if (balance != 0 && _sendToken(token, destination_, balance)) {
                emit Forwarded(token, balance);
            }
            // Native coin sent to a token intent's address by mistake.
            uint256 stray = address(this).balance;
            if (stray != 0 && _sendNative(destination_, stray)) {
                emit Forwarded(address(0), stray);
            }
        }
    }

    /// A payment that arrives after deployment goes straight on, in the same
    /// transaction; if the destination refuses it, the payment reverts.
    receive() external payable {
        uint256 balance = address(this).balance;
        require(_sendNative(destination, balance), "forward failed");
        emit Forwarded(address(0), balance);
    }

    /// Forwards the native balance. Anyone may call it: it can only pay `destination`.
    function flush() external {
        uint256 balance = address(this).balance;
        require(_sendNative(destination, balance), "forward failed");
        emit Forwarded(address(0), balance);
    }

    /// Forwards a token balance. Anyone may call it: it can only pay `destination`.
    function flushToken(address token) external {
        uint256 balance = _balanceOf(token);
        require(_sendToken(token, destination, balance), "forward failed");
        emit Forwarded(token, balance);
    }

    function _sendNative(address payable to, uint256 amount) private returns (bool ok) {
        (ok, ) = to.call{value: amount}("");
    }

    /// `transfer(to, amount)`, accepting tokens that return nothing (USDT-style).
    function _sendToken(address token, address to, uint256 amount) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(
            abi.encodeWithSelector(0xa9059cbb, to, amount)
        );
        return ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (bool))));
    }

    /// `balanceOf(this)`, or zero for an address that does not answer it.
    function _balanceOf(address token) private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(
            abi.encodeWithSelector(0x70a08231, address(this))
        );
        return ok && ret.length == 32 ? abi.decode(ret, (uint256)) : 0;
    }
}
