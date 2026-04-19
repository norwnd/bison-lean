//go:build !harness && !botlive

package core

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"decred.org/dcrdex/client/db"
	dbtest "decred.org/dcrdex/client/db/test"
	"decred.org/dcrdex/dex"
	"decred.org/dcrdex/dex/order"
	ordertest "decred.org/dcrdex/dex/order/test"
)

func TestNotifications(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()

	// Insert a notification into the database.
	typedNote := newOrderNote("123", "abc", "def", 100, nil)

	tCore := rig.core
	ch := tCore.NotificationFeed()
	tCore.notify(typedNote)
	select {
	case n := <-ch.C:
		dbtest.MustCompareNotifications(t, n.DBNote(), &typedNote.Notification)
	case <-time.After(time.Second):
		t.Fatalf("no notification received over the notification channel")
	}
}

func TestAddrHost(t *testing.T) {
	tests := []struct {
		name, addr, want string
		wantErr          bool
	}{{
		name: "scheme, host, and port",
		addr: "https://localhost:5758",
		want: "localhost:5758",
	}, {
		name: "scheme, ipv6 host, and port",
		addr: "https://[::1]:5758",
		want: "[::1]:5758",
	}, {
		name: "host and port",
		addr: "localhost:5758",
		want: "localhost:5758",
	}, {
		name: "just port",
		addr: ":5758",
		want: "localhost:5758",
	}, {
		name: "ip host and port",
		addr: "127.0.0.1:5758",
		want: "127.0.0.1:5758",
	}, {
		name: "just host",
		addr: "thatonedex.com",
		want: "thatonedex.com:7232",
	}, {
		name: "scheme and host",
		addr: "https://thatonedex.com",
		want: "thatonedex.com:7232",
	}, {
		name: "scheme, host, and path",
		addr: "https://thatonedex.com/any/path",
		want: "thatonedex.com:7232",
	}, {
		name: "ipv6 host",
		addr: "[1:2::]",
		want: "[1:2::]:7232",
	}, {
		name: "ipv6 host and port",
		addr: "[1:2::]:5758",
		want: "[1:2::]:5758",
	}, {
		name: "empty address",
		want: "localhost:7232",
	}, {
		name:    "invalid host",
		addr:    "https://\n:1234",
		wantErr: true,
	}, {
		name:    "invalid port",
		addr:    ":asdf",
		wantErr: true,
	}}
	for _, test := range tests {
		res, err := addrHost(test.addr)
		if res != test.want {
			t.Fatalf("wanted %s but got %s for test '%s'", test.want, res, test.name)
		}
		if test.wantErr {
			if err == nil {
				t.Fatalf("wanted error for test %s, but got none", test.name)
			}
			continue
		} else if err != nil {
			t.Fatalf("addrHost error for test %s: %v", test.name, err)
		}
		// Parsing results a second time should produce the same results.
		res, _ = addrHost(res)
		if res != test.want {
			t.Fatalf("wanted %s but got %s for test '%s'", test.want, res, test.name)
		}
	}
}

func TestParseCert(t *testing.T) {
	byteCert := []byte{0x0a, 0x0b}
	cert, err := parseCert("anyhost", []byte{0x0a, 0x0b}, dex.Mainnet)
	if err != nil {
		t.Fatalf("byte cert error: %v", err)
	}
	if !bytes.Equal(cert, byteCert) {
		t.Fatalf("byte cert note returned unmodified. expected %x, got %x", byteCert, cert)
	}
	byteCert = []byte{0x05, 0x06}
	certFile, _ := os.CreateTemp("", "dumbcert")
	defer os.Remove(certFile.Name())
	certFile.Write(byteCert)
	certFile.Close()
	cert, err = parseCert("anyhost", certFile.Name(), dex.Mainnet)
	if err != nil {
		t.Fatalf("file cert error: %v", err)
	}
	if !bytes.Equal(cert, byteCert) {
		t.Fatalf("byte cert note returned unmodified. expected %x, got %x", byteCert, cert)
	}
	_, err = parseCert("bison.exchange:17232", []byte(nil), dex.Testnet)
	if err != nil {
		t.Fatalf("CertStore cert error: %v", err)
	}
}

