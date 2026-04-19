package core

type translation struct {
	subject  string
	template string
}

const originLang = "en-US"

// originLocale is the American English translations.
var originLocale = map[Topic]*translation{
	TopicAccountRegistered: {
		subject:  "Account registered",
		template: "You may now trade at %s",
	},
	TopicFeePaymentInProgress: {
		subject:  "Fee payment in progress",
		template: "Waiting for %d confirmations before trading at %s",
	},
	TopicRegUpdate: {
		subject:  "regupdate",
		template: "Fee payment confirmations %v/%v",
	},
	TopicFeePaymentError: {
		subject:  "Fee payment error",
		template: "Error encountered while paying fees to %s: %v",
	},
	TopicAccountUnlockError: {
		subject:  "Account unlock error",
		template: "error unlocking account for %s: %v",
	},
	TopicFeeCoinError: {
		subject:  "Fee coin error",
		template: "Empty fee coin for %s.",
	},
	TopicWalletConnectionWarning: {
		subject:  "Wallet connection warning",
		template: "Incomplete registration detected for %s, but failed to connect to the Decred wallet",
	},
	TopicBondWalletNotConnected: {
		subject:  "Bond wallet not connected",
		template: "Wallet for selected bond asset %s is not connected",
	},
	TopicWalletUnlockError: {
		subject:  "Wallet unlock error",
		template: "Connected to wallet to complete registration at %s, but failed to unlock: %v",
	},
	TopicWalletCommsWarning: {
		subject:  "Wallet connection issue",
		template: "Unable to communicate with %v wallet! Reason: %v",
	},
	TopicWalletPeersWarning: {
		subject:  "Wallet network issue",
		template: "%v wallet has no network peers!",
	},
	TopicWalletPeersRestored: {
		subject:  "Wallet connectivity restored",
		template: "%v wallet has reestablished connectivity.",
	},
	TopicSendError: {
		subject:  "Send error",
		template: "Error encountered while sending %s: %v",
	},
	TopicSendSuccess: {
		subject:  "Send successful",
		template: "Sending %s %s to %s has completed successfully. Tx ID = %s",
	},
	TopicAsyncOrderFailure: {
		subject:  "In-Flight Order Error",
		template: "In-Flight order with ID %v failed: %v",
	},
	TopicOrderQuantityTooHigh: {
		subject:  "Trade limit exceeded",
		template: "Order quantity exceeds current trade limit on %s",
	},
	TopicOrderLoadFailure: {
		subject:  "Order load failure",
		template: "Some orders failed to load from the database: %v",
	},
	TopicYoloPlaced: {
		subject:  "Market order placed",
		template: "selling %s %s at market rate (%s)",
	},
	TopicBuyOrderPlaced: {
		subject:  "Order placed",
		template: "Buying %s %s, rate = %s (%s)",
	},
	TopicSellOrderPlaced: {
		subject:  "Order placed",
		template: "Selling %s %s, rate = %s (%s)",
	},
	TopicMissingMatches: {
		subject:  "Missing matches",
		template: "%d matches for order %s were not reported by %q and are considered revoked",
	},
	TopicWalletMissing: {
		subject:  "Wallet missing",
		template: "Wallet retrieval error for active order %s: %v",
	},
	TopicMatchErrorCoin: {
		subject:  "Match coin error",
		template: "Match %s for order %s is in state %s, but has no maker swap coin.",
	},
	TopicMatchErrorContract: {
		subject:  "Match contract error",
		template: "Match %s for order %s is in state %s, but has no maker swap contract.",
	},
	TopicMatchRecoveryError: {
		subject:  "Match recovery error",
		template: "Error auditing counter-party's swap contract (%s %v) during swap recovery on order %s: %v",
	},
	TopicOrderCoinError: {
		subject:  "Order coin error",
		template: "No funding coins recorded for active order %s",
	},
	TopicOrderCoinFetchError: {
		subject:  "Order coin fetch error",
		template: "Source coins retrieval error for order %s (%s): %v",
	},
	TopicMissedCancel: {
		subject:  "Missed cancel",
		template: "Cancel order did not match for order %s. This can happen if the cancel order is submitted in the same epoch as the trade or if the target order is fully executed before matching with the cancel order.",
	},
	TopicBuyOrderCanceled: {
		subject:  "Order canceled",
		template: "Buy order on %s-%s at %s has been canceled (%s)",
	},
	TopicSellOrderCanceled: {
		subject:  "Order canceled",
		template: "Sell order on %s-%s at %s has been canceled (%s)",
	},
	TopicBuyMatchesMade: {
		subject:  "Matches made",
		template: "Buy order on %s-%s %.1f%% filled (%s)",
	},
	TopicSellMatchesMade: {
		subject:  "Matches made",
		template: "Sell order on %s-%s %.1f%% filled (%s)",
	},
	TopicSwapSendError: {
		subject:  "Swap send error",
		template: "Error encountered sending a swap output(s) worth %s %s on order %s",
	},
	TopicInitError: {
		subject:  "Swap reporting error",
		template: "Error notifying DEX of swap for match %s: %v",
	},
	TopicReportRedeemError: {
		subject:  "Redeem reporting error",
		template: "Error notifying DEX of redemption for match %s: %v",
	},
	TopicSwapsInitiated: {
		subject:  "Swaps initiated",
		template: "Sent swaps worth %s %s on order %s",
	},
	TopicRedemptionError: {
		subject:  "Redemption error",
		template: "Error encountered sending redemptions worth %s %s on order %s",
	},
	TopicMatchComplete: {
		subject:  "Match complete",
		template: "Redeemed %s %s on order %s",
	},
	TopicRefundFailure: {
		subject:  "Refund Failure",
		template: "Refunded %s %s on order %s, with some errors",
	},
	TopicMatchesRefunded: {
		subject:  "Matches Refunded",
		template: "Refunded %s %s on order %s",
	},
	TopicMatchRevoked: {
		subject:  "Match revoked",
		template: "Match %s has been revoked",
	},
	TopicOrderRevoked: {
		subject:  "Order revoked",
		template: "Order %s on market %s at %s has been revoked by the server",
	},
	TopicOrderAutoRevoked: {
		subject:  "Order auto-revoked",
		template: "Order %s on market %s at %s revoked due to market suspension",
	},
	TopicMatchRecovered: {
		subject:  "Match recovered",
		template: "Found maker's redemption (%s: %v) and validated secret for match %s",
	},
	TopicCancellingOrder: {
		subject:  "Cancelling order",
		template: "A cancel order has been submitted for order %s",
	},
	TopicOrderStatusUpdate: {
		subject:  "Order status update",
		template: "Status of order %v revised from %v to %v",
	},
	TopicMatchResolutionError: {
		subject:  "Match resolution error",
		template: "%d matches reported by %s were not found for %s.",
	},
	TopicFailedCancel: {
		subject:  "Failed cancel",
		template: "Cancel order for order %s failed and is now deleted.",
	},
	TopicAuditTrouble: {
		subject:  "Audit trouble",
		template: "Still searching for counterparty's contract coin %v (%s) for match %s. Are your internet and wallet connections good?",
	},
	TopicDexAuthError: {
		subject:  "DEX auth error",
		template: "%s: %v",
	},
	TopicUnknownOrders: {
		subject:  "DEX reported unknown orders",
		template: "%d active orders reported by DEX %s were not found.",
	},
	TopicOrdersReconciled: {
		subject:  "Orders reconciled with DEX",
		template: "Statuses updated for %d orders.",
	},
	TopicWalletConfigurationUpdated: {
		subject:  "Wallet configuration updated",
		template: "Configuration for %s wallet has been updated. Deposit address = %s",
	},
	TopicWalletPasswordUpdated: {
		subject:  "Wallet Password Updated",
		template: "Password for %s wallet has been updated.",
	},
	TopicMarketSuspendScheduled: {
		subject:  "Market suspend scheduled",
		template: "Market %s at %s is now scheduled for suspension at %v",
	},
	TopicMarketSuspended: {
		subject:  "Market suspended",
		template: "Trading for market %s at %s is now suspended.",
	},
	TopicMarketSuspendedWithPurge: {
		subject:  "Market suspended, orders purged",
		template: "Trading for market %s at %s is now suspended. All booked orders are now PURGED.",
	},
	TopicMarketResumeScheduled: {
		subject:  "Market resume scheduled",
		template: "Market %s at %s is now scheduled for resumption at %v",
	},
	TopicMarketResumed: {
		subject:  "Market resumed",
		template: "Market %s at %s has resumed trading at epoch %d",
	},
	TopicUpgradeNeeded: {
		subject:  "Upgrade needed",
		template: "You may need to update your client to trade at %s",
	},
	TopicServerVersionTooOld: {
		subject:  "Server version incompatible",
		template: "The server at %s is running an incompatible older protocol version.",
	},
	TopicMMSnapshotsNotSupported: {
		subject:  "MM Snapshots Not Supported",
		template: "The server at %s does not support market maker epoch snapshots.",
	},
	TopicDEXConnected: {
		subject:  "Server connected",
		template: "%s",
	},
	TopicDEXDisconnected: {
		subject:  "Server disconnected",
		template: "%s",
	},
	TopicDexConnectivity: {
		subject:  "Internet Connectivity",
		template: "Your connection to %s is unstable, check your internet connection",
	},
	TopicPenalized: {
		subject:  "Server has penalized you",
		template: "Penalty from DEX at %s\nlast broken rule: %s\ntime: %v\ndetails:\n\"%s\"\n",
	},
	TopicSeedNeedsSaving: {
		subject:  "Don't forget to back up your application seed",
		template: "A new application seed has been created. Make a back up now in the settings view.",
	},
	TopicUpgradedToSeed: {
		subject:  "Back up your new application seed",
		template: "The client has been upgraded to use an application seed. Back up the seed now in the settings view.",
	},
	TopicDEXNotification: {
		subject:  "Message from DEX",
		template: "%s: %s",
	},
	TopicQueuedCreationFailed: {
		subject:  "Failed to create token wallet",
		template: "After creating %s wallet, failed to create the %s wallet",
	},
	TopicRedemptionResubmitted: {
		subject:  "Redemption Resubmitted",
		template: "Your redemption for match %s in order %s was resubmitted.",
	},
	TopicRefundResubmitted: {
		subject:  "Refund Resubmitted",
		template: "Your refund for match %s in order %s was resubmitted.",
	},
	TopicSwapRefunded: {
		subject:  "Swap Refunded",
		template: "Match %s in order %s was refunded by the counterparty.",
	},
	TopicRedemptionConfirmed: {
		subject:  "Redemption Confirmed",
		template: "Your redemption for match %s in order %s was confirmed",
	},
	TopicRefundConfirmed: {
		subject:  "Refund Confirmed",
		template: "Your refund for match %s in order %s was confirmed",
	},
	TopicWalletTypeDeprecated: {
		subject:  "Wallet Disabled",
		template: "Your %s wallet type is no longer supported. Create a new wallet.",
	},
	TopicOrderResumeFailure: {
		subject:  "Resume order failure",
		template: "Failed to resume processing of trade: %v",
	},
	TopicBondConfirming: {
		subject:  "Confirming bond",
		template: "Waiting for %d confirmations to post bond %v (%s) to %s",
	},
	TopicBondConfirmed: {
		subject:  "Bond confirmed",
		template: "New tier = %d (target = %d).",
	},
	TopicBondExpired: {
		subject:  "Bond expired",
		template: "New tier = %d (target = %d).",
	},
	TopicBondRefunded: {
		subject:  "Bond refunded",
		template: "Bond %v for %v refunded in %v, reclaiming %v of %v after tx fees",
	},
	TopicBondPostError: {
		subject:  "Bond post error",
		template: "postbond request error (will retry): %v (%T)",
	},
	TopicBondPostErrorConfirm: {
		subject:  "Bond post error",
		template: "Error encountered while waiting for bond confirms for %s: %v",
	},
	TopicDexAuthErrorBond: {
		subject:  "Authentication error",
		template: "Bond confirmed, but failed to authenticate connection: %v",
	},
	TopicAccountRegTier: {
		subject:  "Account registered",
		template: "New tier = %d",
	},
	TopicUnknownBondTierZero: {
		subject:  "Unknown bond found",
		template: "Unknown %s bonds were found and added to active bonds " + "but your target tier is zero for the dex at %s. Set your " + "target tier in Settings to stay bonded with auto renewals.",
	},
	TopicDEXDisabled: {
		subject:  "DEX server status",
		template: "DEX server %s has been disabled.",
	},
	TopicDEXEnabled: {
		subject:  "DEX server status",
		template: "DEX server %s has been enabled.",
	},
}
