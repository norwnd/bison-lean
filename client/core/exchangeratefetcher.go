// This code is available on the terms of the project LICENSE.md file,
// also available online at https://blueoakcouncil.org/license/1.0.0.

package core

import (
	"context"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	"decred.org/dcrdex/dex"
	"decred.org/dcrdex/dex/dexnet"
	"decred.org/dcrdex/dex/fiatrates"
)

const (
	// DefaultFiatCurrency is the currency for displaying assets fiat value.
	DefaultFiatCurrency = "USD"
	// fiatRateRequestInterval is the amount of time between calls to the exchange API.
	fiatRateRequestInterval = 60 * time.Second
	// fiatRateDataExpiry : Any data older than fiatRateDataExpiry will be discarded.
	fiatRateDataExpiry = 150 * time.Second
	fiatRequestTimeout = time.Second * 15

	// Tokens. Used to identify fiat rate source, source name must not contain a
	// comma.
	messari       = "Messari"
	coinpaprika   = "Coinpaprika"
	dcrdataDotOrg = "dcrdata"
	binance       = "Binance"
)

var (
	btcBipID, _ = dex.BipSymbolID("btc")
	dcrBipID, _ = dex.BipSymbolID("dcr")

	dcrDataURL = "https://explorer.dcrdata.org/api/exchangerate"
	// The best info I can find on Messari says
	//    Without an API key requests are rate limited to 20 requests per minute
	//    and 1000 requests per day.
	// For a
	// fiatRateRequestInterval of 12 minutes, to hit 20 requests per minute, we
	// would need to have 20 * 12 = 480 assets. To hit 1000 requests per day,
	// we would need 12 * 60 / (86,400 / 1000) = 8.33 assets. Very likely. So
	// we're in a similar position to coinpaprika here too.
	messariURL = "https://data.messari.io/api/v1/assets/%s/metrics/market-data"
	binanceURL = "https://api.binance.com/api/v3/avgPrice?symbol=%sUSDT"
)

// fiatRateFetchers is the list of all supported fiat rate fetchers.
var fiatRateFetchers = map[string]rateFetcher{
	// disabling these for now because Binance is the only rate source that provides reasonably fresh
	// prices (coinpaprika and messari for example have string rate limits, and dcrdataDotOrg probably
	// has quite stale data)
	//coinpaprika:   FetchCoinpaprikaRates,
	//dcrdataDotOrg: FetchDcrdataRates,
	//messari:       FetchMessariRates,
	binance: FetchBinanceRates,
}

// fiatRateInfo holds the fiat rate and the last update time for an
// asset.
type fiatRateInfo struct {
	rate       float64
	lastUpdate time.Time
}

// rateFetcher can fetch fiat rates for assets from an API.
type rateFetcher func(context context.Context, logger dex.Logger, assets map[uint32]*SupportedAsset) map[uint32]float64

type commonRateSource struct {
	fetchRates rateFetcher

	mtx       sync.RWMutex
	fiatRates map[uint32]*fiatRateInfo
}

// isExpired checks the last update time for all fiat rates against the
// provided expiryTime. This only returns true if all rates are expired.
func (source *commonRateSource) isExpired(expiryTime time.Duration) bool {
	now := time.Now()

	source.mtx.RLock()
	defer source.mtx.RUnlock()
	if len(source.fiatRates) == 0 {
		return false
	}
	for _, rateInfo := range source.fiatRates {
		if now.Sub(rateInfo.lastUpdate) < expiryTime {
			return false // one not expired is enough
		}
	}
	return true
}

// assetRate returns the fiat rate information for the assetID specified. The
// fiatRateInfo returned should not be modified by the caller.
func (source *commonRateSource) assetRate(assetID uint32) *fiatRateInfo {
	source.mtx.RLock()
	defer source.mtx.RUnlock()
	return source.fiatRates[assetID]
}

// refreshRates updates the last update time and the rate information for assets.
func (source *commonRateSource) refreshRates(ctx context.Context, logger dex.Logger, assets map[uint32]*SupportedAsset) {
	fiatRates := source.fetchRates(ctx, logger, assets)
	now := time.Now()
	source.mtx.Lock()
	defer source.mtx.Unlock()
	for assetID, fiatRate := range fiatRates {
		if fiatRate <= 0 {
			continue
		}
		source.fiatRates[assetID] = &fiatRateInfo{
			rate:       fiatRate,
			lastUpdate: now,
		}
	}
}

// Used to initialize a fiat rate source.
func newCommonRateSource(fetcher rateFetcher) *commonRateSource {
	return &commonRateSource{
		fetchRates: fetcher,
		fiatRates:  make(map[uint32]*fiatRateInfo),
	}
}

// FetchCoinpaprikaRates retrieves and parses fiat rate data from the
// Coinpaprika API. See https://api.coinpaprika.com/#operation/getTickersById
// for sample request and response information.
func FetchCoinpaprikaRates(ctx context.Context, log dex.Logger, assets map[uint32]*SupportedAsset) map[uint32]float64 {
	coinpapAssets := make([]*fiatrates.CoinpaprikaAsset, 0, len(assets) /* too small cuz tokens*/)
	for assetID, a := range assets {
		coinpapAssets = append(coinpapAssets, &fiatrates.CoinpaprikaAsset{
			AssetID: assetID,
			Name:    a.Name,
			Symbol:  a.Symbol,
		})
	}
	return fiatrates.FetchCoinpaprikaRates(ctx, coinpapAssets, log)
}

