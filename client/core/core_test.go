//go:build !harness && !botlive

package core

import (
	"bytes"
	"context"
	crand "crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	mrand "math/rand/v2"
	"os"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"decred.org/dcrdex/client/asset"
	"decred.org/dcrdex/client/comms"
	"decred.org/dcrdex/client/db"
	"decred.org/dcrdex/dex"
	"decred.org/dcrdex/dex/calc"
	"decred.org/dcrdex/dex/encode"
	"decred.org/dcrdex/dex/encrypt"
	"decred.org/dcrdex/dex/msgjson"
	"decred.org/dcrdex/dex/order"
	ordertest "decred.org/dcrdex/dex/order/test"
	"decred.org/dcrdex/dex/wait"
	"decred.org/dcrdex/server/account"
	serverdex "decred.org/dcrdex/server/dex"
	"github.com/decred/dcrd/crypto/blake256"
	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"golang.org/x/text/language"
)

var rand = mrand.New(mrand.NewPCG(0xbadc0de, 0xdeadbeef))

func init() {
	asset.Register(tUTXOAssetA.ID, &tDriver{
		decodedCoinID: tUTXOAssetA.Symbol + "-coin",
		winfo:         tWalletInfo,
	}, true)
	asset.Register(tUTXOAssetB.ID, &tCreator{
		tDriver: &tDriver{
			decodedCoinID: tUTXOAssetB.Symbol + "-coin",
			winfo:         tWalletInfo,
		},
	}, true)
	asset.Register(tACCTAsset.ID, &tCreator{
		tDriver: &tDriver{
			decodedCoinID: tACCTAsset.Symbol + "-coin",
			winfo:         tWalletInfo,
		},
	}, true)
}

var (
	tCtx           context.Context
	dcrBtcLotSize  uint64 = 1e7
	dcrBtcRateStep uint64 = 10
	tUTXOAssetA           = &dex.Asset{
		ID:         42,
		Symbol:     "dcr",
		Version:    0, // match the stubbed (*TXCWallet).Info result
		MaxFeeRate: 10,
		SwapConf:   1,
	}
	tSwapSizeA uint64 = 251

	tUTXOAssetB = &dex.Asset{
		ID:         0,
		Symbol:     "btc",
		Version:    0, // match the stubbed (*TXCWallet).Info result
		MaxFeeRate: 2,
		SwapConf:   1,
	}
	tSwapSizeB uint64 = 225

	tACCTAsset = &dex.Asset{
		ID:         60,
		Symbol:     "eth",
		Version:    0, // match the stubbed (*TXCWallet).Info result
		MaxFeeRate: 20,
		SwapConf:   1,
	}
	tDexPriv            *secp256k1.PrivateKey
	tDexKey             *secp256k1.PublicKey
	tPW                        = []byte("dexpw")
	wPW                        = []byte("walletpw")
	tDexHost                   = "somedex.tld:7232"
	tDcrBtcMktName             = "dcr_btc"
	tBtcEthMktName             = "btc_eth"
	tErr                       = fmt.Errorf("test error")
	tFee                uint64 = 1e8
	tFeeAsset           uint32 = 42
	tUnparseableHost           = string([]byte{0x7f})
	tSwapFeesPaid       uint64 = 500
	tRedemptionFeesPaid uint64 = 350
	tLogger                    = dex.StdOutLogger("TCORE", dex.LevelInfo)
	// tMaxFeeRate is the "server-side max fee rate" value the test
	// rig uses when constructing synthetic match-route payloads
	// (FeeRateBase / FeeRateSwap / FeeRateQuote on msgjson.Match) and
	// for assertions against wallet refund-fee suggestions. It
	// happens to equal tUTXOAssetA.MaxFeeRate (10) — tUTXOAssetB.
	// MaxFeeRate is 2 and tACCTAsset.MaxFeeRate is 20, so
	// tMaxFeeRate isn't a universal cap, just a convenient match for
	// the DCR-side tests that dominate the trade paths.
	//
	// See also tradeTestFeeRate (near the trade tests) for the
	// wallet-provided rate on the client side; the two are kept
	// equal by default — see that comment for the why.
	tMaxFeeRate uint64 = 10
	tWalletInfo        = &asset.WalletInfo{
		SupportedVersions: []uint32{0},
		UnitInfo: dex.UnitInfo{
			Conventional: dex.Denomination{
				ConversionFactor: 1e8,
			},
		},
		AvailableWallets: []*asset.WalletDefinition{{
			Type: "type",
		}},
	}
	dcrBondAsset = &msgjson.BondAsset{ID: 42, Amt: tFee, Confs: 1}
)

type tMsg = *msgjson.Message
type msgFunc = func(*msgjson.Message)

func uncovertAssetInfo(ai *dex.Asset) *msgjson.Asset {
	return &msgjson.Asset{
		Symbol:     ai.Symbol,
		ID:         ai.ID,
		Version:    ai.Version,
		MaxFeeRate: ai.MaxFeeRate,
		SwapConf:   uint16(ai.SwapConf),
	}
}

func makeAcker(serializer func(msg *msgjson.Message) msgjson.Signable) func(msg *msgjson.Message, f msgFunc) error {
	return func(msg *msgjson.Message, f msgFunc) error {
		signable := serializer(msg)
		sigMsg := signable.Serialize()
		sig := signMsg(tDexPriv, sigMsg)
		ack := &msgjson.Acknowledgement{
			Sig: sig,
		}
		resp, _ := msgjson.NewResponse(msg.ID, ack, nil)
		f(resp)
		return nil
	}
}

var (
	invalidAcker = func(msg *msgjson.Message, f msgFunc) error {
		resp, _ := msgjson.NewResponse(msg.ID, msg, nil)
		f(resp)
		return nil
	}
	initAcker = makeAcker(func(msg *msgjson.Message) msgjson.Signable {
		init := new(msgjson.Init)
		msg.Unmarshal(init)
		return init
	})
	redeemAcker = makeAcker(func(msg *msgjson.Message) msgjson.Signable {
		redeem := new(msgjson.Redeem)
		msg.Unmarshal(redeem)
		return redeem
	})
)

type TWebsocket struct {
	mtx            sync.RWMutex
	id             uint64
	sendErr        error
	sendMsgErrChan chan *msgjson.Error
	reqErr         error
	connectErr     error
	msgs           <-chan *msgjson.Message
	// handlers simulates a peer (server) response for request, and handles the
	// response with the msgFunc.
	handlers       map[string][]func(*msgjson.Message, msgFunc) error
	submittedBond  *msgjson.PostBond
	liveBondExpiry uint64
}

func newTWebsocket() *TWebsocket {
	return &TWebsocket{
		msgs:     make(<-chan *msgjson.Message),
		handlers: make(map[string][]func(*msgjson.Message, msgFunc) error),
	}
}

func tNewAccount(crypter *tCrypter) *dexAccount {
	privKey, _ := secp256k1.GeneratePrivateKey()
	encKey, err := crypter.Encrypt(privKey.Serialize())
	if err != nil {
		panic(err)
	}
	return &dexAccount{
		host:      tDexHost,
		encKey:    encKey,
		dexPubKey: tDexKey,
		privKey:   privKey,
		id:        account.NewID(privKey.PubKey().SerializeCompressed()),
		// feeAssetID is 0 (btc)
		// tier, bonds, etc. set on auth
		pendingBondsConfs: make(map[string]uint32),
		rep:               account.Reputation{BondedTier: 1}, // not suspended by default
	}
}

func testDexConnection(ctx context.Context, crypter *tCrypter) (*dexConnection, *TWebsocket, *dexAccount) {
	conn := newTWebsocket()
	connMaster := dex.NewConnectionMaster(conn)
	connMaster.Connect(ctx)
	acct := tNewAccount(crypter)
	return &dexConnection{
		WsConn:     conn,
		log:        tLogger,
		connMaster: connMaster,
		ticker:     newDexTicker(time.Millisecond * 1000 / 3),
		acct:       acct,
		assets: map[uint32]*dex.Asset{
			tUTXOAssetA.ID: tUTXOAssetA,
			tUTXOAssetB.ID: tUTXOAssetB,
			tACCTAsset.ID:  tACCTAsset,
		},
		books: make(map[string]*bookie),
		cfg: &msgjson.ConfigResult{
			APIVersion:       serverdex.V1APIVersion,
			DEXPubKey:        acct.dexPubKey.SerializeCompressed(),
			CancelMax:        0.8,
			BroadcastTimeout: 1000, // 1000 ms for faster expiration, but ticker fires fast
			Assets: []*msgjson.Asset{
				uncovertAssetInfo(tUTXOAssetA),
				uncovertAssetInfo(tUTXOAssetB),
				uncovertAssetInfo(tACCTAsset),
			},
			Markets: []*msgjson.Market{
				{
					Name:            tDcrBtcMktName,
					Base:            tUTXOAssetA.ID,
					Quote:           tUTXOAssetB.ID,
					LotSize:         dcrBtcLotSize,
					ParcelSize:      1,
					RateStep:        dcrBtcRateStep,
					EpochLen:        60000,
					MarketBuyBuffer: 1.1,
					MarketStatus: msgjson.MarketStatus{
						StartEpoch: 12, // since the stone age
						FinalEpoch: 0,  // no scheduled suspend
						// Persist:   nil,
					},
				},
				{
					Name:            tBtcEthMktName,
					Base:            tUTXOAssetB.ID,
					Quote:           tACCTAsset.ID,
					LotSize:         dcrBtcLotSize,
					RateStep:        dcrBtcRateStep,
					EpochLen:        60000,
					MarketBuyBuffer: 1.1,
					MarketStatus: msgjson.MarketStatus{
						StartEpoch: 12,
						FinalEpoch: 0,
					},
				},
			},
			BondExpiry: 86400, // >0 make client treat as API v1
			BondAssets: map[string]*msgjson.BondAsset{
				"dcr": dcrBondAsset,
			},
			BinSizes: []string{"1h", "24h"},
		},
		notify:             func(Notification) {},
		dispatchTradeWork:  func(_ order.OrderID, fn func()) { fn() },
		trades:             make(map[order.OrderID]*trackedTrade),
		cancels:            make(map[order.OrderID]order.OrderID),
		inFlightOrders:     make(map[uint64]*InFlightOrder),
		epoch:              map[string]uint64{tDcrBtcMktName: 0},
		resolvedEpoch:      map[string]uint64{tDcrBtcMktName: 0},
		apiVer:             serverdex.PreAPIVersion,
		connectionStatus:   uint32(comms.Connected),
		reportingConnects:  1,
		spots:              make(map[string]*msgjson.Spot),
		activeCoinIDs:      make(map[string]order.MatchID),
		activeSecretHashes: make(map[string]order.MatchID),
		matchCoinIDs:       make(map[order.MatchID][]string),
		matchSecretHashes:  make(map[order.MatchID][]string),
	}, conn, acct
}

func (conn *TWebsocket) queueResponse(route string, handler func(*msgjson.Message, msgFunc) error) {
	conn.mtx.Lock()
	defer conn.mtx.Unlock()
	handlers := conn.handlers[route]
	if handlers == nil {
		handlers = make([]func(*msgjson.Message, msgFunc) error, 0, 1)
	}
	conn.handlers[route] = append(handlers, handler) // NOTE: handler is called by RequestWithTimeout
}

func (conn *TWebsocket) NextID() uint64 {
	conn.mtx.Lock()
	defer conn.mtx.Unlock()
	conn.id++
	return conn.id
}
func (conn *TWebsocket) Send(msg *msgjson.Message) error {
	if conn.sendMsgErrChan != nil {
		resp, err := msg.Response()
		if err != nil {
			return err
		}
		if resp.Error != nil {
			conn.sendMsgErrChan <- resp.Error
			return nil // the response was sent successfully
		}
	}

	return conn.sendErr
}

