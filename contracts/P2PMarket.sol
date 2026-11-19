// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/**
 * @title P2PMarket
 * @notice Peer-to-peer trades of a stablecoin against a local-money transfer
 *         (a bank transfer, PIX, a CVU alias...) that happens off-chain.
 *
 * Every trade is one order between a SELLER, whose tokens the order locks and
 * who receives the local money, and a BUYER, who sends the local money and
 * receives the tokens. The contract never learns whether the local money
 * arrived: the party that receives it says so. So:
 *
 *   - only the seller (or a bot it delegated) RELEASES the tokens to the buyer;
 *   - the buyer MARKS the order paid once it sent the money, and from then on
 *     the seller can no longer take the tokens back on its own;
 *   - a disagreement is DISPUTED and the ARBITER splits the order, paying only
 *     the order's own buyer and seller;
 *   - an order nobody acted on in time can be CANCELLED by anyone, which always
 *     returns the tokens to the seller.
 *
 * An order may also carry a SETTLE window, which turns silence into consent:
 * once the buyer marked it paid and the window passed with no dispute, anyone
 * may release it. Only the seller can agree to that (it opens the order
 * itself, or authorised the matcher for it), because it is the seller's money.
 *
 * An order may require a BOND from the buyer, locked from the buyer's balance
 * when it accepts the order. The bond goes back to the buyer when the order
 * ends, except the part an arbiter's resolution gives the seller.
 *
 * Balances. Anyone may deposit an allowed token and hold it here as a free
 * balance: liquidity providers keep the tokens their buy orders lock, payers
 * keep the tokens their payouts lock, buyers keep their bonds. Only the owner
 * of a balance, or an operator it gave the WITHDRAW permission, moves it out,
 * and always to the owner's own address.
 *
 * Who may open an order on a seller's balance:
 *   - the seller;
 *   - an operator the seller gave the OPEN permission;
 *   - a MATCHER the seller authorised, up to a per-order maximum and with no
 *     settle window unless the seller allowed one. A matcher-opened order lets
 *     the matcher act for the buyer (mark paid, cancel before it is paid,
 *     dispute), so a buyer without gas can trade through the matching service.
 * Anyone may instead open an order that locks tokens it sends in the same call
 * (`openWithDeposit`), as its own seller.
 *
 * Fees. On every payment to a buyer the contract takes the protocol fee and
 * the integrator fee recorded on the order when it was opened, both out of the
 * tokens the buyer receives. Nothing is taken from refunds to the seller.
 *
 * The owner sets the protocol fee (capped), the treasury, the arbiter and the
 * allowed tokens, and may pause new deposits, orders and acceptances. It can
 * never move a balance or an order's tokens, and a pause never blocks a
 * withdrawal, a release, a cancellation, a dispute or a resolution.
 *
 * A payment that cannot be pushed to its recipient (a token that refuses that
 * address, say) is credited to the recipient's balance instead, so one
 * recipient can never freeze an order.
 *
 * Only plain ERC-20 tokens: a deposit that arrives short (fee-on-transfer) is
 * refused, and the owner should never allow a rebasing token.
 */
