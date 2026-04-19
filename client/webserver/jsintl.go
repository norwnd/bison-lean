// jsintl.go is a translator-worksheet backing store, NOT the runtime i18n
// source for the web UI.
//
// The React frontend's live translations come from
// `client/webserver/site/src/i18n/en-US.json`, loaded via react-i18next in
// `client/webserver/site/src/i18n/index.ts`. Edits there take effect at
// runtime; edits here do not.
//
// The `enUS` map below is consumed only by:
//   - `client/cmd/translationsreport/main.go` (via RegisterTranslations), to
//     generate the translator worksheet showing default English strings
//     next to each locale's translation gaps. Keep entries UPPER_SNAKE and
//     in sync with en-US.json keys so translators see the right defaults.
//   - The legacy `/locale` HTTP route (see `apiLocale` in api.go), which
//     currently has zero client callers (the React app does not fetch
//     locale dicts from the server). Route + map are retained for possible
//     future use or out-of-tree consumers.
//
// TL;DR: changing a string here does NOT change what users see in the app.

package webserver

import "decred.org/dcrdex/client/intl"

const (
	limitOrderBuySellOutTotalPreview = "LIMIT_ORDER_BUY_SELL_IN_TOTAL_PREVIEW"
	limitOrderBuySellInTotalPreview  = "LIMIT_ORDER_BUY_SELL_OUT_TOTAL_PREVIEW"
	noQuantityExceedsMax             = "NO_QUANTITY_EXCEEDS_MAX"
	noPassErrMsgID                   = "NO_PASS_ERROR_MSG"
	noAppPassErrMsgID                = "NO_APP_PASS_ERROR_MSG"
	setButtonBuyID                   = "SET_BUTTON_BUY"
	setButtonSellID                  = "SET_BUTTON_SELL"
	offID                            = "OFF"
	maxID                            = "MAX"
	readyID                          = "READY"
	noWalletID                       = "NO_WALLET"
	disabledMsgID                    = "DISABLED_MSG"
	walletSyncProgressID             = "WALLET_SYNC_PROGRESS"
	hideAdditionalSettingsID         = "HIDE_ADDITIONAL_SETTINGS"
	showAdditionalSettingsID         = "SHOW_ADDITIONAL_SETTINGS"
	buyID                            = "BUY"
	sellID                           = "SELL"
	notSupportedID                   = "NOT_SUPPORTED"
	versionNotSupportedID            = "VERSION_NOT_SUPPORTED"
	connectionFailedID               = "CONNECTION_FAILED"
	calculatingID                    = "CALCULATING"
	estimateUnavailableID            = "ESTIMATE_UNAVAILABLE"
	noZeroRateID                     = "NO_ZERO_RATE"
	noZeroQuantityID                 = "NO_ZERO_QUANTITY"
	tradeID                          = "TRADE"
	noAssetWalletID                  = "NO_ASSET_WALLET"
	executedID                       = "EXECUTED"
	bookedID                         = "BOOKED"
	cancelingID                      = "CANCELING"
	passwordNotMatchID               = "PASSWORD_NOT_MATCH"
	acctUndefinedID                  = "ACCT_UNDEFINED"
	keepWalletPassID                 = "KEEP_WALLET_PASS"
	newWalletPassID                  = "NEW_WALLET_PASS"
	lotID                            = "LOT"
	lotsID                           = "LOTS"
	unknownID                        = "UNKNOWN"
	epochID                          = "EPOCH"
	orderSubmittingID                = "ORDER_SUBMITTING"
	settlingID                       = "SETTLING"
	noMatchID                        = "NO_MATCH"
	canceledID                       = "CANCELED"
	revokedID                        = "REVOKED"
	canceledPartiallyFilledID        = "CANCELED_PARTIALLY_FILLED"
	revokedPartiallyFilledID         = "REVOKED_PARTIALLY_FILLED"
	waitingForConfsID                = "WAITING_FOR_CONFS"
	noneSelectedID                   = "NONE_SELECTED"
	regFeeSuccessID                  = "REGISTRATION_FEE_SUCCESS"
	apiErrorID                       = "API_ERROR"
	addID                            = "ADD"
	createID                         = "CREATE"
	setupWalletID                    = "SETUP_WALLET"
	changeWalletTypeID               = "CHANGE_WALLET_TYPE"
	keepWalletTypeID                 = "KEEP_WALLET_TYPE"
	walletReadyID                    = "WALLET_READY"
	setupNeededID                    = "SETUP_NEEDED"
	sendSuccessID                    = "SEND_SUCCESS"
	reconfigSuccessID                = "RECONFIG_SUCCESS"
	rescanStartedID                  = "RESCAN_STARTED"
	newWalletSuccessID               = "NEW_WALLET_SUCCESS"
	walletUnlockedID                 = "WALLET_UNLOCKED"
	sellingID                        = "SELLING"
	buyingID                         = "BUYING"
	walletDisabledID                 = "WALLET_DISABLED"
	walletEnabledID                  = "WALLET_ENABLED"
	activeOrdersErrorID              = "ACTIVE_ORDERS_ERR_MSG"
	availableID                      = "AVAILABLE"
	lockedID                         = "LOCKED"
	immatureID                       = "IMMATURE"
	feeBalanceID                     = "FEE_BALANCE"
	candlesLoadingID                 = "CANDLES_LOADING"
	depthLoadingID                   = "DEPTH_LOADING"
	invalidAddrressMsgID             = "INVALID_ADDRESS_MSG"
	txFeeSupportedID                 = "TXFEE_UNSUPPORTED"
	txFeeErrorMsgID                  = "TXFEE_ERR_MSG"
	activeOrdersLogoutErrorID        = "ACTIVE_ORDERS_LOGOUT_ERR_MSG"
	invalidDateErrorMsgID            = "INVALID_DATE_ERR_MSG"
	noArchivedRecordsID              = "NO_ARCHIVED_RECORDS"
	deleteArchivedRecordsID          = "DELETE_ARCHIVED_RECORDS_RESULT"
	archivedRecordsPathID            = "ARCHIVED_RECORDS_PATH"
	defaultID                        = "DEFAULT"
	addedID                          = "ADDED"
	discoveredID                     = "DISCOVERED"
	unsupportedAssetInfoErrMsgID     = "UNSUPPORTED_ASSET_INFO_ERR_MSG"
	limitOrderID                     = "LIMIT_ORDER"
	limitOrderImmediateTifID         = "LIMIT_ORDER_IMMEDIATE_TIF"
	marketOrderID                    = "MARKET_ORDER"
	cancelOrderID                    = "CANCEL_ORDER"
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
	takerFoundMakerRedemptionID      = "TAKER_FOUND_MAKER_REDEMPTION"
	sentToRelayerID                  = "SENT_TO_RELAYER"
	openWalletErrMsgID               = "OPEN_WALLET_ERR_MSG"
	orderAccelerationFeeErrMsgID     = "ORDER_ACCELERATION_FEE_ERR_MSG"
	orderAccelerationErrMsgID        = "ORDER_ACCELERATION_ERR_MSG"
	connectedID                      = "CONNECTED"
	disconnectedID                   = "DISCONNECTED"
	invalidCertID                    = "INVALID_CERTIFICATE"
	confirmationsID                  = "CONFIRMATIONS"
	takerID                          = "TAKER"
	makerID                          = "MAKER"
	emptyDexAddrID                   = "EMPTY_DEX_ADDRESS_MSG"
	selectWalletForFeePaymentID      = "SELECT_WALLET_FOR_FEE_PAYMENT"
	unavailableID                    = "UNAVAILABLE"
	walletSyncFinishingID            = "WALLET_SYNC_FINISHING_UP"
	connectWalletErrMsgID            = "CONNECTING_WALLET_ERR_MSG"
	refundImminentID                 = "REFUND_IMMINENT"
	refundWillHappenAfterID          = "REFUND_WILL_HAPPEN_AFTER"
	availableTitleID                 = "AVAILABLE_TITLE"
	lockedTitleID                    = "LOCKED_TITLE"
	immatureTitleID                  = "IMMATURE_TITLE"
	swappingID                       = "SWAPPING"
	bondedID                         = "BONDED"
	lockedBalMsgID                   = "LOCKED_BAL_MSG"
	immatureBalMsgID                 = "IMMATURE_BAL_MSG"
	lockedSwappingBalMsgID           = "LOCKED_SWAPPING_BAL_MSG"
	lockedBonBalMsgID                = "LOCKED_BOND_BAL_MSG"
	reservesDeficitID                = "RESERVES_DEFICIT"
	reservesDeficitMsgID             = "RESERVES_DEFICIT_MSG"
	bondReservesID                   = "BOND_RESERVES"
	bondReservesMsgID                = "BOND_RESERVES_MSG"
	shieldedID                       = "SHIELDED"
	shieldedMsgID                    = "SHIELDED_MSG"
	orderID                          = "ORDER"
	lockedOrderBalMsgID              = "LOCKED_ORDER_BAL_MSG"
	creatingWalletsID                = "CREATING_WALLETS"
	addingServersID                  = "ADDING_SERVER"
	walletRecoverySupportMsgID       = "WALLET_RECOVERY_SUPPORT_MSG"
	ticketsPurchasedID               = "TICKETS_PURCHASED"
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
	browserNtfnEnabledID             = "BROWSER_NTFN_ENABLED"
	browserNtfnOrdersID              = "BROWSER_NTFN_ORDERS"
	browserNtfnMatchesID             = "BROWSER_NTFN_MATCHES"
	browserNtfnBondsID               = "BROWSER_NTFN_BONDS"
	browserNtfnConnectionsID         = "BROWSER_NTFN_CONNECTIONS"
	orderBttnBuyBalErrID             = "ORDER_BUTTON_BUY_BALANCE_ERROR"
	orderBttnSellBalErrID            = "ORDER_BUTTON_SELL_BALANCE_ERROR"
	orderBttnQtyErrID                = "ORDER_BUTTON_QTY_ERROR"
	orderBttnQtyRateErrID            = "ORDER_BUTTON_QTY_RATE_ERROR"
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
	mmMinTransferID                = "MM_MIN_TRANSFER"
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
	mmBisonWalletSideID            = "MM_BISON_WALLET_SIDE"
	mmCexSideID                    = "MM_CEX_SIDE"
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

	txTypeUnknownID                = "TX_TYPE_UNKNOWN"
	txTypeSendID                   = "TX_TYPE_SEND"
	txTypeReceiveID                = "TX_TYPE_RECEIVE"
	txTypeSwapID                   = "TX_TYPE_SWAP"
	txTypeRedeemID                 = "TX_TYPE_REDEEM"
	txTypeRefundID                 = "TX_TYPE_REFUND"
	txTypeSplitID                  = "TX_TYPE_SPLIT"
	txTypeCreateBondID             = "TX_TYPE_CREATE_BOND"
	txTypeRedeemBondID             = "TX_TYPE_REDEEM_BOND"
	txTypeApproveTokenID           = "TX_TYPE_APPROVE_TOKEN"
	txTypeAccelerationID           = "TX_TYPE_ACCELERATION"
	txTypeSelfTransferID           = "TX_TYPE_SELF_TRANSFER"
	txTypeRevokeTokenApprovalID    = "TX_TYPE_REVOKE_TOKEN_APPROVAL"
	txTypeTicketPurchaseID         = "TX_TYPE_TICKET_PURCHASE"
	txTypeTicketVoteID             = "TX_TYPE_TICKET_VOTE"
	txTypeTicketRevokeID           = "TX_TYPE_TICKET_REVOCATION"
	txTypeSwapOrSendID             = "TX_TYPE_SWAP_OR_SEND"
	txTypeMixID                    = "TX_TYPE_MIX"
	txTypeBridgeInitiationID       = "TX_TYPE_BRIDGE_INITIATION"
	txTypeBridgeCompletionID       = "TX_TYPE_BRIDGE_COMPLETION"
	swapOrSendTooltipID            = "SWAP_OR_SEND_TOOLTIP"
	missingCexCredsID              = "MISSING_CEX_CREDS"
	matchBufferID                  = "MATCH_BUFFER"
	noPlacementsID                 = "NO_PLACEMENTS"
	invalidValueID                 = "INVALID_VALUE"
	noZeroID                       = "NO_ZERO"
	botTypeBasicMMID               = "BOTTYPE_BASIC_MM"
	botTypeArbMMID                 = "BOTTYPE_ARB_MM"
	botTypeSimpleArbID             = "BOTTYPE_SIMPLE_ARB"
	botTypeNoneID                  = "NO_BOTTYPE"
	noCexID                        = "NO_CEX"
	cexBalanceErrID                = "CEXBALANCE_ERR"
	pendingID                      = "PENDING"
	completeID                     = "COMPLETE"
	archivedSettingsID             = "ARCHIVED_SETTINGS"
	idTransparent                  = "TRANSPARENT"
	idNoCodeProvided               = "NO_CODE_PROVIDED"
	enableAccount                  = "ENABLE_ACCOUNT"
	disableAccount                 = "DISABLE_ACCOUNT"
	accountDisabledMsg             = "ACCOUNT_DISABLED_MSG"
	dexDisabledMsg                 = "DEX_DISABLED_MSG"
	idWalletNotSynced              = "WALLET_NOT_SYNCED"
	idWalletNoPeers                = "WALLET_NO_PEERS"
	idDepositError                 = "DEPOSIT_ERROR"
	idWithdrawError                = "WITHDRAW_ERROR"
	idDEXUnderfunded               = "DEX_UNDERFUNDED"
	idCEXUnderfunded               = "CEX_UNDERFUNDED"
	idCEXTooShallow                = "CEX_TOO_SHALLOW"
	idAccountSuspended             = "ACCOUNT_SUSPENDED"
	idUserLimitTooLow              = "USER_LIMIT_TOO_LOW"
	idNoPriceSource                = "NO_PRICE_SOURCE"
	idCEXOrderbookUnsynced         = "CEX_ORDERBOOK_UNSYNCED"
	idDeterminePlacementsError     = "DETERMINE_PLACEMENTS_ERROR"
	idPlaceBuyOrdersError          = "PLACE_BUY_ORDERS_ERROR"
	idPlaceSellOrdersError         = "PLACE_SELL_ORDERS_ERROR"
	idCEXTradeError                = "CEX_TRADE_ERROR"
	idOrderReportTitle             = "ORDER_REPORT_TITLE"
	idCEXBalances                  = "CEX_BALANCES"
	idCausesSelfMatch              = "CAUSES_SELF_MATCH"
	idCexNotConnected              = "CEX_NOT_CONNECTED"
	idDeleteBot                    = "DELETE_BOT"
	idMarketOrderCapitalize        = "MARKET_ORDER_CAPITALIZE"
	idLimitOrderCapitalize         = "LIMIT_ORDER_CAPITALIZE"
	idInsuffRedeemFundsErrMsg      = "INSUFFICIENT_REDEEM_FUNDS_ERR_MSG"
	idInsuffRedeemFundsRelayErrMsg = "INSUFFICIENT_REDEEM_FUNDS_RELAY_ERR_MSG"
	idSlippageAckRequired          = "SLIPPAGE_ACK_REQUIRED"
	idSlippageWarningMsg           = "SLIPPAGE_WARNING_MSG"
	idHighSlippageWarningMsg       = "HIGH_SLIPPAGE_WARNING_MSG"
	idVoteCastMsg                  = "VOTE_CAST_MESSAGE"
	idVersionTxt                   = "VERSION"
)

