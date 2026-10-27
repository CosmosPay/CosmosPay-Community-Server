// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/**
 * @title MerchantFeeSwapRouter
 * @notice Pays an organization's merchant fee and swaps through one aggregator
 *         (Kuru Flow on Monad), in the one transaction the swapper signs.
 *
 * Kuru Flow pays a single referrer fee per swap and Cosmos Pay's plan
 * commission takes it, so a merchant's own fee needs a payment the aggregator
 * cannot make. The swap is quoted for THIS contract as the user, so the
 * aggregator takes its input from here and pays its output here; this contract:
 *
 *   1. takes `amountIn + fee` of `tokenIn` from the caller (the native value
 *      sent, or an ERC-20 the caller approved to this contract);
 *   2. pays `fee` to `feeWallet`;
 *   3. lets `aggregator` (fixed at deployment) spend exactly `amountIn` and
 *      runs the aggregator's calldata, bubbling up its revert;
 *   4. forwards everything of `tokenOut` it holds to `recipient`, and refunds
 *      to the caller whatever of `tokenIn` the aggregator left;
 *   5. reverts unless `recipient` gained at least `minOut` of `tokenOut`.
 *
 * It calls nothing but `aggregator` and the two tokens, pulls only from the
 * caller, leaves no allowance behind and holds nothing between transactions.
 * `address(0)` is native MON on either side.
 */
contract MerchantFeeSwapRouter {
    /// @notice The only contract this router calls with swap calldata.
    address public immutable aggregator;

    address private constant NATIVE = address(0);
    uint256 private locked = 1;

    error Reentrant();
    error SameToken();
    error WrongValue(uint256 sent, uint256 expected);
    error NoFeeWallet();
    error TokenCallFailed(address token);
    error NativeTransferFailed(address to);
    error InsufficientOutput(uint256 received, uint256 minOut);

    /// @dev The tokens and `amountIn` are in the transaction's own input.
    event MerchantFeeSwap(
        address indexed payer,
        address indexed feeWallet,
        uint256 fee,
        uint256 amountOut
    );

    constructor(address aggregator_) {
        aggregator = aggregator_;
    }

    /// @dev The aggregator pays native output here before it is forwarded.
    receive() external payable {}

    /**
     * @notice Pays `fee` of `tokenIn` to `feeWallet`, swaps `amountIn` of it
     *         through the aggregator with `data`, and sends the output to
     *         `recipient`, who must gain at least `minOut`.
     * @return amountOut What `recipient` gained of `tokenOut`.
     */
    function swap(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 minOut,
        address feeWallet,
        uint256 fee,
        address recipient,
        bytes calldata data
    ) external payable returns (uint256 amountOut) {
        if (locked != 1) revert Reentrant();
        locked = 2;
        if (tokenIn == tokenOut) revert SameToken();
        if (fee > 0 && feeWallet == address(0)) revert NoFeeWallet();

        uint256 recipientBefore = _balanceOf(tokenOut, recipient);
        _payAndSwap(tokenIn, amountIn, feeWallet, fee, data);
        amountOut = _deliver(tokenIn, tokenOut, recipient, recipientBefore);
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);

        emit MerchantFeeSwap(msg.sender, feeWallet, fee, amountOut);
        locked = 1;
    }

    /// @dev Steps 1 to 3: take the input, pay the fee, run the aggregator.
    function _payAndSwap(
        address tokenIn,
        uint256 amountIn,
        address feeWallet,
        uint256 fee,
        bytes calldata data
    ) private {
        if (tokenIn == NATIVE) {
            if (msg.value != amountIn + fee) {
                revert WrongValue(msg.value, amountIn + fee);
            }
            if (fee > 0) _sendNative(feeWallet, fee);
            _callAggregator(amountIn, data);
            return;
        }
        if (msg.value != 0) revert WrongValue(msg.value, 0);
        _tokenCall(
            tokenIn,
            abi.encodeWithSelector(
                0x23b872dd, // transferFrom(address,address,uint256)
                msg.sender,
                address(this),
                amountIn + fee
            )
        );
        if (fee > 0) _send(tokenIn, feeWallet, fee);
        _approve(tokenIn, amountIn);
        _callAggregator(0, data);
        _approve(tokenIn, 0);
    }

    /**
     * @dev Step 4: everything the swap paid this contract goes on to the
     *      recipient, and what the aggregator did not take of the input goes
     *      back to the caller. Answers what the recipient gained.
     */
    function _deliver(
        address tokenIn,
        address tokenOut,
        address recipient,
        uint256 recipientBefore
    ) private returns (uint256) {
        uint256 held = _balanceOf(tokenOut, address(this));
        if (held > 0) _send(tokenOut, recipient, held);
        uint256 left = _balanceOf(tokenIn, address(this));
        if (left > 0) _send(tokenIn, msg.sender, left);
        return _balanceOf(tokenOut, recipient) - recipientBefore;
    }

    function _callAggregator(uint256 value, bytes calldata data) private {
        (bool ok, bytes memory reason) = aggregator.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }
    }

    function _balanceOf(
        address token,
        address owner
    ) private view returns (uint256) {
        if (token == NATIVE) return owner.balance;
        (bool ok, bytes memory answer) = token.staticcall(
            abi.encodeWithSelector(0x70a08231, owner) // balanceOf(address)
        );
        if (!ok || answer.length < 32) revert TokenCallFailed(token);
        return abi.decode(answer, (uint256));
    }

    function _send(address token, address to, uint256 amount) private {
        if (token == NATIVE) {
            _sendNative(to, amount);
        } else {
            _tokenCall(
                token,
                abi.encodeWithSelector(0xa9059cbb, to, amount) // transfer(address,uint256)
            );
        }
    }

    function _approve(address token, uint256 amount) private {
        _tokenCall(
            token,
            abi.encodeWithSelector(0x095ea7b3, aggregator, amount) // approve(address,uint256)
        );
    }

    function _sendNative(address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed(to);
    }

    /// @dev Accepts tokens that return nothing as well as those that return true.
    function _tokenCall(address token, bytes memory call) private {
        (bool ok, bytes memory answer) = token.call(call);
        if (
            !ok ||
            (answer.length > 0 && !abi.decode(answer, (bool))) ||
            token.code.length == 0
        ) {
            revert TokenCallFailed(token);
        }
    }
}