func (conn *TWebsocket) SendRaw([]byte) error {
	return conn.sendErr
}
func (conn *TWebsocket) Request(msg *msgjson.Message, f msgFunc) error {
	return conn.RequestWithTimeout(msg, f, 0, func() {})
}
func (conn *TWebsocket) RequestRaw(msgID uint64, rawMsg []byte, respHandler func(*msgjson.Message)) error {
	return nil
}
func (conn *TWebsocket) RequestWithTimeout(msg *msgjson.Message, f func(*msgjson.Message), _ time.Duration, _ func()) error {
	if conn.reqErr != nil {
		return conn.reqErr
	}
	conn.mtx.Lock()
	defer conn.mtx.Unlock()
	handlers := conn.handlers[msg.Route]
	if len(handlers) > 0 {
		handler := handlers[0]
		conn.handlers[msg.Route] = handlers[1:]
		return handler(msg, f)
	}
	return fmt.Errorf("no handler for route %q", msg.Route)
}
func (conn *TWebsocket) MessageSource() <-chan *msgjson.Message { return conn.msgs } // use when Core.listen is running
func (conn *TWebsocket) IsDown() bool {
	return false
}
func (conn *TWebsocket) Connect(context.Context) (*sync.WaitGroup, error) {
	// NOTE: tCore's wsConstructor just returns a reused conn, so we can't close
	// conn.msgs on ctx cancel. See the wsConstructor definition in newTestRig.
	// Consider reworking the tests (TODO).
	return &sync.WaitGroup{}, conn.connectErr
}

func (conn *TWebsocket) UpdateURL(string) {}

type TDB struct {
	updateWalletErr  error
	acct             *db.AccountInfo
	acctErr          error
	createAccountErr error
	// updateMatchHook is called during UpdateMatch if non-nil.
	updateMatchHook  func(m *db.MetaMatch)
	addBondErr       error
	updateOrderErr   error
	activeDEXOrders  []*db.MetaOrder
	allOrders        []*db.MetaOrder
	matchesForOID    []*db.MetaMatch
	matchesByOrderID map[order.OrderID][]*db.MetaMatch
	matchesForOIDErr error
	updateMatchChan  chan order.MatchStatus
	// For async-safe match update tracking
	matchUpdatesMtx          sync.Mutex
	matchUpdates             []order.MatchStatus
	matchUpdateCond          *sync.Cond
	activeMatchOIDs          []order.OrderID
	activeMatchOIDSErr       error
	lastStatusID             order.OrderID
	lastStatus               order.OrderStatus
	wallet                   *db.Wallet
	walletErr                error
	setWalletPwErr           error
	orderOrders              map[order.OrderID]*db.MetaOrder
	orderErr                 error
	linkedFromID             order.OrderID
	linkedToID               order.OrderID
	existValues              map[string]bool
	accountProofErr          error
	verifyCreateAccount      bool
	verifyUpdateAccountInfo  bool
	disabledHost             *string
	disableAccountErr        error
	creds                    *db.PrimaryCredentials
	setCredsErr              error
	legacyKeyErr             error
	recryptErr               error
	deleteInactiveOrdersErr  error
	archivedOrders           int
	deleteInactiveMatchesErr error
	archivedMatches          int
	updateAccountInfoErr     error
}

func (tdb *TDB) Run(context.Context) {}

func (tdb *TDB) ListAccounts() ([]string, error) {
	return nil, nil
}

func (tdb *TDB) Accounts() ([]*db.AccountInfo, error) {
	return []*db.AccountInfo{}, nil
}

func (tdb *TDB) Account(url string) (*db.AccountInfo, error) {
	return tdb.acct, tdb.acctErr
}

func (tdb *TDB) CreateAccount(ai *db.AccountInfo) error {
	tdb.verifyCreateAccount = true
	tdb.acct = ai
	return tdb.createAccountErr
}

func (tdb *TDB) NextBondKeyIndex(assetID uint32) (uint32, error) {
	return 0, nil
}

func (tdb *TDB) AddBond(host string, bond *db.Bond) error {
	return tdb.addBondErr
}

func (tdb *TDB) ConfirmBond(host string, assetID uint32, bondCoinID []byte) error {
	return nil
}
func (tdb *TDB) BondRefunded(host string, assetID uint32, bondCoinID []byte) error {
	return nil
}

func (tdb *TDB) ToggleAccountStatus(host string, disable bool) error {
	if disable {
		tdb.disabledHost = &host
	} else {
		tdb.disabledHost = nil
	}
	return tdb.disableAccountErr
}

func (tdb *TDB) UpdateAccountInfo(ai *db.AccountInfo) error {
	tdb.verifyUpdateAccountInfo = true
	tdb.acct = ai
	return tdb.updateAccountInfoErr
}

func (tdb *TDB) UpdateOrder(m *db.MetaOrder) error {
	return tdb.updateOrderErr
}

func (tdb *TDB) ActiveDEXOrders(dex string) ([]*db.MetaOrder, error) {
	return tdb.activeDEXOrders, nil
}

func (tdb *TDB) ActiveOrders() ([]*db.MetaOrder, error) {
	return nil, nil
}

func (tdb *TDB) AccountOrders(dex string, n int, since uint64) ([]*db.MetaOrder, error) {
	return nil, nil
}

func (tdb *TDB) Order(oid order.OrderID) (*db.MetaOrder, error) {
	if tdb.orderErr != nil {
		return nil, tdb.orderErr
	}
	return tdb.orderOrders[oid], nil
}

func (tdb *TDB) Orders(filter *db.OrderFilter) ([]*db.MetaOrder, error) {
	if tdb.allOrders == nil {
		return nil, nil
	}

	// Filter orders based on status
	var filtered []*db.MetaOrder
	for _, ord := range tdb.allOrders {
		// If no status filter, include all
		if len(filter.Statuses) == 0 {
			filtered = append(filtered, ord)
			continue
		}

		// Check if order status matches any of the filter statuses
		if slices.Contains(filter.Statuses, ord.MetaData.Status) {
			filtered = append(filtered, ord)
			continue
		}

		// Handle IncludePartial: include canceled/revoked orders with partial fills
		// when filtering for "executed" status
		if filter.IncludePartial && slices.Contains(filter.Statuses, order.OrderStatusExecuted) {
			if ord.MetaData.Status == order.OrderStatusCanceled ||
				ord.MetaData.Status == order.OrderStatusRevoked {
				// Check if order has trade matches (non-cancel matches indicating partial fill)
				oid := ord.Order.ID()
				if tdb.matchesByOrderID != nil {
					if matches := tdb.matchesByOrderID[oid]; len(matches) > 0 {
						// Check for non-cancel trade matches
						// A trade match has:
						// - Non-empty Address (not a cancel match for maker)
						// - If Status == MatchComplete, must have InitSig (not a cancel match for taker)
						for _, m := range matches {
							// Cancel match for maker has empty Address
							if m.UserMatch.Address == "" {
								continue
							}
							// Cancel match for taker has no InitSig and status MatchComplete
							if m.UserMatch.Status == order.MatchComplete {
								if m.MetaData == nil || len(m.MetaData.Proof.Auth.InitSig) == 0 {
									continue
								}
							}
							// Found a trade match - include this order
							filtered = append(filtered, ord)
							break
						}
					}
				}
			}
		}
	}

	return filtered, nil
}

func (tdb *TDB) MarketOrders(dex string, base, quote uint32, n int, since uint64) ([]*db.MetaOrder, error) {
	return nil, nil
}

func (tdb *TDB) UpdateOrderMetaData(order.OrderID, *db.OrderMetaData) error {
	return nil
}

func (tdb *TDB) UpdateOrderStatus(oid order.OrderID, status order.OrderStatus) error {
	tdb.lastStatusID = oid
	tdb.lastStatus = status
	return nil
}

func (tdb *TDB) LinkOrder(oid, linkedID order.OrderID) error {
	tdb.linkedFromID = oid
	tdb.linkedToID = linkedID
	return nil
}

func (tdb *TDB) UpdateMatch(m *db.MetaMatch) error {
	if tdb.updateMatchHook != nil {
		tdb.updateMatchHook(m)
	}
	// Non-blocking channel send for backward compatibility with tests
	// that still use the channel pattern.
	if tdb.updateMatchChan != nil {
		select {
		case tdb.updateMatchChan <- m.Status:
		default:
			// Channel full or no reader - don't block
		}
	}
	// Also track updates in a thread-safe slice for async-aware tests.
	tdb.matchUpdatesMtx.Lock()
	tdb.matchUpdates = append(tdb.matchUpdates, m.Status)
	if tdb.matchUpdateCond != nil {
		tdb.matchUpdateCond.Broadcast()
	}
	tdb.matchUpdatesMtx.Unlock()
	return nil
}

// resetMatchUpdates clears the tracked match updates.
func (tdb *TDB) resetMatchUpdates() {
	tdb.matchUpdatesMtx.Lock()
	tdb.matchUpdates = nil
	tdb.matchUpdatesMtx.Unlock()
}

// waitForMatchUpdate waits for at least n match updates within the timeout.
// Returns the updates received.
func (tdb *TDB) waitForMatchUpdate(n int, timeout time.Duration) []order.MatchStatus {
	deadline := time.Now().Add(timeout)
	tdb.matchUpdatesMtx.Lock()
	defer tdb.matchUpdatesMtx.Unlock()

	if tdb.matchUpdateCond == nil {
		tdb.matchUpdateCond = sync.NewCond(&tdb.matchUpdatesMtx)
	}

	// Wake up when the deadline expires so we don't block forever.
	timer := time.AfterFunc(timeout, func() {
		tdb.matchUpdateCond.Broadcast()
	})
	defer timer.Stop()

	for len(tdb.matchUpdates) < n && time.Now().Before(deadline) {
		tdb.matchUpdateCond.Wait()
	}
	result := make([]order.MatchStatus, len(tdb.matchUpdates))
	copy(result, tdb.matchUpdates)
	return result
}

func (tdb *TDB) ActiveMatches() ([]*db.MetaMatch, error) {
	return nil, nil
}

func (tdb *TDB) MatchesForOrder(oid order.OrderID, excludeCancels bool) ([]*db.MetaMatch, error) {
	// Use matchesByOrderID map if available for more accurate testing
	if tdb.matchesByOrderID != nil {
		return tdb.matchesByOrderID[oid], tdb.matchesForOIDErr
	}
	return tdb.matchesForOID, tdb.matchesForOIDErr
}

func (tdb *TDB) DEXOrdersWithActiveMatches(dex string) ([]order.OrderID, error) {
	return tdb.activeMatchOIDs, tdb.activeMatchOIDSErr
}

func (tdb *TDB) UpdateWallet(wallet *db.Wallet) error {
	tdb.wallet = wallet
	return tdb.updateWalletErr
}

func (tdb *TDB) SetWalletPassword(wid []byte, newPW []byte) error {
	return tdb.setWalletPwErr
}

func (tdb *TDB) UpdateBalance(wid []byte, balance *db.Balance) error {
	return nil
}

func (tdb *TDB) UpdateWalletStatus(wid []byte, disable bool) error {
	return nil
}

func (tdb *TDB) Wallets() ([]*db.Wallet, error) {
	return nil, nil
}

func (tdb *TDB) Wallet([]byte) (*db.Wallet, error) {
	return tdb.wallet, tdb.walletErr
}

func (tdb *TDB) SaveNotification(*db.Notification) error            { return nil }
func (tdb *TDB) BackupTo(dst string, overwrite, compact bool) error { return nil }
func (tdb *TDB) NotificationsN(int) ([]*db.Notification, error)     { return nil, nil }
func (tdb *TDB) SavePokes([]*db.Notification) error                 { return nil }
func (tdb *TDB) LoadPokes() ([]*db.Notification, error)             { return nil, nil }

func (tdb *TDB) SetPrimaryCredentials(creds *db.PrimaryCredentials) error {
	if tdb.setCredsErr != nil {
		return tdb.setCredsErr
	}
	tdb.creds = creds
	return nil
}

func (tdb *TDB) DeleteInactiveOrders(ctx context.Context, olderThan *time.Time, perBatchFn func(ords *db.MetaOrder) error) (int, error) {
	return tdb.archivedOrders, tdb.deleteInactiveOrdersErr
}

func (tdb *TDB) DeleteInactiveMatches(ctx context.Context, olderThan *time.Time, perBatchFn func(mtchs *db.MetaMatch, isSell bool) error) (int, error) {
	return tdb.archivedMatches, tdb.deleteInactiveMatchesErr
}