func TestDeleteOrderFn(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core

	randomOdrs := func() []*db.MetaOrder {
		acct1 := dbtest.RandomAccountInfo()
		acct2 := dbtest.RandomAccountInfo()
		base1, quote1 := tUTXOAssetA.ID, tUTXOAssetB.ID
		base2, quote2 := tACCTAsset.ID, tUTXOAssetA.ID
		n := rand.IntN(9) + 1
		orders := make([]*db.MetaOrder, n)
		for i := 0; i < n; i++ {
			acct := acct1
			base, quote := base1, quote1
			if i%2 == 1 {
				acct = acct2
				base, quote = base2, quote2
			}
			ord := randOrderForMarket(base, quote)
			orders[i] = &db.MetaOrder{
				MetaData: &db.OrderMetaData{
					Status:             order.OrderStatus(rand.IntN(5) + 1),
					Host:               acct.Host,
					Proof:              db.OrderProof{DEXSig: randBytes(73)},
					SwapFeesPaid:       rand.Uint64(),
					RedemptionFeesPaid: rand.Uint64(),
				},
				Order: ord,
			}
		}
		return orders
	}

	ordersFile, err := os.CreateTemp("", "delete_archives_test_orders")
	if err != nil {
		t.Fatal(err)
	}
	ordersFileName := ordersFile.Name()
	ordersFile.Close()
	os.Remove(ordersFileName)

	tests := []struct {
		name, ordersFileStr string
		wantErr             bool
	}{{
		name:          "ok orders and file save",
		ordersFileStr: ordersFileName,
	}, {
		name:          "bad file (already closed)",
		ordersFileStr: ordersFileName,
		wantErr:       true,
	}}

	for _, test := range tests {
		perOrdFn, cleanupFn, err := tCore.deleteOrderFn(test.ordersFileStr)
		if test.wantErr {
			if err != nil {
				continue
			}
			t.Fatalf("%q: expected error", test.name)
		}
		if err != nil {
			t.Fatalf("%q: unexpected failure: %v", test.name, err)
		}
		for _, o := range randomOdrs() {
			err = perOrdFn(o)
			if err != nil {
				t.Fatalf("%q: unexpected failure: %v", test.name, err)
			}
		}
		cleanupFn()
	}

	b, err := os.ReadFile(ordersFileName)
	if err != nil {
		t.Fatalf("unable to read file: %s", ordersFileName)
	}
	fmt.Println(string(b))
	os.Remove(ordersFileName)
}

func TestDeleteMatchFn(t *testing.T) {
	randomMtchs := func() []*db.MetaMatch {
		base, quote := tUTXOAssetA.ID, tUTXOAssetB.ID
		acct := dbtest.RandomAccountInfo()
		n := rand.IntN(9) + 1
		metaMatches := make([]*db.MetaMatch, 0, n)
		for i := 0; i < n; i++ {
			m := &db.MetaMatch{
				MetaData: &db.MatchMetaData{
					Proof: *dbtest.RandomMatchProof(0.5),
					DEX:   acct.Host,
					Base:  base,
					Quote: quote,
					Stamp: rand.Uint64(),
				},
				UserMatch: ordertest.RandomUserMatch(),
			}
			if i%2 == 1 {
				m.Status = order.MatchStatus(rand.IntN(4))
			} else {
				m.Status = order.MatchComplete              // inactive
				m.MetaData.Proof.Auth.RedeemSig = []byte{0} // redeemSig required for MatchComplete to be considered inactive
			}
			metaMatches = append(metaMatches, m)
		}
		return metaMatches
	}

	matchesFile, err := os.CreateTemp("", "delete_archives_test_matches")
	if err != nil {
		t.Fatal(err)
	}
	matchesFileName := matchesFile.Name()
	matchesFile.Close()
	os.Remove(matchesFileName)

	tests := []struct {
		name, matchesFileStr string
		wantErr              bool
	}{{
		name:           "ok matches and file save",
		matchesFileStr: matchesFileName,
	}, {
		name:           "bad file (already closed)",
		matchesFileStr: matchesFileName,
		wantErr:        true,
	}}

	for _, test := range tests {
		perMatchFn, cleanupFn, err := deleteMatchFn(test.matchesFileStr)
		if test.wantErr {
			if err != nil {
				continue
			}
			t.Fatalf("%q: expected error", test.name)
		}
		if err != nil {
			t.Fatalf("%q: unexpected failure: %v", test.name, err)
		}
		for _, m := range randomMtchs() {
			err = perMatchFn(m, true)
			if err != nil {
				t.Fatalf("%q: unexpected failure: %v", test.name, err)
			}
		}
		cleanupFn()
	}

	b, err := os.ReadFile(matchesFileName)
	if err != nil {
		t.Fatalf("unable to read file: %s", matchesFileName)
	}
	fmt.Println(string(b))
	os.Remove(matchesFileName)
}

