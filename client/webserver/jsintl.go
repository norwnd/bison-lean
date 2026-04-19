// jsintl.go holds an English-side mirror of the frontend's i18n keys for the
// `cmd/translationsreport` translator-worksheet pipeline. It is NOT the
// runtime i18n source for the web UI.
//
// The React frontend's live translations come from
// `client/webserver/site/src/i18n/en-US.json`, loaded via react-i18next in
// `client/webserver/site/src/i18n/index.ts`. Edits there take effect at
// runtime; edits here do not.
//
// The `enUS` map below is consumed only by
// `client/cmd/translationsreport/main.go` (via RegisterTranslations), which
// pairs it against per-locale `notifications` / `html` / `js` maps elsewhere
// to emit a `worksheets/<lang>.json` file per non-en-US locale listing the
// English strings that lack a translation. With `localesMap` currently
// enumerating only en-US and `client/core/locale_ntfn.go`'s `locales` map
// likewise en-US-only (removed in `f9bfeba2`, 2024-12), the tool produces
// empty output today; the worksheet plumbing is kept so a single map
// re-registration can revive the workflow.
//
// `localesMap` is also consumed at webserver startup to enumerate the list
// of supported language tags returned in the `/api/user` / `/api/login`
// response (`s.langs`), which the React frontend uses for locale-aware
// formatting (`Intl.NumberFormat`, `toLocaleLowerCase`, etc.).
//
// TL;DR: changing a string here does NOT change what users see in the app.

package webserver

import "decred.org/dcrdex/client/intl"