// FetchDcrdataRates retrieves and parses fiat rate data from dcrdata
// exchange rate API.
func FetchDcrdataRates(ctx context.Context, log dex.Logger, assets map[uint32]*SupportedAsset) map[uint32]float64 {
	assetBTC := assets[btcBipID]
	assetDCR := assets[dcrBipID]
	noBTCAsset := assetBTC == nil || assetBTC.Wallet == nil
	noDCRAsset := assetDCR == nil || assetDCR.Wallet == nil
	if noBTCAsset && noDCRAsset {
		return nil
	}

	fiatRates := make(map[uint32]float64)
	res := new(struct {
		DcrPrice float64 `json:"dcrPrice"`
		BtcPrice float64 `json:"btcPrice"`
	})

	if err := getRates(ctx, dcrDataURL, res); err != nil {
		log.Error(err)
		return nil
	}

	if !noBTCAsset && !math.IsNaN(res.BtcPrice) && res.BtcPrice > 0 {
		fiatRates[btcBipID] = res.BtcPrice
	}
	if !noDCRAsset && !math.IsNaN(res.DcrPrice) && res.DcrPrice > 0 {
		fiatRates[dcrBipID] = res.DcrPrice
	}

	return fiatRates
}

// FetchMessariRates retrieves and parses fiat rate data from the Messari API.
// See https://messari.io/api/docs#operation/Get%20Asset%20Market%20Data for
// sample request and response information.
func FetchMessariRates(ctx context.Context, log dex.Logger, assets map[uint32]*SupportedAsset) map[uint32]float64 {
	fiatRates := make(map[uint32]float64)
	fetchRate := func(sa *SupportedAsset) {
		assetID := sa.ID
		if sa.Wallet == nil {
			// we don't want to fetch rate for assets with no wallet.
			return
		}

		res := new(struct {
			Data struct {
				MarketData struct {
					Price float64 `json:"price_usd"`
				} `json:"market_data"`
			} `json:"data"`
		})

		slug := dex.TokenSymbol(sa.Symbol)
		reqStr := fmt.Sprintf(messariURL, slug)

		ctx, cancel := context.WithTimeout(ctx, fiatRequestTimeout)
		defer cancel()

		if err := getRates(ctx, reqStr, res); err != nil {
			log.Errorf("Error getting fiat exchange rates from messari for asset %s: %v", sa.Symbol, err)
			return
		}

		price := res.Data.MarketData.Price
		if math.IsNaN(price) || price <= 0 {
			log.Errorf("Invalid price returned from messari for asset %s, price %v", sa.Symbol, price)
			return
		}
		fiatRates[assetID] = price
	}

	for _, sa := range assets {
		fetchRate(sa)
	}
	return fiatRates
}

func getRates(ctx context.Context, uri string, thing any) error {
	return dexnet.Get(ctx, uri, thing, dexnet.WithSizeLimit(1<<26))
}

// FetchBinanceRates retrieves and parses rate data from Binance API.
// See https://developers.binance.com/docs/binance-spot-api-docs/rest-api/public-api-endpoints
// for sample request and response information.
func FetchBinanceRates(ctx context.Context, log dex.Logger, assets map[uint32]*SupportedAsset) map[uint32]float64 {
	fiatRates := make(map[uint32]float64)
	fetchRate := func(sa *SupportedAsset) {
		if sa.Wallet == nil {
			// we don't want to fetch rate for assets with no wallet.
			return
		}

		ctx, cancel := context.WithTimeout(ctx, fiatRequestTimeout)
		defer cancel()

		res := new(struct {
			Minutes   int64  `json:"mins"`
			Price     string `json:"price"`
			CloseTime int64  `json:"closeTime"`
		})

		slug := strings.ToUpper(dex.TokenSymbol(sa.Symbol)) // API expects upper-case
		if slug == "USDT" {
			// for Binance, we use USDT instead of USD, and hence we take this shortcut here
			fiatRates[sa.ID] = 1.0
			return
		}
		if slug == "POLYGON" {
			slug = "POL" // Binance uses POL, not POLYGON
		}
		reqStr := fmt.Sprintf(binanceURL, slug)
		if err := getRates(ctx, reqStr, res); err != nil {
			log.Errorf("Error getting fiat exchange rates from Binance for asset %s: %v", sa.Symbol, err)
			return
		}

		price, err := strconv.ParseFloat(res.Price, 64)
		if err != nil {
			log.Errorf("Couldn't parse price returned from Binance for asset %s, err: %v", sa.Symbol, err)
			return
		}
		if math.IsNaN(price) || price <= 0 {
			log.Errorf("Invalid price returned from Binance for asset %s, price %v", sa.Symbol, price)
			return
		}

		fiatRates[sa.ID] = price
	}

	for _, sa := range assets {
		fetchRate(sa)
	}

	return fiatRates
}