var enUS = map[string]*intl.Translation{
	limitOrderBuySellOutTotalPreview: {T: "+{{ total }} {{ asset }}"},
	limitOrderBuySellInTotalPreview:  {T: "-{{ total }} {{ asset }}"},
	noQuantityExceedsMax:             {T: "not enough funds"},
	noPassErrMsgID:                   {T: "password cannot be empty"},
	noAppPassErrMsgID:                {T: "app password cannot be empty"},
	passwordNotMatchID:               {T: "passwords do not match"},
	setButtonBuyID:                   {T: "Buy  {{ asset }}"},
	setButtonSellID:                  {T: "Sell {{ asset }}"},
	orderBttnBuyBalErrID:             {T: "insufficient balance to buy"},
	orderBttnSellBalErrID:            {T: "insufficient balance to sell"},
	orderBttnQtyErrID:                {T: "order quantity must be specified"},
	orderBttnQtyRateErrID:            {T: "order quantity and price must be specified"},
	offID:                            {T: "off"},
	readyID:                          {T: "ready"},
	lockedID:                         {T: "locked"},
	noWalletID:                       {T: "no wallet"},
	walletSyncProgressID:             {T: "wallet is {{ syncProgress }}% synced"},
	hideAdditionalSettingsID:         {T: "hide additional settings"},
	showAdditionalSettingsID:         {T: "show additional settings"},
	buyID:                            {T: "Buy"},
	sellID:                           {T: "Sell"},
	notSupportedID:                   {T: "{{ asset }} is not supported"},
	versionNotSupportedID:            {T: "{{ asset }} (v{{version}}) is not supported"},
	connectionFailedID:               {T: "Connection to dex server failed. You can close bisonw and try again later or wait for it to reconnect."},
	calculatingID:                    {T: "calculating..."},
	estimateUnavailableID:            {T: "estimate unavailable"},
	noZeroRateID:                     {T: "zero rate not allowed"},
	noZeroQuantityID:                 {T: "zero quantity not allowed"},
	tradeID:                          {T: "trade"},
	noAssetWalletID:                  {T: "No {{ asset }} wallet"},
	executedID:                       {T: "executed"},
	bookedID:                         {T: "booked"},
	cancelingID:                      {T: "canceling"},
	acctUndefinedID:                  {T: "Account undefined."},
	keepWalletPassID:                 {T: "keep current wallet password"},
	newWalletPassID:                  {T: "set a new wallet password"},
	lotID:                            {T: "lot"},
	lotsID:                           {T: "lots"},
	unknownID:                        {T: "unknown"},
	epochID:                          {T: "epoch"},
	settlingID:                       {T: "settling"},
	noMatchID:                        {T: "no match"},
	canceledID:                       {T: "canceled"},
	revokedID:                        {T: "revoked"},
	canceledPartiallyFilledID:        {T: "canceled/partially filled"},
	revokedPartiallyFilledID:         {T: "revoked/partially filled"},
	waitingForConfsID:                {T: "Waiting for confirmations..."},
	noneSelectedID:                   {T: "none selected"},
	regFeeSuccessID:                  {Version: 1, T: "Fidelity bond accepted!"},
	addID:                            {T: "Add"},
	createID:                         {T: "Create"},
	walletReadyID:                    {T: "Ready"},
	setupWalletID:                    {T: "Setup"},
	changeWalletTypeID:               {T: "change the wallet type"},
	keepWalletTypeID:                 {T: "don't change the wallet type"},
	setupNeededID:                    {T: "Setup Needed"},
	sendSuccessID:                    {T: "{{ assetName }} Sent!"},
	reconfigSuccessID:                {T: "Wallet Reconfigured!"},
	rescanStartedID:                  {T: "Wallet Rescan Running"},
	newWalletSuccessID:               {T: "{{ assetName }} Wallet Created!"},
	walletUnlockedID:                 {T: "Wallet Unlocked"},
	sellingID:                        {T: "Selling"},
	buyingID:                         {T: "Buying"},
	walletEnabledID:                  {T: "{{ assetName }} Wallet Enabled"},
	walletDisabledID:                 {T: "{{ assetName }} Wallet Disabled"},
	disabledMsgID:                    {T: "wallet is disabled"},
	activeOrdersErrorID:              {T: "{{ assetName }} wallet is actively managing orders"},
	availableID:                      {T: "available"},
	immatureID:                       {T: "immature"},
	feeBalanceID:                     {T: "fee balance"},
	candlesLoadingID:                 {T: "waiting for candlesticks"},
	depthLoadingID:                   {T: "retrieving depth data"},
	invalidAddrressMsgID:             {T: "invalid address: {{ address }}"},
	txFeeSupportedID:                 {T: "fee estimation is not supported for this wallet type"},
	txFeeErrorMsgID:                  {T: "fee estimation failed: {{ err }}"},
	activeOrdersLogoutErrorID:        {T: "cannot logout with active orders"},
	invalidDateErrorMsgID:            {T: "error: invalid date or time"},
	noArchivedRecordsID:              {T: "No archived records found"},
	deleteArchivedRecordsID:          {T: "Message: {{ nRecords }} archived records has been deleted"},
	archivedRecordsPathID:            {T: "File Location: {{ path }}"},
	orderSubmittingID:                {T: "submitting"},
	defaultID:                        {T: "Default"},
	addedID:                          {T: "Added"},
	discoveredID:                     {T: "Discovered"},
	unsupportedAssetInfoErrMsgID:     {T: "no supported asset info for id = {{ assetID }}, and no exchange info provided"},
	limitOrderID:                     {T: "limit"},
	limitOrderImmediateTifID:         {T: "limit (i)", Notes: "i = immediate"},
	marketOrderID:                    {T: "market"},
	cancelOrderID:                    {T: "cancel"},
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
	openWalletErrMsgID:               {T: "Error opening wallet: {{ msg }}"},
	orderAccelerationFeeErrMsgID:     {T: "Error estimating acceleration fee: {{ msg }}"},
	orderAccelerationErrMsgID:        {T: "Error accelerating order: {{ msg }}"},
	connectedID:                      {T: "Connected"},
	disconnectedID:                   {T: "Disconnected"},
	invalidCertID:                    {T: "Invalid Certificate"},
	confirmationsID:                  {T: "confirmations"},
	takerID:                          {T: "Taker"},
	makerID:                          {T: "Maker"},
	unavailableID:                    {T: "unavailable"},
	emptyDexAddrID:                   {T: "DEX address cannot be empty"},
	selectWalletForFeePaymentID:      {T: "Select a valid wallet to post a bond"},
	walletSyncFinishingID:            {T: "finishing up"},
	connectWalletErrMsgID:            {T: "Failed to connect {{ assetName }} wallet: {{ errMsg }}"},
	takerFoundMakerRedemptionID:      {T: "Redeemed by {{ makerAddr }}"},
	sentToRelayerID:                  {T: "Sent to relayer"},
	refundImminentID:                 {T: "Will happen in the next few blocks"},
	refundWillHappenAfterID:          {T: "Refund will happen after {{ refundAfterTime }}"},
	availableTitleID:                 {T: "Available"},
	lockedTitleID:                    {T: "Locked"},
	immatureTitleID:                  {T: "Immature"},
	swappingID:                       {T: "Swapping"},
	bondedID:                         {T: "Bonded"},
	lockedBalMsgID:                   {T: "Total funds temporarily locked to cover the costs of your bond maintenance, live orders, matches and other activities"},
	immatureBalMsgID:                 {T: "Incoming funds awaiting confirmation"},
	lockedSwappingBalMsgID:           {T: "Funds currently locked in settling matches"},
	lockedBonBalMsgID:                {T: "Funds locked in active bonds"},
	reservesDeficitID:                {T: "Reserves Deficit"},
	reservesDeficitMsgID:             {T: "The apparent wallet balance shortcoming to maintain bonding level. If this persists, you may need to add funds to stay fully bonded."},
	bondReservesID:                   {T: "Bond Reserves"},
	bondReservesMsgID:                {T: "Funds reserved to cover the expenses associated with bond maintenance"},
	shieldedID:                       {T: "Shielded"},
	shieldedMsgID:                    {T: "Total funds kept shielded"},
	orderID:                          {T: "Order"},
	lockedOrderBalMsgID:              {T: "Funds locked in unmatched orders"},
	creatingWalletsID:                {T: "Creating wallets"},
	addingServersID:                  {T: "Connecting to servers"},
	walletRecoverySupportMsgID:       {T: "Native {{ walletSymbol }} wallet failed to load properly. Try clicking the 'Recover' button below to fix it"},
	ticketsPurchasedID:               {T: "Purchasing {{ n }} Tickets!"},
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
	browserNtfnEnabledID:             {T: "Bison Wallet notifications enabled"},
	browserNtfnOrdersID:              {T: "Orders"},
	browserNtfnMatchesID:             {T: "Matches"},
	browserNtfnBondsID:               {T: "Bonds"},
	browserNtfnConnectionsID:         {T: "Server connections"},
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
	mmMinTransferID:                {T: "Minimum External Transfer Size"},
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
	mmBisonWalletSideID:            {T: "Bison Wallet Side"},
	mmCexSideID:                    {T: "{{ cexName }} Side"},
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

	apiErrorID:                     {T: "api error: {{ msg }}"},
	txTypeUnknownID:                {T: "Unknown"},
	txTypeSendID:                   {T: "Send"},
	txTypeReceiveID:                {T: "Receive"},
	txTypeSwapID:                   {T: "Swap"},
	txTypeRedeemID:                 {T: "Redeem"},
	txTypeRefundID:                 {T: "Refund"},
	txTypeSplitID:                  {T: "Split"},
	txTypeCreateBondID:             {T: "Create bond"},
	txTypeRedeemBondID:             {T: "Redeem bond"},
	txTypeApproveTokenID:           {T: "Approve token"},
	txTypeAccelerationID:           {T: "Acceleration"},
	txTypeSelfTransferID:           {T: "Self transfer"},
	txTypeRevokeTokenApprovalID:    {T: "Revoke token approval"},
	txTypeTicketPurchaseID:         {T: "Ticket purchase"},
	txTypeTicketVoteID:             {T: "Ticket vote"},
	txTypeTicketRevokeID:           {T: "Ticket revocation"},
	txTypeSwapOrSendID:             {T: "Swap / Send"},
	txTypeMixID:                    {T: "Mix"},
	txTypeBridgeInitiationID:       {T: "Bridge initiation"},
	txTypeBridgeCompletionID:       {T: "Bridge completion"},
	swapOrSendTooltipID:            {T: "The wallet was unable to determine if this transaction was a swap or a send."},
	missingCexCredsID:              {T: "specify both key and secret"},
	matchBufferID:                  {T: "Match buffer"},
	noPlacementsID:                 {T: "must specify 1 or more placements"},
	invalidValueID:                 {T: "invalid value"},
	noZeroID:                       {T: "zero not allowed"},
	botTypeBasicMMID:               {T: "Market Maker"},
	botTypeArbMMID:                 {T: "Market Maker + Arbitrage"},
	botTypeSimpleArbID:             {Version: 1, T: "Arbitrage"},
	botTypeNoneID:                  {T: "choose a bot type"},
	noCexID:                        {T: "choose an exchange for arbitrage"},
	cexBalanceErrID:                {T: "error fetching {{ cexName }} balance for {{ assetID }}: {{ err }}"},
	pendingID:                      {T: "Pending"},
	completeID:                     {T: "Complete"},
	archivedSettingsID:             {T: "Archived Settings"},
	idTransparent:                  {T: "Transparent"},
	idNoCodeProvided:               {T: "no code provided"},
	enableAccount:                  {T: "Enable Account"},
	disableAccount:                 {T: "Disable Account"},
	accountDisabledMsg:             {T: "account disabled - re-enable to update settings"},
	dexDisabledMsg:                 {T: "DEX server is disabled. Visit the settings page to enable and connect to this server."},
	idWalletNotSynced:              {T: "{{ assetSymbol }} wallet not synced."},
	idWalletNoPeers:                {T: "{{ assetSymbol }} wallet has no peers."},
	idDepositError:                 {T: "The last attempted deposit of {{ assetSymbol }} at {{ time }} failed with the following error: {{ error }}"},
	idWithdrawError:                {T: "The last attempted withdrawal of {{ assetSymbol }} at {{ time }} failed with the following error: {{ error }}"},
	idDEXUnderfunded:               {T: "The {{ assetSymbol }} wallet is underfunded by {{ amount }}"},
	idCEXUnderfunded:               {T: "The {{ cexName }} {{ assetSymbol }} wallet is underfunded by {{ amount }}"},
	idCEXTooShallow:                {T: "The {{ cexName }} market on the {{ side }} side is too shallow for arbitrages as specified by the configuration."},
	idAccountSuspended:             {T: "Your account at {{ dexHost }} is suspended."},
	idUserLimitTooLow:              {T: "Your account at {{ dexHost }} has a limit too low to place all the orders required by the configuration."},
	idNoPriceSource:                {T: "No oracle or fiat rate sources are available for this market."},
	idCEXOrderbookUnsynced:         {T: "The {{ cexName }} orderbook is not synced."},
	idDeterminePlacementsError:     {T: "Error determining placements: {{ error }}"},
	idPlaceBuyOrdersError:          {T: "Error placing buy orders: {{ error }}"},
	idPlaceSellOrdersError:         {T: "Error placing sell orders: {{ error }}"},
	idCEXTradeError:                {T: "The last attempted CEX trade at {{ time }} failed with the following error: {{ error }}"},
	idOrderReportTitle:             {T: "{{ side }} orders report for epoch #{{ epochNum }}"},
	idCEXBalances:                  {T: "{{ cexName }} Balances"},
	idCausesSelfMatch:              {T: "This order would cause a self-match"},
	idCexNotConnected:              {T: "{{ cexName }} not connected"},
	idDeleteBot:                    {T: "Are you sure you want to delete this bot for the {{ baseTicker }}-{{ quoteTicker }} market on {{ host }}?"},
	idMarketOrderCapitalize:        {T: "Market"},
	idLimitOrderCapitalize:         {T: "Limit"},
	idInsuffRedeemFundsErrMsg:      {T: "Insufficient gas for redemption. Configure a relay to do a gasless redemption."},
	idInsuffRedeemFundsRelayErrMsg: {T: "Redemption value per lot at this rate is too small to cover gasless redemption fees."},
	idSlippageAckRequired:          {T: "Please acknowledge the high slippage warning before submitting."},
	idSlippageWarningMsg:           {T: "This order has significant price impact. The estimated fill rate is {{ slippagePct }}% away from the mid-market rate."},
	idHighSlippageWarningMsg:       {T: "This order has very high price impact ({{ slippagePct }}% slippage). You may receive significantly less than expected."},
	idVoteCastMsg:                  {T: "Your vote has been cast"},
	idVersionTxt:                   {T: "Version"},
}

