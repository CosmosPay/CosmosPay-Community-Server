// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/**
 * @title P2PTestToken
 * @notice A test-only ERC-20 with the misbehaviours P2PMarket must survive:
 *         an issuer blocklist (USDC-style), a fee on transfer, transfers that
 *         return nothing (USDT-style) and a hook that calls back into the
 *         market in the middle of a transfer. Never deployed anywhere.
 */
contract P2PTestToken {
    string public constant name = "P2P Test Dollar";
    string public constant symbol = "tUSD";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;
    uint16 public feeBps;
    bool public noReturn;

    address public hookTarget;
    bytes public hookData;
    bool public hookRan;
    bool public hookOk;
    bytes public hookResult;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setBlocked(address account, bool value) external {
        blocked[account] = value;
    }

    function setFeeBps(uint16 bps) external {
        feeBps = bps;
    }

    function setNoReturn(bool value) external {
        noReturn = value;
    }

    /// The next transfer calls `target` with `data` once, recording the outcome.
    function setHook(address target, bytes calldata data) external {
        hookTarget = target;
        hookData = data;
        hookRan = false;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return _answer();
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return _answer();
    }

    function _move(address from, address to, uint256 amount) private {
        require(!blocked[from] && !blocked[to], "blocked");
        require(balanceOf[from] >= amount, "balance");
        uint256 fee = (amount * feeBps) / 10_000;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        emit Transfer(from, to, amount - fee);
        if (hookTarget != address(0) && !hookRan) {
            hookRan = true;
            (hookOk, hookResult) = hookTarget.call(hookData);
        }
    }

    function _answer() private view returns (bool) {
        if (noReturn) {
            assembly {
                return(0, 0)
            }
        }
        return true;
    }
}
