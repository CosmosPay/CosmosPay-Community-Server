// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/**
 * cUSD: Cosmos Pay's test stablecoin, for the sandbox ONLY, on the test
 * networks where no official test USDC exists. It has no value and is never
 * deployed on a mainnet: `scripts/sandbox/deploy-cusd.ts` refuses any chain id
 * that is not a sandbox test network.
 *
 * A plain ERC-20 with 6 decimals (like USDC) and one minter, the deployer,
 * who mints to the sandbox treasury. No pause, no blocklist, no upgrade: a
 * test token has nothing to protect, and the less it does the less a payer's
 * wallet has to understand.
 */
contract SandboxUsd {
    string public constant name = "cUSD";
    string public constant symbol = "cUSD";
    uint8 public constant decimals = 6;

    address public immutable minter;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(address treasury, uint256 initialSupply) {
        minter = msg.sender;
        _mint(treasury, initialSupply);
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "cUSD: only the minter");
        _mint(to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "cUSD: allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        require(to != address(0), "cUSD: zero address");
        uint256 balance = balanceOf[from];
        require(balance >= amount, "cUSD: balance");
        unchecked {
            balanceOf[from] = balance - amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function _mint(address to, uint256 amount) private {
        require(to != address(0), "cUSD: zero address");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }
}