var ptBR = map[string]*intl.Translation{
	noPassErrMsgID:           {T: "senha não pode ser vazia"},
	noAppPassErrMsgID:        {T: "senha do app não pode ser vazia"},
	passwordNotMatchID:       {T: "senhas diferentes"},
	setButtonBuyID:           {T: "Ordem de compra de {{ asset }}"},
	setButtonSellID:          {T: "Ordem de venda de {{ asset }}"},
	offID:                    {T: "desligar"},
	readyID:                  {T: "pronto"},
	lockedID:                 {T: "trancado"},
	noWalletID:               {T: "sem carteira"},
	walletSyncProgressID:     {T: "carteira está {{ syncProgress }}% sincronizada"},
	hideAdditionalSettingsID: {T: "esconder configurações adicionais"},
	showAdditionalSettingsID: {T: "mostrar configurações adicionais"},
	buyID:                    {T: "Comprar"},
	sellID:                   {T: "Vender"},
	notSupportedID:           {T: "{{ asset }} não tem suporte"},
	connectionFailedID:       {T: "Conexão ao server dex falhou. Pode fechar bisonw e tentar novamente depois ou esperar para tentar se reconectar."},
	calculatingID:            {T: "calculando..."},
	estimateUnavailableID:    {T: "estimativa indisponível"},
	noZeroRateID:             {T: "taxa não pode ser zero"},
	noZeroQuantityID:         {T: "quantidade não pode ser zero"},
	tradeID:                  {T: "troca"},
	noAssetWalletID:          {T: "Sem carteira {{ asset }}"},
	executedID:               {T: "executado"},
	bookedID:                 {T: "reservado"},
	cancelingID:              {T: "cancelando"},
	acctUndefinedID:          {T: "conta não definida."},
	keepWalletPassID:         {T: "manter senha da carteira"},
	newWalletPassID:          {T: "definir nova senha para carteira"},
	lotID:                    {T: "lote"},
	lotsID:                   {T: "lotes"},
	unknownID:                {T: "desconhecido"},
	epochID:                  {T: "epoque"},
	settlingID:               {T: "assentando"},
	noMatchID:                {T: "sem combinações"},
	canceledID:               {T: "cancelado"},
	revokedID:                {T: "revocado"},
	waitingForConfsID:        {T: "Esperando confirmações..."},
	noneSelectedID:           {T: "nenhuma selecionado"},
	regFeeSuccessID:          {T: "Sucesso no pagamento da taxa de registro!"},
	apiErrorID:               {T: "erro de API: {{ msg }}"},
	addID:                    {T: "Adicionar"},
	createID:                 {T: "Criar"},
	setupWalletID:            {T: "Configurar"},
	changeWalletTypeID:       {T: "trocar o tipo de carteira"},
	keepWalletTypeID:         {T: "Não trocara tipo de carteira"},
	walletReadyID:            {T: "Carteira Pronta"},
	setupNeededID:            {T: "Configuração Necessária"},
	availableID:              {T: "disponível"},
	immatureID:               {T: "imaturo"},
	maxID:                    {T: "ma"},
}