func (tdb *TDB) PrimaryCredentials() (*db.PrimaryCredentials, error) {
	return tdb.creds, nil
}
func (tdb *TDB) SetSeedGenerationTime(time uint64) error {
	return nil
}
func (tdb *TDB) SeedGenerationTime() (uint64, error) {
	return 0, nil
}
func (tdb *TDB) DisabledRateSources() ([]string, error) {
	return nil, nil
}
func (tdb *TDB) SaveDisabledRateSources(disableSources []string) error {
	return nil
}
func (tdb *TDB) Recrypt(creds *db.PrimaryCredentials, oldCrypter, newCrypter encrypt.Crypter) (
	walletUpdates map[uint32][]byte, acctUpdates map[string][]byte, err error) {

	if tdb.recryptErr != nil {
		return nil, nil, tdb.recryptErr
	}

	return nil, nil, nil
}

func (tdb *TDB) Backup() error {
	return nil
}

func (tdb *TDB) AckNotification(id []byte) error { return nil }

func (tdb *TDB) Language() (string, error) {
	return "en-US", nil
}
func (tdb *TDB) SetCompanionToken(token string) error {
	return nil
}
func (tdb *TDB) CompanionToken() (string, error) {
	return "", nil
}

func (tdb *TDB) NextMultisigKeyIndex(assetID uint32) (uint32, error) {
	return 0, nil
}

func (tdb *TDB) StoreMultisigIndexForPubkey(assetID, idx uint32, pubkey [33]byte) error {
	return nil
}

func (tdb *TDB) MultisigIndexForPubkey(assetID uint32, pubkey [33]byte) (uint32, error) {
	return 0, nil
}
func (tdb *TDB) StoreMMEpochSnapshot(host string, snap *msgjson.MMEpochSnapshot) error {
	return nil
}
func (tdb *TDB) MMEpochSnapshots(host string, base, quote uint32, startEpoch, endEpoch uint64) ([]*msgjson.MMEpochSnapshot, error) {
	return nil, nil
}
func (tdb *TDB) PruneMMEpochSnapshots(host string, base, quote uint32, minEpochIdx uint64) (int, error) {
	return 0, nil
}

type tCoin struct {
	id []byte

	val uint64
}

func (c *tCoin) ID() dex.Bytes {
	return c.id
}

func (c *tCoin) TxID() string {
	return ""
}

func (c *tCoin) String() string {
	return hex.EncodeToString(c.id)
}

func (c *tCoin) Value() uint64 {
	return c.val
}

type tReceipt struct {
	coin       *tCoin
	contract   []byte
	expiration time.Time
}

func (r *tReceipt) Coin() asset.Coin {
	return r.coin
}

func (r *tReceipt) Contract() dex.Bytes {
	return r.contract
}

func (r *tReceipt) Expiration() time.Time {
	return r.expiration
}

func (r *tReceipt) String() string {
	return r.coin.String()
}

func (r *tReceipt) SignedRefund() dex.Bytes {
	return nil
}

type TXCWallet struct {
	swapSize          uint64
	sendFeeSuggestion uint64
	sendCoin          *tCoin
	sendErr           error
	addrErr           error
	signCoinErr       error
	// signCoinErrAfterN, when signCoinErr is non-nil, controls which
	// SignCoinMessage calls return the error: 0 (default) means every
	// call errors; N>0 means the first N calls succeed and the
	// (N+1)th onward error. signCoinCallCounter tracks the number of
	// calls seen. Used by TestPrepareMultiTradeRequestsPerPlacementCleanup
	// to fail createTradeRequest at a non-first placement.
	signCoinErrAfterN   int32
	signCoinCallCounter atomic.Int32
	lastSwapsMtx        sync.Mutex
	lastSwaps           []*asset.Swaps
	lastRedeems         []*asset.RedeemForm
	swapReceipts        []asset.Receipt
	swapCounter         int
	swapErr             error
	auditInfo           *asset.AuditInfo
	auditInfoFunc       func(coinID, contract, txData dex.Bytes) (*asset.AuditInfo, error)
	auditErr            error
	auditChan           chan struct{}
	refundCoin          dex.Bytes
	refundErr           error
	refundFeeSuggestion uint64
	redeemCoins         []dex.Bytes
	redeemCounter       int
	redeemFeeSuggestion uint64
	redeemErr           error
	redeemErrChan       chan error
	badSecret           bool
	fundedVal           uint64
	fundedSwaps         uint64
	connectErr          error
	unlockErr           error
	balErr              error
	bal                 *asset.Balance
	fundingMtx          sync.RWMutex
	fundingCoins        asset.Coins
	fundRedeemScripts   []dex.Bytes
	returnedCoins       asset.Coins
	// allReturnedCoins accumulates every ReturnCoins call in order.
	// Unlike returnedCoins (which is overwritten on each call),
	// this captures the full history so tests can assert that
	// per-iteration cleanup (e.g. prepareMultiTradeRequests's
	// per-placement errCloser defers) ran for every expected
	// placement. Guarded by fundingMtx.
	allReturnedCoins []asset.Coins
	fundingCoinErr   error
	// multiFundCoins / multiFundRedeemScripts / multiFundFees /
	// multiFundErr are the configurable return values for
	// FundMultiOrder. Defaults are zero-value (nil coins, no error),
	// preserving the pre-existing stub behaviour.
	multiFundCoins         []asset.Coins
	multiFundRedeemScripts [][]dex.Bytes
	multiFundFees          uint64
	multiFundErr           error
	lockErr                error
	locked                 bool
	changeCoin             *tCoin
	syncStatus             func() (bool, float32, error)
	confsMtx               sync.RWMutex
	confs                  map[string]uint32
	confsErr               map[string]error
	preSwapForm            *asset.PreSwapForm
	preSwap                *asset.PreSwap
	preRedeemForm          *asset.PreRedeemForm
	preRedeem              *asset.PreRedeem
	ownsAddress            bool
	ownsAddressErr         error
	pubKeys                []dex.Bytes
	sigs                   []dex.Bytes
	feeCoin                []byte
	makeRegFeeTxErr        error
	feeCoinSent            []byte
	sendTxnErr             error
	contractExpired        bool
	contractLockTime       time.Time
	accelerationParams     *struct {
		swapCoins                 []dex.Bytes
		accelerationCoins         []dex.Bytes
		changeCoin                dex.Bytes
		feeSuggestion             uint64
		newFeeRate                uint64
		requiredForRemainingSwaps uint64
	}
	newAccelerationTxID         string
	newChangeCoinID             *dex.Bytes
	preAccelerateSwapRate       uint64
	preAccelerateSuggestedRange asset.XYRange
	accelerationEstimate        uint64
	accelerateOrderErr          error
	info                        *asset.WalletInfo
	bondTxCoinID                []byte
	refundBondCoin              asset.Coin
	refundBondErr               error
	makeBondTxErr               error
	reserves                    atomic.Uint64
	findBond                    *asset.BondDetails
	findBondErr                 error
	maxSwaps, maxRedeems        int

	confirmTxResult *asset.ConfirmTxStatus
	confirmTxErr    error
	confirmTxCalled bool

	estFee    uint64
	estFeeErr error
	validAddr bool

	returnedAddr      string
	returnedContracts [][]byte
	redemptionAddr    string
}

var _ asset.Accelerator = (*TXCWallet)(nil)
var _ asset.Withdrawer = (*TXCWallet)(nil)

// newTWalletDisconnected is a convenience wrapper that returns an
// xcWallet with hookedUp=false, so tests exercising xcWallet.Connect()
// (or anything gated on connected()) don't short-circuit at the
// `if w.connected() { return nil }` guard. Prefer this over
// `newTWallet(id); wallet.hookedUp = false` when the test's whole
// point is to drive Connect.
func newTWalletDisconnected(assetID uint32) (*xcWallet, *TXCWallet) {
	wallet, tw := newTWallet(assetID)
	wallet.hookedUp = false
	return wallet, tw
}

func newTWallet(assetID uint32) (*xcWallet, *TXCWallet) {
	w := &TXCWallet{
		changeCoin:       &tCoin{id: encode.RandomBytes(36)},
		syncStatus:       func() (synced bool, progress float32, err error) { return true, 1, nil },
		confs:            make(map[string]uint32),
		confsErr:         make(map[string]error),
		ownsAddress:      true,
		contractLockTime: time.Now().Add(time.Minute),
		lastSwaps:        make([]*asset.Swaps, 0),
		lastRedeems:      make([]*asset.RedeemForm, 0),
		info: &asset.WalletInfo{
			SupportedVersions: []uint32{0},
		},
		bondTxCoinID: encode.RandomBytes(32),
	}
	var broadcasting uint32 = 1
	xcWallet := &xcWallet{
		log:               tLogger,
		supportedVersions: w.info.SupportedVersions,
		Wallet:            w,
		Symbol:            dex.BipIDSymbol(assetID),
		AssetID:           assetID,
		hookedUp:          true,
		dbID:              encode.Uint32Bytes(assetID),
		encPass:           []byte{0x01},
		peerCount:         1,
		syncStatus:        &asset.SyncStatus{Synced: true},
		pw:                tPW,
		traits:            asset.DetermineWalletTraits(w),
		broadcasting:      &broadcasting,
	}
	// atomic.Pointer can't be pre-populated via struct literal; Store
	// the initial connector after construction.
	xcWallet.connector.Store(dex.NewConnectionMaster(w))

	return xcWallet, w
}

// newTradingTWallet is newTWallet + a TFeeRater shim pre-installed at
// tradeTestFeeRate. Trade-path tests need Core.feeSuggestionAny /
// feeSuggestionSwapAny to return a non-zero rate locally so the
// "fee_rate" server route (not stubbed by the test rig) stays off
// the critical path — the TFeeRater wrap short-circuits those
// helpers on the wallet-provided rate. Use this helper wherever a
// test was doing `newTWallet(...)` followed by
// `wallet.Wallet = &TFeeRater{tw, tradeTestFeeRate}`.
//
// Tests that need a custom fee rate (zero, a test-specific constant,
// etc.) should keep the raw `&TFeeRater{...}` literal — the helper
// is opinionated on tradeTestFeeRate by design.
func newTradingTWallet(assetID uint32) (*xcWallet, *TXCWallet) {
	wallet, tw := newTWallet(assetID)
	wallet.Wallet = &TFeeRater{TXCWallet: tw, feeRate: tradeTestFeeRate}
	return wallet, tw
}

// newTradingTWalletDisconnected is the hookedUp=false counterpart to
// newTradingTWallet, for tests that need to exercise xcWallet.Connect
// (e.g. connectAndUnlock flows) without panicking on a re-Connect.
func newTradingTWalletDisconnected(assetID uint32) (*xcWallet, *TXCWallet) {
	wallet, tw := newTWalletDisconnected(assetID)
	wallet.Wallet = &TFeeRater{TXCWallet: tw, feeRate: tradeTestFeeRate}
	return wallet, tw
}

func (w *TXCWallet) Info() *asset.WalletInfo {
	return w.info
}

func (w *TXCWallet) OwnsDepositAddress(address string) (bool, error) {
	return w.ownsAddress, w.ownsAddressErr
}

func (w *TXCWallet) Connect(ctx context.Context) (*sync.WaitGroup, error) {
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		<-ctx.Done()
		wg.Done()
	}()
	return &wg, w.connectErr
}

func (w *TXCWallet) Balance() (*asset.Balance, error) {
	if w.balErr != nil {
		return nil, w.balErr
	}
	if w.bal == nil {
		w.bal = new(asset.Balance)
	}
	return w.bal, nil
}

func (w *TXCWallet) ConfirmTransaction(coinID dex.Bytes, confirmTx *asset.ConfirmTx, feeSuggestion uint64) (*asset.ConfirmTxStatus, error) {
	w.confirmTxCalled = true
	return w.confirmTxResult, w.confirmTxErr
}

func (w *TXCWallet) FundOrder(ord *asset.Order) (asset.Coins, []dex.Bytes, uint64, error) {
	w.fundedVal = ord.Value
	w.fundedSwaps = ord.MaxSwapCount
	return w.fundingCoins, w.fundRedeemScripts, 0, w.fundingCoinErr
}

func (w *TXCWallet) MaxOrder(*asset.MaxOrderForm) (*asset.SwapEstimate, error) {
	return nil, nil
}

func (w *TXCWallet) PreSwap(form *asset.PreSwapForm) (*asset.PreSwap, error) {
	w.preSwapForm = form
	return w.preSwap, nil
}