func TestDeleteArchivedRecords(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core
	tdb := tCore.db.(*TDB)

	tempFile := func(suffix string) (path string) {
		matchesFile, err := os.CreateTemp("", suffix+"delete_archives_test_matches")
		if err != nil {
			t.Fatal(err)
		}
		matchesFileName := matchesFile.Name()
		matchesFile.Close()
		os.Remove(matchesFileName)
		return matchesFileName
	}

	tests := []struct {
		name                                              string
		olderThan                                         *time.Time
		matchesFileStr, ordersFileStr                     string
		archivedMatches, archivedOrders                   int
		deleteInactiveOrdersErr, deleteInactiveMatchesErr error
		wantErr                                           bool
	}{{
		name:            "ok no order or file save",
		archivedMatches: 12,
		archivedOrders:  24,
	}, {
		name:            "ok orders and file save",
		ordersFileStr:   tempFile("abc"),
		matchesFileStr:  tempFile("123"),
		archivedMatches: 34,
		archivedOrders:  67,
	}, {
		name:                    "orders save error",
		ordersFileStr:           tempFile("abc"),
		deleteInactiveOrdersErr: errors.New(""),
		wantErr:                 true,
	}, {
		name:                     "matches save error",
		matchesFileStr:           tempFile("123"),
		deleteInactiveMatchesErr: errors.New(""),
		wantErr:                  true,
	}}

	for _, test := range tests {
		tdb.archivedMatches = test.archivedMatches
		tdb.archivedOrders = test.archivedOrders
		tdb.deleteInactiveOrdersErr = test.deleteInactiveOrdersErr
		tdb.deleteInactiveMatchesErr = test.deleteInactiveMatchesErr
		nRecordsDeleted, err := tCore.DeleteArchivedRecords(test.olderThan, test.matchesFileStr, test.ordersFileStr)
		if test.wantErr {
			if err != nil {
				continue
			}
			t.Fatalf("%q: expected error", test.name)
		}
		if err != nil {
			t.Fatalf("%q: unexpected failure: %v", test.name, err)
		}
		expectedRecords := test.archivedMatches + test.archivedOrders
		if nRecordsDeleted != expectedRecords {
			t.Fatalf("%s: Expected %d deleted records, got %d", test.name, expectedRecords, nRecordsDeleted)
		}
	}
}

func TestLCM(t *testing.T) {
	tests := []struct {
		name                                  string
		a, b, wantDenom, wantMultA, wantMultB uint64
	}{{
		name:      "ok 5 and 10",
		a:         5,
		b:         10,
		wantDenom: 10,
		wantMultA: 2,
		wantMultB: 1,
	}, {
		name:      "ok 3 and 7",
		a:         3,
		b:         7,
		wantDenom: 21,
		wantMultA: 7,
		wantMultB: 3,
	}, {
		name:      "ok 6 and 34",
		a:         34,
		b:         6,
		wantDenom: 102,
		wantMultA: 3,
		wantMultB: 17,
	}}

	for _, test := range tests {
		denom, multA, multB := lcm(test.a, test.b)
		if denom != test.wantDenom || multA != test.wantMultA || multB != test.wantMultB {
			t.Fatalf("%q: expected %d %d %d but got %d %d %d", test.name,
				test.wantDenom, test.wantMultA, test.wantMultB, denom, multA, multB)
		}
	}
}

