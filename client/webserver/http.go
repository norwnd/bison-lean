// This code is available on the terms of the project LICENSE.md file,
// also available online at https://blueoakcouncil.org/license/1.0.0.

package webserver

import (
	"encoding/csv"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"decred.org/dcrdex/client/asset"
	"decred.org/dcrdex/client/core"
	"decred.org/dcrdex/dex"
	"decred.org/dcrdex/dex/order"
	qrcode "github.com/skip2/go-qrcode"
)

const (
	homeRoute        = "/"
	registerRoute    = "/register"
	initRoute        = "/init"
	loginRoute       = "/login"
	walletsRoute     = "/wallets"
	walletLogRoute   = "/wallets/logfile"
	exportOrderRoute = "/orders/export"
)

// knownUnregisteredExchanges returns all the known exchanges that
// the user has not registered for.
func (s *WebServer) knownUnregisteredExchanges(registeredExchanges map[string]*core.Exchange) []string {
	certs := core.CertStore[s.core.Network()]
	exchanges := make([]string, 0, len(certs))
	for host := range certs {
		xc := registeredExchanges[host]
		if xc == nil || xc.Auth.TargetTier == 0 {
			exchanges = append(exchanges, host)
		}
	}
	for host, xc := range registeredExchanges {
		if certs[host] != nil || xc.Auth.TargetTier > 0 {
			continue
		}
		exchanges = append(exchanges, host)
	}
	return exchanges
}

// handleWalletLogFile is the handler for the '/wallets/logfile' page request.
func (s *WebServer) handleWalletLogFile(w http.ResponseWriter, r *http.Request) {
	err := r.ParseForm()
	if err != nil {
		log.Errorf("error parsing form for wallet log file: %v", err)
		http.Error(w, http.StatusText(http.StatusBadRequest), http.StatusBadRequest)
		return
	}

	assetIDQueryString := r.Form["assetid"]
	if len(assetIDQueryString) != 1 || len(assetIDQueryString[0]) == 0 {
		log.Error("could not find asset id in query string")
		http.Error(w, http.StatusText(http.StatusBadRequest), http.StatusBadRequest)
		return
	}

	assetID, err := strconv.ParseUint(assetIDQueryString[0], 10, 32)
	if err != nil {
		log.Errorf("failed to parse asset id query string %v", err)
		http.Error(w, http.StatusText(http.StatusBadRequest), http.StatusBadRequest)
		return
	}

	logFilePath, err := s.core.WalletLogFilePath(uint32(assetID))
	if err != nil {
		log.Errorf("failed to get log file path %v", err)
		http.Error(w, http.StatusText(http.StatusBadRequest), http.StatusBadRequest)
		return
	}

	logFile, err := os.Open(logFilePath)
	if err != nil {
		log.Errorf("error opening log file: %v", err)
		http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
		return
	}
	defer logFile.Close()

	assetName := dex.BipIDSymbol(uint32(assetID))
	logFileName := fmt.Sprintf("dcrdex-%s-wallet.log", assetName)
	w.Header().Set("Content-Disposition", "attachment; filename="+logFileName)
	w.Header().Set("Content-Type", "text/plain")
	w.WriteHeader(http.StatusOK)

	_, err = io.Copy(w, logFile)
	if err != nil {
		log.Errorf("error copying log file: %v", err)
	}
}