const (
	noPassErrMsgID                   = "NO_PASS_ERROR_MSG"
	noAppPassErrMsgID                = "NO_APP_PASS_ERROR_MSG"
	hideAdditionalSettingsID         = "HIDE_ADDITIONAL_SETTINGS"
	showAdditionalSettingsID         = "SHOW_ADDITIONAL_SETTINGS"
	buyID                            = "BUY"
	sellID                           = "SELL"
	versionNotSupportedID            = "VERSION_NOT_SUPPORTED"
	executedID                       = "EXECUTED"
	bookedID                         = "BOOKED"
	cancelingID                      = "CANCELING"
	passwordNotMatchID               = "PASSWORD_NOT_MATCH"
	acctUndefinedID                  = "ACCT_UNDEFINED"
	lotsID                           = "LOTS"
	unknownID                        = "UNKNOWN"
	epochID                          = "EPOCH"
	orderSubmittingID                = "ORDER_SUBMITTING"
	settlingID                       = "SETTLING"
	noMatchID                        = "NO_MATCH"
	canceledID                       = "CANCELED"
	revokedID                        = "REVOKED"
	waitingForConfsID                = "WAITING_FOR_CONFS"
	noneSelectedID                   = "NONE_SELECTED"
	apiErrorID                       = "API_ERROR"
	addID                            = "ADD"
	createID                         = "CREATE"
	walletReadyID                    = "WALLET_READY"
	lockedID                         = "LOCKED"
	feeBalanceID                     = "FEE_BALANCE"
	invalidDateErrorMsgID            = "INVALID_DATE_ERR_MSG"
	noArchivedRecordsID              = "NO_ARCHIVED_RECORDS"
	deleteArchivedRecordsID          = "DELETE_ARCHIVED_RECORDS_RESULT"
	archivedRecordsPathID            = "ARCHIVED_RECORDS_PATH"
	defaultID                        = "DEFAULT"
	addedID                          = "ADDED"
	discoveredID                     = "DISCOVERED"
	limitOrderID                     = "LIMIT_ORDER"
	limitOrderImmediateTifID         = "LIMIT_ORDER_IMMEDIATE_TIF"
	marketOrderID                    = "MARKET_ORDER"
	matchStatusNewlyMatchedID        = "MATCH_STATUS_NEWLY_MATCHED"
	matchStatusMakerSwapCastID       = "MATCH_STATUS_MAKER_SWAP_CAST"
	matchStatusTakerSwapCastID       = "MATCH_STATUS_TAKER_SWAP_CAST"
	matchStatusMakerRedeemedID       = "MATCH_STATUS_MAKER_REDEEMED"
	matchStatusRedemptionSentID      = "MATCH_STATUS_REDEMPTION_SENT"
	matchStatusRedemptionConfirmedID = "MATCH_REDEMPTION_CONFIRMED"
	matchStatusRevokedID             = "MATCH_STATUS_REVOKED"
	matchStatusRefundedID            = "MATCH_STATUS_REFUNDED"
	matchStatusRefundPendingID       = "MATCH_STATUS_REFUND_PENDING"
	matchStatusRedeemPendingID       = "MATCH_STATUS_REDEEM_PENDING"
	matchStatusCompleteID            = "MATCH_STATUS_COMPLETE"
	orderAccelerationFeeErrMsgID     = "ORDER_ACCELERATION_FEE_ERR_MSG"
	orderAccelerationErrMsgID        = "ORDER_ACCELERATION_ERR_MSG"
	connectedID                      = "CONNECTED"
	invalidCertID                    = "INVALID_CERTIFICATE"
	confirmationsID                  = "CONFIRMATIONS"
	takerID                          = "TAKER"
	makerID                          = "MAKER"
	emptyDexAddrID                   = "EMPTY_DEX_ADDRESS_MSG"
	selectWalletForFeePaymentID      = "SELECT_WALLET_FOR_FEE_PAYMENT"
	walletSyncFinishingID            = "WALLET_SYNC_FINISHING_UP"
	refundImminentID                 = "REFUND_IMMINENT"
	refundWillHappenAfterID          = "REFUND_WILL_HAPPEN_AFTER"
	availableTitleID                 = "AVAILABLE_TITLE"
	reservesDeficitID                = "RESERVES_DEFICIT"
	creatingWalletsID                = "CREATING_WALLETS"
	ticketStatusUnknownID            = "TICKET_STATUS_UNKNOWN"
	ticketStatusUnminedID            = "TICKET_STATUS_UNMINED"
	ticketStatusImmatureID           = "TICKET_STATUS_IMMATURE"
	ticketStatusLiveID               = "TICKET_STATUS_LIVE"
	ticketStatusVotedID              = "TICKET_STATUS_VOTED"
	ticketStatusMissedID             = "TICKET_STATUS_MISSED"
	ticketStatusExpiredID            = "TICKET_STATUS_EXPIRED"
	ticketStatusUnspentID            = "TICKET_STATUS_UNSPENT"
	ticketStatusRevokedID            = "TICKET_STATUS_REVOKED"
	passwordResetSuccessMsgID        = "PASSWORD_RESET_SUCCESS_MSG"
	enableAssetWalletMsgID           = "ENABLE_ASSET_WALLET_MSG"
	createAssetWalletMsgID           = "CREATE_ASSET_WALLET_MSG"
	noWalletMsgID                    = "NO_WALLET_MSG"
	tradingTierUpdateddID            = "TRADING_TIER_UPDATED"
	invalidTierValueID               = "INVALID_TIER_VALUE"
	invalidCompsValueID              = "INVALID_COMPS_VALUE"

	// MM Settings translations
	mmStartBotID                   = "MM_START_BOT"
	mmSaveSettingsID               = "MM_SAVE_SETTINGS"
	mmDeleteBotID                  = "MM_DELETE_BOT"
	mmUpdateRunningBotID           = "MM_UPDATE_RUNNING_BOT"
	mmConfirmDeleteID              = "MM_CONFIRM_DELETE"
	mmCancelID                     = "MM_CANCEL"
	mmDeleteID                     = "MM_DELETE"
	mmCloseID                      = "MM_CLOSE"
	mmErrorID                      = "MM_ERROR"
	mmPlacementsID                 = "MM_PLACEMENTS"
	mmAllocationsID                = "MM_ALLOCATIONS"
	mmSettingsID                   = "MM_SETTINGS"
	mmRebalanceSettingsID          = "MM_REBALANCE_SETTINGS"
	mmBasicMarketMakerID           = "MM_BASIC_MARKET_MAKER"
	mmMMPlusArbID                  = "MM_MM_PLUS_ARB"
	mmBasicArbitrageID             = "MM_BASIC_ARBITRAGE"
	mmUnknownID                    = "MM_UNKNOWN"
	mmConfigureID                  = "MM_CONFIGURE"
	mmFixErrorsID                  = "MM_FIX_ERRORS"
	mmMarketNotAvailableID         = "MM_MARKET_NOT_AVAILABLE"
	mmSelectMarketID               = "MM_SELECT_MARKET"
	mmSearchMarketsID              = "MM_SEARCH_MARKETS"
	mmMarketHeaderID               = "MM_MARKET_HEADER"
	mmHostHeaderID                 = "MM_HOST_HEADER"
	mmArbHeaderID                  = "MM_ARB_HEADER"
	mmChooseBotID                  = "MM_CHOOSE_BOT"
	mmDriftToleranceID             = "MM_DRIFT_TOLERANCE"
	mmDriftToleranceTooltipID      = "MM_DRIFT_TOLERANCE_TOOLTIP"
	mmOrderPersistenceID           = "MM_ORDER_PERSISTENCE"
	mmOrderPersistenceTooltipID    = "MM_ORDER_PERSISTENCE_TOOLTIP"
	mmMultiHopArbID                = "MM_MULTI_HOP_ARB"
	mmIntermediateAssetID          = "MM_INTERMEDIATE_ASSET"
	mmIntermediateAssetTooltipID   = "MM_INTERMEDIATE_ASSET_TOOLTIP"
	mmCompletionOrderTypeID        = "MM_COMPLETION_ORDER_TYPE"
	mmCompletionOrderTypeTooltipID = "MM_COMPLETION_ORDER_TYPE_TOOLTIP"
	mmMarketOrderCapitalizeID      = "MM_MARKET_ORDER_CAPITALIZE"
	mmLimitOrderCapitalizeID       = "MM_LIMIT_ORDER_CAPITALIZE"
	mmLimitBufferID                = "MM_LIMIT_BUFFER"
	mmLimitBufferTooltipID         = "MM_LIMIT_BUFFER_TOOLTIP"
	mmGapStrategyID                = "MM_GAP_STRATEGY"
	mmPercentPlusID                = "MM_PERCENT_PLUS"
	mmPercentID                    = "MM_PERCENT"
	mmAbsolutePlusID               = "MM_ABSOLUTE_PLUS"
	mmAbsoluteID                   = "MM_ABSOLUTE"
	mmMultiplierID                 = "MM_MULTIPLIER"
	mmCompetitiveID                = "MM_COMPETITIVE"
	mmFactorLabelPercentID         = "MM_FACTOR_LABEL_PERCENT"
	mmFactorLabelRateID            = "MM_FACTOR_LABEL_RATE"
	mmFactorLabelMultiplierID      = "MM_FACTOR_LABEL_MULTIPLIER"
	mmProfitThresholdID            = "MM_PROFIT_THRESHOLD"
	mmProfitThresholdDescID        = "MM_PROFIT_THRESHOLD_DESC"
	mmProfitThresholdMMTooltipID   = "MM_PROFIT_THRESHOLD_MM_TOOLTIP"
	mmPriceLevelsPerSideID         = "MM_PRICE_LEVELS_PER_SIDE"
	mmPriceIncrementID             = "MM_PRICE_INCREMENT"
	mmPriceIncrementTooltipID      = "MM_PRICE_INCREMENT_TOOLTIP"
	mmMatchBufferID                = "MM_MATCH_BUFFER"
	mmMatchBufferTooltipID         = "MM_MATCH_BUFFER_TOOLTIP"
	mmTradedAmountID               = "MM_TRADED_AMOUNT"
	mmSwapFeesID                   = "MM_SWAP_FEES"
	mmRedeemFeesID                 = "MM_REDEEM_FEES"
	mmRefundFeesID                 = "MM_REFUND_FEES"
	mmFundingFeesID                = "MM_FUNDING_FEES"
	mmSlippageBufferID             = "MM_SLIPPAGE_BUFFER"
	mmMultiSplitBufferID           = "MM_MULTI_SPLIT_BUFFER"
	mmInitialBuyFundingFeesID      = "MM_INITIAL_BUY_FUNDING_FEES"
	mmInitialSellFundingFeesID     = "MM_INITIAL_SELL_FUNDING_FEES"
	mmBridgeFeeReservesID          = "MM_BRIDGE_FEE_RESERVES"
	mmTotalRequiredID              = "MM_TOTAL_REQUIRED"
	mmAlreadyAllocatedID           = "MM_ALREADY_ALLOCATED"
	mmAvailableToUnallocateID      = "MM_AVAILABLE_TO_UNALLOCATE"
	mmTotalAvailableID             = "MM_TOTAL_AVAILABLE"
	mmAmountAllocatedID            = "MM_AMOUNT_ALLOCATED"
	mmBuyBufferID                  = "MM_BUY_BUFFER"
	mmSellBufferID                 = "MM_SELL_BUFFER"
	mmBuyFeeReserveID              = "MM_BUY_FEE_RESERVE"
	mmSellFeeReserveID             = "MM_SELL_FEE_RESERVE"
	mmBridgeFeeReserveID           = "MM_BRIDGE_FEE_RESERVE"
	mmWithdrawalID                 = "MM_WITHDRAWAL"
	mmDepositID                    = "MM_DEPOSIT"
	mmFailedSaveBotConfigID        = "MM_FAILED_SAVE_BOT_CONFIG"
	mmMinTransferTooltipID         = "MM_MIN_TRANSFER_TOOLTIP"
	mmFailedFetchBridgeFeesID      = "MM_FAILED_FETCH_BRIDGE_FEES"
	mmBridgeConfigurationID        = "MM_BRIDGE_CONFIGURATION"
	mmBridgeConfigTooltipID        = "MM_BRIDGE_CONFIG_TOOLTIP"
	mmBridgeToAssetID              = "MM_BRIDGE_TO_ASSET"
	mmSelectCEXAssetID             = "MM_SELECT_CEX_ASSET"
	mmBridgeID                     = "MM_BRIDGE"
	mmSelectBridgeID               = "MM_SELECT_BRIDGE"
	mmBridgeFeesID                 = "MM_BRIDGE_FEES"
	mmCEXRebalanceID               = "MM_CEX_REBALANCE"
	mmCEXRebalanceDescID           = "MM_CEX_REBALANCE_DESC"
	mmInternalTransfersOnlyID      = "MM_INTERNAL_TRANSFERS_ONLY"
	mmInternalTransfersDescID      = "MM_INTERNAL_TRANSFERS_DESC"
	mmRebalanceDescriptionID       = "MM_REBALANCE_DESCRIPTION"
	mmFailedStartBotID             = "MM_FAILED_START_BOT"
	mmMissingFiatRatesID           = "MM_MISSING_FIAT_RATES"
	mmLoadingID                    = "MM_LOADING"
	mmRemovePlacementID            = "MM_REMOVE_PLACEMENT"
	mmMoveUpID                     = "MM_MOVE_UP"
	mmMoveDownID                   = "MM_MOVE_DOWN"
	mmAddPlacementID               = "MM_ADD_PLACEMENT"
	mmPercentPlusDescID            = "MM_PERCENT_PLUS_DESC"
	mmPercentDescID                = "MM_PERCENT_DESC"
	mmAbsolutePlusDescID           = "MM_ABSOLUTE_PLUS_DESC"
	mmAbsoluteDescID               = "MM_ABSOLUTE_DESC"
	mmMultiplierDescID             = "MM_MULTIPLIER_DESC"
	mmCompetitiveDescID            = "MM_COMPETITIVE_DESC"
	mmProfitAdvDescID              = "MM_PROFIT_ADV_DESC"
	mmPriorityID                   = "MM_PRIORITY"
	mmPriorityTooltipID            = "MM_PRIORITY_TOOLTIP"
	mmLotsID                       = "MM_LOTS"
	mmBuyPlacementsID              = "MM_BUY_PLACEMENTS"
	mmSellPlacementsID             = "MM_SELL_PLACEMENTS"
	mmAdvPlacementsDescID          = "MM_ADV_PLACEMENTS_DESC"
	mmSettingsDescID               = "MM_SETTINGS_DESC"
	mmMultiHopLockedID             = "MM_MULTI_HOP_LOCKED"
	mmMarketOrderWarningID         = "MM_MARKET_ORDER_WARNING"
	mmTradingID                    = "MM_TRADING"
	mmNoConfigOptionsID            = "MM_NO_CONFIG_OPTIONS"
	mmCollectSnapshotsID           = "MM_COLLECT_SNAPSHOTS"
	mmCollectSnapshotsTooltipID    = "MM_COLLECT_SNAPSHOTS_TOOLTIP"
	mmNoCexAvailableID             = "MM_NO_CEX_AVAILABLE"
	mmBasicMMDescID                = "MM_BASIC_MM_DESC"
	mmArbMMDescID                  = "MM_ARB_MM_DESC"
	mmBasicArbDescID               = "MM_BASIC_ARB_DESC"
	mmContinueID                   = "MM_CONTINUE"
	mmCexConfigPromptID            = "MM_CEX_CONFIG_PROMPT"
	mmCexConnectionErrorID         = "MM_CEX_CONNECTION_ERROR"
	mmApiKeyID                     = "MM_API_KEY"
	mmApiSecretID                  = "MM_API_SECRET"
	mmSaveCexCredentialsID         = "MM_SAVE_CEX_CREDENTIALS"
	mmFailedDeleteBotID            = "MM_FAILED_DELETE_BOT"
	mmFailedUpdateRunningID        = "MM_FAILED_UPDATE_RUNNING"
	mmManualAllocDescID            = "MM_MANUAL_ALLOC_DESC"
	mmSelectMarketDescID           = "MM_SELECT_MARKET_DESC"
	mmNoMarketsMatchID             = "MM_NO_MARKETS_MATCH"
	mmRegisterHostID               = "MM_REGISTER_HOST"
	mmPriceLevelsTooltipID         = "MM_PRICE_LEVELS_TOOLTIP"
	mmLotsPerLevelID               = "MM_LOTS_PER_LEVEL"
	mmUsdPerSideID                 = "MM_USD_PER_SIDE"
	mmLotsUsdTooltipID             = "MM_LOTS_USD_TOOLTIP"
	mmQuickPlacementsID            = "MM_QUICK_PLACEMENTS"
	mmAdvancedPlacementsID         = "MM_ADVANCED_PLACEMENTS"
	mmSwitchToAdvancedID           = "MM_SWITCH_TO_ADVANCED"
	mmSwitchToQuickID              = "MM_SWITCH_TO_QUICK"
	mmQuickPlacementsDescID        = "MM_QUICK_PLACEMENTS_DESC"
	mmBridgeLockedID               = "MM_BRIDGE_LOCKED"
	mmBridgeRoundTripFeesID        = "MM_BRIDGE_ROUND_TRIP_FEES"
	mmFundedID                     = "MM_FUNDED"
	mmUnderfundedID                = "MM_UNDERFUNDED"
	mmFundedWithRebalanceID        = "MM_FUNDED_WITH_REBALANCE"
	mmFundedWithRebalanceTooltipID = "MM_FUNDED_WITH_REBALANCE_TOOLTIP"
	mmQuickAllocationID            = "MM_QUICK_ALLOCATION"
	mmManualAllocationID           = "MM_MANUAL_ALLOCATION"
	mmSwitchToManualID             = "MM_SWITCH_TO_MANUAL"
	mmUseAutoEstimateID            = "MM_USE_AUTO_ESTIMATE"
	mmBuffersAndReservesID         = "MM_BUFFERS_AND_RESERVES"
	mmAllocationPreviewID          = "MM_ALLOCATION_PREVIEW"
	mmQuickAllocDescID             = "MM_QUICK_ALLOC_DESC"
	mmAllocRunningQuickID          = "MM_ALLOC_RUNNING_QUICK"
	mmAllocNewQuickID              = "MM_ALLOC_NEW_QUICK"
	mmAllocRunningManualID         = "MM_ALLOC_RUNNING_MANUAL"
	mmAllocRunningManualNoteID     = "MM_ALLOC_RUNNING_MANUAL_NOTE"
	mmAllocNewManualID             = "MM_ALLOC_NEW_MANUAL"
	mmExtraBuyLotsTooltipID        = "MM_EXTRA_BUY_LOTS_TOOLTIP"
	mmExtraSellLotsTooltipID       = "MM_EXTRA_SELL_LOTS_TOOLTIP"
	mmSlippageBufferTooltipID      = "MM_SLIPPAGE_BUFFER_TOOLTIP"
	mmExtraBuyFeeTooltipID         = "MM_EXTRA_BUY_FEE_TOOLTIP"
	mmExtraSellFeeTooltipID        = "MM_EXTRA_SELL_FEE_TOOLTIP"
	mmExtraRebalanceFeeTooltipID   = "MM_EXTRA_REBALANCE_FEE_TOOLTIP"
	mmSendFeesID                   = "MM_SEND_FEES"
	mmBufferedAmountID             = "MM_BUFFERED_AMOUNT"
	mmAllocChangeID                = "MM_ALLOC_CHANGE"
	mmBuyFeeReservesID             = "MM_BUY_FEE_RESERVES"
	mmSellFeeReservesID            = "MM_SELL_FEE_RESERVES"
	mmHowRebalancingWorksID        = "MM_HOW_REBALANCING_WORKS"
	mmMinExternalTransferID        = "MM_MIN_EXTERNAL_TRANSFER"

	txTypeUnknownID             = "TX_TYPE_UNKNOWN"
	txTypeSendID                = "TX_TYPE_SEND"
	txTypeReceiveID             = "TX_TYPE_RECEIVE"
	txTypeSwapID                = "TX_TYPE_SWAP"
	txTypeRedeemID              = "TX_TYPE_REDEEM"
	txTypeRefundID              = "TX_TYPE_REFUND"
	txTypeSplitID               = "TX_TYPE_SPLIT"
	txTypeCreateBondID          = "TX_TYPE_CREATE_BOND"
	txTypeRedeemBondID          = "TX_TYPE_REDEEM_BOND"
	txTypeApproveTokenID        = "TX_TYPE_APPROVE_TOKEN"
	txTypeAccelerationID        = "TX_TYPE_ACCELERATION"
	txTypeSelfTransferID        = "TX_TYPE_SELF_TRANSFER"
	txTypeRevokeTokenApprovalID = "TX_TYPE_REVOKE_TOKEN_APPROVAL"
	txTypeTicketPurchaseID      = "TX_TYPE_TICKET_PURCHASE"
	txTypeTicketVoteID          = "TX_TYPE_TICKET_VOTE"
	txTypeTicketRevokeID        = "TX_TYPE_TICKET_REVOCATION"
	txTypeSwapOrSendID          = "TX_TYPE_SWAP_OR_SEND"
	txTypeMixID                 = "TX_TYPE_MIX"
	txTypeBridgeInitiationID    = "TX_TYPE_BRIDGE_INITIATION"
	txTypeBridgeCompletionID    = "TX_TYPE_BRIDGE_COMPLETION"
	invalidValueID              = "INVALID_VALUE"
	pendingID                   = "PENDING"
	completeID                  = "COMPLETE"
	idNoCodeProvided            = "NO_CODE_PROVIDED"
	enableAccount               = "ENABLE_ACCOUNT"
	disableAccount              = "DISABLE_ACCOUNT"
	idCEXBalances               = "CEX_BALANCES"
	idCexNotConnected           = "CEX_NOT_CONNECTED"
	idVoteCastMsg               = "VOTE_CAST_MESSAGE"
	idVersionTxt                = "VERSION"
)