func TestToggleRateSourceStatus(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core

	// Note: fiatRateFetchers used to include coinpaprika/dcrdata/messari,
	// but those are now commented out — Binance is the only enabled source
	// (see exchangeratefetcher.go). The test was written before the prune
	// and still referenced "binance" as an invalid source and coinpaprika as
	// the valid one. Updated to use the currently-valid source and a
	// made-up invalid name.
	tests := []struct {
		name, source  string
		wantErr, init bool
	}{{
		name:    "Invalid rate source",
		source:  "nonexistent-source",
		wantErr: true,
	}, {
		name:    "ok valid source",
		source:  binance,
		wantErr: false,
	}, {
		name:    "ok already disabled/not initialized || enabled",
		source:  binance,
		wantErr: false,
	}}

	// Test disabling fiat rate source.
	for _, test := range tests {
		err := tCore.ToggleRateSourceStatus(test.source, true)
		if test.wantErr != (err != nil) {
			t.Fatalf("%s: wantErr = %t, err = %v", test.name, test.wantErr, err)
		}
	}

	// Test enabling fiat rate source.
	for _, test := range tests {
		if test.init {
			tCore.fiatRateSources[test.source] = newCommonRateSource(tFetcher)
		}
		err := tCore.ToggleRateSourceStatus(test.source, false)
		if test.wantErr != (err != nil) {
			t.Fatalf("%s: wantErr = %t, err = %v", test.name, test.wantErr, err)
		}
	}
}

func TestFiatRateSources(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core
	supportedFetchers := len(fiatRateFetchers)
	rateSources := tCore.FiatRateSources()
	if len(rateSources) != supportedFetchers {
		t.Fatalf("Expected %d number of fiat rate source/fetchers", supportedFetchers)
	}
}

func TestFiatConversions(t *testing.T) {
	rig := newTestRig()
	defer rig.shutdown()
	tCore := rig.core

	// No fiat rate source initialized
	fiatRates := tCore.fiatConversions()
	if len(fiatRates) != 0 {
		t.Fatal("Unexpected asset rate values.")
	}

	// Initialize fiat rate sources.
	for token := range fiatRateFetchers {
		tCore.fiatRateSources[token] = newCommonRateSource(tFetcher)
	}

	// Fetch fiat rates.
	tCore.wg.Add(1)
	go func() {
		defer tCore.wg.Done()
		tCore.refreshFiatRates(tCtx)
	}()
	tCore.wg.Wait()

	// Expects assets fiat rate values.
	fiatRates = tCore.fiatConversions()
	if len(fiatRates) != 2 {
		t.Fatal("Expected assets fiat rate for two assets")
	}

	// fiat rates for assets can expire, and fiat rate fetchers can be
	// removed if expired.
	for token, source := range tCore.fiatRateSources {
		source.fiatRates[tUTXOAssetA.ID].lastUpdate = time.Now().Add(-time.Minute)
		source.fiatRates[tUTXOAssetB.ID].lastUpdate = time.Now().Add(-time.Minute)
		if source.isExpired(55 * time.Second) {
			delete(tCore.fiatRateSources, token)
		}
	}

	fiatRates = tCore.fiatConversions()
	if len(fiatRates) != 0 {
		t.Fatal("Unexpected assets fiat rate values, expected to ignore expired fiat rates.")
	}

	if len(tCore.fiatRateSources) != 0 {
		t.Fatal("Expected fiat conversion to be disabled, all rate source data has expired.")
	}
}

func TestPokesCacheInit(t *testing.T) {
	tPokes := []*db.Notification{
		{DetailText: "poke 1"},
		{DetailText: "poke 2"},
		{DetailText: "poke 3"},
		{DetailText: "poke 4"},
		{DetailText: "poke 5"},
	}
	{
		pokesCapacity := 6
		c := newPokesCache(pokesCapacity)
		c.init(tPokes)

		// Check if the cache is initialized correctly
		if len(c.cache) != 5 {
			t.Errorf("Expected cache length %d, got %d", len(tPokes), len(c.cache))
		}

		if c.cursor != 5 {
			t.Errorf("Expected cursor %d, got %d", len(tPokes)%pokesCapacity, c.cursor)
		}

		// Check if the cache contains the correct pokes
		for i, poke := range tPokes {
			if c.cache[i] != poke {
				t.Errorf("Expected poke %v at index %d, got %v", poke, i, c.cache[i])
			}
		}
	}
	{
		pokesCapacity := 4
		c := newPokesCache(pokesCapacity)
		c.init(tPokes)

		// Check if the cache is initialized correctly
		if len(c.cache) != 1 {
			t.Errorf("Expected cache length %d, got %d", 1, len(c.cache))
		}

		if c.cursor != 1 {
			t.Errorf("Expected cursor %d, got %d", 1, c.cursor)
		}

		// Check if the cache contains the correct pokes
		for i, poke := range tPokes[:len(tPokes)-pokesCapacity] {
			if c.cache[i] != poke {
				t.Errorf("Expected poke %v at index %d, got %v", poke, i, c.cache[i])
			}
		}
	}
}

