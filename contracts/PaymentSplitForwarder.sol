// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

/// @title One payment intent's deposit address, with the organization's own fee.
///
/// PaymentForwarder with two more terms baked into the address: the wallet the
/// merchant fee goes to and its amount. Everything PaymentForwarder says about
/// the address holds here: it is deployed with CREATE2 through the
/// deterministic deployment proxy from a random salt and an init code that
/// embeds every term, so the address is the commitment, and nobody (Cosmos Pay
/// included) can deploy code at it that pays anyone else.
///
/// The constructor pays, in this order and only out of what arrived: the
/// relayer its fee, then the merchant fee to `feeWallet`, then everything else
/// to `destination`. A fee is paid only when the balance covers it whole. After
/// deployment the code only ever forwards to `destination`: the merchant fee is
/// charged once, on the payment the address was made for.
///
/// Sends in the constructor never revert, for PaymentForwarder's reason: a
/// receiver that refuses a transfer must not make the address undeployable and
/// lock the funds. Whatever could not be sent stays for `flush` / `flushToken`,
/// which pay `destination`.
contract PaymentSplitForwarder {
    /// The merchant: the account this contract pays, besides the relayer's fee
    /// and the merchant fee, each paid once in the constructor.
    address payable public immutable destination;

    event Forwarded(address indexed token, uint256 amount);
    event FeePaid(address indexed token, address indexed wallet, uint256 amount);

    /// @param destination_ The merchant's account.
    /// @param token        The ERC-20 the intent is paid in; zero for the native coin.
    /// @param relayer      Who deploys this, and is paid `fee` for it.
    /// @param fee          The relayer's fee, in `token` units (or wei).
    /// @param feeWallet    Where the merchant fee goes.
    /// @param merchantFee  The merchant fee, in `token` units (or wei).
    constructor(
        address payable destination_,
        address token,
        address payable relayer,
        uint256 fee,
        address payable feeWallet,
        uint256 merchantFee
    ) {
        destination = destination_;
        if (token == address(0)) {
            uint256 balance = address(this).balance;
            if (fee != 0 && balance >= fee && _sendNative(relayer, fee)) {
                balance -= fee;
            }
            if (
                merchantFee != 0 &&
                balance >= merchantFee &&
                _sendNative(feeWallet, merchantFee)
            ) {
                balance -= merchantFee;
                emit FeePaid(address(0), feeWallet, merchantFee);
            }
            if (balance != 0 && _sendNative(destination_, balance)) {
                emit Forwarded(address(0), balance);
            }
        } else {
            uint256 balance = _balanceOf(token);
            if (fee != 0 && balance >= fee && _sendToken(token, relayer, fee)) {
                balance -= fee;
            }
            if (
                merchantFee != 0 &&
                balance >= merchantFee &&
                _sendToken(token, feeWallet, merchantFee)
            ) {
                balance -= merchantFee;
                emit FeePaid(token, feeWallet, merchantFee);
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