var zhCN = map[string]*intl.Translation{
	noPassErrMsgID:           {T: "密码不能为空"},
	noAppPassErrMsgID:        {T: "应用密码不能为空"},
	passwordNotMatchID:       {T: "密码不相同"},
	setButtonBuyID:           {T: "来自{{ asset }}的买入订单"},
	setButtonSellID:          {T: "来自{{ asset }}的卖出订单"},
	offID:                    {T: "关闭"},
	readyID:                  {T: "准备就绪"},
	lockedID:                 {T: "锁"},
	noWalletID:               {T: "未连接钱包"},
	walletSyncProgressID:     {T: "钱包同步进度{{ syncProgress }}%"},
	hideAdditionalSettingsID: {T: "隐藏其它设置"},
	showAdditionalSettingsID: {T: "显示其它设置"},
	buyID:                    {T: "买入"},
	sellID:                   {T: "卖出"},
	notSupportedID:           {T: "{{ asset }}不受支持"},
	connectionFailedID:       {T: "连接到服务器 dex 失败。您可以关闭 bisonw 并稍后重试或等待尝试重新连接。"},
	calculatingID:            {T: "计算中..."},
	estimateUnavailableID:    {T: "估计不可用"},
	noZeroRateID:             {T: "汇率不能为零"},
	noZeroQuantityID:         {T: "数量不能为零"},
	tradeID:                  {T: "交易"},
	noAssetWalletID:          {T: "没有钱包 {{ asset }}"},
	executedID:               {T: "执行"},
	bookedID:                 {T: "保留"},
	cancelingID:              {T: "取消"},
	acctUndefinedID:          {T: "帐户未定义。"},
	keepWalletPassID:         {T: "保留钱包密码"},
	newWalletPassID:          {T: "设置新的钱包密码"},
	lotID:                    {T: "批处理"},
	lotsID:                   {T: "批"},
	epochID:                  {T: "时间"},
	apiErrorID:               {T: "接口错误: {{ msg }}"},
	addID:                    {T: "添加"},
	createID:                 {T: "创建"},
	availableID:              {T: "可用"},
	immatureID:               {T: "不成"},
	limitOrderID:             {T: "限价单"},
	marketOrderID:            {T: "市价单"},
	cancelOrderID:            {T: "取消单"},
}