func (w *TXCWallet) PreRedeem(form *asset.PreRedeemForm) (*asset.PreRedeem, error) {
	w.preRedeemForm = form
	return w.preRedeem, nil
}
func (w *TXCWallet) RedemptionFees() (uint64, error) { return 0, nil }

func (w *TXCWallet) ReturnCoins(coins asset.Coins) error {
	w.fundingMtx.Lock()
	defer w.fundingMtx.Unlock()
	w.returnedCoins = coins
	// Snapshot into the per-call history. Copy defensively so a
	// caller mutating `coins` after the fact can't retro-edit our
	// record.
	snap := append(asset.Coins(nil), coins...)
	w.allReturnedCoins = append(w.allReturnedCoins, snap)
	coinInSlice := func(coin asset.Coin) bool {
		for _, c := range coins {
			if bytes.Equal(c.ID(), coin.ID()) {
				return true
			}
		}
		return false
	}

	for _, c := range w.fundingCoins {
		if coinInSlice(c) {
			continue
		}
		return errors.New("not found")
	}
	return nil
}

func (w *TXCWallet) FundingCoins([]dex.Bytes) (asset.Coins, error) {
	return w.fundingCoins, w.fundingCoinErr
}

func (w *TXCWallet) Swap(_ context.Context, swaps *asset.Swaps) ([]asset.Receipt, asset.Coin, uint64, error) {
	w.swapCounter++
	w.lastSwapsMtx.Lock()
	w.lastSwaps = append(w.lastSwaps, swaps)
	w.lastSwapsMtx.Unlock()
	if w.swapErr != nil {
		return nil, nil, 0, w.swapErr
	}
	return w.swapReceipts, w.changeCoin, tSwapFeesPaid, nil
}

func (w *TXCWallet) Redeem(_ context.Context, form *asset.RedeemForm) ([]dex.Bytes, asset.Coin, uint64, error) {
	w.redeemFeeSuggestion = form.FeeSuggestion
	defer func() {
		if w.redeemErrChan != nil {
			w.redeemErrChan <- w.redeemErr
		}
	}()
	w.lastRedeems = append(w.lastRedeems, form)
	w.redeemCounter++
	if w.redeemErr != nil {
		return nil, nil, 0, w.redeemErr
	}
	return w.redeemCoins, &tCoin{id: []byte{0x0c, 0x0d}}, tRedemptionFeesPaid, nil
}

func (w *TXCWallet) SignCoinMessage(asset.Coin, dex.Bytes) (pubkeys, sigs []dex.Bytes, err error) {
	n := w.signCoinCallCounter.Add(1)
	// signCoinErrAfterN: 0 means error on every call (preserves the
	// pre-existing fail-every-call behaviour); N>0 means the first N
	// calls succeed and the (N+1)th onward error.
	if w.signCoinErr != nil && (w.signCoinErrAfterN == 0 || n > w.signCoinErrAfterN) {
		return w.pubKeys, w.sigs, w.signCoinErr
	}
	return w.pubKeys, w.sigs, nil
}

func (w *TXCWallet) AuditContract(coinID, contract, txData dex.Bytes, rebroadcast bool) (*asset.AuditInfo, error) {
	defer func() {
		if w.auditChan != nil {
			w.auditChan <- struct{}{}
		}
	}()
	if w.auditInfoFunc != nil {
		return w.auditInfoFunc(coinID, contract, txData)
	}
	return w.auditInfo, w.auditErr
}

func (w *TXCWallet) LockTimeExpired(_ context.Context, lockTime time.Time) (bool, error) {
	return w.contractExpired, nil
}

func (w *TXCWallet) ContractLockTimeExpired(_ context.Context, contract dex.Bytes) (bool, time.Time, error) {
	return w.contractExpired, w.contractLockTime, nil
}

func (w *TXCWallet) FindRedemption(ctx context.Context, coinID, _ dex.Bytes) (redemptionCoin, secret dex.Bytes, err error) {
	return nil, nil, fmt.Errorf("not mocked")
}

func (w *TXCWallet) Refund(_ context.Context, refundCoin dex.Bytes, refundContract dex.Bytes, feeSuggestion uint64) (dex.Bytes, error) {
	w.refundFeeSuggestion = feeSuggestion
	return w.refundCoin, w.refundErr
}

func (w *TXCWallet) DepositAddress() (string, error) {
	return "", w.addrErr
}

func (w *TXCWallet) RedemptionAddress() (string, error) {
	return w.redemptionAddr, w.addrErr
}

func (w *TXCWallet) NewAddress() (string, error) {
	return "", w.addrErr
}

func (w *TXCWallet) AddressUsed(addr string) (bool, error) {
	return false, nil
}

func (w *TXCWallet) Unlock(pw []byte) error {
	return w.unlockErr
}

func (w *TXCWallet) Lock() error {
	return w.lockErr
}

func (w *TXCWallet) Locked() bool {
	return w.locked
}

func (w *TXCWallet) ConfirmTime(id dex.Bytes, nConfs uint32) (time.Time, error) {
	return time.Time{}, nil
}

func (w *TXCWallet) Send(address string, value, feeSuggestion uint64) (asset.Coin, error) {
	w.sendFeeSuggestion = feeSuggestion
	w.sendCoin.val = value
	return w.sendCoin, w.sendErr
}

func (w *TXCWallet) SendTransaction(rawTx []byte) ([]byte, error) {
	return w.feeCoinSent, w.sendTxnErr
}

func (w *TXCWallet) Withdraw(address string, value, feeSuggestion uint64) (asset.Coin, error) {
	w.sendFeeSuggestion = feeSuggestion
	return w.sendCoin, w.sendErr
}

func (w *TXCWallet) ValidateAddress(address string) bool {
	return w.validAddr
}

func (w *TXCWallet) EstimateSendTxFee(address string, value, feeRate uint64, subtract, maxWithdraw bool) (fee uint64, isValidAddress bool, err error) {
	return w.estFee, true, w.estFeeErr
}

func (w *TXCWallet) ValidateSecret(secret, secretHash []byte) bool {
	return !w.badSecret
}

func (w *TXCWallet) SyncStatus() (*asset.SyncStatus, error) {
	synced, progress, err := w.syncStatus()
	if err != nil {
		return nil, err
	}
	blocks := uint64(math.Round(float64(progress) * 100))
	return &asset.SyncStatus{Synced: synced, TargetHeight: blocks, Blocks: blocks}, nil
}

func (w *TXCWallet) setConfs(coinID dex.Bytes, confs uint32, err error) {
	id := coinID.String()
	w.confsMtx.Lock()
	w.confs[id] = confs
	w.confsErr[id] = err
	w.confsMtx.Unlock()
}

func (w *TXCWallet) tConfirmations(_ context.Context, coinID dex.Bytes) (uint32, error) {
	id := coinID.String()
	w.confsMtx.RLock()
	defer w.confsMtx.RUnlock()
	return w.confs[id], w.confsErr[id]
}

func (w *TXCWallet) SwapConfirmations(ctx context.Context, coinID dex.Bytes, contract dex.Bytes, matchTime time.Time) (uint32, bool, error) {
	confs, err := w.tConfirmations(ctx, coinID)
	return confs, false, err
}

func (w *TXCWallet) RegFeeConfirmations(ctx context.Context, coinID dex.Bytes) (uint32, error) {
	return w.tConfirmations(ctx, coinID)
}

func (w *TXCWallet) FeesForRemainingSwaps(n uint64) uint64 {
	return n * 1 * w.swapSize
}
func (w *TXCWallet) AccelerateOrder(swapCoins, accelerationCoins []dex.Bytes, changeCoin dex.Bytes, requiredForRemainingSwaps, newFeeRate uint64) (asset.Coin, string, error) {
	if w.accelerateOrderErr != nil {
		return nil, "", w.accelerateOrderErr
	}

	w.accelerationParams = &struct {
		swapCoins                 []dex.Bytes
		accelerationCoins         []dex.Bytes
		changeCoin                dex.Bytes
		feeSuggestion             uint64
		newFeeRate                uint64
		requiredForRemainingSwaps uint64
	}{
		swapCoins:                 swapCoins,
		accelerationCoins:         accelerationCoins,
		changeCoin:                changeCoin,
		requiredForRemainingSwaps: requiredForRemainingSwaps,
		newFeeRate:                newFeeRate,
	}
	if w.newChangeCoinID != nil {
		return &tCoin{id: *w.newChangeCoinID}, w.newAccelerationTxID, nil
	}

	return nil, w.newAccelerationTxID, nil
}

func (w *TXCWallet) PreAccelerate(swapCoins, accelerationCoins []dex.Bytes, changeCoin dex.Bytes, requiredForRemainingSwaps, feeSuggestion uint64) (uint64, *asset.XYRange, *asset.EarlyAcceleration, error) {
	if w.accelerateOrderErr != nil {
		return 0, nil, nil, w.accelerateOrderErr
	}

	w.accelerationParams = &struct {
		swapCoins                 []dex.Bytes
		accelerationCoins         []dex.Bytes
		changeCoin                dex.Bytes
		feeSuggestion             uint64
		newFeeRate                uint64
		requiredForRemainingSwaps uint64
	}{
		swapCoins:                 swapCoins,
		accelerationCoins:         accelerationCoins,
		changeCoin:                changeCoin,
		requiredForRemainingSwaps: requiredForRemainingSwaps,
		feeSuggestion:             feeSuggestion,
	}

	return w.preAccelerateSwapRate, &w.preAccelerateSuggestedRange, nil, nil
}

func (w *TXCWallet) SingleLotSwapRefundFees(version uint32, feeRate uint64, useSafeTxSize bool) (uint64, uint64, error) {
	return 0, 0, nil
}

func (w *TXCWallet) SingleLotRedeemFees(version uint32, feeRate uint64) (uint64, error) {
	return 0, nil
}

func (w *TXCWallet) StandardSendFee(uint64) uint64 { return 1 }

func (w *TXCWallet) AccelerationEstimate(swapCoins, accelerationCoins []dex.Bytes, changeCoin dex.Bytes, requiredForRemainingSwaps, newFeeRate uint64) (uint64, error) {
	if w.accelerateOrderErr != nil {
		return 0, w.accelerateOrderErr
	}

	w.accelerationParams = &struct {
		swapCoins                 []dex.Bytes
		accelerationCoins         []dex.Bytes
		changeCoin                dex.Bytes
		feeSuggestion             uint64
		newFeeRate                uint64
		requiredForRemainingSwaps uint64
	}{
		swapCoins:                 swapCoins,
		accelerationCoins:         accelerationCoins,
		changeCoin:                changeCoin,
		requiredForRemainingSwaps: requiredForRemainingSwaps,
		newFeeRate:                newFeeRate,
	}

	return w.accelerationEstimate, nil
}

func (w *TXCWallet) ReturnRedemptionAddress(addr string) {
	w.returnedAddr = addr
}
func (w *TXCWallet) ReturnRefundContracts(contracts [][]byte) {
	w.returnedContracts = contracts
}
func (w *TXCWallet) MaxFundingFees(_ uint32, _ uint64, _ map[string]string) uint64 {
	return 0
}

func (w *TXCWallet) FundMultiOrder(ord *asset.MultiOrder, maxLock uint64) (coins []asset.Coins, redeemScripts [][]dex.Bytes, fundingFees uint64, err error) {
	return w.multiFundCoins, w.multiFundRedeemScripts, w.multiFundFees, w.multiFundErr
}

var _ asset.Bonder = (*TXCWallet)(nil)

func (*TXCWallet) BondsFeeBuffer(feeRate uint64) uint64 {
	return 4 * 1000 * feeRate * 2
}

func (w *TXCWallet) SetBondReserves(reserves uint64) {
	w.reserves.Store(reserves)
}

func (w *TXCWallet) RefundBond(ctx context.Context, ver uint16, coinID, script []byte, amt uint64, privKey *secp256k1.PrivateKey) (asset.Coin, error) {
	return w.refundBondCoin, w.refundBondErr
}

func (w *TXCWallet) FindBond(ctx context.Context, coinID []byte, searchUntil time.Time) (bond *asset.BondDetails, err error) {
	return w.findBond, w.findBondErr
}