func TestPokesAdd(t *testing.T) {
	tPokes := []*db.Notification{
		{DetailText: "poke 1"},
		{DetailText: "poke 2"},
		{DetailText: "poke 3"},
		{DetailText: "poke 4"},
		{DetailText: "poke 5"},
	}
	tNewPoke := &db.Notification{
		DetailText: "poke 6",
	}
	{
		pokesCapacity := 6
		c := newPokesCache(pokesCapacity)
		c.init(tPokes)
		c.add(tNewPoke)

		// Check if the cache is updated correctly
		if len(c.cache) != 6 {
			t.Errorf("Expected cache length %d, got %d", len(tPokes), len(c.cache))
		}

		if c.cursor != 0 {
			t.Errorf("Expected cursor %d, got %d", 0, c.cursor)
		}

		// Check if the cache contains the correct pokes
		tAllPokes := append(tPokes, tNewPoke)
		for i, poke := range tAllPokes {
			if c.cache[i] != poke {
				t.Errorf("Expected poke %v at index %d, got %v", poke, i, c.cache[i])
			}
		}
	}
	{
		pokesCapacity := 5
		c := newPokesCache(pokesCapacity)
		c.init(tPokes)
		c.add(tNewPoke)

		// Check if the cache is updated correctly
		if len(c.cache) != pokesCapacity {
			t.Errorf("Expected cache length %d, got %d", pokesCapacity, len(c.cache))
		}

		if c.cursor != 1 {
			t.Errorf("Expected cursor %d, got %d", 1, c.cursor)
		}

		// Check if the cache contains the correct pokes
		tAllPokes := make([]*db.Notification, 0)
		tAllPokes = append(tAllPokes, tNewPoke)
		tAllPokes = append(tAllPokes, tPokes[1:]...)
		for i, poke := range tAllPokes {
			if c.cache[i] != poke {
				t.Errorf("Expected poke %v at index %d, got %v", poke, i, c.cache[i])
			}
		}
	}
}

func TestPokesCachePokes(t *testing.T) {
	tPokes := []*db.Notification{
		{TimeStamp: 1, DetailText: "poke 1"},
		{TimeStamp: 2, DetailText: "poke 2"},
		{TimeStamp: 3, DetailText: "poke 3"},
		{TimeStamp: 4, DetailText: "poke 4"},
		{TimeStamp: 5, DetailText: "poke 5"},
	}
	{
		pokesCapacity := 6
		c := newPokesCache(pokesCapacity)
		c.init(tPokes)
		pokes := c.pokes()

		// Check if the result length is correct
		if len(pokes) != len(tPokes) {
			t.Errorf("Expected pokes length %d, got %d", len(tPokes), len(pokes))
		}

		// Check if the result contains the correct pokes
		for i, poke := range tPokes {
			if pokes[i] != poke {
				t.Errorf("Expected poke %v at index %d, got %v", poke, i, pokes[i])
			}
		}
	}
	{
		pokesCapacity := 5
		tNewPoke := &db.Notification{
			TimeStamp:  6,
			DetailText: "poke 6",
		}
		c := newPokesCache(pokesCapacity)
		c.init(tPokes)
		c.add(tNewPoke)
		pokes := c.pokes()

		// Check if the result length is correct
		if len(pokes) != pokesCapacity {
			t.Errorf("Expected cache length %d, got %d", 1, len(pokes))
		}

		tAllPokes := append(tPokes[1:], tNewPoke)
		// Check if the result contains the correct pokes
		for i, poke := range tAllPokes {
			if pokes[i] != poke {
				t.Errorf("Expected poke %v at index %d, got %v", poke, i, pokes[i])
			}
		}
	}
}