var plPL = map[string]*intl.Translation{
	noPassErrMsgID:                   {T: "hasło nie może być puste"},
	noAppPassErrMsgID:                {T: "hasło aplikacji nie może być puste"},
	passwordNotMatchID:               {T: "hasła nie są jednakowe"},
	setButtonBuyID:                   {T: "Złóż zlecenie, aby kupić  {{ asset }}"},
	setButtonSellID:                  {T: "Złóż zlecenie, aby sprzedać {{ asset }}"},
	offID:                            {T: "wyłączony"},
	readyID:                          {T: "gotowy"},
	lockedID:                         {T: "zablokowany"},
	noWalletID:                       {T: "brak portfela"},
	walletSyncProgressID:             {T: "portfel zsynchronizowany w {{ syncProgress }}%"},
	hideAdditionalSettingsID:         {T: "ukryj dodatkowe ustawienia"},
	showAdditionalSettingsID:         {T: "pokaż dodatkowe ustawienia"},
	buyID:                            {T: "Kup"},
	sellID:                           {T: "Sprzedaj"},
	notSupportedID:                   {T: "{{ asset }} nie jest wspierany"},
	connectionFailedID:               {T: "Połączenie z serwerem dex nie powiodło się. Możesz zamknąć bisonw i spróbować ponownie później, lub poczekać na wznowienie połączenia."},
	calculatingID:                    {T: "obliczanie..."},
	estimateUnavailableID:            {T: "brak szacunkowego wyliczenia"},
	noZeroRateID:                     {T: "zero nie może być ceną"},
	noZeroQuantityID:                 {T: "zero nie może być ilością"},
	tradeID:                          {T: "handluj"},
	noAssetWalletID:                  {T: "Brak portfela {{ asset }}"},
	executedID:                       {T: "wykonano"},
	bookedID:                         {T: "zapisano"},
	cancelingID:                      {T: "anulowanie"},
	acctUndefinedID:                  {T: "Niezdefiniowane konto."},
	keepWalletPassID:                 {T: "zachowaj obecne hasło portfela"},
	newWalletPassID:                  {T: "ustaw nowe hasło portfela"},
	lotID:                            {T: "lot"},
	lotsID:                           {T: "loty(ów)"},
	unknownID:                        {T: "nieznane"},
	epochID:                          {T: "epoka"},
	settlingID:                       {T: "rozliczanie"},
	noMatchID:                        {T: "brak spasowania"},
	canceledID:                       {T: "anulowano"},
	revokedID:                        {T: "unieważniono"},
	canceledPartiallyFilledID:        {T: "anulowano/częściowo zrealizowano"},
	revokedPartiallyFilledID:         {T: "unieważniono/częściowo zrealizowano"},
	waitingForConfsID:                {T: "Oczekiwanie na potwierdzenia..."},
	noneSelectedID:                   {T: "brak zaznaczenia"},
	apiErrorID:                       {T: "błąd API: {{ msg }}"},
	addID:                            {T: "Dodaj"},
	createID:                         {T: "Utwórz"},
	setupWalletID:                    {T: "Konfiguracja"},
	changeWalletTypeID:               {T: "zmień typ portfela"},
	keepWalletTypeID:                 {T: "nie zmieniaj typu portfela"},
	walletReadyID:                    {T: "Portfel jest gotowy"},
	setupNeededID:                    {T: "Potrzebna konfiguracja"},
	availableID:                      {T: "dostępne"},
	immatureID:                       {T: "niedojrzałe"},
	lockedOrderBalMsgID:              {T: "Środki zablokowane w niesparowanych zamówieniach"},
	invalidCertID:                    {T: "Nieważny certyfikat"},
	connectedID:                      {T: "Połączono"},
	invalidTierValueID:               {T: "Niepoprawna wartość poziomu"},
	selectWalletForFeePaymentID:      {T: "Wybierz odpowiedni portfel, aby opłacić kaucję"},
	makerID:                          {T: "Maker"},
	disconnectedID:                   {T: "Rozłączono"},
	reservesDeficitMsgID:             {T: "Brak odpowiedniego salda portfela do utrzymania poziomu kaucji. Jeśli ten problem będzie się utrzymywał, konieczne może być dodanie środków, aby utrzymać kaucję."},
	connectWalletErrMsgID:            {T: "Połączenie z portfelem {{ assetName }} nie powiodło się: {{ errMsg }}"},
	matchStatusTakerSwapCastID:       {T: "Wysłano swap taker"},
	txTypeAccelerationID:             {T: "Przyspieszenie"},
	orderBttnQtyErrID:                {T: "Ilość zamówień musi zostać określona."},
	botTypeSimpleArbID:               {T: "Prosty arbitraż"},
	bondReservesID:                   {T: "Rezerwy kaucji"},
	invalidValueID:                   {T: "nieprawidłowa wartość"},
	disabledMsgID:                    {T: "portfel jest wyłączony"},
	walletRecoverySupportMsgID:       {T: "Błąd wczytywania wbudowanego portfela {{ walletSymbol }}. Kliknij przycisk 'Odtwórz' poniżej, aby to naprawić"},
	sendSuccessID:                    {T: "Wysłano {{ assetName }}!"},
	limitOrderImmediateTifID:         {T: "limit (i)"},
	txTypeSwapID:                     {T: "Swap"},
	txFeeErrorMsgID:                  {T: "szacowanie opłaty nie powiodło się: {{ err }}"},
	botTypeBasicMMID:                 {T: "Animacja rynku"},
	botTypeNoneID:                    {T: "wybierz rodzaj bota"},
	orderBttnQtyRateErrID:            {T: "Ilość zamówień i cena muszą zostać określone."},
	shieldedMsgID:                    {T: "Suma osłoniętych środków"},
	noZeroID:                         {T: "wartość nie może być zerowa"},
	marketOrderID:                    {T: "market"},
	walletDisabledID:                 {T: "Portfel {{ assetName }} jest wyłączony"},
	missingCexCredsID:                {T: "określ zarówno klucz, jak i sekret"},
	takerID:                          {T: "Taker"},
	txTypeCreateBondID:               {T: "Utwórz kaucję"},
	confirmationsID:                  {T: "potwierdzenia"},
	deleteArchivedRecordsID:          {T: "Wiadomość: usunięto {{ nRecords }} wiadomości archiwalnych"},
	browserNtfnMatchesID:             {T: "Sparowania"},
	rescanStartedID:                  {T: "Trwa ponowne skanowanie portfela"},
	addingServersID:                  {T: "Łączenie z serwerami"},
	swappingID:                       {T: "Wymiana"},
	matchStatusRefundedID:            {T: "Zwrócono"},
	matchStatusRevokedID:             {T: "Odrzucono - {{ status }}"},
	txTypeRedeemID:                   {T: "Wykup"},
	orderAccelerationFeeErrMsgID:     {T: "Błąd przy szacowaniu opłaty przyspieszenia: {{ msg }}"},
	ticketStatusRevokedID:            {T: "odwołany"},
	limitOrderID:                     {T: "limit"},
	orderBttnBuyBalErrID:             {T: "Brak wystarczających środków do zakupu."},
	lockedBalMsgID:                   {T: "Suma środków tymczasowo zablokowanych na pokrycie kaucji, wystawionych zamówień, sparowań, oraz innych czynności"},
	unavailableID:                    {T: "niedostępny"},
	createAssetWalletMsgID:           {T: "Utwórz portfel {{ asset }}, aby rozpocząć handel"},
	sellingID:                        {T: "Sprzedaż"},
	discoveredID:                     {T: "Odkryto"},
	ticketStatusUnspentID:            {T: "niewykorzystany"},
	browserNtfnBondsID:               {T: "Kaucje"},
	invalidCompsValueID:              {T: "Nieprawidłowa wartość zrównoważenia"},
	buyingID:                         {T: "Kupno"},
	ticketsPurchasedID:               {T: "Zakupiono {{ n }} biletów!"},
	browserNtfnOrdersID:              {T: "Zamówienia"},
	invalidAddrressMsgID:             {T: "nieprawidłowy adres: {{ address }}"},
	browserNtfnConnectionsID:         {T: "Połączenia z serwerami"},
	txTypeTicketVoteID:               {T: "Głos"},
	reservesDeficitID:                {T: "Deficyt rezerw"},
	bondedID:                         {T: "Zabezpieczone kaucją"},
	creatingWalletsID:                {T: "Tworzenie portfeli"},
	orderID:                          {T: "Zamówienie"},
	emptyDexAddrID:                   {T: "Pole adresu DEX nie może być puste"},
	addedID:                          {T: "Dodano"},
	tradingTierUpdateddID:            {T: "Zaktualizowano poziom handlu"},
	txTypeTicketPurchaseID:           {T: "Zakup biletu"},
	unsupportedAssetInfoErrMsgID:     {T: "brak wspieranego aktywa dla id = {{ assetID }}, oraz brak informacji o giełdzie"},
	orderSubmittingID:                {T: "składanie"},
	ticketStatusMissedID:             {T: "przegapiony"},
	feeBalanceID:                     {T: "saldo opłat"},
	browserNtfnEnabledID:             {T: "Powiadomienia DCRDEX są włączone"},
	ticketStatusExpiredID:            {T: "wygasły"},
	txFeeSupportedID:                 {T: "szacowanie opłat dla tego rodzaju portfela nie jest wspierane"},
	matchStatusRedeemPendingID:       {T: "Wykup środków w toku"},
	passwordResetSuccessMsgID:        {T: "Hasło zostało zresetowane pomyślnie. Możesz zalogować się z użyciem nowego hasła."},
	depthLoadingID:                   {T: "pobieranie danych o głębokości"},
	txTypeApproveTokenID:             {T: "Zatwierdź token"},
	txTypeSendID:                     {T: "Wyślij"},
	openWalletErrMsgID:               {T: "Błąd otwierania portfela: {{ msg }}"},
	reconfigSuccessID:                {T: "Konfiguracja portfela powiodła się!"},
	ticketStatusUnminedID:            {T: "niewydobyty"},
	immatureBalMsgID:                 {T: "Nadchodzące środki oczekujące na potwierdzenie"},
	matchStatusRedemptionSentID:      {T: "Wysłano transakcję wykupu"},
	availableTitleID:                 {T: "Dostępne"},
	newWalletSuccessID:               {T: "Utworzono portfel {{ assetName }}!"},
	txTypeTicketRevokeID:             {T: "Odwołanie biletu"},
	shieldedID:                       {T: "Osłonięte"},
	takerFoundMakerRedemptionID:      {T: "Wykupione przez {{ makerAddr }}"},
	lockedSwappingBalMsgID:           {T: "Środki obecnie zablokowane w rozliczanych sparowaniach"},
	refundImminentID:                 {T: "Odbędzie się w następnych paru blokach"},
	immatureTitleID:                  {T: "Niedojrzałe"},
	matchStatusMakerSwapCastID:       {T: "Wysłano swap maker"},
	matchStatusRedemptionConfirmedID: {T: "Wykup potwierdzony"},
	txTypeRefundID:                   {T: "Zwrot"},
	orderBttnSellBalErrID:            {T: "Brak wystarczających środków do sprzedaży."},
	txTypeSelfTransferID:             {T: "Przelew własny"},
	noWalletMsgID:                    {T: "Utwórz portfele {{ asset1 }} oraz {{ asset2 }}, aby rozpocząć handel"},
	ticketStatusUnknownID:            {T: "nieznany"},
	ticketStatusVotedID:              {T: "oddano głos"},
	txTypeRevokeTokenApprovalID:      {T: "Wycofaj zatwierdzenie tokena"},
	lockedBonBalMsgID:                {T: "Środki zablokowane w aktywnych kaucjach"},
	activeOrdersLogoutErrorID:        {T: "nie można wylogować się z aktywnymi zamówieniami"},
	activeOrdersErrorID:              {T: "Portfel {{ assetName }} zarządza aktywnymi zamówieniami"},
	lockedTitleID:                    {T: "Zablokowane"},
	noCexID:                          {T: "wybierz giełdę do arbitrażu"},
	bondReservesMsgID:                {T: "Środki zarezerwowane na pokrycie kosztów związanych z utrzymaniem kaucji"},
	walletUnlockedID:                 {T: "Odblokowano portfel"},
	matchStatusNewlyMatchedID:        {T: "Świeżo sparowane"},
	regFeeSuccessID:                  {Version: 1, T: "Kaucja lojalnościowa została przyjęta!"},
	botTypeArbMMID:                   {T: "Animacja rynku + arbitraż"},
	txTypeRedeemBondID:               {T: "Wykup kaucji"},
	ticketStatusImmatureID:           {T: "niedojrzałe"},
	archivedRecordsPathID:            {T: "Lokalizacja pliku:  {{ path }}"},
	candlesLoadingID:                 {T: "oczekiwanie na świece"},
	walletEnabledID:                  {T: "Portfel {{ assetName }} jest włączony"},
	matchStatusMakerRedeemedID:       {T: "Maker wykupił środki"},
	noPlacementsID:                   {T: "1 lub więcej miejsc musi zostać określone"},
	cexBalanceErrID:                  {T: "błąd pobierania salda {{ cexName }} dla {{ assetID }}: {{ err }}"},
	refundWillHappenAfterID:          {T: "Zwrot środków za {{ refundAfterTime }}"},
	txTypeSplitID:                    {T: "Dzielona"},
	versionNotSupportedID:            {T: "{{ asset }} (v{{version}}) nie jest wspierana"},
	matchStatusCompleteID:            {T: "Zakończone"},
	noArchivedRecordsID:              {T: "Brak zapisów archiwalnych"},
	ticketStatusLiveID:               {T: "gotowy do głosowania"},
	orderAccelerationErrMsgID:        {T: "Błąd przyspieszenia zamówienia: {{ msg }}"},
	matchStatusRefundPendingID:       {T: "Zwrot środków W TOKU"},
	invalidDateErrorMsgID:            {T: "błąd: nieprawidłowa data lub czas"},
	defaultID:                        {T: "Domyślne"},
	txTypeUnknownID:                  {T: "Nieznany"},
	walletSyncFinishingID:            {T: "na ukończeniu"},
	txTypeReceiveID:                  {T: "Odbiór"},
	mmConfigureID:                    {T: "Skonfiguruj"},
	mmMarketNotAvailableID:           {T: "Rynek niedostępny"},
	mmSelectMarketID:                 {T: "Wybierz rynek"},
	mmRebalanceSettingsID:            {T: "Ustawienia rebalancingu"},
	mmSettingsID:                     {T: "Ustawienia"},
	mmDepositID:                      {T: "Zdeponuj"},
}