func (w *TXCWallet) MakeBondTx(ver uint16, amt, feeRate uint64, lockTime time.Time, privKey *secp256k1.PrivateKey, acctID []byte) (*asset.Bond, func(), error) {
	if w.makeBondTxErr != nil {
		return nil, nil, w.makeBondTxErr
	}
	return &asset.Bond{
		Version: ver,
		AssetID: dcrBondAsset.ID,
		Amount:  amt,
		CoinID:  w.bondTxCoinID,
	}, func() {}, nil
}

func (w *TXCWallet) TxHistory(*asset.TxHistoryRequest) (*asset.TxHistoryResponse, error) {
	return nil, nil
}
func (w *TXCWallet) WalletTransaction(ctx context.Context, txID string) (*asset.WalletTransaction, error) {
	return nil, nil
}

func (w *TXCWallet) PendingTransactions(ctx context.Context) []*asset.WalletTransaction {
	return nil
}

var _ asset.MaxMatchesCounter = (*TXCWallet)(nil)

func (w *TXCWallet) MaxSwaps(serverVer uint32, feeRate uint64) (int, error) {
	return w.maxSwaps, nil
}
func (w *TXCWallet) MaxRedeems(serverVer uint32) (int, error) {
	return w.maxRedeems, nil
}

type TAccountLocker struct {
	*TXCWallet
	reserveNRedemptions    uint64
	reserveNRedemptionsErr error
	reReserveRedemptionErr error
	redemptionUnlocked     uint64
	reservedRedemption     uint64

	reserveNRefunds    uint64
	reserveNRefundsErr error
	reReserveRefundErr error
	refundUnlocked     uint64
	reservedRefund     uint64

	// feeRate, when non-zero, makes TAccountLocker act as an asset.FeeRater
	// returning this rate. Leave 0 to preserve the default non-FeeRater
	// behavior (xcWallet.feeRate() falls through to server fetch).
	feeRate uint64
}

var _ asset.AccountLocker = (*TAccountLocker)(nil)

// FeeRate implements asset.FeeRater. Returns 0 when feeRate is unset so
// callers fall through to other rate sources, matching pre-FeeRater behavior.
func (w *TAccountLocker) FeeRate() (rate uint64, tooLow bool) {
	return w.feeRate, false
}

// FeeRateSwap implements asset.FeeRater.
func (w *TAccountLocker) FeeRateSwap() (rate uint64, tooLow bool) {
	return w.FeeRate()
}

func newTAccountLocker(assetID uint32) (*xcWallet, *TAccountLocker) {
	xcWallet, tWallet := newTWallet(assetID)
	accountLocker := &TAccountLocker{TXCWallet: tWallet}
	xcWallet.Wallet = accountLocker
	return xcWallet, accountLocker
}

func (w *TAccountLocker) ReserveNRedemptions(n uint64, ver uint32, maxFeeRate uint64, lotSize uint64) (uint64, error) {
	return w.reserveNRedemptions, w.reserveNRedemptionsErr
}

func (w *TAccountLocker) ReReserveRedemption(v uint64) error {
	w.fundingMtx.Lock()
	defer w.fundingMtx.Unlock()
	w.reservedRedemption += v
	return w.reReserveRedemptionErr
}

func (w *TAccountLocker) UnlockRedemptionReserves(v uint64) {
	w.fundingMtx.Lock()
	defer w.fundingMtx.Unlock()
	w.redemptionUnlocked += v
}

func (w *TAccountLocker) ReserveNRefunds(n uint64, ver uint32, maxFeeRate uint64) (uint64, error) {
	return w.reserveNRefunds, w.reserveNRefundsErr
}

func (w *TAccountLocker) UnlockRefundReserves(v uint64) {
	w.fundingMtx.Lock()
	defer w.fundingMtx.Unlock()
	w.refundUnlocked += v
}

func (w *TAccountLocker) ReReserveRefund(v uint64) error {
	w.fundingMtx.Lock()
	defer w.fundingMtx.Unlock()
	w.reservedRefund += v
	return w.reReserveRefundErr
}

type TFeeRater struct {
	*TXCWallet
	feeRate uint64
}

func (w *TFeeRater) FeeRate() (rate uint64, tooLow bool) {
	return w.feeRate, false
}

func (w *TFeeRater) FeeRateSwap() (rate uint64, tooLow bool) {
	return w.FeeRate()
}

type TLiveReconfigurer struct {
	*TXCWallet
	restart     bool
	reconfigErr error
}

func (r *TLiveReconfigurer) Reconfigure(ctx context.Context, cfg *asset.WalletConfig, currentAddress string) (restartRequired bool, err error) {
	return r.restart, r.reconfigErr
}

type tCrypterSmart struct {
	params     []byte
	encryptErr error
	decryptErr error
	recryptErr error
}

func newTCrypterSmart() *tCrypterSmart {
	return &tCrypterSmart{
		params: encode.RandomBytes(5),
	}
}

// Encrypt appends 8 random bytes to given []byte to mock.
func (c *tCrypterSmart) Encrypt(b []byte) ([]byte, error) {
	randSuffix := make([]byte, 8)
	crand.Read(randSuffix)
	b = append(b, randSuffix...)
	return b, c.encryptErr
}

// Decrypt deletes the last 8 bytes from given []byte.
func (c *tCrypterSmart) Decrypt(b []byte) ([]byte, error) {
	return b[:len(b)-8], c.decryptErr
}

func (c *tCrypterSmart) Serialize() []byte { return c.params }

func (c *tCrypterSmart) Close() {}

type tCrypter struct {
	encryptErr error
	decryptErr error
	recryptErr error
}

func (c *tCrypter) Encrypt(b []byte) ([]byte, error) {
	return b, c.encryptErr
}

func (c *tCrypter) Decrypt(b []byte) ([]byte, error) {
	return b, c.decryptErr
}

func (c *tCrypter) Serialize() []byte { return nil }

func (c *tCrypter) Close() {}

var tAssetID uint32

func randomAsset() *msgjson.Asset {
	tAssetID++
	return &msgjson.Asset{
		Symbol:  "BT" + strconv.Itoa(int(tAssetID)),
		ID:      tAssetID,
		Version: tAssetID * 2,
	}
}

func randomMsgMarket() (baseAsset, quoteAsset *msgjson.Asset) {
	return randomAsset(), randomAsset()
}

func tFetcher(_ context.Context, log dex.Logger, _ map[uint32]*SupportedAsset) map[uint32]float64 {
	return map[uint32]float64{
		tUTXOAssetA.ID: 45,
		tUTXOAssetB.ID: 32000,
	}
}

type testRig struct {
	shutdown func()
	core     *Core
	db       *TDB
	queue    *wait.TickerQueue
	ws       *TWebsocket
	dc       *dexConnection
	acct     *dexAccount
	crypter  encrypt.Crypter
}

func newTestRig() *testRig {
	tdb := &TDB{
		orderOrders:  make(map[order.OrderID]*db.MetaOrder),
		wallet:       &db.Wallet{},
		existValues:  map[string]bool{},
		legacyKeyErr: tErr,
	}

	// Set the global waiter expiration, and start the waiter.
	queue := wait.NewTickerQueue(time.Millisecond * 5)
	ctx, cancel := context.WithCancel(tCtx)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		queue.Run(ctx)
	}()

	crypter := &tCrypter{}
	dc, conn, acct := testDexConnection(ctx, crypter) // crypter makes acct.encKey consistent with privKey

	ai := &db.AccountInfo{
		Host:      "somedex.com",
		Cert:      acct.cert,
		DEXPubKey: acct.dexPubKey,
		EncKeyV2:  acct.encKey,
	}
	tdb.acct = ai

	shutdown := func() {
		cancel()
		wg.Wait()
		dc.connMaster.Wait()
	}

	rig := &testRig{
		shutdown: shutdown,
		core: &Core{
			ctx:      ctx,
			cfg:      &Config{},
			db:       tdb,
			log:      tLogger,
			latencyQ: queue,
			conns: map[string]*dexConnection{
				tDexHost: dc,
			},
			lockTimeTaker: dex.LockTimeTaker(dex.Testnet),
			lockTimeMaker: dex.LockTimeMaker(dex.Testnet),
			wallets:       make(map[uint32]*xcWallet),
			blockWaiters:  make(map[string]*blockWaiter),
			sentCommits:   make(map[order.Commitment]chan struct{}),
			wsConstructor: func(*comms.WsCfg) (comms.WsConn, error) {
				// This is not very realistic since it doesn't start a fresh
				// one, and (*Core).connectDEX always gets the same TWebsocket,
				// which may have been previously "disconnected".
				return conn, nil
			},
			newCrypter: func([]byte) encrypt.Crypter { return crypter },
			reCrypter:  func([]byte, []byte) (encrypt.Crypter, error) { return crypter, crypter.recryptErr },
			noteChans:  make(map[uint64]chan Notification),
			tipPending: make(map[uint32]uint64),
			tipActive:  make(map[uint32]bool),
			balPending: make(map[uint32]*asset.Balance),
			balActive:  make(map[uint32]bool),

			fiatRateSources:  make(map[string]*commonRateSource),
			notes:            make(chan asset.WalletNotification, 128),
			pokesCache:       newPokesCache(pokesCapacity),
			requestedActions: make(map[string]*asset.ActionRequiredNote),
		},
		db:      tdb,
		queue:   queue,
		ws:      conn,
		dc:      dc,
		acct:    acct,
		crypter: crypter,
	}

	rig.core.intl.Store(&locale{lang: language.AmericanEnglish})

	rig.core.InitializeClient(tPW, nil)

	// tCrypter doesn't actually use random bytes supplied by InitializeClient,
	// (the crypter is known ahead of time) but if that changes, we would need
	// to encrypt the acct.privKey here, after InitializeClient generates a new
	// random inner key/crypter: rig.resetAcctEncKey(tPW)

	return rig
}

// Encrypt acct.privKey -> acct.encKey if InitializeClient generates a new
// random inner key/crypter that is different from the one used on construction.
// Important if Core's crypters actually use their initialization data (random
// bytes for inner crypter and the pw for outer).
func (rig *testRig) resetAcctEncKey(pw []byte) error {
	innerCrypter, err := rig.core.encryptionKey(pw)
	if err != nil {
		return fmt.Errorf("encryptionKey error: %w", err)
	}
	encKey, err := innerCrypter.Encrypt(rig.acct.privKey.Serialize())
	if err != nil {
		return fmt.Errorf("crypter.Encrypt error: %w", err)
	}
	rig.acct.encKey = encKey
	return nil
}

func (rig *testRig) queueConfig() {
	rig.ws.queueResponse(msgjson.ConfigRoute, func(msg *msgjson.Message, f msgFunc) error {
		resp, _ := msgjson.NewResponse(msg.ID, rig.dc.cfg, nil)
		f(resp)
		return nil
	})
}

func (rig *testRig) queuePrevalidateBond() {
	rig.ws.queueResponse(msgjson.PreValidateBondRoute, func(msg *msgjson.Message, f msgFunc) error {
		preEval := new(msgjson.PreValidateBond)
		msg.Unmarshal(preEval)

		preEvalResult := &msgjson.PreValidateBondResult{
			AccountID: rig.dc.acct.id[:],
			AssetID:   preEval.AssetID,
			Amount:    dcrBondAsset.Amt,
			// Expiry: ,
		}
		sign(tDexPriv, preEvalResult)
		resp, _ := msgjson.NewResponse(msg.ID, preEvalResult, nil)
		f(resp)
		return nil
	})
}

func (rig *testRig) queuePostBond(postBondResult *msgjson.PostBondResult) {
	rig.ws.queueResponse(msgjson.PostBondRoute, func(msg *msgjson.Message, f msgFunc) error {
		bond := new(msgjson.PostBond)
		msg.Unmarshal(bond)
		rig.ws.submittedBond = bond
		postBondResult.BondID = bond.CoinID
		sign(tDexPriv, postBondResult)
		resp, _ := msgjson.NewResponse(msg.ID, postBondResult, nil)
		f(resp)
		return nil
	})
}