// handleGenerateQRCode is the handler for the '/generateqrcode' page request
func (s *WebServer) handleGenerateQRCode(w http.ResponseWriter, r *http.Request) {
	err := r.ParseForm()
	if err != nil {
		log.Errorf("error parsing form for generate qr code: %v", err)
		http.Error(w, http.StatusText(http.StatusBadRequest), http.StatusBadRequest)
		return
	}

	address := r.Form["address"]
	if len(address) != 1 || len(address[0]) == 0 {
		log.Error("form for generating qr code does not contain address")
		http.Error(w, http.StatusText(http.StatusBadRequest), http.StatusBadRequest)
		return
	}

	png, err := qrcode.Encode(address[0], qrcode.Medium, 200)
	if err != nil {
		log.Error("error generating qr code: %v", err)
		http.Error(w, http.StatusText(http.StatusBadRequest), http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Content-Length", strconv.Itoa(len(png)))
	w.WriteHeader(http.StatusOK)

	_, err = w.Write(png)
	if err != nil {
		log.Errorf("error writing qr code image: %v", err)
	}
}

// handleGenerateCompanionAppQRCode is the handler for the
// '/generatecompanionappqrcode' page request.
func (s *WebServer) handleGenerateCompanionAppQRCode(w http.ResponseWriter, r *http.Request) {
	if s.onion == "" {
		http.Error(w, "Tor must be enabled to pair a companion app", http.StatusBadRequest)
		return
	}

	authToken := s.authorizeCompanion()
	url := fmt.Sprintf("%s?%s=%s", s.onion, authCK, authToken)

	png, err := qrcode.Encode(url, qrcode.Medium, 200)
	if err != nil {
		log.Error("error generating qr code: %v", err)
		http.Error(w, http.StatusText(http.StatusBadRequest), http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Content-Length", strconv.Itoa(len(png)))
	w.WriteHeader(http.StatusOK)

	_, err = w.Write(png)
	if err != nil {
		log.Errorf("error writing qr code image: %v", err)
	}
}

// handleExportOrders is the handler for the /orders/export page request.
func (s *WebServer) handleExportOrders(w http.ResponseWriter, r *http.Request) {
	filter := new(core.OrderFilter)
	err := r.ParseForm()
	if err != nil {
		log.Errorf("error parsing form for export order: %v", err)
		http.Error(w, http.StatusText(http.StatusBadRequest), http.StatusBadRequest)
		return
	}

	nStr := r.Form.Get("n")
	if nStr != "" {
		n, err := strconv.ParseInt(nStr, 10, 32)
		if err != nil {
			log.Errorf("error parsing N: %v", err)
			http.Error(w, http.StatusText(http.StatusBadRequest), http.StatusBadRequest)
			return
		}
		filter.N = int(n)
	}
	fresherThanUnixMsStr := r.Form.Get("fresherThanUnixMs")
	if fresherThanUnixMsStr != "" {
		fresherThanUnixMs, err := strconv.ParseUint(fresherThanUnixMsStr, 10, 64)
		if err != nil {
			log.Errorf("error parsing fresherThanUnixMs: %v", err)
			http.Error(w, http.StatusText(http.StatusBadRequest), http.StatusBadRequest)
			return
		}
		filter.FresherThanUnixMs = fresherThanUnixMs
	}

	filter.Hosts = r.Form["hosts"]
	assets := r.Form["assets"]
	filter.Assets = make([]uint32, len(assets))
	for k, assetStrID := range assets {
		assetNumID, err := strconv.ParseUint(assetStrID, 10, 32)
		if err != nil {
			log.Errorf("error parsing asset id: %v", err)
			http.Error(w, http.StatusText(http.StatusBadRequest), http.StatusBadRequest)
			return
		}
		filter.Assets[k] = uint32(assetNumID)
	}
	statuses := r.Form["statuses"]
	filter.Statuses = make([]order.OrderStatus, len(statuses))
	for k, statusStrID := range statuses {
		statusNumID, err := strconv.ParseUint(statusStrID, 10, 16)
		if err != nil {
			http.Error(w, http.StatusText(http.StatusBadRequest), http.StatusBadRequest)
			log.Errorf("error parsing status id: %v", err)
			return
		}
		filter.Statuses[k] = order.OrderStatus(statusNumID)
	}
	filter.CompletedOnly = r.Form.Get("completedOnly") == "true"

	ords, err := s.core.Orders(filter)
	if err != nil {
		log.Errorf("error retrieving order: %v", err)
		http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Disposition", "attachment; filename=orders.csv")
	w.Header().Set("Content-Type", "text/csv")
	w.WriteHeader(http.StatusOK)
	csvWriter := csv.NewWriter(w)
	csvWriter.UseCRLF = strings.Contains(r.UserAgent(), "Windows")

	err = csvWriter.Write([]string{
		"Host",
		"Base",
		"Quote",
		"Base Quantity",
		"Order Rate",
		"Actual Rate",
		"Base Fees",
		"Base Fees Asset",
		"Quote Fees",
		"Quote Fees Asset",
		"Type",
		"Side",
		"Time in Force",
		"Status",
		"Filled (%)",
		"Settled (%)",
		"Time",
	})
	if err != nil {
		log.Errorf("error writing CSV: %v", err)
		return
	}
	csvWriter.Flush()
	err = csvWriter.Error()
	if err != nil {
		log.Errorf("error writing CSV: %v", err)
		return
	}

	for _, ord := range ords {
		ordReader := s.orderReader(ord)

		timestamp := time.UnixMilli(int64(ord.Stamp)).Local().Format(time.RFC3339Nano)
		err = csvWriter.Write([]string{
			ord.Host,                      // Host
			ord.BaseSymbol,                // Base
			ord.QuoteSymbol,               // Quote
			ordReader.BaseQtyString(),     // Base Quantity
			ordReader.SimpleRateString(),  // Order Rate
			ordReader.AverageRateString(), // Actual Rate
			ordReader.BaseAssetFees(),     // Base Fees
			ordReader.BaseFeeSymbol(),     // Base Fees Asset
			ordReader.QuoteAssetFees(),    // Quote Fees
			ordReader.QuoteFeeSymbol(),    // Quote Fees Asset
			ordReader.Type.String(),       // Type
			ordReader.SideString(),        // Side
			ord.TimeInForce.String(),      // Time in Force
			ordReader.StatusString(),      // Status
			ordReader.FilledPercent(),     // Filled
			ordReader.SettledPercent(),    // Settled
			timestamp,                     // Time
		})
		if err != nil {
			log.Errorf("error writing CSV: %v", err)
			return
		}
		csvWriter.Flush()
		err = csvWriter.Error()
		if err != nil {
			log.Errorf("error writing CSV: %v", err)
			return
		}
	}
}

func defaultUnitInfo(symbol string) dex.UnitInfo {
	return dex.UnitInfo{
		AtomicUnit: "atoms",
		Conventional: dex.Denomination{
			ConversionFactor: 1e8,
			Unit:             symbol,
		},
	}
}

func (s *WebServer) orderReader(ord *core.Order) *core.OrderReader {
	unitInfo := func(assetID uint32, symbol string) dex.UnitInfo {
		unitInfo, err := asset.UnitInfo(assetID)
		if err == nil {
			return unitInfo
		}
		xc := s.core.Exchanges()[ord.Host]
		a, found := xc.Assets[assetID]
		if !found || a.UnitInfo.Conventional.ConversionFactor == 0 {
			return defaultUnitInfo(symbol)
		}
		return a.UnitInfo
	}

	feeAssetInfo := func(assetID uint32, symbol string) (string, dex.UnitInfo) {
		if token := asset.TokenInfo(assetID); token != nil {
			parentAsset := asset.Asset(token.ParentID)
			return unbip(parentAsset.ID), parentAsset.Info.UnitInfo
		}
		return unbip(assetID), unitInfo(assetID, symbol)
	}

	baseFeeAssetSymbol, baseFeeUintInfo := feeAssetInfo(ord.BaseID, ord.BaseSymbol)
	quoteFeeAssetSymbol, quoteFeeUnitInfo := feeAssetInfo(ord.QuoteID, ord.QuoteSymbol)

	return &core.OrderReader{
		Order:               ord,
		BaseUnitInfo:        unitInfo(ord.BaseID, ord.BaseSymbol),
		BaseFeeUnitInfo:     baseFeeUintInfo,
		BaseFeeAssetSymbol:  baseFeeAssetSymbol,
		QuoteUnitInfo:       unitInfo(ord.QuoteID, ord.QuoteSymbol),
		QuoteFeeUnitInfo:    quoteFeeUnitInfo,
		QuoteFeeAssetSymbol: quoteFeeAssetSymbol,
	}
}