var deDE = map[string]*intl.Translation{
	noPassErrMsgID:           {T: "Passwort darf nicht leer sein"},
	noAppPassErrMsgID:        {T: "App-Passwort darf nicht leer sein"},
	passwordNotMatchID:       {T: "Passwörter stimmen nicht überein"},
	setButtonBuyID:           {T: "Platziere Auftrag zum Kauf von  {{ asset }}"},
	setButtonSellID:          {T: "Platziere Auftrag zum Verkauf von {{ asset }}"},
	offID:                    {T: "aus"},
	readyID:                  {T: "bereit"},
	lockedID:                 {T: "gesperrt"},
	noWalletID:               {T: "kein Wallet"},
	walletSyncProgressID:     {T: "Wallet ist zu {{ syncProgress }}% synchronisiert"},
	hideAdditionalSettingsID: {T: "zusätzliche Einstellungen ausblenden"},
	showAdditionalSettingsID: {T: "zusätzliche Einstellungen anzeigen"},
	buyID:                    {T: "Kaufen"},
	sellID:                   {T: "Verkaufen"},
	notSupportedID:           {T: "{{ asset }} wird nicht unterstützt"},
	connectionFailedID:       {T: "Die Verbindung zum Dex-Server fehlgeschlagen. Du kannst bisonw schließen und es später erneut versuchen oder warten bis die Verbindung wiederhergestellt ist."},
	calculatingID:            {T: "kalkuliere..."},
	estimateUnavailableID:    {T: "Schätzung nicht verfügbar"},
	noZeroRateID:             {T: "Null-Satz nicht erlaubt"},
	noZeroQuantityID:         {T: "Null-Menge nicht erlaubt"},
	tradeID:                  {T: "Handel"},
	noAssetWalletID:          {T: "Kein {{ asset }} Wallet"},
	executedID:               {T: "ausgeführt"},
	bookedID:                 {T: "gebucht"},
	cancelingID:              {T: "Abbruch"},
	acctUndefinedID:          {T: "Account undefiniert."},
	keepWalletPassID:         {T: "aktuelles Passwort für das Wallet behalten"},
	newWalletPassID:          {T: "ein neues Passwort für das Wallet festlegen"},
	lotID:                    {T: "Lot"},
	lotsID:                   {T: "Lots"},
	unknownID:                {T: "unbekannt"},
	epochID:                  {T: "Epoche"},
	settlingID:               {T: "Abwicklung"},
	noMatchID:                {T: "kein Match"},
	canceledID:               {T: "abgebrochen"},
	revokedID:                {T: "widerrufen"},
	waitingForConfsID:        {T: "Warten auf Bestätigungen..."},
	noneSelectedID:           {T: "keine ausgewählt"},
	regFeeSuccessID:          {T: "Zahlung der Registrierungsgebühr erfolgreich!"},
	apiErrorID:               {T: "API Fehler: {{ msg }}"},
	addID:                    {T: "Hinzufügen"},
	createID:                 {T: "Erstellen"},
	setupWalletID:            {T: "Einrichten"},
	changeWalletTypeID:       {T: "den Wallet-Typ ändern"},
	keepWalletTypeID:         {T: "den Wallet-Typ nicht ändern"},
	walletReadyID:            {T: "Wallet bereit"},
	setupNeededID:            {T: "Einrichtung erforderlich"},
	sendSuccessID:            {T: "{{ assetName }} gesendet!"},
	reconfigSuccessID:        {T: "Wallet neu konfiguriert!"},
	rescanStartedID:          {T: "Wallet Rescan läuft"},
	newWalletSuccessID:       {T: "{{ assetName }} Wallet erstellt!"},
	walletUnlockedID:         {T: "Wallet entsperrt"},
}