func (rig *testRig) queueConnect(rpcErr *msgjson.Error, matches []*msgjson.Match, orders []*msgjson.OrderStatus, suspended ...bool) {
	rig.ws.queueResponse(msgjson.ConnectRoute, func(msg *msgjson.Message, f msgFunc) error {
		if rpcErr != nil {
			resp, _ := msgjson.NewResponse(msg.ID, nil, rpcErr)
			f(resp)
			return nil
		}

		connect := new(msgjson.Connect)
		msg.Unmarshal(connect)
		sign(tDexPriv, connect)

		activeBonds := make([]*msgjson.Bond, 0, 1)
		if b := rig.ws.submittedBond; b != nil {
			activeBonds = append(activeBonds, &msgjson.Bond{
				Version: b.Version,
				Amount:  dcrBondAsset.Amt,
				Expiry:  rig.ws.liveBondExpiry,
				CoinID:  b.CoinID,
				AssetID: b.AssetID,
			})
		}

		result := &msgjson.ConnectResult{
			Sig:                 connect.Sig,
			ActiveMatches:       matches,
			ActiveOrderStatuses: orders,
			ActiveBonds:         activeBonds,
			Score:               10,
			Reputation:          &account.Reputation{BondedTier: 1},
		}
		if len(suspended) > 0 && suspended[0] {
			result.Reputation.Penalties = 1
		}
		resp, _ := msgjson.NewResponse(msg.ID, result, nil)
		f(resp)
		return nil
	})
}

func (rig *testRig) queueCancel(rpcErr *msgjson.Error) {
	rig.ws.queueResponse(msgjson.CancelRoute, func(msg *msgjson.Message, f msgFunc) error {
		var resp *msgjson.Message
		if rpcErr == nil {
			// Need to stamp and sign the message with the server's key.
			msgOrder := new(msgjson.CancelOrder)
			err := msg.Unmarshal(msgOrder)
			if err != nil {
				rpcErr = msgjson.NewError(msgjson.RPCParseError, "unable to unmarshal request")
			} else {
				co := convertMsgCancelOrder(msgOrder)
				resp = orderResponse(msg.ID, msgOrder, co, false, false, false)
			}
		}
		if rpcErr != nil {
			resp, _ = msgjson.NewResponse(msg.ID, nil, rpcErr)
		}
		f(resp)
		return nil
	})
}

func TestMain(m *testing.M) {
	var shutdown context.CancelFunc
	tCtx, shutdown = context.WithCancel(context.Background())
	tDexPriv, _ = secp256k1.GeneratePrivateKey()
	tDexKey = tDexPriv.PubKey()

	doIt := func() int {
		// Not counted as coverage, must test Archiver constructor explicitly.
		defer shutdown()
		return m.Run()
	}
	os.Exit(doIt())
}

type tDriver struct {
	wallet        asset.Wallet
	decodedCoinID string
	winfo         *asset.WalletInfo
}

func (drv *tDriver) Open(cfg *asset.WalletConfig, logger dex.Logger, net dex.Network) (asset.Wallet, error) {
	return drv.wallet, nil
}

func (drv *tDriver) DecodeCoinID(coinID []byte) (string, error) {
	return drv.decodedCoinID, nil
}

func (drv *tDriver) Info() *asset.WalletInfo {
	return drv.winfo
}

type tCreator struct {
	*tDriver
	doesntExist bool
	existsErr   error
	createErr   error
}

func (ctr *tCreator) Exists(walletType, dataDir string, settings map[string]string, net dex.Network) (bool, error) {
	return !ctr.doesntExist, ctr.existsErr
}

func (ctr *tCreator) Create(*asset.CreateWalletParams) error {
	return ctr.createErr
}

func unauth(a *dexAccount) {
	a.authMtx.Lock()
	a.isAuthed = false
	a.authMtx.Unlock()
}

// tradeTestFeeRate is the wallet-provided fee rate returned by the
// TFeeRater shim installed by newTradingTWallet. Trade-path tests
// need Core.feeSuggestionAny / feeSuggestionSwapAny to return a
// non-zero rate locally so the "fee_rate" WS route (not stubbed by
// the test rig) stays off the critical path.
//
// It equals tMaxFeeRate by design: keeping the two in lock-step
// ensures the match-route FeeRateBase > MaxFeeRate checks fire at
// tMaxFeeRate + 1 without the trade-rate path tripping a different
// validation first. A test that specifically wants to exercise
// "wallet rate diverges from server max" should keep a raw
// &TFeeRater{...} literal at a local rate (see the newTradingTWallet
// godoc) rather than retuning tradeTestFeeRate globally — changing
// the constant would ripple through every newTradingTWallet call
// site.
var tradeTestFeeRate = tMaxFeeRate

func trade(t *testing.T, async bool) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core
	dcrWallet, tDcrWallet := newTradingTWalletDisconnected(tUTXOAssetA.ID)
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet
	dcrWallet.address = "DsVmA7aqqWeKWy461hXjytbZbgCqbB8g2dq"
	dcrWallet.Unlock(rig.crypter)
	_ = dcrWallet.Connect() // connector will panic on Wait, and sync status goroutines will exit if disconnected
	defer dcrWallet.Disconnect()
	syncTickerPeriod = 10 * time.Millisecond

	btcWallet, tBtcWallet := newTradingTWallet(tUTXOAssetB.ID)
	tCore.wallets[tUTXOAssetB.ID] = btcWallet
	btcWallet.address = "12DXGkvxFjuq5btXYkwWfBZaz1rVwFgini"
	btcWallet.Unlock(rig.crypter)

	ethWallet, tEthWallet := newTAccountLocker(tACCTAsset.ID)
	tCore.wallets[tACCTAsset.ID] = ethWallet
	ethWallet.address = "18d65fb8d60c1199bb1ad381be47aa692b482605"
	ethWallet.Unlock(rig.crypter)

	var lots uint64 = 10
	qty := dcrBtcLotSize * lots
	rate := dcrBtcRateStep * 1000

	form := &TradeForm{
		Host:    tDexHost,
		IsLimit: true,
		Sell:    true,
		Base:    tUTXOAssetA.ID,
		Quote:   tUTXOAssetB.ID,
		Qty:     qty,
		Rate:    rate,
		TifNow:  false,
	}

	dcrCoin := &tCoin{
		id:  encode.RandomBytes(36),
		val: qty * 2,
	}
	tDcrWallet.fundingCoins = asset.Coins{dcrCoin}
	tDcrWallet.fundRedeemScripts = []dex.Bytes{nil}

	btcVal := calc.BaseToQuote(rate, qty*2)
	btcCoin := &tCoin{
		id:  encode.RandomBytes(36),
		val: btcVal,
	}
	tBtcWallet.fundingCoins = asset.Coins{btcCoin}
	tBtcWallet.fundRedeemScripts = []dex.Bytes{nil}

	book := newBookie(rig.dc, tUTXOAssetA.ID, tUTXOAssetB.ID, nil, tLogger)
	rig.dc.books[tDcrBtcMktName] = book

	msgOrderNote := &msgjson.BookOrderNote{
		OrderNote: msgjson.OrderNote{
			OrderID: encode.RandomBytes(32),
		},
		TradeNote: msgjson.TradeNote{
			Side:     msgjson.SellOrderNum,
			Quantity: dcrBtcLotSize,
			Time:     uint64(time.Now().Unix()),
			Rate:     rate,
		},
	}

	err := book.Sync(&msgjson.OrderBook{
		MarketID: tDcrBtcMktName,
		Seq:      1,
		Epoch:    1,
		Orders:   []*msgjson.BookOrderNote{msgOrderNote},
	})
	if err != nil {
		t.Fatalf("order book sync error: %v", err)
	}

	badSig := false
	noID := false
	badID := false
	handleLimit := func(msg *msgjson.Message, f msgFunc) error {
		t.Helper()
		// Need to stamp and sign the message with the server's key.
		msgOrder := new(msgjson.LimitOrder)
		err := msg.Unmarshal(msgOrder)
		if err != nil {
			t.Fatalf("unmarshal error: %v", err)
		}
		lo := convertMsgLimitOrder(msgOrder)
		f(orderResponse(msg.ID, msgOrder, lo, badSig, noID, badID))
		return nil
	}

	// handleMarket is unused now that the market-order sections are
	// gone (Bison disables market orders); keeping nothing here to
	// avoid dead code.

	ch := tCore.NotificationFeed() // detect when sync goroutine completes
	waitForOrderNotification := func() (*Order, uint64, error) {
		var corder *Order
		var tempID uint64
	wait:
		for {
			select {
			case note := <-ch.C:
				if note.Type() == NoteTypeOrder {
					n, ok := note.(*OrderNote)
					if !ok {
						t.Fatalf("Expected OrderNote type, got %T", note)
					}
					if note.Topic() == TopicAsyncOrderSubmitted {
						tempID = n.TemporaryID
					} else if tempID == n.TemporaryID && note.Topic() == TopicAsyncOrderFailure {
						return nil, tempID, fmt.Errorf("%v", note.Details())
					} else {
						corder = n.Order
						break wait
					}
				}
			case <-time.After(1 * time.Second):
				t.Fatal("Failed to receive queued order note")
			}
		}
		return corder, tempID, nil
	}

	// bypassRateWarning pre-seeds the previously-failed-trade-attempt so
	// the next validateTradeRate call treats the current form's
	// market/rate as "caller has already seen the 1-time warning and
	// is retrying to proceed". Without this, limit trades placed at a
	// rate that matches the test book's order get rejected by the
	// Bison-specific immediate-match safety check.
	bypassRateWarning := func() {
		tCore.rememberFailedTradeAttempt(marketName(form.Base, form.Quote), form.Rate)
	}

	trade := func() (*Order, error) {
		bypassRateWarning()
		if !async {
			return tCore.Trade(tPW, form)
		}

		inFlight, err := tCore.TradeAsync(tPW, form)
		if err != nil {
			return nil, err
		}

		corder, tempID, err := waitForOrderNotification()
		if err != nil {
			return nil, err
		}

		if inFlight.TemporaryID != tempID {
			t.Fatalf("received wrong in-flight order, expected %d got %d", inFlight.TemporaryID, tempID)
		}

		return corder, nil
	}

	ensureOrderErr := func(tag string, waitForErr bool) {
		t.Helper()
		var err error
		if async {
			_, err = tCore.TradeAsync(tPW, form)
		} else {
			_, err = tCore.Trade(tPW, form)
		}
		if !waitForErr && err == nil {
			t.Fatalf("%s: no error", tag)
		}

		if waitForErr {
			_, _, err := waitForOrderNotification()
			if err == nil {
				t.Fatalf("%s: no error for queued order", tag)
			}
		}
	}

	ensureErr := func(tag string) {
		t.Helper()
		ensureOrderErr(tag, false)
	}

	// Initial success
	rig.ws.queueResponse(msgjson.LimitRoute, handleLimit)
	corder, err := trade()
	if err != nil {
		t.Fatalf("limit order error: %v", err)
	}
	t.Logf("Order with ID(%s) has been placed successfully!", corder.ID.String())

	// Check that the Fund request for a limit sell came through and that
	// value was not adjusted internally with BaseToQuote.
	if tDcrWallet.fundedVal != qty {
		t.Fatalf("limit sell expected funded value %d, got %d", qty, tDcrWallet.fundedVal)
	}
	tDcrWallet.fundedVal = 0
	if tDcrWallet.fundedSwaps != lots {
		t.Fatalf("limit sell expected %d max swaps, got %d", lots, tDcrWallet.fundedSwaps)
	}
	tDcrWallet.fundedSwaps = 0

	// Should not be able to close wallet now, since there are orders.
	if tCore.CloseWallet(tUTXOAssetA.ID) == nil {
		t.Fatalf("no error for closing DCR wallet with active orders")
	}
	if tCore.CloseWallet(tUTXOAssetB.ID) == nil {
		t.Fatalf("no error for closing BTC wallet with active orders")
	}

	// Should not be able to disable wallet, since there are active orders.
	if tCore.ToggleWalletStatus(tUTXOAssetA.ID, true) == nil {
		t.Fatalf("no error for disabling DCR wallet with active orders")
	}
	if tCore.ToggleWalletStatus(tUTXOAssetB.ID, true) == nil {
		t.Fatalf("no error for disabling BTC wallet with active orders")
	}

	// We want to set peerCount to 0 (from 1), but we'll do this the hard way to
	// ensure the peerChange handler works as intended.
	// dcrWallet.mtx.Lock()
	// dcrWallet.peerCount = 0
	// dcrWallet.mtx.Unlock()
	tCore.peerChange(dcrWallet, 0, nil)
	_, err = tCore.Trade(tPW, form)
	if err == nil {
		t.Fatalf("no error for no peers")
	}
	tCore.peerChange(dcrWallet, 1, nil)

	// Dex not found
	form.Host = "someotherdex.org"
	_, err = tCore.Trade(tPW, form)
	if err == nil {
		t.Fatalf("no error for unknown dex")
	}
	form.Host = tDexHost

	// Account locked = probably not logged in
	rig.dc.acct.lock()
	_, err = tCore.Trade(tPW, form)
	if err == nil {
		t.Fatalf("no error for disconnected dex")
	}
	rig.dc.acct.unlock(rig.crypter)

	// DEX not connected
	atomic.StoreUint32(&rig.dc.connectionStatus, uint32(comms.Disconnected))
	_, err = tCore.Trade(tPW, form)
	if err == nil {
		t.Fatalf("no error for disconnected dex")
	}
	atomic.StoreUint32(&rig.dc.connectionStatus, uint32(comms.Connected))

	setWalletSyncStatus := func(w *xcWallet, status bool) {
		w.mtx.Lock()
		ss := *w.syncStatus
		ss.Synced = status
		w.syncStatus = &ss
		w.mtx.Unlock()
	}

	// No base asset
	form.Base = 12345
	ensureErr("bad base asset")
	form.Base = tUTXOAssetA.ID

	// No quote asset
	form.Quote = 12345
	ensureErr("bad quote asset")
	form.Quote = tUTXOAssetB.ID

	// Limit order zero rate
	form.Rate = 0
	ensureErr("zero rate limit")
	form.Rate = rate

	// No from wallet
	tCore.walletMtx.Lock()
	delete(tCore.wallets, tUTXOAssetA.ID)
	tCore.walletMtx.Unlock()
	ensureErr("no dcr wallet")
	tCore.walletMtx.Lock()
	tCore.wallets[tUTXOAssetA.ID] = dcrWallet
	tCore.walletMtx.Unlock()

	// No to wallet
	tCore.walletMtx.Lock()
	delete(tCore.wallets, tUTXOAssetB.ID)
	tCore.walletMtx.Unlock()
	ensureErr("no btc wallet")
	tCore.walletMtx.Lock()
	tCore.wallets[tUTXOAssetB.ID] = btcWallet
	tCore.walletMtx.Unlock()

	// Address error
	tBtcWallet.addrErr = tErr
	ensureErr("address error")
	tBtcWallet.addrErr = nil

	// Not enough funds
	tDcrWallet.fundingCoinErr = tErr
	ensureErr("funds error")
	tDcrWallet.fundingCoinErr = nil

	// Lot size violation
	ogQty := form.Qty
	form.Qty += dcrBtcLotSize / 2
	ensureErr("bad size")
	form.Qty = ogQty

	// Coin signature error
	tDcrWallet.signCoinErr = tErr
	ensureErr("signature error")
	tDcrWallet.signCoinErr = nil

	// Sync-in-progress error
	setWalletSyncStatus(dcrWallet, false)
	ensureErr("base not synced")
	setWalletSyncStatus(dcrWallet, true)

	setWalletSyncStatus(btcWallet, false)
	ensureErr("quote not synced")
	setWalletSyncStatus(btcWallet, true)

	// LimitRoute error
	rig.ws.reqErr = tErr
	ensureOrderErr("Request error", async)
	rig.ws.reqErr = nil

	// The rest need a queued handler

	// Bad signature
	rig.ws.queueResponse(msgjson.LimitRoute, handleLimit)
	badSig = true
	ensureOrderErr("bad server sig", async)
	badSig = false

	// No order ID in response
	rig.ws.queueResponse(msgjson.LimitRoute, handleLimit)
	noID = true
	ensureOrderErr("no ID", async)
	noID = false

	// Wrong order ID in response
	rig.ws.queueResponse(msgjson.LimitRoute, handleLimit)
	badID = true
	ensureOrderErr("no ID", async)
	badID = false

	// Storage failure
	rig.ws.queueResponse(msgjson.LimitRoute, handleLimit)
	rig.db.updateOrderErr = tErr
	ensureOrderErr("db failure", async)
	rig.db.updateOrderErr = nil

	// Success when buying.
	form.Sell = false
	rig.ws.queueResponse(msgjson.LimitRoute, handleLimit)
	corder, err = trade()
	if err != nil {
		t.Fatalf("limit order error: %v", err)
	}
	t.Logf("Order with ID(%s) has been placed successfully!", corder.ID.String())

	// Check that the Fund request for a limit buy came through to the BTC wallet
	// and that the value was adjusted internally with BaseToQuote.
	expQty := calc.BaseToQuote(rate, qty)
	if tBtcWallet.fundedVal != expQty {
		t.Fatalf("limit buy expected funded value %d, got %d", expQty, tBtcWallet.fundedVal)
	}
	tBtcWallet.fundedVal = 0
	// The number of lots should still be the same as for a sell order.
	if tBtcWallet.fundedSwaps != lots {
		t.Fatalf("limit buy expected %d max swaps, got %d", lots, tBtcWallet.fundedSwaps)
	}
	tBtcWallet.fundedSwaps = 0

	// NOTE: Market buy/sell success-path tests are omitted here. Bison
	// disables market orders for safety (see prepareTradeRequest), so
	// those specific market-only semantics (e.g. fundedVal == form.Qty
	// without BaseToQuote adjustment) aren't exercisable on this
	// branch. The account-based redemption coverage below is preserved
	// by running it via a limit order instead of a market order.

	// Selling to an account-based quote asset. Using a limit order
	// since market orders are disabled in Bison.
	const reserveN = 50
	form.IsLimit = true
	form.Sell = true
	form.Rate = rate
	form.Qty = qty
	form.Base = tUTXOAssetB.ID
	form.Quote = tACCTAsset.ID
	rig.ws.queueResponse(msgjson.LimitRoute, handleLimit)
	tEthWallet.fundingMtx.Lock()
	tEthWallet.reserveNRedemptions = reserveN
	tEthWallet.fundingMtx.Unlock()
	tEthWallet.sigs = []dex.Bytes{{}}
	tEthWallet.pubKeys = []dex.Bytes{{}}
	corder, err = trade()
	if err != nil {
		t.Fatalf("account-redeemed order error: %v", err)
	}
	t.Logf("Order with ID(%s) has been placed successfully!", corder.ID.String())

	// redeem sig error
	tEthWallet.signCoinErr = tErr
	ensureErr("redeem sig error")
	tEthWallet.signCoinErr = nil

	// missing sig
	tEthWallet.sigs = []dex.Bytes{}
	ensureErr("no redeem sig is result")
	tEthWallet.sigs = []dex.Bytes{{}}

	// ReserveN error
	tEthWallet.reserveNRedemptionsErr = tErr
	ensureErr("reserveN error")
	tEthWallet.reserveNRedemptionsErr = nil

	// Funds returned for later error.
	tEthWallet.fundingMtx.Lock()
	tEthWallet.redemptionUnlocked = 0
	tEthWallet.fundingMtx.Unlock()
	rig.db.updateOrderErr = tErr
	rig.ws.queueResponse(msgjson.LimitRoute, handleLimit)
	ensureOrderErr("db error after redeem funds checked out", async)
	rig.db.updateOrderErr = nil
	tEthWallet.fundingMtx.Lock()
	defer tEthWallet.fundingMtx.Unlock()
	if tEthWallet.redemptionUnlocked != reserveN {
		t.Fatalf("redeem funds not returned")
	}
}