var enUS = map[string]*intl.Translation{
	noPassErrMsgID:                   {T: "password cannot be empty"},
	noAppPassErrMsgID:                {T: "app password cannot be empty"},
	passwordNotMatchID:               {T: "passwords do not match"},
	lockedID:                         {T: "locked"},
	hideAdditionalSettingsID:         {T: "hide additional settings"},
	showAdditionalSettingsID:         {T: "show additional settings"},
	buyID:                            {T: "Buy"},
	sellID:                           {T: "Sell"},
	versionNotSupportedID:            {T: "{{ asset }} (v{{version}}) is not supported"},
	executedID:                       {T: "executed"},
	bookedID:                         {T: "booked"},
	cancelingID:                      {T: "canceling"},
	acctUndefinedID:                  {T: "Account undefined."},
	lotsID:                           {T: "lots"},
	unknownID:                        {T: "unknown"},
	epochID:                          {T: "epoch"},
	settlingID:                       {T: "settling"},
	noMatchID:                        {T: "no match"},
	canceledID:                       {T: "canceled"},
	revokedID:                        {T: "revoked"},
	waitingForConfsID:                {T: "Waiting for confirmations..."},
	noneSelectedID:                   {T: "none selected"},
	addID:                            {T: "Add"},
	createID:                         {T: "Create"},
	walletReadyID:                    {T: "Ready"},
	feeBalanceID:                     {T: "fee balance"},
	invalidDateErrorMsgID:            {T: "error: invalid date or time"},
	noArchivedRecordsID:              {T: "No archived records found"},
	deleteArchivedRecordsID:          {T: "Message: {{ nRecords }} archived records has been deleted"},
	archivedRecordsPathID:            {T: "File Location: {{ path }}"},
	orderSubmittingID:                {T: "submitting"},
	defaultID:                        {T: "Default"},
	addedID:                          {T: "Added"},
	discoveredID:                     {T: "Discovered"},
	limitOrderID:                     {T: "limit"},
	limitOrderImmediateTifID:         {T: "limit (i)", Notes: "i = immediate"},
	marketOrderID:                    {T: "market"},
	matchStatusNewlyMatchedID:        {T: "Newly Matched"},
	matchStatusMakerSwapCastID:       {T: "Maker Swap Sent"},
	matchStatusTakerSwapCastID:       {T: "Taker Swap Sent"},
	matchStatusMakerRedeemedID:       {T: "Maker Redeemed"},
	matchStatusRedemptionSentID:      {T: "Redemption Sent"},
	matchStatusRevokedID:             {T: "Revoked - {{ status }}"},
	matchStatusRefundPendingID:       {T: "Refund PENDING"},
	matchStatusRefundedID:            {T: "Refunded"},
	matchStatusRedeemPendingID:       {T: "Redeem PENDING"},
	matchStatusRedemptionConfirmedID: {T: "Redemption Confirmed"},
	matchStatusCompleteID:            {T: "Complete"},
	orderAccelerationFeeErrMsgID:     {T: "Error estimating acceleration fee: {{ msg }}"},
	orderAccelerationErrMsgID:        {T: "Error accelerating order: {{ msg }}"},
	connectedID:                      {T: "Connected"},
	invalidCertID:                    {T: "Invalid Certificate"},
	confirmationsID:                  {T: "confirmations"},
	takerID:                          {T: "Taker"},
	makerID:                          {T: "Maker"},
	emptyDexAddrID:                   {T: "DEX address cannot be empty"},
	selectWalletForFeePaymentID:      {T: "Select a valid wallet to post a bond"},
	walletSyncFinishingID:            {T: "finishing up"},
	refundImminentID:                 {T: "Will happen in the next few blocks"},
	refundWillHappenAfterID:          {T: "Refund will happen after {{ refundAfterTime }}"},
	availableTitleID:                 {T: "Available"},
	reservesDeficitID:                {T: "Reserves Deficit"},
	creatingWalletsID:                {T: "Creating wallets"},
	ticketStatusUnknownID:            {T: "unknown"},
	ticketStatusUnminedID:            {T: "unmined"},
	ticketStatusImmatureID:           {T: "immature"},
	ticketStatusLiveID:               {T: "live"},
	ticketStatusVotedID:              {T: "voted"},
	ticketStatusMissedID:             {T: "missed"},
	ticketStatusExpiredID:            {T: "expired"},
	ticketStatusUnspentID:            {T: "unspent"},
	ticketStatusRevokedID:            {T: "revoked"},
	passwordResetSuccessMsgID:        {T: "Your password reset was successful. You can proceed to login with your new password."},
	enableAssetWalletMsgID:           {T: "Enable / Activate a {{ asset }} wallet to trade"},
	createAssetWalletMsgID:           {T: "Create a {{ asset }} wallet to trade"},
	noWalletMsgID:                    {T: "Create {{ asset1 }} and {{ asset2 }} wallet to trade"},
	tradingTierUpdateddID:            {T: "Trading Tier Updated"},
	invalidTierValueID:               {T: "Invalid tier value"},
	invalidCompsValueID:              {T: "Invalid comps value"},

	// MM Settings translations
	mmStartBotID:                   {T: "Start Bot"},
	mmSaveSettingsID:               {T: "Save Bot Configuration"},
	mmDeleteBotID:                  {T: "Delete Bot Configuration"},
	mmUpdateRunningBotID:           {T: "Apply Changes to Running Bot"},
	mmConfirmDeleteID:              {T: "Delete this saved bot configuration?"},
	mmCancelID:                     {T: "Cancel"},
	mmDeleteID:                     {T: "Delete"},
	mmCloseID:                      {T: "Close"},
	mmErrorID:                      {T: "Error"},
	mmPlacementsID:                 {T: "Placements"},
	mmAllocationsID:                {T: "Allocations"},
	mmSettingsID:                   {T: "Settings"},
	mmRebalanceSettingsID:          {T: "Rebalance Settings"},
	mmBasicMarketMakerID:           {T: "Basic Market Maker"},
	mmMMPlusArbID:                  {T: "MM + Arbitrage"},
	mmBasicArbitrageID:             {T: "Basic Arbitrage"},
	mmUnknownID:                    {T: "Unknown"},
	mmConfigureID:                  {T: "Configure"},
	mmFixErrorsID:                  {T: "Fix errors"},
	mmMarketNotAvailableID:         {T: "This market is not supported for this bot type"},
	mmSelectMarketID:               {T: "Select Market"},
	mmSearchMarketsID:              {T: "Search by asset or host"},
	mmMarketHeaderID:               {T: "Market"},
	mmHostHeaderID:                 {T: "Host"},
	mmArbHeaderID:                  {T: "CEX Support"},
	mmChooseBotID:                  {T: "Choose Your Bot"},
	mmDriftToleranceID:             {T: "Drift Tolerance"},
	mmDriftToleranceTooltipID:      {T: "If an existing DEX order drifts too far from the bot's current target price, the bot cancels and replaces it."},
	mmOrderPersistenceID:           {T: "Order Persistence"},
	mmOrderPersistenceTooltipID:    {T: "How many epochs an unfilled arbitrage order can remain open before the bot cancels it."},
	mmMultiHopArbID:                {T: "Multi-Hop Arbitrage"},
	mmIntermediateAssetID:          {T: "Intermediate Asset"},
	mmIntermediateAssetTooltipID:   {T: "The CEX asset the bot routes through to complete the second leg of a multi-hop hedge."},
	mmCompletionOrderTypeID:        {T: "Second-Leg Order Type"},
	mmCompletionOrderTypeTooltipID: {T: "Controls how the bot finishes the second CEX trade in a multi-hop hedge. Market orders favor completion. Limit orders favor price control but can leave funds temporarily stuck in the intermediate asset."},
	mmMarketOrderCapitalizeID:      {T: "Market"},
	mmLimitOrderCapitalizeID:       {T: "Limit"},
	mmLimitBufferID:                {T: "Second-Leg Limit Buffer"},
	mmLimitBufferTooltipID:         {T: "When using a limit order for the second leg, the bot worsens the price by this amount to improve the chance of a fill."},
	mmGapStrategyID:                {T: "Gap Strategy"},
	mmPercentPlusID:                {T: "Percent Plus"},
	mmPercentID:                    {T: "Percent"},
	mmAbsolutePlusID:               {T: "Absolute Plus"},
	mmAbsoluteID:                   {T: "Absolute"},
	mmMultiplierID:                 {T: "Multiplier"},
	mmCompetitiveID:                {T: "Competitive"},
	mmFactorLabelPercentID:         {T: "Percent"},
	mmFactorLabelRateID:            {T: "Rate"},
	mmFactorLabelMultiplierID:      {T: "Multiplier"},
	mmProfitThresholdID:            {T: "Profit Threshold"},
	mmProfitThresholdDescID:        {T: "Minimum profit required after the DEX order fills and the hedge is placed on the CEX."},
	mmProfitThresholdMMTooltipID:   {T: "Sets the minimum half-spread \u2014 how far the innermost buy and sell placements start from the market. Additional levels are placed farther out using Price Increment."},
	mmPriceLevelsPerSideID:         {T: "Price levels per side"},
	mmPriceIncrementID:             {T: "Price increment"},
	mmPriceIncrementTooltipID:      {T: "Sets how much farther from the market each additional placement level sits."},
	mmMatchBufferID:                {T: "Match buffer"},
	mmMatchBufferTooltipID:         {T: "Makes the bot price against more CEX liquidity than the exact placement size. Higher values are more conservative and can make the hedge easier to complete if top-of-book liquidity disappears."},
	mmTradedAmountID:               {T: "Traded Amount"},
	mmSwapFeesID:                   {T: "Swap Fees"},
	mmRedeemFeesID:                 {T: "Redeem Fees"},
	mmRefundFeesID:                 {T: "Refund Fees"},
	mmFundingFeesID:                {T: "Funding Fees"},
	mmSlippageBufferID:             {T: "Slippage Buffer"},
	mmMultiSplitBufferID:           {T: "Multi-Split Buffer"},
	mmInitialBuyFundingFeesID:      {T: "Initial Buy Funding Fees"},
	mmInitialSellFundingFeesID:     {T: "Initial Sell Funding Fees"},
	mmBridgeFeeReservesID:          {T: "Extra External Rebalance Fee Units"},
	mmTotalRequiredID:              {T: "Estimated Total Needed"},
	mmAlreadyAllocatedID:           {T: "Currently Reserved by Running Bot"},
	mmAvailableToUnallocateID:      {T: "Available to Remove Now"},
	mmTotalAvailableID:             {T: "Unreserved Balance Available Now"},
	mmAmountAllocatedID:            {T: "Allocation to Reserve"},
	mmBuyBufferID:                  {T: "Extra Buy Lots"},
	mmSellBufferID:                 {T: "Extra Sell Lots"},
	mmBuyFeeReserveID:              {T: "Extra Buy Token Fee Reserves"},
	mmSellFeeReserveID:             {T: "Extra Sell Token Fee Reserves"},
	mmBridgeFeeReserveID:           {T: "Extra External Rebalance Fee Units"},
	mmWithdrawalID:                 {T: "Withdrawal"},
	mmDepositID:                    {T: "Deposit"},
	mmFailedSaveBotConfigID:        {T: "Failed to save bot config: "},
	mmMinTransferTooltipID:         {T: "Real deposits and withdrawals below this size are skipped. Use this to avoid excessive fee churn on small transfers."},
	mmFailedFetchBridgeFeesID:      {T: "Failed to fetch bridge fees and limits"},
	mmBridgeConfigurationID:        {T: "{{ asset }} Asset Bridge"},
	mmBridgeConfigTooltipID:        {T: "The DEX and CEX use different assets or networks for this side of the market. Choose which CEX asset to bridge to and which bridge to use for rebalance transfers."},
	mmBridgeToAssetID:              {T: "Bridge To"},
	mmSelectCEXAssetID:             {T: "Select target asset"},
	mmBridgeID:                     {T: "Bridge Route"},
	mmSelectBridgeID:               {T: "Select bridge route"},
	mmBridgeFeesID:                 {T: "Bridge Fees"},
	mmCEXRebalanceID:               {T: "Allow external deposits and withdrawals"},
	mmCEXRebalanceDescID:           {T: "The bot may move funds between wallet and CEX accounts when that improves inventory balance, subject to the minimum transfer sizes below."},
	mmInternalTransfersOnlyID:      {T: "Use internal-only rebalancing"},
	mmInternalTransfersDescID:      {T: "The bot may reassign currently unreserved funds between the DEX side and CEX side in its internal inventory model, but it will not perform real deposits or withdrawals."},
	mmRebalanceDescriptionID:       {T: "Control how the bot shifts inventory between its DEX side and CEX side when one side runs low."},
	mmFailedStartBotID:             {T: "Failed to start bot: "},
	mmMissingFiatRatesID:           {T: "Fiat rate data is not available for {{ assetSymbols }}."},
	mmLoadingID:                    {T: "Loading..."},
	mmRemovePlacementID:            {T: "Remove placement"},
	mmMoveUpID:                     {T: "Move up"},
	mmMoveDownID:                   {T: "Move down"},
	mmAddPlacementID:               {T: "Add placement"},
	mmPercentPlusDescID:            {T: "Places orders at a fixed percentage from the market mid-gap, then adds the estimated break-even gap."},
	mmPercentDescID:                {T: "Places orders at a fixed percentage from the market mid-gap, without adding break-even costs."},
	mmAbsolutePlusDescID:           {T: "Places orders at a fixed rate distance from the market mid-gap, then adds the estimated break-even gap."},
	mmAbsoluteDescID:               {T: "Places orders at a fixed rate distance from the market mid-gap, without adding break-even costs."},
	mmMultiplierDescID:             {T: "Places orders using a multiple of the estimated break-even gap."},
	mmCompetitiveDescID:            {T: "Picks an order rate that tries to compete with the best buy/sell orders in the book but also keeps away from the basis rate far enough to respect specified gap value."},
	mmProfitAdvDescID:              {T: "Minimum profit required after the DEX trade and its CEX hedge are both accounted for."},
	mmPriorityID:                   {T: "Priority"},
	mmPriorityTooltipID:            {T: "Higher rows are kept first if balance is not enough to fund every placement."},
	mmLotsID:                       {T: "Lots"},
	mmBuyPlacementsID:              {T: "Buy Placements"},
	mmSellPlacementsID:             {T: "Sell Placements"},
	mmAdvPlacementsDescID:          {T: "Set each target placement explicitly, in priority order."},
	mmSettingsDescID:               {T: "Configure live bot behavior, wallet funding options, and optional data collection."},
	mmMultiHopLockedID:             {T: "These multi-hop route settings cannot be changed while the bot is running."},
	mmMarketOrderWarningID:         {T: "Market orders can lose funds in thin markets or during high volatility."},
	mmTradingID:                    {T: "Trading"},
	mmNoConfigOptionsID:            {T: "No configurable options"},
	mmCollectSnapshotsID:           {T: "Collect signed epoch snapshots"},
	mmCollectSnapshotsTooltipID:    {T: "Subscribe to server-signed epoch snapshots for this market while the bot is running. You can export them later to independently verify market-making activity."},
	mmNoCexAvailableID:             {T: "No connected CEX is available for arbitrage yet, so only the DEX-only market maker can be used."},
	mmBasicMMDescID:                {T: "Keeps buy and sell orders on the DEX order book. Profit comes from earning spread over time while providing liquidity."},
	mmArbMMDescID:                  {T: "Places standing DEX orders only where a profitable CEX hedge is available. When a DEX order fills, the bot immediately submits the offsetting trade on the CEX."},
	mmBasicArbDescID:               {T: "Waits for direct DEX/CEX arbitrage opportunities and submits the trade pair when one is profitable, instead of maintaining standing maker orders."},
	mmContinueID:                   {T: "Continue"},
	mmCexConfigPromptID:            {T: "Enter your {{ cexName }} API credentials so this bot can read balances and place hedge trades for arbitrage features."},
	mmCexConnectionErrorID:         {T: "CEX connection error"},
	mmApiKeyID:                     {T: "API Key"},
	mmApiSecretID:                  {T: "API Secret"},
	mmSaveCexCredentialsID:         {T: "Save CEX Credentials"},
	mmFailedDeleteBotID:            {T: "Failed to delete bot: "},
	mmFailedUpdateRunningID:        {T: "Failed to update running bot: "},
	mmManualAllocDescID:            {T: "Set the bot allocation directly instead of using the automatic estimate."},
	mmSelectMarketDescID:           {T: "Choose the DEX market this bot will manage."},
	mmNoMarketsMatchID:             {T: "No markets match your search."},
	mmRegisterHostID:               {T: "Register on {{ host }} to use this market for market making"},
	mmPriceLevelsTooltipID:         {T: "How many distinct buy prices and sell prices the bot should target."},
	mmLotsPerLevelID:               {T: "Lots per level"},
	mmUsdPerSideID:                 {T: "Approx. USD per side"},
	mmLotsUsdTooltipID:             {T: "How much size the bot tries to keep at each configured price level. Toggle the arrows to view or enter the same setting as an approximate USD amount per side."},
	mmQuickPlacementsID:            {T: "Quick Placements"},
	mmAdvancedPlacementsID:         {T: "Advanced Placements"},
	mmSwitchToAdvancedID:           {T: "Switch to advanced"},
	mmSwitchToQuickID:              {T: "Switch to quick"},
	mmQuickPlacementsDescID:        {T: "Set how many orders the bot aims to keep on each side of the book and how far from the market they should sit."},
	mmBridgeLockedID:               {T: "Bridge route settings cannot be changed while the bot is running."},
	mmBridgeRoundTripFeesID:        {T: "Estimated Round-Trip Bridge Fees"},
	mmFundedID:                     {T: "Funded"},
	mmUnderfundedID:                {T: "Underfunded"},
	mmFundedWithRebalanceID:        {T: "Funded with rebalance"},
	mmFundedWithRebalanceTooltipID: {T: "The bot cannot satisfy this requirement from the current side alone, but rebalance settings allow it to shift more inventory to the needed side."},
	mmQuickAllocationID:            {T: "Quick Allocation"},
	mmManualAllocationID:           {T: "Manual Allocation"},
	mmSwitchToManualID:             {T: "Switch to manual"},
	mmUseAutoEstimateID:            {T: "Use automatic estimate"},
	mmBuffersAndReservesID:         {T: "Buffers & Reserves"},
	mmAllocationPreviewID:          {T: "Allocation Preview"},
	mmQuickAllocDescID:             {T: "Automatically estimates the funds to reserve based on your placements, fees, and rebalance settings."},
	mmAllocRunningQuickID:          {T: "This bot is already running. The preview below shows only the allocation changes that will be applied \u2014 not the bot's new total."},
	mmAllocNewQuickID:              {T: "This preview shows the total starting allocation that will be saved for the bot and reserved when it starts."},
	mmAllocRunningManualID:         {T: "This bot is already running. Enter the net amount to add to or remove from the bot's current allocation on each side."},
	mmAllocRunningManualNoteID:     {T: "Positive values add funds. Negative values remove funds that are currently available to the running bot."},
	mmAllocNewManualID:             {T: "Enter the total amount to reserve for this bot on each side."},
	mmExtraBuyLotsTooltipID:        {T: "Adds buy-side lot capacity above the lots required by your configured placements."},
	mmExtraSellLotsTooltipID:       {T: "Adds sell-side lot capacity above the lots required by your configured placements."},
	mmSlippageBufferTooltipID:      {T: "Adds extra funds above the expected trade amount so the bot can still complete trades if execution moves against it."},
	mmExtraBuyFeeTooltipID:         {T: "Only used on token markets. Reserves extra copies of the estimated buy-side token fee budget because those fee balances are spent over time and are not replenished by the bot's trades."},
	mmExtraSellFeeTooltipID:        {T: "Only used on token markets. Reserves extra copies of the estimated sell-side token fee budget because those fee balances are spent over time and are not replenished by the bot's trades."},
	mmExtraRebalanceFeeTooltipID:   {T: "Reserves extra copies of estimated external rebalance costs, including bridge fees when used and the approximate wallet send fee for deposits."},
	mmSendFeesID:                   {T: "Send Fees"},
	mmBufferedAmountID:             {T: "Buffered Amount"},
	mmAllocChangeID:                {T: "Allocation Change to Apply"},
	mmBuyFeeReservesID:             {T: "Buy Fee Reserves"},
	mmSellFeeReservesID:            {T: "Sell Fee Reserves"},
	mmHowRebalancingWorksID:        {T: "How Rebalancing Works"},
	mmMinExternalTransferID:        {T: "Minimum External Transfer Size"},

	apiErrorID:                  {T: "api error: {{ msg }}"},
	txTypeUnknownID:             {T: "Unknown"},
	txTypeSendID:                {T: "Send"},
	txTypeReceiveID:             {T: "Receive"},
	txTypeSwapID:                {T: "Swap"},
	txTypeRedeemID:              {T: "Redeem"},
	txTypeRefundID:              {T: "Refund"},
	txTypeSplitID:               {T: "Split"},
	txTypeCreateBondID:          {T: "Create bond"},
	txTypeRedeemBondID:          {T: "Redeem bond"},
	txTypeApproveTokenID:        {T: "Approve token"},
	txTypeAccelerationID:        {T: "Acceleration"},
	txTypeSelfTransferID:        {T: "Self transfer"},
	txTypeRevokeTokenApprovalID: {T: "Revoke token approval"},
	txTypeTicketPurchaseID:      {T: "Ticket purchase"},
	txTypeTicketVoteID:          {T: "Ticket vote"},
	txTypeTicketRevokeID:        {T: "Ticket revocation"},
	txTypeSwapOrSendID:          {T: "Swap / Send"},
	txTypeMixID:                 {T: "Mix"},
	txTypeBridgeInitiationID:    {T: "Bridge initiation"},
	txTypeBridgeCompletionID:    {T: "Bridge completion"},
	invalidValueID:              {T: "invalid value"},
	pendingID:                   {T: "Pending"},
	completeID:                  {T: "Complete"},
	idNoCodeProvided:            {T: "no code provided"},
	enableAccount:               {T: "Enable Account"},
	disableAccount:              {T: "Disable Account"},
	idCEXBalances:               {T: "{{ cexName }} Balances"},
	idCexNotConnected:           {T: "{{ cexName }} not connected"},
	idVoteCastMsg:               {T: "Your vote has been cast"},
	idVersionTxt:                {T: "Version"},
}

var localesMap = map[string]map[string]*intl.Translation{
	"en-US": enUS,
}

// RegisterTranslations registers translations with the init package for
// translator worksheet preparation.
func RegisterTranslations() {
	const callerID = "js"

	for lang, ts := range localesMap {
		r := intl.NewRegistrar(callerID, lang, len(ts))
		for translationID, t := range ts {
			r.Register(translationID, t)
		}
	}
}