var ar = map[string]*intl.Translation{
	noPassErrMsgID:                   {T: "لا يمكن أن تكون كلمة المرور فارغة"},
	noAppPassErrMsgID:                {T: "لا يمكن أن تكون كلمة مرور التطبيق فارغة"},
	passwordNotMatchID:               {T: "كلمات المرور غير متطابقة"},
	setButtonBuyID:                   {T: "ضع طلبًا للشراء  {{ asset }}"},
	setButtonSellID:                  {T: "ضع طلبًا للبيع {{ asset }}"},
	offID:                            {T: "إيقاف"},
	readyID:                          {T: "متوقف"},
	lockedID:                         {T: "مقفل"},
	noWalletID:                       {T: "لا توجد أي محفظة"},
	walletSyncProgressID:             {T: "تمت مزامنة {{ syncProgress }}% المحفظة"},
	hideAdditionalSettingsID:         {T: "إخفاء الإعدادات الإضافية"},
	showAdditionalSettingsID:         {T: "عرض الإعدادات الإضافية"},
	buyID:                            {T: "شراء"},
	sellID:                           {T: "بيع"},
	notSupportedID:                   {T: "{{ asset }} غير مدعوم"},
	connectionFailedID:               {T: "فشل الاتصال بخادم dex. يمكنك إغلاق dexc والمحاولة مرة أخرى لاحقًا أو انتظار إعادة الاتصال."},
	calculatingID:                    {T: "جاري الحساب ..."},
	estimateUnavailableID:            {T: "التقديرات غير متاحة"},
	noZeroRateID:                     {T: "معدل الصفر غير مسموح به"},
	noZeroQuantityID:                 {T: "غير مسموح بالكمية الصفرية"},
	tradeID:                          {T: "التداول"},
	noAssetWalletID:                  {T: "لا توجد {{ asset }} محفظة"},
	executedID:                       {T: "تم تنفيذها"},
	bookedID:                         {T: "تم الحجز"},
	cancelingID:                      {T: "جارٍ الإلغاء"},
	acctUndefinedID:                  {T: "حساب غير محدد."},
	keepWalletPassID:                 {T: "احتفظ بكلمة مرور المحفظة الحالية"},
	newWalletPassID:                  {T: "قم بتعيين كلمة مرور جديدة للمحفظة"},
	lotID:                            {T: "الحصة"},
	lotsID:                           {T: "الحصص"},
	unknownID:                        {T: "غير معروف"},
	epochID:                          {T: "الحقبة الزمنية"},
	settlingID:                       {T: "الإعدادات"},
	noMatchID:                        {T: "غير متطابقة"},
	canceledID:                       {T: "ملغاة"},
	revokedID:                        {T: "مستعادة"},
	canceledPartiallyFilledID:        {T: "ملغاة/معبأة جزئيًا"},
	revokedPartiallyFilledID:         {T: "مستعادة/معبأة جزئيًا"},
	waitingForConfsID:                {T: "في انتظار التأكيدات ..."},
	noneSelectedID:                   {T: "لم يتم تحديد أي شيء"},
	apiErrorID:                       {T: "خطأ في واجهة برمجة التطبيقات :{{ msg }}"},
	addID:                            {T: "إضافة"},
	createID:                         {T: "إنشاء"},
	setupWalletID:                    {T: "إعداد"},
	changeWalletTypeID:               {T: "تغيير نوع المحفظة"},
	keepWalletTypeID:                 {T: "لا تغير نوع المحفظة"},
	walletReadyID:                    {T: "المحفظة جاهزة"},
	setupNeededID:                    {T: "الإعداد مطلوب"},
	sendSuccessID:                    {T: "{{ assetName }} تم الإرسال!"},
	reconfigSuccessID:                {T: "تمت إعادة تهيئة المحفظة!!"},
	rescanStartedID:                  {T: "إعادة فحص المحفظة قيد التشغيل"},
	newWalletSuccessID:               {T: "{{ assetName }} تم إنشاء المحفظة!"},
	walletUnlockedID:                 {T: "المحفظة غير مقفلة"},
	sellingID:                        {T: "البيع"},
	buyingID:                         {T: "Bالشراء"},
	walletEnabledID:                  {T: "{{ assetName }} المحفظة ممكنة"},
	walletDisabledID:                 {T: "{{ assetName }} المحفظة معطلة"},
	disabledMsgID:                    {T: "تم تعطيل المحفظة"},
	activeOrdersErrorID:              {T: "{{ assetName }} تدير المحفظة  الطلبات بفعالية"},
	orderBttnQtyRateErrID:            {T: "يجب تحديد كمية وسعر الطلب."},
	reservesDeficitMsgID:             {T: "النقص في رصيد المحفظة القابل للوصول للحفاظ على مستوى السند. إذا استمر هذا الوضع، قد تحتاج إلى إضافة أموال للبقاء مضمونا بسند."},
	invalidCertID:                    {T: "شهادة غير صالحة"},
	availableTitleID:                 {T: "متاح"},
	addedID:                          {T: "تمت الإضافة"},
	ticketStatusUnspentID:            {T: "غير منفقة"},
	txTypeTicketVoteID:               {T: "تصويت التذكرة"},
	disconnectedID:                   {T: "انقطع الاتصال"},
	shieldedID:                       {T: "محمية"},
	ticketStatusExpiredID:            {T: "منتهية الصلاحية"},
	txTypeRefundID:                   {T: "استرداد"},
	discoveredID:                     {T: "مكتشفة"},
	versionNotSupportedID:            {T: "{{ asset }} (v{{version}}) غير مدعوم"},
	noWalletMsgID:                    {T: "أنشئ محفظة لتداول {{ asset1 }} و {{ asset2 }}"},
	noPlacementsID:                   {T: "يجب تحديد موضع واحد أو أكثر"},
	ticketStatusUnknownID:            {T: "غير معروفة"},
	matchStatusMakerRedeemedID:       {T: "استرداد صانع السوق"},
	txTypeSelfTransferID:             {T: "التحويل الذاتي"},
	tradingTierUpdateddID:            {T: "تم تحديث مستوى التداول"},
	txTypeApproveTokenID:             {T: "اعتماد التوكن"},
	cexBalanceErrID:                  {T: "خطأ في جلب رصيد {{ cexName }} لـ {{ assetID }}: {{ err }}"},
	txTypeTicketRevokeID:             {T: "استرجاع التذكرة"},
	makerID:                          {T: "صانع السوق"},
	txTypeAccelerationID:             {T: "التعجيل"},
	noZeroID:                         {T: "الصفر غير مسموح"},
	txTypeReceiveID:                  {T: "استلام"},
	invalidValueID:                   {T: "قيمة غير صحيحة"},
	connectWalletErrMsgID:            {T: "فشل في الاتصال بمحفظة {{ assetName }}: {{ errMsg }}"},
	matchStatusRevokedID:             {T: "مسترجعة - {{ status }}"},
	lockedBonBalMsgID:                {T: "الأموال مقفلة في سندات نشطة"},
	orderID:                          {T: "طلب"},
	regFeeSuccessID:                  {Version: 1, T: "تم قبول سند الاخلاص!"},
	connectedID:                      {T: "متصل"},
	limitOrderID:                     {T: "حد السعر"},
	lockedOrderBalMsgID:              {T: "الأموال مقفلة في الطلبات غير المتطابقة"},
	limitOrderImmediateTifID:         {T: "حد السعر (i)"},
	swappingID:                       {T: "المقايضة"},
	refundWillHappenAfterID:          {T: "سيحدث الاسترداد بعد {{ refundAfterTime }}"},
	takerFoundMakerRedemptionID:      {T: "تم الاسترداد بواسطة {{ makerAddr }}"},
	ticketStatusRevokedID:            {T: "مسترجعة"},
	matchStatusRedemptionSentID:      {T: "تم إرسال الاسترداد"},
	ticketStatusVotedID:              {T: "مُصوِّتة"},
	browserNtfnBondsID:               {T: "السندات"},
	orderBttnBuyBalErrID:             {T: "رصيد غير كاف للشراء."},
	matchStatusRefundedID:            {T: "تم الاسترداد"},
	bondReservesMsgID:                {T: "الأموال المخصصة لتغطية النفقات المرتبطة بصيانة السندات"},
	noArchivedRecordsID:              {T: "لم يتم العثور على سجلات مؤرشفة"},
	marketOrderID:                    {T: "السوق"},
	walletSyncFinishingID:            {T: "الانتهاء"},
	browserNtfnMatchesID:             {T: "التطابقات"},
	noCexID:                          {T: "اختر منصة مبادلات للمراجحة"},
	walletRecoverySupportMsgID:       {T: "فشل تحميل محفظة {{ walletSymbol }} الأصلية بشكل صحيح. حاول النقر على زر 'استعادة' أدناه لإصلاحها"},
	invalidCompsValueID:              {T: "قيمة المقارنات غير صحيحة"},
	immatureBalMsgID:                 {T: "الأموال الواردة في انتظار التأكيد"},
	archivedRecordsPathID:            {T: "موقع الملف: {{ path }}"},
	passwordResetSuccessMsgID:        {T: "تمت إعادة تعيين كلمة المرور الخاصة بك بنجاح. يمكنك المتابعة لتسجيل الدخول باستخدام كلمة المرور الجديدة."},
	matchStatusNewlyMatchedID:        {T: "مطابقة حديثة"},
	ticketStatusLiveID:               {T: "حية"},
	matchStatusRefundPendingID:       {T: "الاسترداد قيد الانتظار"},
	selectWalletForFeePaymentID:      {T: "حدد محفظة صالحة لنشر السند"},
	matchStatusRedemptionConfirmedID: {T: "تم تأكيد الإسترداد"},
	matchStatusCompleteID:            {T: "مكتملة"},
	ticketStatusUnminedID:            {T: "غير معدنة"},
	orderAccelerationErrMsgID:        {T: "خطأ في تسريع الطلب: {{ msg }}"},
	missingCexCredsID:                {T: "حدد كلاً من المفتاح والسر"},
	lockedSwappingBalMsgID:           {T: "الأموال مقفلة حاليا في تسوية المطابقات"},
	invalidAddrressMsgID:             {T: "عنوان غير صحيح: {{ address }}"},
	openWalletErrMsgID:               {T: "خطأ في فتح المحفظة: {{ msg }}"},
	botTypeBasicMMID:                 {T: "صانع السوق"},
	shieldedMsgID:                    {T: "إجمالي الأموال المحتفظ بها محمية"},
	txFeeErrorMsgID:                  {T: "فشل تقدير الرسوم: {{ err }}"},
	createAssetWalletMsgID:           {T: "أنشئ محفظة {{ asset }} للتداول"},
	takerID:                          {T: "المستفيد"},
	lockedBalMsgID:                   {T: "إجمالي الأموال مقفلة مؤقتًا لتغطية تكاليف صيانة السندات، والطلبات الحية، والمطابقات والأنشطة الأخرى"},
	matchStatusTakerSwapCastID:       {T: "تم إرسال مقايضة المستفيد"},
	defaultID:                        {T: "افتراضي"},
	botTypeNoneID:                    {T: "اختر نوع البوت"},
	availableID:                      {T: "متوفر"},
	creatingWalletsID:                {T: "إنشاء المحافظ"},
	orderSubmittingID:                {T: "تقديم"},
	deleteArchivedRecordsID:          {T: "الرسالة: تم حذف {{ nRecords }} من السجلات المؤرشفة"},
	ticketStatusImmatureID:           {T: "غير ناضجة"},
	txTypeRevokeTokenApprovalID:      {T: "إلغاء الموافقة بالتوكن"},
	txTypeRedeemBondID:               {T: "استرداد السند"},
	browserNtfnEnabledID:             {T: "تم تفعيل إشعارات منصة المبادلات اللامركزية لديكريد DCRDEX"},
	orderAccelerationFeeErrMsgID:     {T: "خطأ في تقدير رسوم التسريع: {{ msg }}"},
	depthLoadingID:                   {T: "استرجاع بيانات العمق"},
	matchStatusMakerSwapCastID:       {T: "تم إرسال مقايضة صانع السوق"},
	feeBalanceID:                     {T: "رصيد الرسوم"},
	confirmationsID:                  {T: "التأكيدات"},
	addingServersID:                  {T: "الاتصال بالخوادم"},
	invalidTierValueID:               {T: "قيمة المستوى غير صحيحة"},
	activeOrdersLogoutErrorID:        {T: "لا يمكن تسجيل الخروج مع وجود طلبات نشطة"},
	browserNtfnOrdersID:              {T: "الطلبات"},
	botTypeArbMMID:                   {T: "صانع السوق + المراجحة"},
	bondedID:                         {T: "مضمون بسند"},
	botTypeSimpleArbID:               {T: "المراجحة البسيطة"},
	txTypeSendID:                     {T: "إرسال"},
	txTypeTicketPurchaseID:           {T: "شراء التذكرة"},
	unsupportedAssetInfoErrMsgID:     {T: "لا توجد معلومات عن الأصول المدعومة للمعرف = {{ assetID }}، ولم يتم تقديم معلومات عن منصة المبادلات"},
	ticketsPurchasedID:               {T: "شراء {{ n }} تذاكر!"},
	refundImminentID:                 {T: "سيحدث في الكتل القليلة القادمة"},
	candlesLoadingID:                 {T: "في انتظار أعمدة الشموع"},
	immatureID:                       {T: "غير ناضجة"},
	unavailableID:                    {T: "غير متوفرة"},
	bondReservesID:                   {T: "احتياطيات السندات"},
	txTypeUnknownID:                  {T: "غير معروفة"},
	txTypeCreateBondID:               {T: "إنشاء السند"},
	emptyDexAddrID:                   {T: "لا يمكن أن يكون عنوان منصة المبادلات اللامركزية DEX فارغًا"},
	txTypeRedeemID:                   {T: "استرداد"},
	orderBttnQtyErrID:                {T: "يجب تحديد كمية الطلب."},
	immatureTitleID:                  {T: "غير ناضجة"},
	invalidDateErrorMsgID:            {T: "خطأ: تاريخ أو وقت غير صحيح"},
	reservesDeficitID:                {T: "عجز الاحتياطيات"},
	browserNtfnConnectionsID:         {T: "اتصالات الخادم"},
	lockedTitleID:                    {T: "مقفل"},
	txTypeSplitID:                    {T: "تقسيم"},
	matchStatusRedeemPendingID:       {T: "الاسترداد قيد الانتظار"},
	txTypeSwapID:                     {T: "مقايضة"},
	ticketStatusMissedID:             {T: "مفوتة"},
	txFeeSupportedID:                 {T: "تقدير الرسوم غير مدعوم لهذا النوع من المحفظة"},
	orderBttnSellBalErrID:            {T: "الرصيد غير كافي للبيع."},
	mmConfigureID:                    {T: "التهيئة"},
	mmMarketNotAvailableID:           {T: "السوق غير متوفر"},
	mmSelectMarketID:                 {T: "اختر سوقًا"},
	mmRebalanceSettingsID:            {T: "إعدادات إعادة الرصيد لـ"},
	mmSettingsID:                     {T: "الإعدادات"},
	mmDepositID:                      {T: "إيداع"},
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