func makeTradeTracker(rig *testRig, walletSet *walletSet, force order.TimeInForce, status order.OrderStatus) *trackedTrade {
	qty := 4 * dcrBtcLotSize
	lo, dbOrder, preImg, _ := makeLimitOrder(rig.dc, true, qty, dcrBtcRateStep)
	lo.Force = force
	dbOrder.MetaData.Status = status

	return newTrackedTrade(dbOrder, preImg, rig.dc,
		rig.core.lockTimeTaker, rig.core.lockTimeMaker,
		rig.db, rig.queue, walletSet, nil, rig.core.notify,
		rig.core.formatDetails, &rig.core.wg)
}

func generateMatch(rig *testRig, baseID, quoteID uint32) (uint64, *order.LimitOrder, *db.MetaOrder, *db.MetaMatch, *tCoin) {
	const redemptionReserves = 50
	const refundReserves = 75

	qty := dcrBtcLotSize * 5
	rate := dcrBtcRateStep * 5
	lo := &order.LimitOrder{
		P: order.Prefix{
			OrderType:  order.LimitOrderType,
			BaseAsset:  baseID,
			QuoteAsset: quoteID,
			ClientTime: time.Now(),
			ServerTime: time.Now(),
			Commit:     ordertest.RandomCommitment(),
		},
		T: order.Trade{
			Quantity: qty,
			Sell:     true,
		},
		Rate:  rate,
		Force: order.StandingTiF, // we're calling it booked in OrderMetaData
	}

	changeCoinID := encode.RandomBytes(36)
	changeCoin := &tCoin{id: changeCoinID}

	dbOrder := &db.MetaOrder{
		MetaData: &db.OrderMetaData{
			Status:             order.OrderStatusBooked,
			Host:               tDexHost,
			Proof:              db.OrderProof{},
			ChangeCoin:         changeCoinID,
			RedemptionReserves: redemptionReserves,
			RefundReserves:     refundReserves,
		},
		Order: lo,
	}

	oid := lo.ID()
	mid := ordertest.RandomMatchID()
	addr := ordertest.RandomAddress()
	matchQty := qty - dcrBtcLotSize
	match := &db.MetaMatch{
		MetaData: &db.MatchMetaData{
			Proof: db.MatchProof{
				CounterContract: encode.RandomBytes(50),
				SecretHash:      encode.RandomBytes(32),
				MakerSwap:       encode.RandomBytes(32),
				Auth: db.MatchAuth{
					MatchSig: encode.RandomBytes(32),
					InitSig:  encode.RandomBytes(32), // otherwise MatchComplete will be seen as a cancel order match (inactive)
				},
			},
			DEX:   tDexHost,
			Base:  baseID,
			Quote: quoteID,
		},
		UserMatch: &order.UserMatch{
			OrderID:  oid,
			MatchID:  mid,
			Quantity: matchQty,
			Rate:     rate,
			Address:  addr,
			Status:   order.MakerSwapCast,
			Side:     order.Taker,
		},
	}

	// Need to return an order from db.ActiveDEXOrders
	rig.db.activeDEXOrders = []*db.MetaOrder{dbOrder}
	rig.db.orderOrders[oid] = dbOrder

	rig.db.activeMatchOIDs = []order.OrderID{oid}
	rig.db.matchesForOID = []*db.MetaMatch{match}

	return qty, lo, dbOrder, match, changeCoin
}