contract P2PMarket {
    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    enum Status {
        None,
        Offered, // waiting for the buyer to accept and lock its bond
        Active, // the buyer may send the local money
        Paid, // the buyer said it sent the money
        Disputed, // waiting for the arbiter
        Released, // the buyer was paid
        Cancelled, // the seller got its tokens back
        Resolved // the arbiter split it
    }

    struct Order {
        address seller;
        uint40 acceptDeadline;
        uint40 paymentDeadline;
        Status status;
        bool fromBalance;
        address buyer;
        uint40 paidAt;
        uint32 paymentWindow;
        uint16 feeBps;
        bool viaMatcher;
        address token;
        uint32 settleWindow;
        uint16 integratorFeeBps;
        address opener;
        address integrator;
        uint128 amount;
        uint128 bond;
        bytes32 ref;
    }

    struct OpenParams {
        /// Caller's own reference, unique per opener (the API's order id).
        bytes32 ref;
        address seller;
        address buyer;
        address token;
        uint128 amount;
        /// Locked from the buyer's balance when it accepts; 0 = no acceptance step.
        uint128 bond;
        /// Seconds the buyer has to accept. Must be 0 when there is no bond.
        uint32 acceptWindow;
        /// Seconds the buyer has to send the money and mark the order paid.
        uint32 paymentWindow;
        /// 0, or seconds after "paid" with no dispute after which anyone may release.
        uint32 settleWindow;
        /// Receives `integratorFeeBps` of every payment to the buyer; 0 = none.
        address integrator;
        uint16 integratorFeeBps;
    }

    struct MatcherTerms {
        uint128 maxPerOrder;
        bool autoSettle;
    }

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------

    uint16 public constant MAX_PROTOCOL_FEE_BPS = 300;
    uint16 public constant MAX_INTEGRATOR_FEE_BPS = 500;
    uint32 public constant MIN_PAYMENT_WINDOW = 5 minutes;
    uint32 public constant MAX_PAYMENT_WINDOW = 2 days;
    uint32 public constant MIN_ACCEPT_WINDOW = 1 minutes;
    uint32 public constant MAX_ACCEPT_WINDOW = 1 days;
    uint32 public constant MIN_SETTLE_WINDOW = 1 hours;
    uint32 public constant MAX_SETTLE_WINDOW = 14 days;

    /// Operator permissions, a bitmask per (account, operator).
    uint8 public constant PERM_OPEN = 1; // open orders on the account's balance
    uint8 public constant PERM_RELEASE = 2; // release the account's orders (pays their buyer)
    uint8 public constant PERM_TRADE = 4; // accept, mark paid, cancel, dispute for the account
    uint8 public constant PERM_WITHDRAW = 8; // withdraw the account's balance to the account
    uint8 private constant PERM_ALL = 15;

    uint256 private constant BPS = 10_000;

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    address public owner;
    address public pendingOwner;
    address public treasury;
    address public arbiter;
    uint16 public protocolFeeBps;
    bool public paused;

    uint256 public nextOrderId = 1;

    mapping(address token => bool) public tokenAllowed;
    mapping(address account => mapping(address token => uint256)) private balances;
    mapping(address account => mapping(address operator => uint8)) private permissions;
    mapping(address seller => mapping(address matcher => MatcherTerms)) private matchers;
    mapping(uint256 id => Order) private orders;
    mapping(bytes32 openerRef => uint256 id) private idByRef;

    uint256 private locked = 1;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event Deposited(address indexed account, address indexed token, uint256 amount);
    event Withdrawn(address indexed account, address indexed token, uint256 amount);
    event Credited(address indexed account, address indexed token, uint256 amount);
    event OperatorSet(address indexed account, address indexed operator, uint8 permissions);
    event MatcherSet(address indexed seller, address indexed matcher, uint128 maxPerOrder, bool autoSettle);

    event OrderOpened(
        uint256 indexed id,
        address indexed opener,
        bytes32 indexed ref,
        address seller,
        address buyer,
        address token,
        uint128 amount,
        uint128 bond,
        bool viaMatcher
    );
    event OrderAccepted(uint256 indexed id, uint40 paymentDeadline);
    event OrderPaid(uint256 indexed id, address by);
    event OrderReleased(uint256 indexed id, address by, uint256 toBuyer, uint256 protocolFee, uint256 integratorFee);
    event OrderCancelled(uint256 indexed id, address by);
    event OrderDisputed(uint256 indexed id, address by);
    event OrderResolved(
        uint256 indexed id,
        uint256 toBuyer,
        uint256 toSeller,
        uint256 bondToSeller,
        uint256 protocolFee,
        uint256 integratorFee
    );

    event ProtocolFeeSet(uint16 bps);
    event TreasurySet(address treasury);
    event ArbiterSet(address arbiter);
    event TokenSet(address indexed token, bool allowed);
    event PausedSet(bool paused);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error Reentrant();
    error NotOwner();
    error NotPendingOwner();
    error NotArbiter();
    error NotAuthorized();
    error IsPaused();
    error ZeroAddress();
    error ZeroAmount();
    error TokenNotAllowed(address token);
    error FeeTooHigh();
    error BadWindow();
    error BadIntegrator();
    error SameParty();
    error RefTaken(bytes32 ref);
    error EmptyRef();
    error InsufficientBalance(uint256 available, uint256 needed);
    error ShortDeposit(uint256 received, uint256 expected);
    error TokenCallFailed(address token);
    error UnknownOrder(uint256 id);
    error WrongStatus(Status status);
    error Expired();
    error NotYet();
    error BadSplit();
    error InvalidPermissions();

    // ------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------

    modifier nonReentrant() {
        if (locked != 1) revert Reentrant();
        locked = 2;
        _;
        locked = 1;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert IsPaused();
        _;
    }

    // ------------------------------------------------------------------
    // Construction and administration
    // ------------------------------------------------------------------

    constructor(address owner_, address treasury_, address arbiter_, uint16 protocolFeeBps_) {
        if (owner_ == address(0) || treasury_ == address(0) || arbiter_ == address(0)) revert ZeroAddress();
        if (protocolFeeBps_ > MAX_PROTOCOL_FEE_BPS) revert FeeTooHigh();
        owner = owner_;
        treasury = treasury_;
        arbiter = arbiter_;
        protocolFeeBps = protocolFeeBps_;
        emit OwnershipTransferred(address(0), owner_);
        emit TreasurySet(treasury_);
        emit ArbiterSet(arbiter_);
        emit ProtocolFeeSet(protocolFeeBps_);
    }

    /// @notice Applies to orders opened from now on; open orders keep theirs.
    function setProtocolFee(uint16 bps) external onlyOwner {
        if (bps > MAX_PROTOCOL_FEE_BPS) revert FeeTooHigh();
        protocolFeeBps = bps;
        emit ProtocolFeeSet(bps);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function setArbiter(address arbiter_) external onlyOwner {
        if (arbiter_ == address(0)) revert ZeroAddress();
        arbiter = arbiter_;
        emit ArbiterSet(arbiter_);
    }

    /// @notice A disallowed token can still be withdrawn, released, cancelled and resolved.
    function setToken(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        tokenAllowed[token] = allowed;
        emit TokenSet(token, allowed);
    }

    /// @notice Stops deposits, new orders and acceptances; never stops money from leaving.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ------------------------------------------------------------------
    // Balances, operators and matchers
    // ------------------------------------------------------------------

    function deposit(address token, uint256 amount) external nonReentrant whenNotPaused {
        if (!tokenAllowed[token]) revert TokenNotAllowed(token);
        if (amount == 0) revert ZeroAmount();
        _pull(token, msg.sender, amount);
        balances[msg.sender][token] += amount;
        emit Deposited(msg.sender, token, amount);
    }

    /// @notice Withdraws the caller's balance to the caller.
    function withdraw(address token, uint256 amount) external nonReentrant {
        _withdraw(msg.sender, token, amount);
    }

    /// @notice An operator with PERM_WITHDRAW withdraws `account`'s balance to `account`.
    function withdrawFor(address account, address token, uint256 amount) external nonReentrant {
        if (!_can(account, PERM_WITHDRAW)) revert NotAuthorized();
        _withdraw(account, token, amount);
    }

    /// @notice Grants `operator` the permission bits in `perms` over the caller; 0 revokes.
    function setOperator(address operator, uint8 perms) external {
        if (operator == address(0)) revert ZeroAddress();
        if (operator == msg.sender) revert SameParty();
        if (perms & ~PERM_ALL != 0) revert InvalidPermissions();
        permissions[msg.sender][operator] = perms;
        emit OperatorSet(msg.sender, operator, perms);
    }

    /**
     * @notice Lets `matcher` open orders on the caller's balance, each at most
     *         `maxPerOrder`; 0 revokes. `autoSettle` also lets it give those
     *         orders a settle window. Revoking never touches open orders.
     */
    function setMatcher(address matcher, uint128 maxPerOrder, bool autoSettle) external {
        if (matcher == address(0)) revert ZeroAddress();
        if (matcher == msg.sender) revert SameParty();
        matchers[msg.sender][matcher] = MatcherTerms(maxPerOrder, maxPerOrder != 0 && autoSettle);
        emit MatcherSet(msg.sender, matcher, maxPerOrder, maxPerOrder != 0 && autoSettle);
    }

    // ------------------------------------------------------------------
    // Opening orders
    // ------------------------------------------------------------------

    /// @notice Opens an order that locks `p.amount` of the seller's balance.
    function open(OpenParams calldata p) external nonReentrant whenNotPaused returns (uint256 id) {
        bool viaMatcher = _authorizeOpen(p);
        uint256 available = balances[p.seller][p.token];
        if (available < p.amount) revert InsufficientBalance(available, p.amount);
        balances[p.seller][p.token] = available - p.amount;
        id = _create(p, true, viaMatcher);
    }

    /// @notice Opens an order that locks tokens the caller (the seller) sends now.
    function openWithDeposit(OpenParams calldata p) external nonReentrant whenNotPaused returns (uint256 id) {
        if (msg.sender != p.seller) revert NotAuthorized();
        _validate(p);
        _pull(p.token, msg.sender, p.amount);
        id = _create(p, false, false);
    }

    // ------------------------------------------------------------------
    // Order lifecycle
    // ------------------------------------------------------------------

    /// @notice The buyer accepts an order that needs a bond, locking the bond from its balance.
    function accept(uint256 id) external nonReentrant whenNotPaused {
        Order storage o = _order(id);
        if (o.status != Status.Offered) revert WrongStatus(o.status);
        if (block.timestamp > o.acceptDeadline) revert Expired();
        if (!_can(o.buyer, PERM_TRADE)) revert NotAuthorized();
        uint256 available = balances[o.buyer][o.token];
        if (available < o.bond) revert InsufficientBalance(available, o.bond);
        balances[o.buyer][o.token] = available - o.bond;
        o.status = Status.Active;
        o.paymentDeadline = uint40(block.timestamp + o.paymentWindow);
        emit OrderAccepted(id, o.paymentDeadline);
    }

    /// @notice The buyer says it sent the local money.
    function markPaid(uint256 id) external nonReentrant {
        Order storage o = _order(id);
        if (o.status != Status.Active) revert WrongStatus(o.status);
        if (block.timestamp > o.paymentDeadline) revert Expired();
        if (!_actsForBuyer(o)) revert NotAuthorized();
        o.status = Status.Paid;
        o.paidAt = uint40(block.timestamp);
        emit OrderPaid(id, msg.sender);
    }

    /// @notice The seller confirms it received the money: the buyer is paid.
    function release(uint256 id) external nonReentrant {
        Order storage o = _order(id);
        if (o.status != Status.Active && o.status != Status.Paid) revert WrongStatus(o.status);
        if (!_can(o.seller, PERM_RELEASE)) revert NotAuthorized();
        _release(id, o);
    }

    /// @notice Anyone releases a paid order whose settle window passed with no dispute.
    function settle(uint256 id) external nonReentrant {
        Order storage o = _order(id);
        if (o.status != Status.Paid) revert WrongStatus(o.status);
        if (o.settleWindow == 0 || block.timestamp < uint256(o.paidAt) + o.settleWindow) revert NotYet();
        _release(id, o);
    }

    /**
     * @notice Returns the tokens to the seller.
     *  - Offered: the seller's side or the buyer's side at any time; anyone after the accept deadline.
     *  - Active: the buyer's side at any time; anyone after the payment deadline.
     *  - Paid: only the buyer itself or its operator (it gives up a payment it reported).
     */
    function cancel(uint256 id) external nonReentrant {
        Order storage o = _order(id);
        Status s = o.status;
        bool allowed;
        if (s == Status.Offered) {
            allowed = block.timestamp > o.acceptDeadline || _actsForBuyer(o) || _actsForSeller(o);
        } else if (s == Status.Active) {
            allowed = block.timestamp > o.paymentDeadline || _actsForBuyer(o);
        } else if (s == Status.Paid) {
            allowed = _can(o.buyer, PERM_TRADE);
        } else {
            revert WrongStatus(s);
        }
        if (!allowed) revert NotAuthorized();

        o.status = Status.Cancelled;
        _refundSeller(o, o.amount);
        if (s != Status.Offered && o.bond != 0) _credit(o.buyer, o.token, o.bond);
        emit OrderCancelled(id, msg.sender);
    }

    /**
     * @notice Either side contests a paid order. With a settle window, the
     *         seller's side must do it before the window ends.
     */
    function dispute(uint256 id) external nonReentrant {
        Order storage o = _order(id);
        if (o.status != Status.Paid) revert WrongStatus(o.status);
        if (_actsForBuyer(o)) {
            // the buyer's side may always escalate a payment the seller ignores
        } else if (_actsForSeller(o)) {
            if (o.settleWindow != 0 && block.timestamp >= uint256(o.paidAt) + o.settleWindow) revert Expired();
        } else {
            revert NotAuthorized();
        }
        o.status = Status.Disputed;
        emit OrderDisputed(id, msg.sender);
    }

    /**
     * @notice The arbiter ends a disputed order: `toBuyer` of the amount goes to
     *         the buyer (fees taken from it), the rest back to the seller, and
     *         `bondToSeller` of the buyer's bond goes to the seller.
     */
    function resolve(uint256 id, uint128 toBuyer, uint128 bondToSeller) external nonReentrant {
        if (msg.sender != arbiter) revert NotArbiter();
        Order storage o = _order(id);
        if (o.status != Status.Disputed) revert WrongStatus(o.status);
        if (toBuyer > o.amount || bondToSeller > o.bond) revert BadSplit();

        o.status = Status.Resolved;
        (uint256 protocolFee, uint256 integratorFee) = toBuyer == 0 ? (0, 0) : _payBuyer(o, toBuyer);
        uint256 toSeller = o.amount - toBuyer;
        if (toSeller != 0) _refundSeller(o, toSeller);
        if (bondToSeller != 0) _push(o.token, o.seller, bondToSeller);
        if (o.bond != bondToSeller) _credit(o.buyer, o.token, o.bond - bondToSeller);
        emit OrderResolved(id, toBuyer, toSeller, bondToSeller, protocolFee, integratorFee);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function getOrder(uint256 id) external view returns (Order memory) {
        return orders[id];
    }

    /// @notice The order `opener` opened with `ref`, or 0.
    function orderIdOf(address opener, bytes32 ref) external view returns (uint256) {
        return idByRef[_refKey(opener, ref)];
    }

    function balanceOf(address account, address token) external view returns (uint256) {
        return balances[account][token];
    }

    function permissionsOf(address account, address operator) external view returns (uint8) {
        return permissions[account][operator];
    }

    function matcherTermsOf(address seller, address matcher) external view returns (MatcherTerms memory) {
        return matchers[seller][matcher];
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _authorizeOpen(OpenParams calldata p) private view returns (bool viaMatcher) {
        _validate(p);
        if (msg.sender == p.seller || permissions[p.seller][msg.sender] & PERM_OPEN != 0) return false;
        MatcherTerms memory t = matchers[p.seller][msg.sender];
        if (t.maxPerOrder == 0 || p.amount > t.maxPerOrder) revert NotAuthorized();
        if (p.settleWindow != 0 && !t.autoSettle) revert NotAuthorized();
        return true;
    }

    function _validate(OpenParams calldata p) private view {
        if (p.ref == bytes32(0)) revert EmptyRef();
        if (p.seller == address(0) || p.buyer == address(0)) revert ZeroAddress();
        if (p.seller == p.buyer) revert SameParty();
        if (!tokenAllowed[p.token]) revert TokenNotAllowed(p.token);
        if (p.amount == 0) revert ZeroAmount();
        if (p.paymentWindow < MIN_PAYMENT_WINDOW || p.paymentWindow > MAX_PAYMENT_WINDOW) revert BadWindow();
        if (p.bond == 0) {
            if (p.acceptWindow != 0) revert BadWindow();
        } else if (p.acceptWindow < MIN_ACCEPT_WINDOW || p.acceptWindow > MAX_ACCEPT_WINDOW) {
            revert BadWindow();
        }
        if (p.settleWindow != 0 && (p.settleWindow < MIN_SETTLE_WINDOW || p.settleWindow > MAX_SETTLE_WINDOW)) {
            revert BadWindow();
        }
        if ((p.integrator == address(0)) != (p.integratorFeeBps == 0)) revert BadIntegrator();
        if (p.integratorFeeBps > MAX_INTEGRATOR_FEE_BPS) revert FeeTooHigh();
        if (idByRef[_refKey(msg.sender, p.ref)] != 0) revert RefTaken(p.ref);
    }

    function _create(OpenParams calldata p, bool fromBalance, bool viaMatcher) private returns (uint256 id) {
        id = nextOrderId++;
        idByRef[_refKey(msg.sender, p.ref)] = id;
        bool bonded = p.bond != 0;
        orders[id] = Order({
            seller: p.seller,
            acceptDeadline: bonded ? uint40(block.timestamp + p.acceptWindow) : 0,
            paymentDeadline: bonded ? 0 : uint40(block.timestamp + p.paymentWindow),
            status: bonded ? Status.Offered : Status.Active,
            fromBalance: fromBalance,
            buyer: p.buyer,
            paidAt: 0,
            paymentWindow: p.paymentWindow,
            feeBps: protocolFeeBps,
            viaMatcher: viaMatcher,
            token: p.token,
            settleWindow: p.settleWindow,
            integratorFeeBps: p.integratorFeeBps,
            opener: msg.sender,
            integrator: p.integrator,
            amount: p.amount,
            bond: p.bond,
            ref: p.ref
        });
        emit OrderOpened(id, msg.sender, p.ref, p.seller, p.buyer, p.token, p.amount, p.bond, viaMatcher);
        if (!bonded) emit OrderAccepted(id, uint40(block.timestamp + p.paymentWindow));
    }

    function _release(uint256 id, Order storage o) private {
        o.status = Status.Released;
        (uint256 protocolFee, uint256 integratorFee) = _payBuyer(o, o.amount);
        if (o.bond != 0) _credit(o.buyer, o.token, o.bond);
        emit OrderReleased(id, msg.sender, o.amount - protocolFee - integratorFee, protocolFee, integratorFee);
    }

    function _payBuyer(Order storage o, uint256 gross) private returns (uint256 protocolFee, uint256 integratorFee) {
        protocolFee = (gross * o.feeBps) / BPS;
        integratorFee = (gross * o.integratorFeeBps) / BPS;
        if (protocolFee != 0) _push(o.token, treasury, protocolFee);
        if (integratorFee != 0) _push(o.token, o.integrator, integratorFee);
        _push(o.token, o.buyer, gross - protocolFee - integratorFee);
    }

    function _refundSeller(Order storage o, uint256 amount) private {
        if (o.fromBalance) _credit(o.seller, o.token, amount);
        else _push(o.token, o.seller, amount);
    }

    function _withdraw(address account, address token, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        uint256 available = balances[account][token];
        if (available < amount) revert InsufficientBalance(available, amount);
        balances[account][token] = available - amount;
        if (!_tryTransfer(token, account, amount)) revert TokenCallFailed(token);
        emit Withdrawn(account, token, amount);
    }

    function _order(uint256 id) private view returns (Order storage o) {
        o = orders[id];
        if (o.status == Status.None) revert UnknownOrder(id);
    }

    /// The caller is `account` or holds `perm` over it.
    function _can(address account, uint8 perm) private view returns (bool) {
        return msg.sender == account || permissions[account][msg.sender] & perm != 0;
    }

    function _actsForBuyer(Order storage o) private view returns (bool) {
        return _can(o.buyer, PERM_TRADE) || (o.viaMatcher && msg.sender == o.opener);
    }

    function _actsForSeller(Order storage o) private view returns (bool) {
        return _can(o.seller, PERM_TRADE);
    }

    function _refKey(address opener, bytes32 ref) private pure returns (bytes32) {
        return keccak256(abi.encode(opener, ref));
    }

    function _credit(address account, address token, uint256 amount) private {
        balances[account][token] += amount;
        emit Credited(account, token, amount);
    }

    /// Pays `to` directly, or credits its balance when the token refuses the transfer.
    function _push(address token, address to, uint256 amount) private {
        if (!_tryTransfer(token, to, amount)) _credit(to, token, amount);
    }

    function _tryTransfer(address token, address to, uint256 amount) private returns (bool) {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        return ok && (data.length == 0 ? token.code.length != 0 : abi.decode(data, (bool)));
    }

    function _pull(address token, address from, uint256 amount) private {
        uint256 before = _balanceHere(token);
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, address(this), amount));
        if (!ok || (data.length == 0 ? token.code.length == 0 : !abi.decode(data, (bool)))) {
            revert TokenCallFailed(token);
        }
        uint256 received = _balanceHere(token) - before;
        if (received != amount) revert ShortDeposit(received, amount);
    }

    function _balanceHere(address token) private view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        if (!ok || data.length < 32) revert TokenCallFailed(token);
        return abi.decode(data, (uint256));
    }
}