var (
	activeStatuses   = []order.OrderStatus{order.OrderStatusEpoch, order.OrderStatusBooked}
	inactiveStatuses = []order.OrderStatus{order.OrderStatusExecuted, order.OrderStatusCanceled, order.OrderStatusRevoked}

	reservationTests = []struct {
		name          string
		sell          bool
		side          []order.MatchSide
		orderStatuses []order.OrderStatus
		matchStatuses []order.MatchStatus
		expectedCoins int
	}{
		// With an active order, the change coin should always be loaded.
		{
			name:          "active-order, sell",
			sell:          true,
			side:          []order.MatchSide{order.Taker, order.Maker},
			orderStatuses: activeStatuses,
			matchStatuses: []order.MatchStatus{order.NewlyMatched, order.MakerSwapCast,
				order.TakerSwapCast, order.MakerRedeemed, order.MatchComplete},
			expectedCoins: 1,
		},
		{
			name:          "active-order, buy",
			sell:          false,
			side:          []order.MatchSide{order.Taker, order.Maker},
			orderStatuses: activeStatuses,
			matchStatuses: []order.MatchStatus{order.NewlyMatched, order.MakerSwapCast,
				order.TakerSwapCast, order.MakerRedeemed, order.MatchComplete},
			expectedCoins: 1,
		},
		// With an inactive order, as taker, if match is >= TakerSwapCast, there
		// will be no funding coin fetched.
		{
			name:          "inactive taker > MakerSwapCast, sell",
			sell:          true,
			side:          []order.MatchSide{order.Taker},
			orderStatuses: inactiveStatuses,
			matchStatuses: []order.MatchStatus{order.TakerSwapCast, order.MakerRedeemed,
				order.MatchComplete},
			expectedCoins: 0,
		},
		{
			name:          "inactive taker > MakerSwapCast, buy",
			sell:          false,
			side:          []order.MatchSide{order.Taker},
			orderStatuses: inactiveStatuses,
			matchStatuses: []order.MatchStatus{order.TakerSwapCast, order.MakerRedeemed,
				order.MatchComplete},
			expectedCoins: 0,
		},
		// But there will be for NewlyMatched && MakerSwapCast
		{
			name:          "inactive taker < TakerSwapCast, sell",
			sell:          true,
			side:          []order.MatchSide{order.Taker},
			orderStatuses: inactiveStatuses,
			matchStatuses: []order.MatchStatus{order.NewlyMatched, order.MakerSwapCast},
			expectedCoins: 1,
		},
		{
			name:          "inactive taker < TakerSwapCast, buy",
			sell:          false,
			side:          []order.MatchSide{order.Taker},
			orderStatuses: inactiveStatuses,
			matchStatuses: []order.MatchStatus{order.NewlyMatched, order.MakerSwapCast},
			expectedCoins: 1,
		},
		// For a maker with an inactive order, only NewlyMatched would
		// necessitate fetching of coins.
		{
			name:          "inactive maker NewlyMatched, sell",
			sell:          true,
			side:          []order.MatchSide{order.Maker},
			orderStatuses: inactiveStatuses,
			matchStatuses: []order.MatchStatus{order.NewlyMatched},
			expectedCoins: 1,
		},
		{
			name:          "inactive maker NewlyMatched, buy",
			sell:          false,
			side:          []order.MatchSide{order.Maker},
			orderStatuses: inactiveStatuses,
			matchStatuses: []order.MatchStatus{order.NewlyMatched},
			expectedCoins: 1,
		},
		{
			name:          "inactive maker > NewlyMatched, sell",
			sell:          true,
			side:          []order.MatchSide{order.Maker},
			orderStatuses: inactiveStatuses,
			matchStatuses: []order.MatchStatus{order.MakerSwapCast, order.TakerSwapCast,
				order.MakerRedeemed, order.MatchComplete},
			expectedCoins: 0,
		},
		{
			name:          "inactive maker > NewlyMatched, buy",
			sell:          false,
			side:          []order.MatchSide{order.Maker},
			orderStatuses: inactiveStatuses,
			matchStatuses: []order.MatchStatus{order.MakerSwapCast, order.TakerSwapCast,
				order.MakerRedeemed, order.MatchComplete},
			expectedCoins: 0,
		},
	}
)

// auth sets the account as authenticated at the provided tier.
func auth(a *dexAccount) {
	a.authMtx.Lock()
	a.isAuthed = true
	a.rep = account.Reputation{BondedTier: 1}
	a.authMtx.Unlock()
}

func convertMsgLimitOrder(msgOrder *msgjson.LimitOrder) *order.LimitOrder {
	tif := order.ImmediateTiF
	if msgOrder.TiF == msgjson.StandingOrderNum {
		tif = order.StandingTiF
	}
	return &order.LimitOrder{
		P:     convertMsgPrefix(&msgOrder.Prefix, order.LimitOrderType),
		T:     convertMsgTrade(&msgOrder.Trade),
		Rate:  msgOrder.Rate,
		Force: tif,
	}
}

func convertMsgMarketOrder(msgOrder *msgjson.MarketOrder) *order.MarketOrder {
	return &order.MarketOrder{
		P: convertMsgPrefix(&msgOrder.Prefix, order.MarketOrderType),
		T: convertMsgTrade(&msgOrder.Trade),
	}
}

func convertMsgCancelOrder(msgOrder *msgjson.CancelOrder) *order.CancelOrder {
	var oid order.OrderID
	copy(oid[:], msgOrder.TargetID)
	return &order.CancelOrder{
		P:             convertMsgPrefix(&msgOrder.Prefix, order.CancelOrderType),
		TargetOrderID: oid,
	}
}

func convertMsgPrefix(msgPrefix *msgjson.Prefix, oType order.OrderType) order.Prefix {
	var commit order.Commitment
	copy(commit[:], msgPrefix.Commit)
	var acctID account.AccountID
	copy(acctID[:], msgPrefix.AccountID)
	return order.Prefix{
		AccountID:  acctID,
		BaseAsset:  msgPrefix.Base,
		QuoteAsset: msgPrefix.Quote,
		OrderType:  oType,
		ClientTime: time.UnixMilli(int64(msgPrefix.ClientTime)),
		//ServerTime set in epoch queue processing pipeline.
		Commit: commit,
	}
}

func convertMsgTrade(msgTrade *msgjson.Trade) order.Trade {
	coins := make([]order.CoinID, 0, len(msgTrade.Coins))
	for _, coin := range msgTrade.Coins {
		var b []byte = coin.ID
		coins = append(coins, b)
	}
	sell := true
	if msgTrade.Side == msgjson.BuyOrderNum {
		sell = false
	}
	return order.Trade{
		Coins:    coins,
		Sell:     sell,
		Quantity: msgTrade.Quantity,
		Address:  msgTrade.Address,
	}
}

func orderResponse(msgID uint64, msgPrefix msgjson.Stampable, ord order.Order, badSig, noID, badID bool) *msgjson.Message {
	orderTime := time.Now()
	timeStamp := uint64(orderTime.UnixMilli())
	msgPrefix.Stamp(timeStamp)
	sign(tDexPriv, msgPrefix)
	if badSig {
		msgPrefix.SetSig(encode.RandomBytes(5))
	}
	ord.SetTime(orderTime)
	oid := ord.ID()
	oidB := oid[:]
	if noID {
		oidB = nil
	} else if badID {
		oidB = encode.RandomBytes(32)
	}
	resp, _ := msgjson.NewResponse(msgID, &msgjson.OrderResult{
		Sig:        msgPrefix.SigBytes(),
		OrderID:    oidB,
		ServerTime: timeStamp,
	}, nil)
	return resp
}

func tMsgAudit(oid order.OrderID, mid order.MatchID, recipient string, val uint64, secretHash []byte) (*msgjson.Audit, *asset.AuditInfo) {
	auditID := encode.RandomBytes(36)
	auditContract := encode.RandomBytes(75)
	if secretHash == nil {
		secretHash = encode.RandomBytes(32)
	}
	auditStamp := uint64(time.Now().UnixMilli())
	audit := &msgjson.Audit{
		OrderID:  oid[:],
		MatchID:  mid[:],
		Time:     auditStamp,
		CoinID:   auditID,
		Contract: auditContract,
	}
	sign(tDexPriv, audit)
	auditCoin := &tCoin{id: auditID, val: val}
	auditInfo := &asset.AuditInfo{
		Recipient:  recipient,
		Coin:       auditCoin,
		Contract:   auditContract,
		SecretHash: secretHash,
	}
	return audit, auditInfo
}

func makeMatchProof(preimages []order.Preimage, commitments []order.Commitment) (msgjson.Bytes, msgjson.Bytes, error) {
	if len(preimages) != len(commitments) {
		return nil, nil, fmt.Errorf("expected equal number of preimages and commitments")
	}

	sbuff := make([]byte, 0, len(preimages)*order.PreimageSize)
	cbuff := make([]byte, 0, len(commitments)*order.CommitmentSize)
	for i := 0; i < len(preimages); i++ {
		sbuff = append(sbuff, preimages[i][:]...)
		cbuff = append(cbuff, commitments[i][:]...)
	}
	seed := blake256.Sum256(sbuff)
	csum := blake256.Sum256(cbuff)
	return seed[:], csum[:], nil
}

func makeLimitOrder(dc *dexConnection, sell bool, qty, rate uint64) (*order.LimitOrder, *db.MetaOrder, order.Preimage, string) {
	return makeLimitOrderWithTiF(dc, sell, qty, rate, order.ImmediateTiF)
}

func makeLimitOrderWithTiF(dc *dexConnection, sell bool, qty, rate uint64, force order.TimeInForce) (*order.LimitOrder, *db.MetaOrder, order.Preimage, string) {
	preImg := newPreimage()
	addr := ordertest.RandomAddress()
	lo := &order.LimitOrder{
		P: order.Prefix{
			AccountID:  dc.acct.ID(),
			BaseAsset:  tUTXOAssetA.ID,
			QuoteAsset: tUTXOAssetB.ID,
			OrderType:  order.LimitOrderType,
			ClientTime: time.Now(),
			ServerTime: time.Now().Add(time.Millisecond),
			Commit:     preImg.Commit(),
		},
		T: order.Trade{
			// Coins needed?
			Sell:     sell,
			Quantity: qty,
			Address:  addr,
		},
		Rate:  rate,
		Force: force,
	}
	fromAsset, toAsset := tUTXOAssetB, tUTXOAssetA
	if sell {
		fromAsset, toAsset = tUTXOAssetA, tUTXOAssetB
	}
	dbOrder := &db.MetaOrder{
		MetaData: &db.OrderMetaData{
			Status: order.OrderStatusEpoch,
			Host:   dc.acct.host,
			Proof: db.OrderProof{
				Preimage: preImg[:],
			},
			EpochDur:     dc.marketEpochDuration(tDcrBtcMktName),
			FromSwapConf: fromAsset.SwapConf,
			ToSwapConf:   toAsset.SwapConf,
		},
		Order: lo,
	}
	return lo, dbOrder, preImg, addr
}

func orderNoteFeed(tCore *Core) (orderNotes chan *OrderNote, done func()) {
	orderNotes = make(chan *OrderNote, 16)

	ntfnFeed := tCore.NotificationFeed()
	feedDone := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case n := <-ntfnFeed.C:
				if ordNote, ok := n.(*OrderNote); ok {
					orderNotes <- ordNote
				}
			case <-tCtx.Done():
				return
			case <-feedDone:
				return
			}
		}
	}()

	done = func() {
		close(feedDone) // close first on return
		wg.Wait()
	}
	return orderNotes, done
}

func verifyRevokeNotification(ch chan *OrderNote, expectedTopic Topic, t *testing.T) {
	t.Helper()
	select {
	case actualOrderNote := <-ch:
		if expectedTopic != actualOrderNote.TopicID {
			t.Fatalf("SubjectText mismatch. %s != %s", actualOrderNote.TopicID,
				expectedTopic)
		}
		return
	case <-tCtx.Done():
		return
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for OrderNote notification")
		return
	}
}

var randU32 = func() uint32 { return uint32(rand.Int32()) }

func randOrderForMarket(base, quote uint32) order.Order {
	switch rand.IntN(3) {
	case 0:
		o, _ := ordertest.RandomCancelOrder()
		o.BaseAsset = base
		o.QuoteAsset = quote
		return o
	case 1:
		o, _ := ordertest.RandomMarketOrder()
		o.BaseAsset = base
		o.QuoteAsset = quote
		return o
	default:
		o, _ := ordertest.RandomLimitOrder()
		o.BaseAsset = base
		o.QuoteAsset = quote
		return o
	}
}

func randBytes(n int) []byte {
	b := make([]byte, n)
	crand.Read(b)
	return b
}

type TDynamicSwapper struct {
	*TXCWallet
	tfpPaid         uint64
	tfpSecretHashes [][]byte
	tfpErr          error
}

func (dtfc *TDynamicSwapper) DynamicSwapFeesPaid(ctx context.Context, coinID, contractData dex.Bytes) (uint64, [][]byte, error) {
	return dtfc.tfpPaid, dtfc.tfpSecretHashes, dtfc.tfpErr
}
func (dtfc *TDynamicSwapper) DynamicRedemptionFeesPaid(ctx context.Context, coinID, contractData dex.Bytes) (uint64, [][]byte, error) {
	return dtfc.tfpPaid, dtfc.tfpSecretHashes, dtfc.tfpErr
}
func (dtfc *TDynamicSwapper) GasFeeLimit() uint64 {
	return 200
}

var _ asset.DynamicSwapper = (*TDynamicSwapper)(nil)
