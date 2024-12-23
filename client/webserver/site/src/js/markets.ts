import Doc, { Animation } from './doc'
import State from './state'
import BasePage from './basepage'
import OrderBook from './orderbook'
import { ReputationMeter, tradingLimits, strongTier } from './account'
import {
  CandleChart,
  CandleReporters,
  Wave
} from './charts'
import { postJSON } from './http'
import {
  NewWalletForm,
  AccelerateOrderForm,
  DepositAddress,
  TokenApprovalForm,
  bind as bindForm,
  Forms
} from './forms'
import * as OrderUtil from './orderutil'
import ws from './ws'
import * as intl from './locales'
import {
  app,
  ApprovalStatus,
  Asset,
  BalanceNote,
  BondNote,
  BookUpdate,
  Candle,
  CandlesPayload,
  ConnectionStatus,
  ConnEventNote,
  EpochNote,
  Exchange,
  Market, MarketOrderBook,
  MatchNote,
  MaxOrderEstimate,
  MiniOrder,
  Order, OrderFilter,
  OrderNote,
  PageElement,
  RecentMatch,
  RemainderUpdate,
  SpotPriceNote,
  SupportedAsset,
  TradeForm,
  UnitInfo,
  WalletStateNote
} from './registry'
import { setOptionTemplates } from './opts'

const bind = Doc.bind

const bookRoute = 'book'
const bookOrderRoute = 'book_order'
const unbookOrderRoute = 'unbook_order'
const updateRemainingRoute = 'update_remaining'
const epochOrderRoute = 'epoch_order'
const candlesRoute = 'candles'
const candleUpdateRoute = 'candle_update'
const unmarketRoute = 'unmarket'
const epochMatchSummaryRoute = 'epoch_match_summary'

const animationLength = 500
const maxUserOrdersShown = 10

// orderBookSideMaxCapacity defines how many orders in the book side will be displayed
const orderBookSideMaxCapacity = 14

const buyBtnClass = 'buygreen-bg'
const sellBtnClass = 'sellred-bg'

const fiveMinBinKey = '5m'
const oneHrBinKey = '1h'

interface MetaOrder {
  div: HTMLElement
  header: Record<string, PageElement>
  details: Record<string, PageElement>
  ord: Order
  cancelling?: boolean
}

interface CancelData {
  bttn: PageElement
  order: Order
}

interface CurrentMarket {
  dex: Exchange
  sid: string // A string market identifier used by the DEX.
  cfg: Market
  base: SupportedAsset
  quote: SupportedAsset
  baseUnitInfo: UnitInfo
  quoteUnitInfo: UnitInfo
  // maxSell is a cached max order estimate, unlike with buy-orders, for sell-orders
  // max doesn't depend on chosen rate
  maxSell: MaxOrderEstimate | null
  // sellBalance helps to track when we want to update our maxSell estimate, for example
  // when wallet balance updates
  sellBalance: number
  // buyBalance helps to track when we want to update our maxBuys estimates, for example
  // when wallet balance updates
  buyBalance: number
  // maxBuys is cached max order estimates (rateAtom -> estimateAtom), these depend on user-chosen rate
  maxBuys: Record<number, MaxOrderEstimate>
  candleCaches: Record<string, CandlesPayload>
  baseCfg: Asset
  quoteCfg: Asset
  rateConversionFactor: number
  bookLoaded: boolean
}

interface LoadTracker {
  loaded: () => void
  timer: number
}

interface OrderRow extends HTMLElement {
  manager: OrderTableRowManager
}

interface StatsDisplay {
  htmlElem: PageElement
  tmpl: Record<string, PageElement>
}

interface MarketsPageParams {
  host: string
  baseID: string
  quoteID: string
}

export default class MarketsPage extends BasePage {
  page: Record<string, PageElement>
  main: HTMLElement
  // chosenRateBuyAtom of non-0 value represents successfully parsed user-chosen exchange
  // rate (the freshest one) in atoms for buy-order. Note, this is always a value already
  // adjusted to rate-step. 0 value indicates there is no such rate available for whatever
  // reason (for example, if user typed in some garbage).
  chosenRateBuyAtom: number
  // chosenRateSellAtom is same as chosenRateBuyAtom for sell-order.
  chosenRateSellAtom: number
  // chosenQtyBuy is same as chosenRateBuyAtom for order quantity for buy-order (adjusted
  // for lot size). Always in Base asset units.
  chosenQtyBuyAtom: number
  // chosenQtySell is same as chosenQtyBuy for sell-order. Always in Base asset units.
  chosenQtySellAtom: number
  // maxBuyLastReqID helps us track the IDs of /maxbuy requests issued, it's
  // hard to prevent our app (and the user) from sending multiple of these
  // requests in parallel, so instead we keep track of all requests we've issued
  // and make use of the result from latest one.
  maxBuyLastReqID: number
  // maxSellLastReqID same as maxBuyLastReqID but for /maxsell requests.
  maxSellLastReqID: number
  verifiedOrder: TradeForm
  market: CurrentMarket
  openAsset: SupportedAsset
  currentCreate: SupportedAsset
  book: OrderBook
  cancelData: CancelData
  metaOrders: Record<string, MetaOrder>
  hovers: HTMLElement[]
  ogTitle: string
  candleChart: CandleChart
  candleDur: string
  marketList: MarketList
  newWalletForm: NewWalletForm
  depositAddrForm: DepositAddress
  approveTokenForm: TokenApprovalForm
  reputationMeter: ReputationMeter
  keyup: (e: KeyboardEvent) => void
  secondTicker: number
  candlesLoading: LoadTracker | null
  accelerateOrderForm: AccelerateOrderForm
  recentMatches: RecentMatch[]
  recentMatchesSortKey: string
  recentMatchesSortDirection: 1 | -1
  stats: StatsDisplay
  loadingAnimations: { candles?: Wave }
  runningErrAnimations: Animation[]
  forms: Forms
  constructor (main: HTMLElement, pageParams: MarketsPageParams) {
    super()

    const page = this.page = Doc.idDescendants(main)
    this.main = main
    if (!this.main.parentElement) return // Not gonna happen, but TypeScript cares.
    this.maxBuyLastReqID = 0
    this.maxSellLastReqID = 0
    this.metaOrders = {}
    this.recentMatches = []
    this.hovers = []
    // 'Recent Matches' list sort key and direction.
    this.recentMatchesSortKey = 'age'
    this.recentMatchesSortDirection = -1
    // store original title so we can re-append it when updating market value.
    this.ogTitle = document.title
    this.runningErrAnimations = []
    this.forms = new Forms(page.forms)

    const candleReporters: CandleReporters = {
      mouse: c => { this.reportMouseCandle(c) }
    }
    this.candleChart = new CandleChart(page.candlesChart, candleReporters)

    const success = () => { /* do nothing */ }
    // Do not call cleanTemplates before creating the AccelerateOrderForm
    this.accelerateOrderForm = new AccelerateOrderForm(page.accelerateForm, success)

    this.approveTokenForm = new TokenApprovalForm(page.approveTokenForm)

    // Set user's last known candle duration.
    this.candleDur = State.fetchLocal(State.lastCandleDurationLK) || oneHrBinKey

    // Setup the register to trade button.
    // TODO: Use dexsettings page?
    const registerBttn = Doc.tmplElement(page.notRegistered, 'registerBttn')
    bind(registerBttn, 'click', () => {
      app().loadPage('register', { host: this.market.dex.host })
    })

    this.reputationMeter = new ReputationMeter(page.reputationMeter)

    // Bind toggle wallet status form.
    bindForm(page.toggleWalletStatusConfirm, page.toggleWalletStatusSubmit, async () => { this.toggleWalletStatus() })

    // Prepare templates for the buy and sell tables and the user's order table.
    setOptionTemplates(page)

    Doc.cleanTemplates(
      page.orderRowTmpl, page.durBttnTemplate, page.userOrderTmpl, page.recentMatchesTemplate
    )

    // Buttons to show token approval form
    bind(page.approveBaseBttn, 'click', () => { this.showTokenApprovalForm(true) })
    bind(page.approveQuoteBttn, 'click', () => { this.showTokenApprovalForm(false) })

    const toggleTradingTier = (show: boolean) => {
      Doc.setVis(!show, page.showTradingTier)
      Doc.setVis(show, page.tradingLimits, page.hideTradingTier)
    }
    bind(page.showTradingTier, 'click', () => { toggleTradingTier(true) })
    bind(page.hideTradingTier, 'click', () => { toggleTradingTier(false) })

    const toggleTradingReputation = (show: boolean) => {
      Doc.setVis(!show, page.showTradingReputation)
      Doc.setVis(show, page.reputationMeter, page.hideTradingReputation)
    }
    bind(page.showTradingReputation, 'click', () => { toggleTradingReputation(true) })
    bind(page.hideTradingReputation, 'click', () => { toggleTradingReputation(false) })

    bind(page.qtySliderBuyInput, 'input', () => {
      const page = this.page
      const qtyConv = this.market.baseUnitInfo.conventional.conversionFactor

      const sliderValue = this.parseNumber(page.qtySliderBuyInput.value)
      if (sliderValue === null || isNaN(sliderValue) || sliderValue < 0) {
        return
      }

      // Assume max buy has already been fetched and rate has already been validated
      // and adjusted (don't let user touch lot/qty/slider fields otherwise), but
      // still handle the absence of maxBuy just in case.
      const maxBuy = this.market.maxBuys[this.chosenRateBuyAtom]
      if (!maxBuy) return
      // Update lot/qty values accordingly, derive lot value (integer) from the value
      // of slider and our wallet balance.
      // Note, slider value of 0 represents 1 lot (while slider value of 1 represents
      // max lots we can buy).
      // No need to check for errors because only user can "produce" an invalid input.
      const lots = Math.max(1, Math.floor(maxBuy.swap.lots * sliderValue))
      const adjQty = this.lotToQty(lots)
      // Lots and quantity fields are tightly coupled to each other, when one is
      // changed, we need to update the other one as well.
      page.qtyFieldBuy.value = String(adjQty)
      this.chosenQtyBuyAtom = convertNumberToAtoms(adjQty, qtyConv)

      this.finalizeTotalBuy()
    })
    bind(page.qtySliderSellInput, 'input', () => {
      const page = this.page
      const qtyConv = this.market.baseUnitInfo.conventional.conversionFactor

      const sliderValue = this.parseNumber(page.qtySliderSellInput.value)
      if (sliderValue === null || isNaN(sliderValue) || sliderValue < 0) {
        return
      }

      // Assume max sell has already been fetched (don't let user touch lot/qty/slider
      // fields otherwise), but still handle the absence of maxBuy just in case.
      if (!this.market.maxSell) return
      const maxSellLots = this.market.maxSell.swap.lots
      // Update lot/qty values accordingly, derive lot value (integer) from the value
      // of slider and our wallet balance.
      // Note, slider value of 0 represents 1 lot (while slider value of 1 represents
      // max lots we can sell).
      // No need to check for errors because only user can "produce" an invalid input.
      const lots = Math.max(1, Math.floor(maxSellLots * sliderValue))
      const adjQty = this.lotToQty(lots)
      // Lots and quantity fields are tightly coupled to each other, when one is
      // changed, we need to update the other one as well.
      page.qtyFieldSell.value = String(adjQty)
      this.chosenQtySellAtom = convertNumberToAtoms(adjQty, qtyConv)

      this.finalizeTotalSell()
    })

    // Handle the full orderbook sent on the 'book' route.
    ws.registerRoute(bookRoute, (data: BookUpdate) => { this.handleBookRoute(data) })
    // Handle the new order for the order book on the 'book_order' route.
    ws.registerRoute(bookOrderRoute, (data: BookUpdate) => { this.handleBookOrderRoute(data) })
    // Remove the order sent on the 'unbook_order' route from the orderbook.
    ws.registerRoute(unbookOrderRoute, (data: BookUpdate) => { this.handleUnbookOrderRoute(data) })
    // Update the remaining quantity on a booked order.
    ws.registerRoute(updateRemainingRoute, (data: BookUpdate) => { this.handleUpdateRemainingRoute(data) })
    // Handle the new order for the order book on the 'epoch_order' route.
    ws.registerRoute(epochOrderRoute, (data: BookUpdate) => { this.handleEpochOrderRoute(data) })
    // Handle the initial candlestick data on the 'candles' route.
    ws.registerRoute(candlesRoute, (data: BookUpdate) => { this.handleCandlesRoute(data) })
    // Handle the candles update on the 'candles' route.
    ws.registerRoute(candleUpdateRoute, (data: BookUpdate) => { this.handleCandleUpdateRoute(data) })

    // Handle the recent matches update on the 'epoch_report' route.
    ws.registerRoute(epochMatchSummaryRoute, (data: BookUpdate) => { this.handleEpochMatchSummary(data) })
    // Create a wallet
    this.newWalletForm = new NewWalletForm(page.newWalletForm, async () => { this.createWallet() })
    // Main order forms.
    bindForm(page.orderFormBuy, page.submitBttnBuy, async () => { this.stepSubmitBuy() })
    bindForm(page.orderFormSell, page.submitBttnSell, async () => { this.stepSubmitSell() })
    // Order verification form.
    bindForm(page.verifyForm, page.vSubmit, async () => { this.submitVerifiedOrder() })
    // Cancel order form.
    bindForm(page.cancelForm, page.cancelSubmit, async () => { this.submitCancel() })
    // Bind active orders list's header sort events.
    page.recentMatchesTable.querySelectorAll('[data-ordercol]')
      .forEach((th: HTMLElement) => bind(
        th, 'click', () => setRecentMatchesSortCol(th.dataset.ordercol || '')
      ))

    const setRecentMatchesSortCol = (key: string) => {
      // First unset header's current sorted col classes.
      unsetRecentMatchesSortColClasses()
      if (this.recentMatchesSortKey === key) {
        this.recentMatchesSortDirection *= -1
      } else {
        this.recentMatchesSortKey = key
        this.recentMatchesSortDirection = 1
      }
      this.refreshRecentMatchesTable()
      setRecentMatchesSortColClasses()
    }

    // sortClassByDirection receives a sort direction and return a class based on it.
    const sortClassByDirection = (element: 1 | -1) => {
      if (element === 1) return 'sorted-asc'
      return 'sorted-dsc'
    }

    const unsetRecentMatchesSortColClasses = () => {
      page.recentMatchesTable.querySelectorAll('[data-ordercol]')
        .forEach(th => th.classList.remove('sorted-asc', 'sorted-dsc'))
    }

    const setRecentMatchesSortColClasses = () => {
      const key = this.recentMatchesSortKey
      const sortCls = sortClassByDirection(this.recentMatchesSortDirection)
      Doc.safeSelector(page.recentMatchesTable, `[data-ordercol=${key}]`).classList.add(sortCls)
    }

    // Set default's sorted col header classes.
    setRecentMatchesSortColClasses()

    const closePopups = () => {
      this.forms.close()
    }

    this.keyup = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closePopups()
      }
    }
    bind(document, 'keyup', this.keyup)

    page.forms.querySelectorAll('.form-closer').forEach(el => {
      bind(el, 'click', () => { closePopups() })
    })

    // Limit order buy: event listeners for handling user interactions.
    bind(page.rateFieldBuy, 'input', () => { this.rateFieldBuyInputHandler() })
    bind(page.qtyFieldBuy, 'input', () => { this.qtyFieldBuyInputHandler() })
    // Limit order sell: event listeners for handling user interactions.
    bind(page.rateFieldSell, 'input', () => { this.rateFieldSellInputHandler() })
    bind(page.qtyFieldSell, 'input', () => { this.qtyFieldSellInputHandler() })

    // Market search input bindings.
    bind(page.marketSearchV1, ['change', 'keyup'], () => { this.filterMarkets() })

    // Acknowledge the order disclaimer.
    const setDisclaimerAckViz = (acked: boolean) => {
      Doc.setVis(!acked, page.disclaimer, page.disclaimerAck)
      Doc.setVis(acked, page.showDisclaimer)
    }
    bind(page.disclaimerAck, 'click', () => {
      State.storeLocal(State.orderDisclaimerAckedLK, true)
      setDisclaimerAckViz(true)
    })
    bind(page.showDisclaimer, 'click', () => {
      State.storeLocal(State.orderDisclaimerAckedLK, false)
      setDisclaimerAckViz(false)
    })
    setDisclaimerAckViz(State.fetchLocal(State.orderDisclaimerAckedLK))

    // since marketStats resides directly on the header (not markets page) we need to fetch
    // it through markets page parent
    const marketStatsElem = Doc.idDescendants(this.main.parentElement).marketStats
    this.stats = { htmlElem: marketStatsElem, tmpl: Doc.parseTemplate(marketStatsElem) }

    const closeMarketsList = () => {
      Doc.hide(page.leftMarketDock)
      State.storeLocal(State.leftMarketDockLK, '0')
      Doc.show(page.orderBook)
    }
    const openMarketsList = () => {
      Doc.hide(page.orderBook)
      State.storeLocal(State.leftMarketDockLK, '1')
      Doc.show(page.leftMarketDock)
    }
    bind(this.stats.tmpl.marketSelect, 'click', () => {
      if (page.leftMarketDock.clientWidth === 0) openMarketsList()
      else closeMarketsList()
    })
    const loadMarket = (mkt: ExchangeMarket) => {
      // nothing to do if this market is already set/chosen
      const { quoteid: quoteID, baseid: baseID, xc: { host } } = mkt
      if (this.market?.base?.id === baseID && this.market?.quote?.id === quoteID) return
      this.startLoadingAnimations()
      this.setMarket(host, baseID, quoteID)
    }
    // Prepare the list of markets.
    this.marketList = new MarketList(page.marketListV1)
    for (const row of this.marketList.markets) {
      bind(row.node, 'click', () => {
        loadMarket(row.mkt)
      })
      bind(row.node, 'dblclick', () => {
        loadMarket(row.mkt)
        closeMarketsList()
      })
    }
    if (State.fetchLocal(State.leftMarketDockLK) !== '1') { // It is shown by default, hiding if necessary.
      closeMarketsList()
    }

    // Notification filters.
    app().registerNoteFeeder({
      order: (note: OrderNote) => { this.handleOrderNote(note) },
      match: (note: MatchNote) => { this.handleMatchNote(note) },
      epoch: (note: EpochNote) => { this.handleEpochNote(note) },
      conn: (note: ConnEventNote) => { this.handleConnNote(note) },
      balance: (note: BalanceNote) => { this.handleBalanceNote(note) },
      bondpost: (note: BondNote) => { this.handleBondUpdate(note) },
      spots: (note: SpotPriceNote) => { this.handlePriceUpdate(note) },
      walletstate: (note: WalletStateNote) => { this.handleWalletState(note) },
      reputation: () => { this.updateReputation() },
      feepayment: () => { this.updateReputation() },
      runstats: () => {
        // nothing to do, we don't support displaying MM form at the moment
      },
      epochreport: () => {
        // nothing to do, we don't support displaying MM form at the moment
      },
      cexproblems: () => {
        // nothing to do, we don't support displaying MM form at the moment
      },
      runevent: () => {
        // nothing to do, we don't support displaying MM form at the moment
      }
    })

    this.loadingAnimations = {}
    this.startLoadingAnimations()

    // Start a ticker to update time-since values.
    this.secondTicker = window.setInterval(() => {
      for (const mord of Object.values(this.metaOrders)) {
        mord.details.age.textContent = Doc.timeSince(mord.ord.submitTime)
      }
      for (const td of Doc.applySelector(page.recentMatchesLiveList, '[data-tmpl=age]')) {
        td.textContent = Doc.timeSince(parseFloat(td.dataset.sinceStamp ?? '0'))
      }
    }, 1000)

    this.init(pageParams)
  }

  async init (pageParams?: MarketsPageParams) {
    // Fetch the first market in the list, or the users last selected market, if
    // it exists.
    let selected
    if (pageParams?.host) {
      selected = makeMarket(pageParams.host, parseInt(pageParams.baseID), parseInt(pageParams.quoteID))
    } else {
      selected = State.fetchLocal(State.lastMarketLK)
    }
    if (!selected || !this.marketList.exists(selected.host, selected.base, selected.quote)) {
      const first = this.marketList.first()
      if (first) selected = { host: first.mkt.xc.host, base: first.mkt.baseid, quote: first.mkt.quoteid }
    }
    if (selected) this.setMarket(selected.host, selected.base, selected.quote)

    // set the initial state for the registration status
    this.setRegistrationStatusVisibility()
  }

  startLoadingAnimations () {
    const { page, loadingAnimations: anis, candleChart } = this
    candleChart.canvas.classList.add('invisible')
    if (anis.candles) anis.candles.stop()
    anis.candles = new Wave(page.candlesChart, { message: intl.prep(intl.ID_CANDLES_LOADING) })
  }

  /* hasPendingBonds is true if there are pending bonds */
  hasPendingBonds (): boolean {
    return Object.keys(this.market.dex.auth.pendingBonds || []).length > 0
  }

  /* setCurrMarketPrice updates the current market price on the stats displays
     and the orderbook display. */
  setCurrMarketPrice (): void {
    const selectedMkt = this.market

    const setDummyValues = () => {
      this.stats.tmpl.change24.classList.remove('buycolor', 'sellcolor')
      this.stats.tmpl.change24.textContent = '-'
      this.stats.tmpl.volume24.textContent = '-'
      this.stats.tmpl.volume24Unit.textContent = 'USD'
      this.stats.tmpl.bisonPrice.classList.remove('sellcolor', 'buycolor')
      this.stats.tmpl.bisonPrice.textContent = '-'
      this.stats.tmpl.fiatPrice.textContent = '(-)'
      if (mkt) {
        const baseFiatRate = app().fiatRatesMap[selectedMkt.base.id]
        const quoteFiatRate = app().fiatRatesMap[selectedMkt.quote.id]
        let fiatPriceFormatted = '(-)'
        if (baseFiatRate && quoteFiatRate) {
          const fiatPrice = baseFiatRate / quoteFiatRate
          fiatPriceFormatted = Doc.formatRateFullPrecision(
            fiatPrice,
            selectedMkt.baseUnitInfo,
            selectedMkt.quoteUnitInfo,
            selectedMkt.cfg.ratestep
          )
          fiatPriceFormatted = `(~${fiatPriceFormatted})`
        }
        this.stats.tmpl.fiatPrice.textContent = fiatPriceFormatted
      }
      Doc.hide(this.page.obUp)
      Doc.hide(this.page.obDown)
      this.page.obPrice.classList.remove('sellcolor', 'buycolor')
      this.page.obPrice.textContent = '-'
    }

    if (!selectedMkt) {
      // not enough info to display current market price
      setDummyValues()
      return
    }
    // Get an up-to-date Market.
    const xc = app().exchanges[selectedMkt.dex.host]
    const mkt = xc.markets[selectedMkt.cfg.name]
    if (!mkt.spot) {
      // not enough info to display current market price
      setDummyValues()
      return
    }

    const recentMatches = this.recentMatchesSorted('age', -1) // freshest first
    if (recentMatches.length === 0) {
      // not enough info to display current market price
      setDummyValues()
      return
    }

    const mostRecentMatchIsBuy = !recentMatches[0].sell

    this.stats.tmpl.bisonPrice.classList.remove('sellcolor', 'buycolor')
    this.stats.tmpl.bisonPrice.classList.add(mostRecentMatchIsBuy ? 'buycolor' : 'sellcolor')
    this.stats.tmpl.bisonPrice.textContent = Doc.formatRateAtomFullPrecision(
      mkt.spot.rate,
      selectedMkt.baseUnitInfo,
      selectedMkt.quoteUnitInfo,
      selectedMkt.cfg.ratestep
    )

    const baseFiatRate = app().fiatRatesMap[selectedMkt.base.id]
    const quoteFiatRate = app().fiatRatesMap[selectedMkt.quote.id]
    let fiatPriceFormatted = '(-)'
    if (baseFiatRate && quoteFiatRate) {
      const fiatPrice = baseFiatRate / quoteFiatRate
      fiatPriceFormatted = Doc.formatRateFullPrecision(
        fiatPrice,
        selectedMkt.baseUnitInfo,
        selectedMkt.quoteUnitInfo,
        selectedMkt.cfg.ratestep
      )
      fiatPriceFormatted = `(~${fiatPriceFormatted})`
    }
    this.stats.tmpl.fiatPrice.textContent = fiatPriceFormatted

    const sign = mkt.spot.change24 > 0 ? '+' : ''
    this.stats.tmpl.change24.classList.remove('buycolor', 'sellcolor')
    this.stats.tmpl.change24.classList.add(mkt.spot.change24 >= 0 ? 'buycolor' : 'sellcolor')
    this.stats.tmpl.change24.textContent = `${sign}${(mkt.spot.change24 * 100).toFixed(1)}%`

    const { unitInfo: { conventional: { conversionFactor: cFactor, unit } } } = xc.assets[mkt.baseid]
    if (baseFiatRate) {
      this.stats.tmpl.volume24.textContent = Doc.formatFourSigFigs(mkt.spot.vol24 / cFactor * baseFiatRate)
      this.stats.tmpl.volume24Unit.textContent = 'USD'
    } else {
      this.stats.tmpl.volume24.textContent = Doc.formatFourSigFigs(mkt.spot.vol24 / cFactor)
      this.stats.tmpl.volume24Unit.textContent = unit
    }

    // updates order-book affiliated values
    Doc.setVis(mostRecentMatchIsBuy, this.page.obUp)
    Doc.setVis(!mostRecentMatchIsBuy, this.page.obDown)
    this.page.obPrice.classList.remove('sellcolor', 'buycolor')
    this.page.obPrice.classList.add(mostRecentMatchIsBuy ? 'buycolor' : 'sellcolor')
    this.page.obPrice.textContent = Doc.formatRateAtomFullPrecision(
      mkt.spot.rate,
      selectedMkt.baseUnitInfo,
      selectedMkt.quoteUnitInfo,
      selectedMkt.cfg.ratestep
    )
  }

  /* setMarketDetails updates the currency names on the stats displays. */
  setMarketDetails () {
    if (!this.market) return
    const { baseCfg: ba, quoteCfg: qa } = this.market
    this.stats.tmpl.baseIcon.src = Doc.logoPath(ba.symbol)
    this.stats.tmpl.quoteIcon.src = Doc.logoPath(qa.symbol)
    Doc.empty(this.stats.tmpl.baseSymbol, this.stats.tmpl.quoteSymbol)
    this.stats.tmpl.baseSymbol.appendChild(Doc.symbolize(ba, true))
    this.stats.tmpl.quoteSymbol.appendChild(Doc.symbolize(qa, true))
  }

  /**
   * calcMaxOrderLots returns the maximum order size, in lots (buy or sell,
   * depending on what user chose in UI).
   * returns 0 in case it cannot estimate it.
   */
  async calcMaxOrderLots (sell: boolean): Promise<number> {
    if (sell) {
      const res = await this.requestMaxSellEstimateCached()
      if (!res) {
        return 0
      }
      return res.swap.lots
    }

    const res = await this.requestMaxBuyEstimateCached(this.chosenRateBuyAtom)
    if (!res) {
      return 0
    }
    return res.swap.lots
  }

  /**
   * calcMaxOrderQtyAtoms returns the maximum order size, in atoms.
   * returns 0 in case it cannot estimate it.
   */
  async calcMaxOrderQtyAtoms (sell: boolean): Promise<number> {
    const lotSizeAtom = this.market.cfg.lotsize
    const maxOrderLots = await this.calcMaxOrderLots(sell)
    return maxOrderLots * lotSizeAtom
  }

  /* setHighLow calculates the high and low rates over the last 24 hours. */
  setHighLow () {
    let [high, low] = [0, 0]
    const mkt = this.market
    const spot = mkt.cfg.spot
    // Use spot values for 24 hours high and low rates if it is available. We
    // will default to setting it from candles if it's not.
    if (spot && spot.low24 && spot.high24) {
      high = spot.high24
      low = spot.low24
    } else {
      const cache = this.market?.candleCaches[fiveMinBinKey]
      if (!cache) {
        if (this.candleDur !== fiveMinBinKey) {
          this.requestCandles(fiveMinBinKey)
          return
        }
        this.stats.tmpl.high.textContent = '-'
        this.stats.tmpl.low.textContent = '-'
        return
      }

      // Set high and low rates from candles.
      const aDayAgo = new Date().getTime() - 86400000
      for (let i = cache.candles.length - 1; i >= 0; i--) {
        const c = cache.candles[i]
        if (c.endStamp < aDayAgo) break
        if (low === 0 || (c.lowRate > 0 && c.lowRate < low)) low = c.lowRate
        if (c.highRate > high) high = c.highRate
      }
    }

    let lowFormatted = '-'
    if (low > 0) {
      lowFormatted = Doc.formatRateAtomFullPrecision(
        low,
        mkt.baseUnitInfo,
        mkt.quoteUnitInfo,
        mkt.cfg.ratestep
      )
    }
    this.stats.tmpl.low.textContent = lowFormatted
    let highFormatted = '-'
    if (high > 0) {
      highFormatted = Doc.formatRateAtomFullPrecision(
        high,
        mkt.baseUnitInfo,
        mkt.quoteUnitInfo,
        mkt.cfg.ratestep
      )
    }
    this.stats.tmpl.high.textContent = highFormatted
  }

  /* assetsAreSupported is true if all the assets of the current market are
   * supported
   */
  assetsAreSupported (): {
    isSupported: boolean;
    text: string;
    } {
    const { market: { base, quote, baseCfg, quoteCfg } } = this
    if (!base || !quote) {
      const symbol = base ? quoteCfg.symbol : baseCfg.symbol
      return {
        isSupported: false,
        text: intl.prep(intl.ID_NOT_SUPPORTED, { asset: symbol.toUpperCase() })
      }
    }
    // check if versions are supported. If asset is a token, we check if its
    // parent supports the version.
    const bVers = (base.token ? app().assets[base.token.parentID].info?.versions : base.info?.versions) as number[]
    const qVers = (quote.token ? app().assets[quote.token.parentID].info?.versions : quote.info?.versions) as number[]
    // if none them are token, just check if own asset is supported.
    let text = ''
    if (!bVers.includes(baseCfg.version)) {
      text = intl.prep(intl.ID_VERSION_NOT_SUPPORTED, { asset: base.symbol.toUpperCase(), version: baseCfg.version + '' })
    } else if (!qVers.includes(quoteCfg.version)) {
      text = intl.prep(intl.ID_VERSION_NOT_SUPPORTED, { asset: quote.symbol.toUpperCase(), version: quoteCfg.version + '' })
    }
    return {
      isSupported: bVers.includes(baseCfg.version) && qVers.includes(quoteCfg.version),
      text
    }
  }

  /* resolveOrderVsMMForm displays either order form or MM form based on
   * a set of conditions to be met.
   */
  resolveOrderVsMMForm (forseReset?: boolean): void {
    const page = this.page
    const mkt = this.market
    const { base, quote } = mkt

    // sanity-check we are on correct market
    if (!base || !quote) return // market isn't initialized correctly
    if (!this.assetsAreSupported().isSupported) return // assets not supported
    if (!mkt || mkt.dex.auth.effectiveTier < 1) return // acct suspended or not registered
    // check we have required wallets set up, and wallet state (enabled/disabled, locked/unlocked)
    // allows for trading
    const [baseWallet, quoteWallet] = [app().assets[base.id].wallet, app().assets[quote.id].wallet]
    if (!baseWallet || !quoteWallet) return
    if (baseWallet.disabled || quoteWallet.disabled) return
    if (!baseWallet.running || !quoteWallet.running) return
    // check if we have the needed token-approvals
    const { baseAssetApprovalStatus, quoteAssetApprovalStatus } = this.tokenAssetApprovalStatuses()
    if (baseAssetApprovalStatus !== ApprovalStatus.Approved ||
        quoteAssetApprovalStatus !== ApprovalStatus.Approved) {
      return
    }

    // see if we can show order form(s) then

    // if order form is already showing we don't want to re-initialize it because
    // it might contain user inputs already (hence return right away), unless
    // we have been asked to forcefully reset it (which is needed for example when
    // user switches to another market - because we are sharing same order form
    // between different markets)
    if ((Doc.isDisplayed(page.orderFormBuy) || Doc.isDisplayed(page.orderFormSell)) && !forseReset) {
      return
    }

    // show & re-initialize limit order forms everything is disabled by default unless
    // explicitly changed to be otherwise (by events that follow)
    this.chosenRateBuyAtom = 0
    page.rateFieldBuy.value = ''
    page.qtyFieldBuy.value = ''
    page.qtySliderBuyInput.value = '0'
    page.orderTotalPreviewBuyLeft.textContent = ''
    page.orderTotalPreviewBuyRight.textContent = ''
    this.chosenRateSellAtom = 0
    page.rateFieldSell.value = ''
    page.qtyFieldSell.value = ''
    page.qtySliderSellInput.value = '0'
    page.orderTotalPreviewSellLeft.textContent = ''
    page.orderTotalPreviewSellRight.textContent = ''
    this.setPageElementEnabled(this.page.priceBoxBuy, false)
    this.setPageElementEnabled(this.page.qtyBoxBuy, false)
    this.setPageElementEnabled(this.page.qtySliderBuy, false)
    this.setPageElementEnabled(this.page.previewTotalBuy, false)
    this.setOrderBttnBuyEnabled(false)
    this.setPageElementEnabled(this.page.priceBoxSell, false)
    this.setPageElementEnabled(this.page.qtyBoxSell, false)
    this.setPageElementEnabled(this.page.qtySliderSell, false)
    this.setPageElementEnabled(this.page.previewTotalSell, false)
    this.setOrderBttnSellEnabled(false)
    this.reInitOrderForms(1)
    Doc.show(page.orderFormBuy, page.orderFormSell)

    // show also our reputation on this market
    const { auth: { effectiveTier, pendingStrength } } = mkt.dex
    Doc.setVis(effectiveTier > 0 || pendingStrength > 0, page.reputationAndTradingTierBox)
  }

  reInitOrderForms (retryNum: number) {
    const maxRetries = 16

    const page = this.page
    const mkt = this.market

    if (!mkt.bookLoaded && retryNum <= maxRetries) {
      // we don't have order-book yet to fetch default rate, try later again
      setTimeout(() => {
        this.reInitOrderForms(retryNum + 1)
      }, 250) // 250ms delay
      return
    }

    const qtyConv = mkt.baseUnitInfo.conventional.conversionFactor

    if (this.canTradeBuy()) {
      // reset limit-order buy form inputs to defaults
      const defaultRateAtom = this.book.bestBuyRateAtom()
      const adjQtyBuy = this.lotToQty(1)
      this.chosenQtyBuyAtom = convertNumberToAtoms(adjQtyBuy, qtyConv)
      page.qtyFieldBuy.value = String(adjQtyBuy)
      page.qtySliderBuyInput.value = '0'
      if (defaultRateAtom !== 0) {
        this.chosenRateBuyAtom = defaultRateAtom
        page.rateFieldBuy.value = String(defaultRateAtom / mkt.rateConversionFactor)
        this.setPageElementEnabled(this.page.priceBoxBuy, true)
        this.setPageElementEnabled(this.page.qtyBoxBuy, true)
        // we'll eventually need to fetch max estimate for slider to work, plus to
        // do validation on user inputs, might as well do it now
        this.finalizeTotalBuy()
      } else {
        this.setPageElementEnabled(this.page.priceBoxBuy, true)
        this.setPageElementEnabled(this.page.qtyBoxBuy, false)
        this.setPageElementEnabled(this.page.qtySliderBuy, false)
        this.previewTotalBuy(this.chosenRateBuyAtom, this.chosenQtyBuyAtom)
        this.setOrderBttnBuyEnabled(false, 'choose your price')
      }
    }

    if (this.canTradeSell()) {
      // reset limit-order sell form inputs to defaults
      const defaultRateAtom = this.book.bestSellRateAtom()
      const adjQtySell = this.lotToQty(1)
      this.chosenQtySellAtom = convertNumberToAtoms(adjQtySell, qtyConv)
      page.qtyFieldSell.value = String(adjQtySell)
      page.qtySliderSellInput.value = '0'
      if (defaultRateAtom !== 0) {
        this.chosenRateSellAtom = defaultRateAtom
        page.rateFieldSell.value = String(defaultRateAtom / mkt.rateConversionFactor)
        this.setPageElementEnabled(this.page.priceBoxSell, true)
        this.setPageElementEnabled(this.page.qtyBoxSell, true)
        // we'll eventually need to fetch max estimate for slider to work, plus to
        // do validation on user inputs, might as well do it now
        this.finalizeTotalSell()
      } else {
        this.chosenRateSellAtom = 0
        page.rateFieldSell.value = ''
        page.orderTotalPreviewSellLeft.textContent = ''
        page.orderTotalPreviewSellRight.textContent = ''
        this.setPageElementEnabled(this.page.priceBoxSell, true)
        this.setPageElementEnabled(this.page.qtyBoxSell, false)
        this.setPageElementEnabled(this.page.qtySliderSell, false)
        this.previewTotalSell(this.chosenRateSellAtom, this.chosenQtySellAtom)
        this.setOrderBttnSellEnabled(false, 'choose your price')
      }
    }
  }

  /* setLoaderMsgVisibility displays a message in case a dex asset is not
   * supported
   */
  setLoaderMsgVisibility () {
    const { page } = this

    const { isSupported, text } = this.assetsAreSupported()
    if (isSupported) {
      // make sure to hide the loader msg
      Doc.hide(page.loaderMsg)
      return
    }
    page.loaderMsg.textContent = text
    Doc.show(page.loaderMsg)
    Doc.hide(page.notRegistered)
    Doc.hide(page.noWallet)
  }

  /*
   * showTokenApprovalForm displays the form used to give allowance to the
   * swap contract of a token.
   */
  async showTokenApprovalForm (isBase: boolean) {
    const assetID = isBase ? this.market.base.id : this.market.quote.id
    this.approveTokenForm.setAsset(assetID, this.market.dex.host)
    this.forms.show(this.page.approveTokenForm)
  }

  /*
   * tokenAssetApprovalStatuses returns the approval status of the base and
   * quote assets. If the asset is not a token, it is considered approved.
   */
  tokenAssetApprovalStatuses (): {
    baseAssetApprovalStatus: ApprovalStatus;
    quoteAssetApprovalStatus: ApprovalStatus;
    } {
    const { market: { base, quote } } = this
    let baseAssetApprovalStatus = ApprovalStatus.Approved
    let quoteAssetApprovalStatus = ApprovalStatus.Approved

    if (base?.token) {
      const baseAsset = app().assets[base.id]
      const baseVersion = this.market.dex.assets[base.id].version
      if (baseAsset?.wallet?.approved && baseAsset.wallet.approved[baseVersion] !== undefined) {
        baseAssetApprovalStatus = baseAsset.wallet.approved[baseVersion]
      }
    }
    if (quote?.token) {
      const quoteAsset = app().assets[quote.id]
      const quoteVersion = this.market.dex.assets[quote.id].version
      if (quoteAsset?.wallet?.approved && quoteAsset.wallet.approved[quoteVersion] !== undefined) {
        quoteAssetApprovalStatus = quoteAsset.wallet.approved[quoteVersion]
      }
    }

    return {
      baseAssetApprovalStatus,
      quoteAssetApprovalStatus
    }
  }

  /*
   * setTokenApprovalVisibility sets the visibility of the token approval
   * panel elements.
   */
  setTokenApprovalVisibility () {
    const { page } = this

    const { baseAssetApprovalStatus, quoteAssetApprovalStatus } = this.tokenAssetApprovalStatuses()

    if (baseAssetApprovalStatus === ApprovalStatus.Approved && quoteAssetApprovalStatus === ApprovalStatus.Approved) {
      Doc.hide(page.tokenApproval)
      return
    }

    if (baseAssetApprovalStatus !== ApprovalStatus.Approved && quoteAssetApprovalStatus === ApprovalStatus.Approved) {
      Doc.show(page.approvalRequiredSell)
      Doc.hide(page.approvalRequiredBuy, page.approvalRequiredBoth)
    }

    if (baseAssetApprovalStatus === ApprovalStatus.Approved && quoteAssetApprovalStatus !== ApprovalStatus.Approved) {
      Doc.show(page.approvalRequiredBuy)
      Doc.hide(page.approvalRequiredSell, page.approvalRequiredBoth)
    }

    // If they are both unapproved tokens, the order form will not be shown.
    if (baseAssetApprovalStatus !== ApprovalStatus.Approved && quoteAssetApprovalStatus !== ApprovalStatus.Approved) {
      Doc.show(page.approvalRequiredBoth)
      Doc.hide(page.approvalRequiredSell, page.approvalRequiredBuy)
    }

    Doc.show(page.tokenApproval)
    page.approvalPendingBaseSymbol.textContent = page.baseTokenAsset.textContent = this.market.base.symbol.toUpperCase()
    page.approvalPendingQuoteSymbol.textContent = page.quoteTokenAsset.textContent = this.market.quote.symbol.toUpperCase()
    Doc.setVis(baseAssetApprovalStatus === ApprovalStatus.NotApproved, page.approveBaseBttn)
    Doc.setVis(quoteAssetApprovalStatus === ApprovalStatus.NotApproved, page.approveQuoteBttn)
    Doc.setVis(baseAssetApprovalStatus === ApprovalStatus.Pending, page.approvalPendingBase)
    Doc.setVis(quoteAssetApprovalStatus === ApprovalStatus.Pending, page.approvalPendingQuote)
  }

  /* setRegistrationStatusView sets the text content and class for the
   * registration status view
   */
  setRegistrationStatusView (titleContent: string, confStatusMsg: string, titleClass: string) {
    const page = this.page
    page.regStatusTitle.textContent = titleContent
    page.regStatusConfsDisplay.textContent = confStatusMsg
    page.registrationStatus.classList.remove('completed', 'error', 'waiting')
    page.registrationStatus.classList.add(titleClass)
  }

  /*
   * updateRegistrationStatusView updates the view based on the current
   * registration status
   */
  updateRegistrationStatusView () {
    const { page, market: { dex } } = this
    page.regStatusDex.textContent = dex.host
    page.postingBondsDex.textContent = dex.host

    if (dex.auth.effectiveTier >= 1) {
      this.setRegistrationStatusView(intl.prep(intl.ID_REGISTRATION_FEE_SUCCESS), '', 'completed')
      return
    }

    const confStatuses = (dex.auth.pendingBonds || []).map(pending => {
      const confirmationsRequired = dex.bondAssets[pending.symbol].confs
      return `${pending.confs} / ${confirmationsRequired}`
    })
    const confStatusMsg = confStatuses.join(', ')
    this.setRegistrationStatusView(intl.prep(intl.ID_WAITING_FOR_CONFS), confStatusMsg, 'waiting')
  }

  /*
   * setRegistrationStatusVisibility toggles the registration status view based
   * on the dex data.
   */
  setRegistrationStatusVisibility () {
    const { page, market } = this
    if (!market || !market.dex) return

    // If dex is not connected to server, is not possible to know the
    // registration status.
    if (market.dex.connectionStatus !== ConnectionStatus.Connected) return

    this.updateRegistrationStatusView()

    const showSection = (section: PageElement | undefined) => {
      const elements = [page.registrationStatus, page.bondRequired, page.bondCreationPending, page.notRegistered]
      for (const el of elements) {
        Doc.setVis(el === section, el)
      }
    }

    if (market.dex.auth.effectiveTier >= 1) {
      const toggle = () => {
        showSection(undefined)
        this.resolveOrderVsMMForm()
      }
      if (Doc.isHidden(page.orderFormBuy) || Doc.isHidden(page.orderFormSell)) {
        // wait a couple of seconds before showing the form so the success
        // message is shown to the user
        setTimeout(toggle, 5000)
      }
    } else if (market.dex.viewOnly) {
      page.unregisteredDex.textContent = market.dex.host
      showSection(page.notRegistered)
    } else if (this.hasPendingBonds()) {
      showSection(page.registrationStatus)
    } else if (market.dex.auth.targetTier > 0) {
      showSection(page.bondCreationPending)
    } else {
      page.acctTier.textContent = `${market.dex.auth.effectiveTier}`
      page.dexSettingsLink.href = `/dexsettings/${market.dex.host}`
      showSection(page.bondRequired)
    }
  }

  setOrderBttnText () {
    this.page.submitBttnSell.textContent = intl.prep(intl.ID_SET_BUTTON_SELL, { asset: Doc.shortSymbol(this.market.baseCfg.unitInfo.conventional.unit) })
    this.page.submitBttnBuy.textContent = intl.prep(intl.ID_SET_BUTTON_BUY, { asset: Doc.shortSymbol(this.market.baseCfg.unitInfo.conventional.unit) })
  }

  setPageElementEnabled (form: PageElement, isEnabled: boolean) {
    if (isEnabled) {
      form.classList.remove('disabled')
    } else {
      form.classList.add('disabled')
    }
  }

  setOrderBttnBuyEnabled (isEnabled: boolean, disabledTooltipMsg?: string) {
    const btn = this.page.submitBttnBuy
    if (isEnabled) {
      btn.removeAttribute('disabled')
      btn.removeAttribute('title')
    } else {
      btn.setAttribute('disabled', 'true')
      if (disabledTooltipMsg) btn.setAttribute('title', disabledTooltipMsg)
    }
  }

  setOrderBttnSellEnabled (isEnabled: boolean, disabledTooltipMsg?: string) {
    const btn = this.page.submitBttnSell
    if (isEnabled) {
      btn.removeAttribute('disabled')
      btn.removeAttribute('title')
    } else {
      btn.setAttribute('disabled', 'true')
      if (disabledTooltipMsg) btn.setAttribute('title', disabledTooltipMsg)
    }
  }

  setCandleDurBttns () {
    const { page, market } = this
    Doc.empty(page.durBttnBox)
    for (const dur of market.dex.candleDurs) {
      const bttn = page.durBttnTemplate.cloneNode(true)
      bttn.textContent = dur
      bind(bttn, 'click', () => this.candleDurationSelected(dur))
      page.durBttnBox.appendChild(bttn)
    }

    // load candlesticks here since we are resetting page.durBttnBox above.
    this.loadCandles()
  }

  /* setMarket sets the currently displayed market. */
  async setMarket (host: string, baseID: number, quoteID: number) {
    const dex = app().user.exchanges[host]
    const page = this.page

    window.cexBook = async () => {
      const res = await postJSON('/api/cexbook', { host, baseID, quoteID })
      console.log(res.book)
    }

    // clear orderbook (it contains old data now)
    Doc.empty(this.page.buyRows, this.page.sellRows)
    // hide order form (it contains old data now)
    Doc.hide(page.orderFormBuy, page.orderFormSell)
    // clear recent matches for the previous market. This will be set when we
    // receive the order book subscription response
    this.recentMatches = []
    Doc.empty(page.recentMatchesLiveList)
    // hide other notice-type forms
    Doc.hide(page.notRegistered, page.bondRequired, page.noWallet)

    // If we have not yet connected, there is no dex.assets or any other
    // exchange data, so just put up a message and wait for the connection to be
    // established, at which time handleConnNote will refresh and reload.
    if (!dex || !dex.markets || dex.connectionStatus !== ConnectionStatus.Connected) {
      let errMsg = intl.prep(intl.ID_CONNECTION_FAILED)
      if (dex.disabled) errMsg = intl.prep(intl.ID_DEX_DISABLED_MSG)
      page.chartErrMsg.textContent = errMsg
      Doc.show(page.chartErrMsg)
      return
    }

    Doc.show(this.stats.htmlElem)

    const baseCfg = dex.assets[baseID]
    const quoteCfg = dex.assets[quoteID]

    const [bui, qui] = [app().unitInfo(baseID, dex), app().unitInfo(quoteID, dex)]

    const rateConversionFactor = OrderUtil.RateEncodingFactor / bui.conventional.conversionFactor * qui.conventional.conversionFactor
    Doc.hide(page.chartErrMsg)
    const mktId = marketID(baseCfg.symbol, quoteCfg.symbol)
    const baseAsset = app().assets[baseID]
    const quoteAsset = app().assets[quoteID]

    const mkt = {
      dex: dex,
      sid: mktId, // A string market identifier used by the DEX.
      cfg: dex.markets[mktId],
      // app().assets is a map of core.SupportedAsset type, which can be found at
      // client/core/types.go.
      base: baseAsset,
      quote: quoteAsset,
      baseUnitInfo: bui,
      quoteUnitInfo: qui,
      maxSell: null,
      maxBuys: {},
      maxSellRequested: false,
      candleCaches: {},
      baseCfg,
      quoteCfg,
      rateConversionFactor,
      sellBalance: 0,
      buyBalance: 0,
      bookLoaded: false
    }
    this.market = mkt

    page.lotSizeBuy.textContent = Doc.formatCoinValue(mkt.cfg.lotsize, mkt.baseUnitInfo)
    page.lotSizeSell.textContent = Doc.formatCoinValue(mkt.cfg.lotsize, mkt.baseUnitInfo)
    page.rateStepBuy.textContent = Doc.formatCoinValue(mkt.cfg.ratestep / rateConversionFactor)
    page.rateStepSell.textContent = Doc.formatCoinValue(mkt.cfg.ratestep / rateConversionFactor)

    this.displayMessageIfMissingWallet()
    this.setMarketDetails()
    this.setCurrMarketPrice()

    ws.request('loadmarket', makeMarket(host, baseID, quoteID))

    State.storeLocal(State.lastMarketLK, {
      host: host,
      base: baseID,
      quote: quoteID
    })
    app().updateMarketElements(this.main, baseID, quoteID, dex)
    this.marketList.select(host, baseID, quoteID)
    this.setLoaderMsgVisibility()
    this.setTokenApprovalVisibility()
    this.setRegistrationStatusVisibility()
    this.resolveOrderVsMMForm(true)
    this.setOrderBttnText()
    this.setCandleDurBttns()
    this.updateTitle()
    this.reputationMeter.setHost(dex.host)
    this.updateReputation()
    this.loadUserOrders()
  }

  /*
    displayMessageForMissingWallet displays a custom message on the market's
    view if one or more of the selected market's wallet is missing.
  */
  displayMessageIfMissingWallet () {
    const page = this.page
    const mkt = this.market
    const baseSym = mkt.baseCfg.symbol.toLocaleUpperCase()
    const quoteSym = mkt.quoteCfg.symbol.toLocaleUpperCase()

    Doc.hide(page.noWallet)

    const showNoWallet = (msg: string): void => {
      page.noWallet.textContent = msg
      Doc.show(page.noWallet)
    }

    if (!mkt.base?.wallet && !mkt.quote?.wallet) {
      showNoWallet(intl.prep(intl.ID_NO_WALLET_MSG, { asset1: baseSym, asset2: quoteSym }))
      return
    }
    if (!mkt.base?.wallet) {
      showNoWallet(intl.prep(intl.ID_CREATE_ASSET_WALLET_MSG, { asset: baseSym }))
      return
    }
    if (!mkt.quote?.wallet) {
      showNoWallet(intl.prep(intl.ID_CREATE_ASSET_WALLET_MSG, { asset: quoteSym }))
      return
    }
    if (mkt.base.wallet.disabled || !mkt.base.wallet.running) {
      showNoWallet(intl.prep(intl.ID_ENABLE_ASSET_WALLET_MSG, { asset: baseSym }))
      return
    }
    if (mkt.quote.wallet.disabled || !mkt.quote.wallet.running) {
      showNoWallet(intl.prep(intl.ID_ENABLE_ASSET_WALLET_MSG, { asset: quoteSym }))
    }
  }

  reportMouseCandle (candle: Candle | null) {
    const page = this.page
    const mkt = this.market

    if (!candle) {
      Doc.hide(page.candlesLegend)
      return
    }
    Doc.show(page.candlesLegend)

    page.candleStart.textContent = Doc.formatRateAtomFullPrecision(
      candle.startRate,
      mkt.baseUnitInfo,
      mkt.quoteUnitInfo,
      mkt.cfg.ratestep
    )
    page.candleEnd.textContent = Doc.formatRateAtomFullPrecision(
      candle.endRate,
      mkt.baseUnitInfo,
      mkt.quoteUnitInfo,
      mkt.cfg.ratestep
    )
    page.candleHigh.textContent = Doc.formatRateAtomFullPrecision(
      candle.highRate,
      mkt.baseUnitInfo,
      mkt.quoteUnitInfo,
      mkt.cfg.ratestep
    )
    page.candleLow.textContent = Doc.formatRateAtomFullPrecision(
      candle.lowRate,
      mkt.baseUnitInfo,
      mkt.quoteUnitInfo,
      mkt.cfg.ratestep
    )
    page.candleVol.textContent = Doc.formatCoinValue(candle.matchVolume, mkt.baseUnitInfo)
  }

  /*
   * buildOrderSell builds a TradeForm wire-representation that will be sent to
   * Golang client side. Data is not validated in any way (assumes done previously).
   */
  buildOrderBuy (): TradeForm {
    const market = this.market

    const qtyAtom = this.chosenQtyBuyAtom

    return {
      host: market.dex.host,
      isLimit: true,
      sell: false,
      base: market.base.id,
      quote: market.quote.id,
      qty: qtyAtom,
      rate: this.chosenRateBuyAtom,
      tifnow: false,
      options: {}
    }
  }

  /*
 * buildOrderSell builds a TradeForm wire-representation that will be sent to
 * Golang client side. Data is not validated in any way (assumes done previously).
 */
  buildOrderSell (): TradeForm {
    const market = this.market

    const qtyAtom = this.chosenQtySellAtom

    return {
      host: market.dex.host,
      isLimit: true,
      sell: true,
      base: market.base.id,
      quote: market.quote.id,
      qty: qtyAtom,
      rate: this.chosenRateSellAtom,
      tifnow: false,
      options: {}
    }
  }

  /**
   * previewTotalBuy calculates and displays Total value (in quote asset) for the order.
   * It also updates order button state based on the values in the order form.
   */
  previewTotalBuy (orderRateAtom: number, orderQtyAtom: number) {
    const page = this.page
    const market = this.market

    if (orderQtyAtom > 0 && orderRateAtom > 0) {
      const totalOut = orderQtyAtom * orderRateAtom / OrderUtil.RateEncodingFactor
      const totalIn = orderQtyAtom

      page.orderTotalPreviewBuyLeft.textContent = intl.prep(
        intl.ID_LIMIT_ORDER_BUY_SELL_OUT_TOTAL_PREVIEW,
        { total: Doc.formatCoinValueFourSigFigs(totalOut, market.quoteUnitInfo), asset: market.quoteUnitInfo.conventional.unit }
      )
      page.orderTotalPreviewBuyRight.textContent = intl.prep(
        intl.ID_LIMIT_ORDER_BUY_SELL_IN_TOTAL_PREVIEW,
        { total: Doc.formatCoinValueFourSigFigs(totalIn, market.baseUnitInfo), asset: market.baseUnitInfo.conventional.unit }
      )
      this.setPageElementEnabled(this.page.previewTotalBuy, true)
    } else {
      page.orderTotalPreviewBuyLeft.textContent = ''
      page.orderTotalPreviewBuyRight.textContent = ''
      this.setPageElementEnabled(this.page.previewTotalBuy, false)
    }
  }

  /**
   * previewTotalSell calculates and displays Total value (in quote asset) for the order.
   * It also updates order button state based on the values in the order form.
   */
  previewTotalSell (orderRateAtom: number, orderQtyAtom: number) {
    const page = this.page
    const market = this.market

    if (orderQtyAtom > 0 && orderRateAtom > 0) {
      const totalOut = orderQtyAtom * orderRateAtom / OrderUtil.RateEncodingFactor
      const totalIn = orderQtyAtom

      page.orderTotalPreviewSellLeft.textContent = intl.prep(
        intl.ID_LIMIT_ORDER_BUY_SELL_OUT_TOTAL_PREVIEW,
        { total: Doc.formatCoinValueFourSigFigs(totalIn, market.baseUnitInfo), asset: market.baseUnitInfo.conventional.unit }
      )
      page.orderTotalPreviewSellRight.textContent = intl.prep(
        intl.ID_LIMIT_ORDER_BUY_SELL_IN_TOTAL_PREVIEW,
        { total: Doc.formatCoinValueFourSigFigs(totalOut, market.quoteUnitInfo), asset: market.quoteUnitInfo.conventional.unit }
      )
      this.setPageElementEnabled(this.page.previewTotalSell, true)
    } else {
      page.orderTotalPreviewSellLeft.textContent = ''
      page.orderTotalPreviewSellRight.textContent = ''
      this.setPageElementEnabled(this.page.previewTotalSell, false)
    }
  }

  canTradeBuy (): boolean {
    const mkt = this.market
    const quoteWallet = app().assets[mkt.quote.id].wallet
    if (!quoteWallet) {
      console.warn('assertion failed, no quote wallet in app assets for:', mkt.quote.id)
      return false
    }
    return quoteWallet.balance.available > 0
  }

  canTradeSell (): boolean {
    const mkt = this.market
    const baseWallet = app().assets[mkt.base.id].wallet
    if (!baseWallet) {
      console.warn('assertion failed, no base wallet in app assets for:', mkt.base.id)
      return false
    }
    return baseWallet.balance.available >= mkt.cfg.lotsize
  }

  /**
   * finalizeTotalBuy recalculates new max buy estimate (that depends on chosen rate value),
   * as well as validates whether currently chosen quantity (on buy order form) can be
   * purchased - and if not, it displays error on buy order form.
   */
  async finalizeTotalBuy () {
    const mkt = this.market

    // preview total regardless of whether we can afford it
    this.previewTotalBuy(this.chosenRateBuyAtom, this.chosenQtyBuyAtom)

    const quoteWallet = app().assets[mkt.quote.id].wallet
    const aLotAtom = mkt.cfg.lotsize * (this.chosenRateBuyAtom / OrderUtil.RateEncodingFactor)
    if (quoteWallet.balance.available < aLotAtom) {
      this.setPageElementEnabled(this.page.qtySliderBuy, false) // can't use slider
      this.setOrderBttnBuyEnabled(false, intl.prep(intl.ID_ORDER_BUTTON_BUY_BALANCE_ERROR))
      return
    }

    this.setOrderBttnBuyEnabled(false, 'calculating how much we can buy ...')

    this.maxBuyLastReqID++
    const reqID = this.maxBuyLastReqID
    const maxBuy = await this.requestMaxBuyEstimateCached(this.chosenRateBuyAtom)
    if (reqID !== this.maxBuyLastReqID) {
      // a fresher action has been issued, no need to apply the effects of this one,
      // the fresher one will also update order button state as needed
      return
    }
    if (!maxBuy || this.chosenQtyBuyAtom > maxBuy.swap.lots * mkt.cfg.lotsize) {
      this.setPageElementEnabled(this.page.qtySliderBuy, true) // can use slider
      this.setOrderBttnBuyEnabled(false, intl.prep(intl.ID_ORDER_BUTTON_BUY_BALANCE_ERROR))
      return
    }

    this.setPageElementEnabled(this.page.qtySliderBuy, true) // can use slider
    this.setOrderBttnBuyEnabled(true)
  }

  /**
   * finalizeTotalSell recalculates new max sell estimate (that depends on chosen rate value),
   * as well as validates whether currently chosen quantity (on sell order form) can be
   * purchased - and if not, it displays error on sell order form.
   */
  async finalizeTotalSell () {
    const mkt = this.market

    // preview total regardless of whether we can afford it
    this.previewTotalSell(this.chosenRateSellAtom, this.chosenQtySellAtom)
    this.setPageElementEnabled(this.page.previewTotalSell, true)

    const baseWallet = app().assets[this.market.base.id].wallet
    if (baseWallet.balance.available < mkt.cfg.lotsize) {
      this.setPageElementEnabled(this.page.qtySliderSell, false) // can't use slider
      this.setOrderBttnSellEnabled(false, intl.prep(intl.ID_ORDER_BUTTON_SELL_BALANCE_ERROR))
      return
    }

    this.setOrderBttnSellEnabled(false, 'calculating how much we can sell ...')

    this.maxSellLastReqID++
    const reqID = this.maxSellLastReqID
    const maxSell = await this.requestMaxSellEstimateCached()
    if (reqID !== this.maxSellLastReqID) {
      // a fresher action has been issued, no need to apply the effects of this one,
      // the fresher one will also update order button state as needed
      return
    }
    if (!maxSell || this.chosenQtySellAtom > maxSell.swap.value) {
      this.setPageElementEnabled(this.page.qtySliderSell, true) // can use slider
      this.setOrderBttnSellEnabled(false, intl.prep(intl.ID_ORDER_BUTTON_SELL_BALANCE_ERROR))
      return
    }

    this.setPageElementEnabled(this.page.qtySliderSell, true) // can use slider
    this.setOrderBttnSellEnabled(true)
  }

  async requestMaxBuyEstimateCached (rateAtom: number): Promise<any> {
    const maxBuy = this.market.maxBuys[rateAtom]
    if (maxBuy) {
      return maxBuy
    }

    const marketBefore = this.market.sid
    const res = await this.requestMaxEstimate('/api/maxbuy', { rate: rateAtom })
    if (!res) {
      return null
    }
    const marketAfter = this.market.sid

    // see if user has switched to another market while we were waiting on reply
    if (marketBefore !== marketAfter) {
      return null
    }

    this.market.maxBuys[rateAtom] = res.maxBuy
    // see buyBalance desc for why we are doing this
    this.market.buyBalance = app().assets[this.market.quote.id].wallet.balance.available

    return res.maxBuy
  }

  async requestMaxSellEstimateCached (): Promise<any> {
    const maxSell = this.market.maxSell
    if (maxSell) {
      return maxSell
    }

    const marketBefore = this.market.sid
    const res = await this.requestMaxEstimate('/api/maxsell', {})
    if (!res) {
      return null
    }
    const marketAfter = this.market.sid

    // see if user has switched to another market while we were waiting on reply
    if (marketBefore !== marketAfter) {
      return null
    }

    this.market.maxSell = res.maxSell
    // see sellBalance desc for why we are doing this
    this.market.sellBalance = app().assets[this.market.base.id].wallet.balance.available

    return res.maxSell
  }

  /**
   * requestMaxEstimate calls an order estimate api endpoint. If another call to
   * requestMaxEstimate is made before this one is finished, this call will be canceled.
   */
  async requestMaxEstimate (path: string, args: any): Promise<any> {
    const [bid, qid] = [this.market.base.id, this.market.quote.id]
    const [bWallet, qWallet] = [app().assets[bid].wallet, app().assets[qid].wallet]
    if (!bWallet || !bWallet.running || !qWallet || !qWallet.running) return null

    const res = await postJSON(path, {
      host: this.market.dex.host,
      base: bid,
      quote: qid,
      ...args
    })
    if (!app().checkResponse(res)) {
      return null
    }
    return res
  }

  /*
   * validateOrderBuy performs some basic order sanity checks, returning boolean
   * true if the order appears valid.
   */
  async validateOrderBuy (order: TradeForm) {
    const { page, market: { cfg: { minimumRate }, rateConversionFactor } } = this

    const showError = function (err: string) {
      page.orderErrBuy.textContent = intl.prep(err)
      Doc.show(page.orderErrBuy)
    }

    if (!order.rate) {
      showError(intl.ID_NO_ZERO_RATE)
      return false
    }
    if (order.rate < minimumRate) {
      const [r, minRate] = [order.rate / rateConversionFactor, minimumRate / rateConversionFactor]
      showError(`rate is lower than the market's minimum rate. ${r} < ${minRate}`)
      return false
    }
    if (!order.qty) {
      // Hints to the user what inputs don't pass validation.
      this.animateErrors(highlightOutlineRed(page.qtyFieldBuy))
      showError(intl.ID_NO_ZERO_QUANTITY)
      return false
    }
    if (order.qty > await this.calcMaxOrderQtyAtoms(order.sell)) {
      // Hints to the user what inputs don't pass validation.
      this.animateErrors(highlightOutlineRed(page.qtyFieldBuy))
      showError(intl.ID_NO_QUANTITY_EXCEEDS_MAX)
      return false
    }
    return true
  }

  /*
 * validateOrderSell performs some basic order sanity checks, returning boolean
 * true if the order appears valid.
 */
  async validateOrderSell (order: TradeForm) {
    const { page, market: { cfg: { minimumRate }, rateConversionFactor } } = this

    const showError = function (err: string) {
      page.orderErrSell.textContent = intl.prep(err)
      Doc.show(page.orderErrSell)
    }

    if (!order.rate) {
      showError(intl.ID_NO_ZERO_RATE)
      return false
    }
    if (order.rate < minimumRate) {
      const [r, minRate] = [order.rate / rateConversionFactor, minimumRate / rateConversionFactor]
      showError(`rate is lower than the market's minimum rate. ${r} < ${minRate}`)
      return false
    }
    if (!order.qty) {
      // Hints to the user what inputs don't pass validation.
      this.animateErrors(highlightOutlineRed(page.qtyFieldSell))
      showError(intl.ID_NO_ZERO_QUANTITY)
      return false
    }
    if (order.qty > await this.calcMaxOrderQtyAtoms(order.sell)) {
      // Hints to the user what inputs don't pass validation.
      this.animateErrors(highlightOutlineRed(page.qtyFieldBuy))
      showError(intl.ID_NO_QUANTITY_EXCEEDS_MAX)
      return false
    }
    return true
  }

  /*
   * midGapRateConventional is the same as midGap, but returns the mid-gap rate as
   * the conventional ratio. This is used to convert from a conventional
   * quantity from base to quote or vice-versa, or for display purposes.
   */
  midGapRateConventional (): number | null {
    const gapAtom = this.midGapRateAtom()
    if (!gapAtom) return null
    const { baseUnitInfo: b, quoteUnitInfo: q } = this.market
    return (gapAtom / OrderUtil.RateEncodingFactor) * (b.conventional.conversionFactor / q.conventional.conversionFactor)
  }

  /*
   * midGapRateAtom returns the value in the middle of the best buy and best sell. If
   * either one of the buy or sell sides are empty, midGap returns the best rate
   * from the other side. If both sides are empty, midGap returns the value 0.
   * The rate returned is the atomic ratio, used for conversion. For a
   * conventional rate for display or to convert conventional units, use
   * midGapConventional
   */
  midGapRateAtom (): number {
    const book = this.book
    if (!book) return 0
    if (book.buys && book.buys.length) {
      if (book.sells && book.sells.length) {
        return this.adjustRateAtoms((book.buys[0].msgRate + book.sells[0].msgRate) / 2)
      }
      return this.adjustRateAtoms(book.buys[0].msgRate)
    }
    if (book.sells && book.sells.length) {
      return this.adjustRateAtoms(book.sells[0].msgRate)
    }
    return 0
  }

  maxUserOrderCount (): number {
    const { dex: { host }, cfg: { name: mktID } } = this.market
    return Math.max(maxUserOrdersShown, app().orders(host, mktID).length)
  }

  // loadUserOrders draws user orders section on markets page.
  async loadUserOrders () {
    const { base: b, quote: q, dex: { host }, cfg: { name: mktID } } = this.market
    for (const oid in this.metaOrders) delete this.metaOrders[oid]
    if (!b || !q) return this.resolveUserOrders([]) // unsupported asset

    const activeOrders = app().orders(host, mktID)
    if (activeOrders.length !== 0) {
      this.resolveUserOrders(activeOrders)
      return
    }

    // we've probably just started and haven't received any order notifications yet,
    // fetch orders explicitly then
    const filter: OrderFilter = {
      hosts: [host],
      market: { baseID: b.id, quoteID: q.id },
      statuses: [0, 1, 2], // interested in active orders only
      n: this.maxUserOrderCount()
    }
    const res = await postJSON('/api/orders', filter)
    this.resolveUserOrders(res.orders || [])
  }

  /* refreshActiveOrders refreshes the user's active order list. */
  refreshActiveOrders () {
    const orders = app().orders(this.market.dex.host, marketID(this.market.baseCfg.symbol, this.market.quoteCfg.symbol))
    return this.resolveUserOrders(orders)
  }

  resolveUserOrders (orders: Order[]) {
    const { page, metaOrders, market } = this
    const cfg = market.cfg

    const orderIsActive = (ord: Order) => ord.status < OrderUtil.StatusExecuted || OrderUtil.hasActiveMatches(ord)

    for (const ord of orders) metaOrders[ord.id] = { ord: ord } as MetaOrder
    let sortedOrders = Object.keys(metaOrders).map((oid: string) => metaOrders[oid])
    sortedOrders.sort((a: MetaOrder, b: MetaOrder) => {
      const [aActive, bActive] = [orderIsActive(a.ord), orderIsActive(b.ord)]
      if (aActive && !bActive) return -1
      else if (!aActive && bActive) return 1
      return b.ord.submitTime - a.ord.submitTime
    })
    const n = this.maxUserOrderCount()
    if (sortedOrders.length > n) { sortedOrders = sortedOrders.slice(0, n) }

    for (const oid in metaOrders) delete metaOrders[oid]

    Doc.empty(page.userOrders)
    Doc.setVis(sortedOrders?.length, page.userOrders)
    Doc.setVis(!sortedOrders?.length, page.userNoOrders)

    let unreadyOrders = false
    for (const mord of sortedOrders) {
      const div = page.userOrderTmpl.cloneNode(true) as HTMLElement
      page.userOrders.appendChild(div)
      const tmpl = Doc.parseTemplate(div)
      const header = Doc.parseTemplate(tmpl.header)
      const details = Doc.parseTemplate(tmpl.details)

      mord.div = div
      mord.header = header
      mord.details = details
      const ord = mord.ord

      const orderID = ord.id
      const isActive = orderIsActive(ord)

      // No need to track in-flight orders here. We've already added it to
      // display.
      if (orderID) metaOrders[orderID] = mord

      if (!ord.readyToTick && OrderUtil.hasActiveMatches(ord)) {
        tmpl.header.classList.add('unready-user-order')
        unreadyOrders = true
      }
      header.sideLight.classList.add(ord.sell ? 'sell' : 'buy')
      if (!isActive) header.sideLight.classList.add('inactive')
      details.side.textContent = mord.header.side.textContent = OrderUtil.sellString(ord)
      details.side.classList.add(ord.sell ? 'sellcolor' : 'buycolor')
      header.side.classList.add(ord.sell ? 'sellcolor' : 'buycolor')
      details.qty.textContent = mord.header.qty.textContent = Doc.formatCoinValue(ord.qty, market.baseUnitInfo)
      let headerRateStr = Doc.formatRateAtomFullPrecision(ord.rate, market.baseUnitInfo, market.quoteUnitInfo, cfg.ratestep)
      let detailsRateStr = Doc.formatRateAtomFullPrecision(ord.rate, market.baseUnitInfo, market.quoteUnitInfo, cfg.ratestep)
      if (ord.type === OrderUtil.Market) {
        headerRateStr = this.marketOrderHeaderRateString(ord, market)
        detailsRateStr = this.marketOrderDetailsRateString(ord, market)
      }
      mord.header.rate.textContent = `@ ${headerRateStr}`
      details.rate.textContent = detailsRateStr
      header.baseSymbol.textContent = market.baseUnitInfo.conventional.unit
      details.type.textContent = OrderUtil.orderTypeText(ord.type)
      this.updateMetaOrder(mord)

      const showCancel = (e: Event) => {
        e.stopPropagation()
        this.showCancel(div, orderID)
      }

      const showAccelerate = (e: Event) => {
        e.stopPropagation()
        this.showAccelerate(ord)
      }

      if (!orderID) {
        Doc.hide(details.accelerateBttn)
        Doc.hide(details.cancelBttn)
        Doc.hide(details.link)
      } else {
        if (OrderUtil.isCancellable(ord)) {
          Doc.show(details.cancelBttn)
          bind(details.cancelBttn, 'click', (e: Event) => { showCancel(e) })
        }

        bind(details.accelerateBttn, 'click', (e: Event) => { showAccelerate(e) })
        if (app().canAccelerateOrder(ord)) {
          Doc.show(details.accelerateBttn)
        }

        details.link.href = `order/${orderID}`
        app().bindInternalNavigation(div)
      }
      let currentFloater: (PageElement | null)
      bind(tmpl.header, 'click', () => {
        if (Doc.isDisplayed(tmpl.details)) {
          Doc.hide(tmpl.details)
          return
        }
        Doc.show(tmpl.details)
        if (currentFloater) currentFloater.remove()
      })
      /**
       * We'll show the button menu when they hover over the header. To avoid
       * pushing the layout around, we'll show the buttons as an absolutely
       * positioned copy of the button menu.
       */
      bind(tmpl.header, 'mouseenter', () => {
        // Don't show the copy if the details are already displayed.
        if (Doc.isDisplayed(tmpl.details)) return
        if (currentFloater) currentFloater.remove()
        // Create and position the element based on the position of the header.
        const floater = document.createElement('div')
        currentFloater = floater
        document.body.appendChild(floater)
        floater.className = 'user-order-floaty-menu'
        const m = Doc.layoutMetrics(tmpl.header)
        const y = m.bodyTop + m.height
        floater.style.top = `${y - 1}px` // - 1 to hide border on header div
        floater.style.left = `${m.bodyLeft}px`
        // Get the updated version of the order
        const mord = this.metaOrders[orderID]
        const ord = mord.ord

        const addButton = (baseBttn: PageElement, cb: ((e: Event) => void)) => {
          const icon = baseBttn.cloneNode(true) as PageElement
          floater.appendChild(icon)
          Doc.show(icon)
          bind(icon, 'click', (e: Event) => { cb(e) })
        }

        if (OrderUtil.isCancellable(ord)) addButton(details.cancelBttn, (e: Event) => { showCancel(e) })
        if (app().canAccelerateOrder(ord)) addButton(details.accelerateBttn, (e: Event) => { showAccelerate(e) })
        floater.appendChild(details.link.cloneNode(true))

        const ogScrollY = page.orderScroller.scrollTop
        // Set up the hover interactions.
        const moved = (e: MouseEvent) => {
          // If the user scrolled, reposition the float menu. This keeps the
          // menu from following us around, which can prevent removal below.
          const yShift = page.orderScroller.scrollTop - ogScrollY
          floater.style.top = `${y + yShift}px`
          if (Doc.mouseInElement(e, floater) || Doc.mouseInElement(e, div)) return
          floater.remove()
          currentFloater = null
          document.removeEventListener('mousemove', moved)
          page.orderScroller.removeEventListener('scroll', moved)
        }
        document.addEventListener('mousemove', moved)
        page.orderScroller.addEventListener('scroll', moved)
      })
      app().bindTooltips(div)
    }
    Doc.setVis(unreadyOrders, page.unreadyOrdersMsg)
  }

  marketOrderHeaderRateString (ord: Order, mkt: CurrentMarket): string {
    if (!ord.matches?.length) return intl.prep(intl.ID_MARKET_ORDER)
    let rateStr = Doc.formatRateAtomFullPrecision(OrderUtil.averageRate(ord), mkt.baseUnitInfo, mkt.quoteUnitInfo, mkt.cfg.ratestep)
    if (ord.matches.length > 1) rateStr = '~ ' + rateStr // ~ only makes sense if the order has more than one match
    return rateStr
  }

  marketOrderDetailsRateString (ord: Order, mkt: CurrentMarket): string {
    if (!ord.matches?.length) return intl.prep(intl.ID_MARKET_ORDER)
    let rateStr = Doc.formatRateAtomFullPrecision(OrderUtil.averageRate(ord), mkt.baseUnitInfo, mkt.quoteUnitInfo, mkt.cfg.ratestep)
    if (ord.matches.length > 1) rateStr = '~ ' + rateStr // ~ only makes sense if the order has more than one match
    return rateStr
  }

  /*
  * updateMetaOrder sets the td contents of the user's order table row.
  */
  updateMetaOrder (mord: MetaOrder) {
    const { header, details, ord } = mord
    if (ord.status <= OrderUtil.StatusBooked || OrderUtil.hasActiveMatches(ord)) header.activeLight.classList.add('active')
    else header.activeLight.classList.remove('active')
    details.status.textContent = header.status.textContent = OrderUtil.statusString(ord)
    details.age.textContent = Doc.timeSince(ord.submitTime)
    details.filled.textContent = `${(OrderUtil.filled(ord) / ord.qty * 100).toFixed(1)}%`
    details.settled.textContent = `${(OrderUtil.settled(ord) / ord.qty * 100).toFixed(1)}%`
  }

  /* updateTitle update the browser title based on the midgap value and the
   * selected assets.
   */
  updateTitle () {
    // gets first price value from buy or from sell, so we can show it on
    // title.
    const midGapValue = this.midGapRateConventional()
    const { baseUnitInfo: { conventional: { unit: bUnit } }, quoteUnitInfo: { conventional: { unit: qUnit } } } = this.market
    if (!midGapValue) document.title = `${bUnit}${qUnit} | ${this.ogTitle}`
    else document.title = `${Doc.formatCoinValue(midGapValue)} | ${bUnit}${qUnit} | ${this.ogTitle}` // more than 6 numbers it gets too big for the title.
  }

  // adjRateAtomsBuy helps us make sure every order we've got is adjusted to rate-step,
  // this is redundant but helps with the hack we do to keep rates manageable in UI
  // (see comment that mentions "insanely large rate-step"); note, we have to round
  // buy-order rate DOWN and sell-order rate UP so that user can actually book it in UI
  // by inputting the rate he sees (otherwise he'll be just short of the rate he needs to set)
  adjRateAtomsBuy (rateAtom: number): number {
    const { cfg: { ratestep } } = this.market
    return rateAtom - (rateAtom % ratestep) // adjusted down
  }

  // adjRateAtomsSell is similar to adjRateAtomsBuy (but helps with sell-orders)
  adjRateAtomsSell (rateAtom: number): number {
    const { cfg: { ratestep } } = this.market
    const adjustedRateAtom = rateAtom - (rateAtom % ratestep)
    if (rateAtom === adjustedRateAtom) {
      return rateAtom // nothing to adjust up
    }
    return adjustedRateAtom + ratestep // adjusted up
  }

  /* handleBookRoute is the handler for the 'book' notification, which is sent
   * in response to a new market subscription. The data received will contain
   * the entire order book.
   */
  handleBookRoute (note: BookUpdate) {
    app().log('book', 'handleBookRoute:', note)
    const mktBook: MarketOrderBook = note.payload
    const { baseCfg, quoteCfg, dex: { host } } = this.market
    if (mktBook.base !== baseCfg.id || mktBook.quote !== quoteCfg.id || note.host !== host) {
      return // user already changed markets
    }

    mktBook.book.buys = mktBook.book.buys || [] // take care of null
    mktBook.book.buys.forEach(order => {
      order.msgRate = this.adjRateAtomsBuy(order.msgRate)
    })
    mktBook.book.sells = mktBook.book.sells || [] // take care of null
    mktBook.book.sells.forEach(order => {
      order.msgRate = this.adjRateAtomsSell(order.msgRate)
    })
    mktBook.book.epoch = mktBook.book.epoch || [] // take care of null
    mktBook.book.epoch.forEach(order => {
      order.msgRate = order.sell ? this.adjRateAtomsSell(order.msgRate) : this.adjRateAtomsBuy(order.msgRate)
    })

    this.book = new OrderBook(mktBook, baseCfg.symbol, quoteCfg.symbol)
    this.loadTable()
    for (const order of (mktBook.book.epoch || [])) {
      if (order.rate > 0) this.book.add(order)
      this.addTableOrder(order)
    }

    this.recentMatches = mktBook.book.recentMatches ?? []
    this.refreshRecentMatchesTable()
    this.setCurrMarketPrice() // needs an update whenever matches update

    this.market.bookLoaded = true
    this.updateTitle()
  }

  /* handleBookOrderRoute is the handler for 'book_order' notifications. */
  handleBookOrderRoute (data: BookUpdate) {
    app().log('book', 'handleBookOrderRoute:', data)
    if (data.host !== this.market.dex.host || data.marketID !== this.market.sid) return
    const order = data.payload as MiniOrder
    order.msgRate = order.sell ? this.adjRateAtomsSell(order.msgRate) : this.adjRateAtomsBuy(order.msgRate)
    if (order.rate > 0) this.book.add(order)
    this.addTableOrder(order)
    this.updateTitle()
  }

  /* handleUnbookOrderRoute is the handler for 'unbook_order' notifications. */
  handleUnbookOrderRoute (data: BookUpdate) {
    app().log('book', 'handleUnbookOrderRoute:', data)
    if (data.host !== this.market.dex.host || data.marketID !== this.market.sid) return
    const order = data.payload
    this.book.remove(order.id)
    this.removeTableOrder(order)
    this.updateTitle()
  }

  /*
   * handleUpdateRemainingRoute is the handler for 'update_remaining'
   * notifications.
   */
  handleUpdateRemainingRoute (data: BookUpdate) {
    app().log('book', 'handleUpdateRemainingRoute:', data)
    if (data.host !== this.market.dex.host || data.marketID !== this.market.sid) return
    const update = data.payload
    this.book.updateRemaining(update.token, update.qty, update.qtyAtomic)
    this.updateTableOrder(update)
  }

  /* handleEpochOrderRoute is the handler for 'epoch_order' notifications. */
  handleEpochOrderRoute (data: BookUpdate) {
    app().log('book', 'handleEpochOrderRoute:', data)
    if (data.host !== this.market.dex.host || data.marketID !== this.market.sid) return
    const order = data.payload
    order.msgRate = order.sell ? this.adjRateAtomsSell(order.msgRate) : this.adjRateAtomsBuy(order.msgRate)
    if (order.msgRate > 0) this.book.add(order) // No cancels or market orders
    if (order.qtyAtomic > 0) this.addTableOrder(order) // No cancel orders
  }

  /* handleCandlesRoute is the handler for 'candles' notifications. */
  handleCandlesRoute (data: BookUpdate) {
    if (this.candlesLoading) {
      clearTimeout(this.candlesLoading.timer)
      this.candlesLoading.loaded()
      this.candlesLoading = null
    }
    if (data.host !== this.market.dex.host || data.marketID !== this.market.cfg.name) return
    const dur = data.payload.dur
    this.market.candleCaches[dur] = data.payload
    this.setHighLow()
    if (this.candleDur !== dur) return
    if (this.loadingAnimations.candles) this.loadingAnimations.candles.stop()
    this.candleChart.canvas.classList.remove('invisible')
    this.candleChart.setCandles(data.payload, this.market.cfg, this.market.baseUnitInfo, this.market.quoteUnitInfo)
  }

  handleEpochMatchSummary (data: BookUpdate) {
    this.addRecentMatches(data.payload.matchSummaries)
    this.refreshRecentMatchesTable()
    this.setCurrMarketPrice() // needs an update whenever matches update
  }

  /* handleCandleUpdateRoute is the handler for 'candle_update' notifications. */
  handleCandleUpdateRoute (data: BookUpdate) {
    if (data.host !== this.market.dex.host) return
    const { dur, candle } = data.payload
    const cache = this.market.candleCaches[dur]
    if (!cache) return // must not have seen the 'candles' notification yet?
    const candles = cache.candles
    if (candles.length === 0) candles.push(candle)
    else {
      const last = candles[candles.length - 1]
      if (last.startStamp === candle.startStamp) candles[candles.length - 1] = candle
      else candles.push(candle)
    }
    if (this.candleDur !== dur) return
    this.candleChart.draw()
  }

  /*
   * toggleWalletStatus toggle wallets status to enabled.
   */
  async toggleWalletStatus () {
    const page = this.page
    Doc.hide(page.toggleWalletStatusErr)

    const url = '/api/togglewalletstatus'
    const req = {
      assetID: this.openAsset.id,
      disable: false
    }

    const loaded = app().loading(page.toggleWalletStatusConfirm)
    const res = await postJSON(url, req)
    loaded()
    if (!app().checkResponse(res)) {
      page.toggleWalletStatusErr.textContent = res.msg
      Doc.show(page.toggleWalletStatusErr)
      return
    }

    Doc.hide(this.page.forms)
  }

  /* showVerify shows the form to accept the currently parsed order information
   * and confirm submission of the order to the dex.
   */
  showVerify (order: TradeForm) {
    const page = this.page
    const isSell = order.sell
    const baseAsset = app().assets[order.base]
    const quoteAsset = app().assets[order.quote]

    page.vBuySell.textContent = isSell ? intl.prep(intl.ID_SELLING) : intl.prep(intl.ID_BUYING)
    const buySellStr = isSell ? intl.prep(intl.ID_SELL) : intl.prep(intl.ID_BUY)
    page.vSideSubmit.textContent = buySellStr
    page.vOrderHost.textContent = order.host
    Doc.show(page.verifyLimit)
    const orderDesc = `Limit ${buySellStr} Order`
    page.vOrderType.textContent = order.tifnow ? orderDesc + ' (immediate)' : orderDesc
    page.vRate.textContent = Doc.formatCoinValue(order.rate / this.market.rateConversionFactor)

    let youSpendAsset = quoteAsset
    let youSpendTotal = order.qty * order.rate / OrderUtil.RateEncodingFactor
    let youGetTotal = order.qty
    let youGetAsset = baseAsset
    if (isSell) {
      youSpendTotal = order.qty
      youSpendAsset = baseAsset
      youGetTotal = order.qty * order.rate / OrderUtil.RateEncodingFactor
      youGetAsset = quoteAsset
    }
    page.youSpend.textContent = '-' + Doc.formatCoinValue(youSpendTotal, youSpendAsset.unitInfo)
    page.youSpendTicker.textContent = youSpendAsset.unitInfo.conventional.unit
    page.youGet.textContent = '+' + Doc.formatCoinValue(youGetTotal, youGetAsset.unitInfo)
    page.youGetTicker.textContent = youGetAsset.unitInfo.conventional.unit
    // Format total fiat value.
    this.showFiatValue(youGetAsset.id, youGetTotal, page.vFiatTotal)

    // Visually differentiate between buy/sell orders.
    if (isSell) {
      page.vHeader.classList.add(sellBtnClass)
      page.vHeader.classList.remove(buyBtnClass)
      page.vSubmit.classList.add(sellBtnClass)
      page.vSubmit.classList.remove(buyBtnClass)
    } else {
      page.vHeader.classList.add(buyBtnClass)
      page.vHeader.classList.remove(sellBtnClass)
      page.vSubmit.classList.add(buyBtnClass)
      page.vSubmit.classList.remove(sellBtnClass)
    }
    this.showVerifyForm()
  }

  // showFiatValue displays the fiat equivalent for an order quantity.
  showFiatValue (assetID: number, qty: number, display: PageElement) {
    if (display) {
      const rate = app().fiatRatesMap[assetID]
      display.textContent = Doc.formatFiatConversion(qty, rate, app().unitInfo(assetID))
      if (rate) Doc.show(display.parentElement as Element)
      else Doc.hide(display.parentElement as Element)
    }
  }

  /* showVerifyForm displays form to verify an order */
  async showVerifyForm () {
    const page = this.page
    Doc.hide(page.vErr)
    this.forms.show(page.verifyForm)
  }

  async submitCancel () {
    // this will be the page.cancelSubmit button (evt.currentTarget)
    const page = this.page
    const cancelData = this.cancelData
    const order = cancelData.order
    const req = {
      orderID: order.id
    }
    // Toggle the loader and submit button.
    const loaded = app().loading(page.cancelSubmit)
    const res = await postJSON('/api/cancel', req)
    loaded()
    // Display error on confirmation modal.
    if (!app().checkResponse(res)) {
      page.cancelErr.textContent = res.msg
      Doc.show(page.cancelErr)
      return
    }
    // Hide confirmation modal only on success.
    Doc.hide(cancelData.bttn, page.forms)
    order.cancelling = true
  }

  /* showCancel shows a form to confirm submission of a cancel order. */
  showCancel (row: HTMLElement, orderID: string) {
    const ord = this.metaOrders[orderID].ord
    const page = this.page
    const remaining = ord.qty - ord.filled
    const asset = OrderUtil.isMarketBuy(ord) ? this.market.quote : this.market.base
    page.cancelRemain.textContent = Doc.formatCoinValue(remaining, asset.unitInfo)
    page.cancelUnit.textContent = asset.symbol.toUpperCase()
    Doc.hide(page.cancelErr)
    this.forms.show(page.cancelForm)
    this.cancelData = {
      bttn: Doc.tmplElement(row, 'cancelBttn'),
      order: ord
    }
  }

  /* showAccelerate shows the accelerate order form. */
  showAccelerate (order: Order) {
    const loaded = app().loading(this.main)
    this.accelerateOrderForm.refresh(order)
    loaded()
    this.forms.show(this.page.accelerateForm)
  }

  /* showCreate shows the new wallet creation form. */
  showCreate (asset: SupportedAsset) {
    const page = this.page
    this.currentCreate = asset
    this.newWalletForm.setAsset(asset.id)
    this.forms.show(page.newWalletForm)
  }

  /*
   * stepSubmitBuy will examine the current state of wallets and step the user
   * through the process of order submission.
   * NOTE: I expect this process will be streamlined soon such that the wallets
   * will attempt to be unlocked in the order submission process, negating the
   * need to unlock ahead of time.
   */
  stepSubmitBuy () {
    const page = this.page
    const market = this.market

    Doc.hide(page.orderErrBuy)

    const showError = function (err: string, args?: Record<string, string>) {
      page.orderErrBuy.textContent = intl.prep(err, args)
      Doc.show(page.orderErrBuy)
    }

    const order = this.buildOrderBuy()
    if (!this.validateOrderBuy(order)) {
      return
    }

    const baseWallet = app().walletMap[market.base.id]
    const quoteWallet = app().walletMap[market.quote.id]
    if (!baseWallet) {
      showError(intl.ID_NO_ASSET_WALLET, { asset: market.base.symbol })
      return
    }
    if (!quoteWallet) {
      showError(intl.ID_NO_ASSET_WALLET, { asset: market.quote.symbol })
      return
    }
    this.verifiedOrder = order
    this.showVerify(this.verifiedOrder)
  }

  /*
 * stepSubmitSell will examine the current state of wallets and step the user
 * through the process of order submission.
 * NOTE: I expect this process will be streamlined soon such that the wallets
 * will attempt to be unlocked in the order submission process, negating the
 * need to unlock ahead of time.
 */
  stepSubmitSell () {
    const page = this.page
    const market = this.market

    Doc.hide(page.orderErrSell)

    const showError = function (err: string, args?: Record<string, string>) {
      page.orderErrSell.textContent = intl.prep(err, args)
      Doc.show(page.orderErrSell)
    }

    const order = this.buildOrderSell()
    if (!this.validateOrderSell(order)) {
      return
    }

    const baseWallet = app().walletMap[market.base.id]
    const quoteWallet = app().walletMap[market.quote.id]
    if (!baseWallet) {
      showError(intl.ID_NO_ASSET_WALLET, { asset: market.base.symbol })
      return
    }
    if (!quoteWallet) {
      showError(intl.ID_NO_ASSET_WALLET, { asset: market.quote.symbol })
      return
    }
    this.verifiedOrder = order
    this.showVerify(this.verifiedOrder)
  }

  /* Display a deposit address. */
  async showDeposit (assetID: number) {
    this.depositAddrForm.setAsset(assetID)
    this.forms.show(this.page.deposit)
  }

  showCustomProviderDialog (assetID: number) {
    app().loadPage('wallets', { promptProvider: assetID, goBack: 'markets' })
  }

  /*
   * handlePriceUpdate is the handler for the 'spots' notification.
   */
  handlePriceUpdate (note: SpotPriceNote) {
    if (!this.market) return // This note can arrive before the market is set.
    if (note.host === this.market.dex.host && note.spots[this.market.cfg.name]) {
      this.setCurrMarketPrice()
    }
  }

  handleWalletState (note: WalletStateNote) {
    if (!this.market) return // This note can arrive before the market is set.
    // if (note.topic !== 'TokenApproval') return
    if (note.wallet.assetID !== this.market.base?.id && note.wallet.assetID !== this.market.quote?.id) return
    this.setTokenApprovalVisibility()
    this.resolveOrderVsMMForm()
  }

  /*
   * handleBondUpdate is the handler for the 'bondpost' notification type.
   * This is used to update the registration status of the current exchange.
   */
  async handleBondUpdate (note: BondNote) {
    const dexAddr = note.dex
    if (!this.market) return // This note can arrive before the market is set.
    if (dexAddr !== this.market.dex.host) return
    // If we just finished legacy registration, we need to update the Exchange.
    // TODO: Use tier change notification once available.
    if (note.topic === 'AccountRegistered') await app().fetchUser()
    // Update local copy of Exchange.
    this.market.dex = app().exchanges[dexAddr]
    this.setRegistrationStatusVisibility()
    this.updateReputation()
  }

  updateReputation () {
    const { page, market: { dex: { host }, cfg: mkt, baseCfg: { unitInfo: bui }, quoteCfg: { unitInfo: qui } } } = this
    const { auth } = app().exchanges[host]

    page.parcelSizeLots.textContent = String(mkt.parcelsize)
    page.marketLimitBase.textContent = Doc.formatFourSigFigs(mkt.parcelsize * mkt.lotsize / bui.conventional.conversionFactor)
    page.marketLimitBaseUnit.textContent = bui.conventional.unit
    page.marketLimitQuoteUnit.textContent = qui.conventional.unit
    const conversionRate = this.anyRate()[1]
    if (conversionRate) {
      const qty = mkt.lotsize * conversionRate
      page.marketLimitQuote.textContent = Doc.formatFourSigFigs(mkt.parcelsize * qty / qui.conventional.conversionFactor)
    } else page.marketLimitQuote.textContent = '-'

    const tier = strongTier(auth)
    page.tradingTier.textContent = String(tier)
    const [usedParcels, parcelLimit] = tradingLimits(host)
    page.tradingLimit.textContent = (parcelLimit * mkt.parcelsize).toFixed(2)
    page.limitUsage.textContent = parcelLimit > 0 ? (usedParcels / parcelLimit * 100).toFixed(1) : '0'

    this.reputationMeter.update()
  }

  /*
   * anyRate finds the best rate from any of, in order of priority, the order
   * book, the server's reported spot rate, or the fiat exchange rates. A
   * 3-tuple of message-rate encoding, a conversion rate, and a conventional
   * rate is generated.
   */
  anyRate (): [number, number, number] {
    const { cfg: { spot }, baseCfg: { id: baseID }, quoteCfg: { id: quoteID }, rateConversionFactor, bookLoaded } = this.market
    if (bookLoaded) {
      const midGapAtom = this.midGapRateAtom()
      if (midGapAtom) return [midGapAtom, midGapAtom / OrderUtil.RateEncodingFactor, midGapAtom / rateConversionFactor || 0]
    }
    if (spot && spot.rate) return [spot.rate, spot.rate / OrderUtil.RateEncodingFactor, spot.rate / rateConversionFactor]
    const [baseUSD, quoteUSD] = [app().fiatRatesMap[baseID], app().fiatRatesMap[quoteID]]
    if (baseUSD && quoteUSD) {
      const conventionalRate = baseUSD / quoteUSD
      const msgRate = conventionalRate * rateConversionFactor
      const conversionRate = msgRate / OrderUtil.RateEncodingFactor
      return [msgRate, conversionRate, conventionalRate]
    }
    return [0, 0, 0]
  }

  handleMatchNote (note: MatchNote) {
    const mord = this.metaOrders[note.orderID]
    const match = note.match
    if (!mord) return this.refreshActiveOrders()
    else if (mord.ord.type === OrderUtil.Market && match.status === OrderUtil.NewlyMatched) { // Update the average market rate display.
      // Fetch and use the updated order.
      const ord = app().order(note.orderID)
      if (ord) {
        mord.header.rate.textContent = this.marketOrderHeaderRateString(ord, this.market)
        mord.details.rate.textContent = this.marketOrderDetailsRateString(ord, this.market)
      }
    }
    if (
      (match.side === OrderUtil.MatchSideMaker && match.status === OrderUtil.MakerRedeemed) ||
      (match.side === OrderUtil.MatchSideTaker && match.status === OrderUtil.MatchComplete)
    ) this.updateReputation()
    if (app().canAccelerateOrder(mord.ord)) Doc.show(mord.details.accelerateBttn)
    else Doc.hide(mord.details.accelerateBttn)
  }

  /*
   * handleOrderNote is the handler for the 'order'-type notification, which are
   * used to update a user's order's status.
   */
  handleOrderNote (note: OrderNote) {
    const ord = note.order
    const mord = this.metaOrders[ord.id]
    // - If metaOrder doesn't exist for the given order it means it was created
    //  via bwctl and the GUI isn't aware of it or it was an inflight order.
    //  refreshActiveOrders must be called to grab this order.
    // - If an OrderLoaded notification is recieved, it means an order that was
    //   previously not "ready to tick" (due to its wallets not being connected
    //   and unlocked) has now become ready to tick. The active orders section
    //   needs to be refreshed.
    const wasInflight = note.topic === 'AsyncOrderFailure' || note.topic === 'AsyncOrderSubmitted'
    if (!mord || wasInflight || (note.topic === 'OrderLoaded' && ord.readyToTick)) {
      return this.refreshActiveOrders()
    }
    const oldStatus = mord.ord.status
    mord.ord = ord
    if (note.topic === 'MissedCancel') Doc.show(mord.details.cancelBttn)
    if (ord.filled === ord.qty) Doc.hide(mord.details.cancelBttn)
    if (app().canAccelerateOrder(ord)) Doc.show(mord.details.accelerateBttn)
    else Doc.hide(mord.details.accelerateBttn)
    this.updateMetaOrder(mord)
    // Only reset markers if there is a change, since the chart is redrawn.
    if (
      (oldStatus === OrderUtil.StatusEpoch && ord.status === OrderUtil.StatusBooked) ||
      (oldStatus === OrderUtil.StatusBooked && ord.status > OrderUtil.StatusBooked)
    ) {
      this.updateReputation()
    }
  }

  /*
   * handleEpochNote handles notifications signalling the start of a new epoch.
   */
  handleEpochNote (note: EpochNote) {
    app().log('book', 'handleEpochNote:', note)
    if (!this.market) return // This note can arrive before the market is set.
    if (note.host !== this.market.dex.host || note.marketID !== this.market.sid) return
    if (this.book) {
      this.book.setEpoch(note.epoch)
    }

    this.clearOrderTableEpochs()
    for (const { ord, details, header } of Object.values(this.metaOrders)) {
      const alreadyMatched = note.epoch > ord.epoch
      switch (true) {
        case ord.type === OrderUtil.Limit && ord.status === OrderUtil.StatusEpoch && alreadyMatched: {
          const status = ord.tif === OrderUtil.ImmediateTiF ? intl.prep(intl.ID_EXECUTED) : intl.prep(intl.ID_BOOKED)
          details.status.textContent = header.status.textContent = status
          ord.status = ord.tif === OrderUtil.ImmediateTiF ? OrderUtil.StatusExecuted : OrderUtil.StatusBooked
          break
        }
        case ord.type === OrderUtil.Market && ord.status === OrderUtil.StatusEpoch:
          // Technically don't know if this should be 'executed' or 'settling'.
          details.status.textContent = header.status.textContent = intl.prep(intl.ID_EXECUTED)
          ord.status = OrderUtil.StatusExecuted
          break
      }
    }
  }

  recentMatchesSorted (sortBy: string, direction: number): RecentMatch[] {
    switch (sortBy) {
      case 'rate':
        return this.recentMatches.sort((a: RecentMatch, b: RecentMatch) => direction * (a.rate - b.rate))
      case 'qty':
        return this.recentMatches.sort((a: RecentMatch, b: RecentMatch) => direction * (a.qty - b.qty))
      case 'age':
        return this.recentMatches.sort((a: RecentMatch, b:RecentMatch) => direction * (a.stamp - b.stamp))
      default:
        return []
    }
  }

  refreshRecentMatchesTable () {
    const page = this.page
    const mkt = this.market

    Doc.empty(page.recentMatchesLiveList)
    const recentMatchesSorted = this.recentMatchesSorted(this.recentMatchesSortKey, this.recentMatchesSortDirection)
    if (!recentMatchesSorted) return
    for (const match of recentMatchesSorted) {
      const row = page.recentMatchesTemplate.cloneNode(true) as HTMLElement
      const tmpl = Doc.parseTemplate(row)
      app().bindTooltips(row)
      tmpl.rate.textContent = Doc.formatRateAtomFullPrecision(match.rate, mkt.baseUnitInfo, mkt.quoteUnitInfo, mkt.cfg.ratestep)
      tmpl.qty.textContent = Doc.formatCoinValue(match.qty, mkt.baseUnitInfo)
      tmpl.age.textContent = Doc.timeSince(match.stamp)
      tmpl.age.dataset.sinceStamp = String(match.stamp)
      row.classList.add(match.sell ? 'sellcolor' : 'buycolor')
      page.recentMatchesLiveList.append(row)
    }
  }

  addRecentMatches (matches: RecentMatch[]) {
    this.recentMatches = [...matches, ...this.recentMatches].slice(0, 100)
  }

  /* handleBalanceNote handles notifications updating a wallet's balance. */
  handleBalanceNote (note: BalanceNote) {
    this.approveTokenForm.handleBalanceNote(note)
    // if connection to dex server fails, it is not possible to retrieve
    // markets.
    const mkt = this.market
    if (!mkt || !mkt.dex || mkt.dex.connectionStatus !== ConnectionStatus.Connected) return

    // If there's a balance update, refresh the max order section.
    const avail = note.balance.available
    if (note.assetID === mkt.quoteCfg.id) {
      if (mkt.buyBalance !== avail) {
        // balance changed since we cached our buy estimates - that means now
        // they are WRONG (all of them), we should flush cache with old values here
        mkt.maxBuys = {}
      }
      if (this.chosenRateBuyAtom) { // can only fetch max buy estimate if we have some chosen rate
        this.finalizeTotalBuy()
      }
    }
    if (note.assetID === mkt.baseCfg.id) {
      if (mkt.sellBalance !== avail) {
        // balance changed since we cached our sell estimate - that means now
        // it is WRONG, we should flush cache with old value here
        mkt.maxSell = null
      }
      this.finalizeTotalSell()
    }
  }

  /*
   * submitVerifiedOrder is attached to the affirmative button on the order validation
   * form. Clicking the button is the last step in the order submission process.
   */
  async submitVerifiedOrder () {
    const page = this.page
    Doc.hide(page.vErr)
    const req = { order: wireOrder(this.verifiedOrder) }
    // Show loader and hide submit button.
    page.vSubmit.classList.add('d-hide')
    page.vLoader.classList.remove('d-hide')
    Doc.hide(page.vSubmit)
    Doc.show(page.vLoader)
    const res = await postJSON('/api/tradeasync', req)
    Doc.hide(page.vLoader)
    Doc.show(page.vSubmit)
    // If error, display error on confirmation modal.
    if (!app().checkResponse(res)) {
      page.vErr.textContent = res.msg
      Doc.show(page.vErr)
      return
    }
    // Hide confirmation modal only on success.
    Doc.hide(page.forms)
    this.refreshActiveOrders()
  }

  /*
   * createWallet is attached to successful submission of the wallet creation
   * form. createWallet is only called once the form is submitted and a success
   * response is received from the client.
   */
  async createWallet () {
    const user = await app().fetchUser()
    if (!user) return
    const asset = user.assets[this.currentCreate.id]
    Doc.hide(this.page.forms)
    const mkt = this.market
    if (mkt.baseCfg.id === asset.id) mkt.base = asset
    else if (mkt.quoteCfg.id === asset.id) mkt.quote = asset
    this.displayMessageIfMissingWallet()
    this.resolveOrderVsMMForm()
  }

  rateFieldBuyInputHandler () {
    const page = this.page

    const rateFieldValue = this.page.rateFieldBuy.value?.trim()

    // allow a '.' (or ',') that's typical for decimals - just wait for the next input
    if ((rateFieldValue && rateFieldValue.length > 0) &&
        ((rateFieldValue.charAt(rateFieldValue.length - 1) === '.' &&
        rateFieldValue.indexOf('.') === rateFieldValue.length - 1) ||
        ((rateFieldValue.charAt(rateFieldValue.length - 1) === '.' &&
        rateFieldValue.indexOf(',') === rateFieldValue.length - 1)))) {
      return
    }

    const [inputValid, adjusted, adjRateAtom] = this.parseRateInput(rateFieldValue)
    if (!inputValid || adjusted) {
      // Let the user know that rate he's entered is invalid or was rounded down.
      this.animateErrors(highlightOutlineRed(page.rateFieldBuy), highlightBackgroundRed(page.rateStepBoxBuy))
    }
    if (!inputValid) {
      this.chosenRateBuyAtom = 0 // reset chosen value, but don't interfere with user input field
      this.setPageElementEnabled(this.page.qtyBoxBuy, false)
      this.setPageElementEnabled(this.page.qtySliderBuy, false)
      this.previewTotalBuy(this.chosenRateBuyAtom, this.chosenQtyBuyAtom)
      this.setOrderBttnBuyEnabled(false, 'choose your price')
      return
    }
    if (adjusted) {
      const adjRate = adjRateAtom / this.market.rateConversionFactor
      page.rateFieldBuy.value = String(adjRate)
    }

    this.chosenRateBuyAtom = adjRateAtom

    this.setPageElementEnabled(this.page.qtyBoxBuy, true)
    this.setPageElementEnabled(this.page.qtySliderBuy, true)

    // recalculate maxbuy value because it does change with every rate change
    this.finalizeTotalBuy()
  }

  rateFieldSellInputHandler () {
    const page = this.page

    const rateFieldValue = this.page.rateFieldSell.value?.trim()

    // allow a '.' (or ',') that's typical for decimals - just wait for the next input
    if ((rateFieldValue && rateFieldValue.length > 0) &&
        ((rateFieldValue.charAt(rateFieldValue.length - 1) === '.' &&
          rateFieldValue.indexOf('.') === rateFieldValue.length - 1) ||
        ((rateFieldValue.charAt(rateFieldValue.length - 1) === '.' &&
          rateFieldValue.indexOf(',') === rateFieldValue.length - 1)))) {
      return
    }

    const [inputValid, adjusted, adjRateAtom] = this.parseRateInput(rateFieldValue)
    if (!inputValid || adjusted) {
      // Let the user know that rate he's entered is invalid or was rounded down.
      this.animateErrors(highlightOutlineRed(page.rateFieldSell), highlightBackgroundRed(page.rateStepBoxSell))
    }
    if (!inputValid) {
      this.chosenRateSellAtom = 0 // reset chosen value, but don't interfere with user input field
      this.setPageElementEnabled(this.page.qtyBoxSell, false)
      this.setPageElementEnabled(this.page.qtySliderSell, false)
      this.previewTotalSell(this.chosenRateSellAtom, this.chosenQtySellAtom)
      this.setOrderBttnSellEnabled(false, 'choose your price')
      return
    }
    if (adjusted) {
      const adjRate = adjRateAtom / this.market.rateConversionFactor
      page.rateFieldSell.value = String(adjRate)
    }

    this.chosenRateSellAtom = adjRateAtom

    this.setPageElementEnabled(this.page.qtyBoxSell, true)
    this.setPageElementEnabled(this.page.qtySliderSell, true)

    // unlike with buy orders there is no need to recalculate maxsell value
    // because it doesn't change with the rate/price change.
    this.finalizeTotalSell()
  }

  /**
   * parseRateInput parses rate(price) string (in conventional units) and returns:
   * 1) whether there are any parsing issues (true if none, false when
   *    parsing fails)
   * 2) whether rounding(adjustment) to rate-step had happened (true when did)
   * 3) adjusted rate(price) value in atoms
   */
  parseRateInput (value: string | undefined): [boolean, boolean, number] {
    const page = this.page

    Doc.hide(page.orderErrBuy) // not the best place to do it, but what is?
    Doc.hide(page.orderErrSell) // not the best place to do it, but what is?

    const rateRaw = this.parseNumber(value)
    if (rateRaw === null || isNaN(rateRaw) || rateRaw <= 0) {
      return [false, false, 0]
    }
    const rateRawAtom = convertNumberToAtoms(rateRaw, this.market.rateConversionFactor)

    const adjRateAtom = this.adjustRateAtoms(rateRawAtom)
    const rounded = adjRateAtom !== rateRawAtom

    return [true, rounded, adjRateAtom]
  }

  parseNumber (value: string | undefined): number | null {
    if (!value) {
      return null
    }

    value = value.replace(',', '.') // comma is a typical alternative to dot, allow for it

    // check value doesn't contain invalid characters
    const validPattern = /^-?\d+\.?\d*$/
    if (!value.match(validPattern)) {
      return null
    }

    return parseFloat(value)
  }

  lotToQty (lots: number): number {
    return lots * this.market.cfg.lotsize / this.market.baseUnitInfo.conventional.conversionFactor
  }

  /*
  * adjustRateAtoms rounds down rateAtom to a multiple of rateStep.
  */
  adjustRateAtoms (rateAtom: number): number {
    const rateStepAtom = this.market.cfg.ratestep
    return rateAtom - (rateAtom % rateStepAtom)
  }

  qtyFieldBuyInputHandler () {
    const page = this.page
    const qtyConv = this.market.baseUnitInfo.conventional.conversionFactor

    const qtyFieldValue = page.qtyFieldBuy.value?.trim()

    // allow a '.' (or ',') that's typical for decimals - just wait for the next input
    if ((qtyFieldValue && qtyFieldValue.length > 0) &&
        ((qtyFieldValue.charAt(qtyFieldValue.length - 1) === '.' &&
          qtyFieldValue.indexOf('.') === qtyFieldValue.length - 1) ||
        ((qtyFieldValue.charAt(qtyFieldValue.length - 1) === '.' &&
          qtyFieldValue.indexOf(',') === qtyFieldValue.length - 1)))) {
      return
    }

    const [inputValid, adjusted, adjLots, adjQty] = this.parseQtyInput(qtyFieldValue)
    if (!inputValid || adjusted) {
      // Let the user know that quantity he's entered was rounded down.
      this.animateErrors(highlightOutlineRed(page.qtyFieldBuy), highlightBackgroundRed(page.lotSizeBoxBuy))
    }
    if (!inputValid) {
      this.chosenQtyBuyAtom = 0 // reset chosen value, but don't interfere with user input field
      this.previewTotalBuy(this.chosenRateBuyAtom, this.chosenQtyBuyAtom)
      this.setOrderBttnBuyEnabled(false, 'choose your quantity')
      return
    }
    if (adjusted) {
      page.qtyFieldBuy.value = String(adjQty)
    }

    this.chosenQtyBuyAtom = convertNumberToAtoms(adjQty, qtyConv)

    // Update slider accordingly, assume max buy has already been fetched and rate has
    // already been validated and adjusted (don't let user touch lot/qty/slider fields otherwise),
    // still handle absent maxBuy case gracefully.
    const maxBuy = this.market.maxBuys[this.chosenRateBuyAtom]
    if (maxBuy) {
      const sliderValue = Math.min(1, adjLots / maxBuy.swap.lots)
      page.qtySliderBuyInput.value = String(sliderValue)
    }

    this.finalizeTotalBuy()
  }

  qtyFieldSellInputHandler () {
    const page = this.page
    const qtyConv = this.market.baseUnitInfo.conventional.conversionFactor

    const qtyFieldValue = page.qtyFieldSell.value?.trim()

    // allow a '.' (or ',') that's typical for decimals - just wait for the next input
    if ((qtyFieldValue && qtyFieldValue.length > 0) &&
        ((qtyFieldValue.charAt(qtyFieldValue.length - 1) === '.' &&
          qtyFieldValue.indexOf('.') === qtyFieldValue.length - 1) ||
        ((qtyFieldValue.charAt(qtyFieldValue.length - 1) === '.' &&
          qtyFieldValue.indexOf(',') === qtyFieldValue.length - 1)))) {
      return
    }

    const [inputValid, adjusted, adjLots, adjQty] = this.parseQtyInput(qtyFieldValue)
    if (!inputValid || adjusted) {
      // Let the user know that quantity he's entered was rounded down.
      this.animateErrors(highlightOutlineRed(page.qtyFieldSell), highlightBackgroundRed(page.lotSizeBoxSell))
    }
    if (!inputValid) {
      this.chosenQtySellAtom = 0 // reset chosen value, but don't interfere with user input field
      this.setPageElementEnabled(this.page.previewTotalSell, false)
      this.setOrderBttnSellEnabled(false, 'choose your quantity')
      return
    }
    if (adjusted) {
      page.qtyFieldSell.value = String(adjQty)
    }

    this.chosenQtySellAtom = convertNumberToAtoms(adjQty, qtyConv)

    // Update slider accordingly, assume max sell has already been fetched (don't
    // let user touch lot/qty/slider fields otherwise), still handle absent maxSell
    // case gracefully.
    const maxSell = this.market.maxSell
    if (maxSell) {
      const sliderValue = Math.min(1, adjLots / maxSell.swap.lots)
      page.qtySliderSellInput.value = String(sliderValue)
    }

    this.finalizeTotalSell()
  }

  /**
   * parseQtyInput parses quantity input and returns:
   * 1) whether there are any parsing issues (true if none, false when
   *    parsing fails)
   * 2) whether rounding(adjustment) had happened (true when did)
   * 3) adjusted lot value
   * 4) adjusted quantity value
   *
   * If quantity value couldn't be parsed (parsing issues), the following
   * values are returned: [false, false, 0, 0].
   */
  parseQtyInput (value: string | undefined): [boolean, boolean, number, number] {
    const { page, market: { baseUnitInfo: bui, cfg: { lotsize: lotSizeAtom } } } = this

    Doc.hide(page.orderErrBuy) // not the best place to do it, but what is?
    Doc.hide(page.orderErrSell) // not the best place to do it, but what is?

    const qtyRaw = this.parseNumber(value)
    if (qtyRaw === null || isNaN(qtyRaw) || qtyRaw <= 0) {
      return [false, false, 0, 0]
    }
    const qtyRawAtom = convertNumberToAtoms(qtyRaw, bui.conventional.conversionFactor)

    const lotsRaw = qtyRawAtom / lotSizeAtom
    const adjLots = Math.floor(lotsRaw)
    const adjQtyAtom = adjLots * lotSizeAtom
    const rounded = adjQtyAtom !== qtyRawAtom
    const adjQty = adjQtyAtom / bui.conventional.conversionFactor

    return [true, rounded, adjLots, adjQty]
  }

  /* loadTable reloads the table from the current order book information. */
  loadTable () {
    this.loadTableSide(true)
    this.loadTableSide(false)
  }

  /* binOrdersByRateAndEpoch takes a list of sorted orders and returns the
     same orders grouped into arrays. The orders are grouped by their rate
     and whether or not they are epoch queue orders. Epoch queue orders
     will come after non epoch queue orders with the same rate. */
  binOrdersByRateAndEpoch (orders: MiniOrder[]): MiniOrder[][] {
    if (!orders || !orders.length) return []
    const bins = []
    let currEpochBin = []
    let currNonEpochBin = []
    let currRate = orders[0].msgRate
    if (orders[0].epoch) currEpochBin.push(orders[0])
    else currNonEpochBin.push(orders[0])
    for (let i = 1; i < orders.length; i++) {
      if (orders[i].msgRate !== currRate) {
        bins.push(currNonEpochBin)
        bins.push(currEpochBin)
        currEpochBin = []
        currNonEpochBin = []
        currRate = orders[i].msgRate
      }
      if (orders[i].epoch) currEpochBin.push(orders[i])
      else currNonEpochBin.push(orders[i])
    }
    bins.push(currNonEpochBin)
    bins.push(currEpochBin)
    return bins.filter(bin => bin.length > 0)
  }

  /* loadTables loads the order book side into its table. */
  loadTableSide (sell: boolean) {
    const bookSide = sell ? this.book.sells : this.book.buys
    const tbody = sell ? this.page.sellRows : this.page.buyRows
    Doc.empty(tbody)
    if (!bookSide || !bookSide.length) return
    let orderBins = this.binOrdersByRateAndEpoch(bookSide)
    // trim order bins list to fit only 14 of them on the screen per book-side (otherwise
    // we'd need to scroll the UI which is undesirable)
    orderBins = orderBins.slice(0, orderBookSideMaxCapacity)
    orderBins.forEach(bin => { tbody.appendChild(this.orderTableRow(bin)) })
  }

  /* addTableOrder adds a single order to the appropriate table. */
  addTableOrder (order: MiniOrder) {
    const tbody = order.sell ? this.page.sellRows : this.page.buyRows
    let row = tbody.firstChild as OrderRow
    // Handle market order differently.
    if (order.rate === 0) {
      if (order.qtyAtomic === 0) return // a cancel order. TODO: maybe make an indicator on the target order, maybe gray out
      // This is a market order.
      if (row && row.manager.getRate() === 0) {
        row.manager.insertOrder(order)
      } else {
        row = this.orderTableRow([order])
        // make sure we don't exceed book-side max capacity
        if (tbody.childElementCount >= orderBookSideMaxCapacity) {
          tbody.lastChild?.remove()
        }
        tbody.insertBefore(row, tbody.firstChild)
      }
      return
    }
    // Must be a limit order. Sort by rate. Skip the market order row.
    if (row && row.manager.getRate() === 0) row = row.nextSibling as OrderRow
    while (row) {
      if (row.manager.compare(order) === 0) {
        row.manager.insertOrder(order)
        return
      } else if (row.manager.compare(order) > 0) {
        const tr = this.orderTableRow([order])
        // make sure we don't exceed book-side max capacity
        if (tbody.childElementCount >= orderBookSideMaxCapacity) {
          tbody.lastChild?.remove()
        }
        tbody.insertBefore(tr, row)
        return
      }
      row = row.nextSibling as OrderRow
    }
    const tr = this.orderTableRow([order])
    // make sure we don't exceed book-side max capacity
    if (tbody.childElementCount >= orderBookSideMaxCapacity) {
      tbody.lastChild?.remove()
    }
    tbody.appendChild(tr)
  }

  /* removeTableOrder removes a single order from its table. */
  removeTableOrder (order: MiniOrder) {
    for (const tbody of [this.page.sellRows, this.page.buyRows]) {
      for (const tr of (Array.from(tbody.children) as OrderRow[])) {
        if (tr.manager.removeOrder(order.id)) {
          return
        }
      }
    }
  }

  /* updateTableOrder looks for the order in the table and updates the qty */
  updateTableOrder (u: RemainderUpdate) {
    for (const tbody of [this.page.sellRows, this.page.buyRows]) {
      for (const tr of (Array.from(tbody.children) as OrderRow[])) {
        if (tr.manager.updateOrderQty(u)) {
          return
        }
      }
    }
  }

  /*
   * clearOrderTableEpochs removes immediate-tif orders whose epoch has expired.
   */
  clearOrderTableEpochs () {
    this.clearOrderTableEpochSide(this.page.sellRows)
    this.clearOrderTableEpochSide(this.page.buyRows)
  }

  /*
   * clearOrderTableEpochs removes immediate-tif orders whose epoch has expired
   * for a single side.
   */
  clearOrderTableEpochSide (tbody: HTMLElement) {
    for (const tr of (Array.from(tbody.children)) as OrderRow[]) {
      tr.manager.removeEpochOrders()
    }
  }

  /*
   * orderTableRow creates a new <tr> element to insert into an order table.
     Takes a bin of orders with the same rate, and displays the total quantity.
   */
  orderTableRow (orderBin: MiniOrder[]): OrderRow {
    const tr = this.page.orderRowTmpl.cloneNode(true) as OrderRow
    tr.manager = new OrderTableRowManager(tr, orderBin, this.market)
    return tr
  }

  /* handleConnNote handles the 'conn' notification.
   */
  async handleConnNote (note: ConnEventNote) {
    this.marketList.setConnectionStatus(note)
    if (note.connectionStatus === ConnectionStatus.Connected) {
      // Having been disconnected from a DEX server, anything may have changed,
      // or this may be the first opportunity to get the server's config, so
      // fetch it all before reloading the markets page.
      await app().fetchUser()
      await app().loadPage('markets')
    }
  }

  /*
   * filterMarkets sets the display of markets in the markets list based on the
   * value of the search input.
   */
  filterMarkets () {
    const filterTxt = this.page.marketSearchV1.value?.toLowerCase()
    const filter = filterTxt ? (mkt: MarketRow) => mkt.name.includes(filterTxt) : () => true
    this.marketList.setFilter(filter)
  }

  /* candleDurationSelected sets the candleDur and loads the candles. It will
  default to the oneHrBinKey if dur is not valid. */
  candleDurationSelected (dur: string) {
    if (!this.market?.dex?.candleDurs.includes(dur)) dur = oneHrBinKey
    this.candleDur = dur
    this.loadCandles()
    State.storeLocal(State.lastCandleDurationLK, dur)
  }

  /*
   * loadCandles loads the candles for the current candleDur. If a cache is already
   * active, the cache will be used without a loadcandles request.
   */
  loadCandles () {
    for (const bttn of Doc.kids(this.page.durBttnBox)) {
      if (bttn.textContent === this.candleDur) bttn.classList.add('selected')
      else bttn.classList.remove('selected')
    }
    const { candleCaches, cfg, baseUnitInfo, quoteUnitInfo } = this.market
    const cache = candleCaches[this.candleDur]
    if (cache) {
      this.candleChart.setCandles(cache, cfg, baseUnitInfo, quoteUnitInfo)
      return
    }
    this.requestCandles()
  }

  /* requestCandles sends the loadcandles request. It accepts an optional candle
   * duration which will be requested if it is provided.
   */
  requestCandles (candleDur?: string) {
    this.candlesLoading = {
      loaded: () => { /* pass */ },
      timer: window.setTimeout(() => {
        if (this.candlesLoading) {
          this.candlesLoading = null
          console.error('candles not received')
        }
      }, 10000)
    }
    const { dex, baseCfg, quoteCfg } = this.market
    ws.request('loadcandles', { host: dex.host, base: baseCfg.id, quote: quoteCfg.id, dur: candleDur || this.candleDur })
  }

  /*
   * unload is called by the Application when the user navigates away from
   * the /markets page.
   */
  unload () {
    ws.request(unmarketRoute, {})
    ws.deregisterRoute(bookRoute)
    ws.deregisterRoute(bookOrderRoute)
    ws.deregisterRoute(unbookOrderRoute)
    ws.deregisterRoute(updateRemainingRoute)
    ws.deregisterRoute(epochOrderRoute)
    ws.deregisterRoute(candlesRoute)
    ws.deregisterRoute(candleUpdateRoute)
    this.candleChart.unattach()
    Doc.unbind(document, 'keyup', this.keyup)
    clearInterval(this.secondTicker)
  }

  animateErrors (...animations: (() => Animation)[]) {
    for (const ani of this.runningErrAnimations) {
      // Note, animation might still continue executing in background for 1 tick,
      // that shouldn't result in any issues for us though.
      ani.stop()
    }

    this.runningErrAnimations = []
    for (const ani of animations) {
      this.runningErrAnimations.push(ani())
    }
  }
}

/*
 *  MarketList represents the list of exchanges and markets on the left side of
 * markets view. The MarketList provides utilities for adjusting the visibility
 * and sort order of markets.
 */
class MarketList {
  // xcSections: ExchangeSection[]
  div: PageElement
  rowTmpl: PageElement
  markets: MarketRow[]
  selected: MarketRow

  constructor (div: HTMLElement) {
    this.div = div
    this.rowTmpl = Doc.idel(div, 'marketTmplV1')
    Doc.cleanTemplates(this.rowTmpl)
    this.reloadMarketsPane()
  }

  reloadMarketsPane (): void {
    Doc.empty(this.div)
    this.markets = []

    const addMarket = (mkt: ExchangeMarket) => {
      const row = new MarketRow(this.rowTmpl, mkt)
      this.div.appendChild(row.node)
      return row
    }

    for (const mkt of sortedMarkets()) this.markets.push(addMarket(mkt))
    app().bindTooltips(this.div)
  }

  find (host: string, baseID: number, quoteID: number): MarketRow | null {
    for (const row of this.markets) {
      if (row.mkt.xc.host === host && row.mkt.baseid === baseID && row.mkt.quoteid === quoteID) return row
    }
    return null
  }

  /* exists will be true if the specified market exists. */
  exists (host: string, baseID: number, quoteID: number): boolean {
    return this.find(host, baseID, quoteID) !== null
  }

  /* first gets the first market from the first exchange, alphabetically. */
  first (): MarketRow {
    return this.markets[0]
  }

  /* select sets the specified market as selected. */
  select (host: string, baseID: number, quoteID: number) {
    const row = this.find(host, baseID, quoteID)
    if (!row) return console.error(`select: no market row for ${host}, ${baseID}-${quoteID}`)
    for (const mkt of this.markets) mkt.node.classList.remove('selected')
    this.selected = row
    this.selected.node.classList.add('selected')
  }

  /* setConnectionStatus sets the visibility of the disconnected icon based
   * on the core.ConnEventNote.
   */
  setConnectionStatus (note: ConnEventNote) {
    for (const row of this.markets) {
      if (row.mkt.xc.host !== note.host) continue
      if (note.connectionStatus === ConnectionStatus.Connected) Doc.hide(row.tmpl.disconnectedIco)
      else Doc.show(row.tmpl.disconnectedIco)
    }
  }

  /*
   * setFilter sets the visibility of market rows based on the provided filter.
   */
  setFilter (filter: (mkt: MarketRow) => boolean) {
    for (const row of this.markets) {
      if (filter(row)) Doc.show(row.node)
      else Doc.hide(row.node)
    }
  }
}

/*
 * MarketRow represents one row in the MarketList. A MarketRow is a subsection
 * of the ExchangeSection.
 */
class MarketRow {
  node: HTMLElement
  mkt: ExchangeMarket
  name: string
  baseID: number
  quoteID: number
  lotSize: number
  tmpl: Record<string, PageElement>

  constructor (template: HTMLElement, mkt: ExchangeMarket) {
    this.mkt = mkt
    this.name = mkt.name
    this.baseID = mkt.baseid
    this.quoteID = mkt.quoteid
    this.lotSize = mkt.lotsize
    this.node = template.cloneNode(true) as HTMLElement
    const tmpl = this.tmpl = Doc.parseTemplate(this.node)
    tmpl.baseIcon.src = Doc.logoPath(mkt.basesymbol)
    tmpl.quoteIcon.src = Doc.logoPath(mkt.quotesymbol)
    tmpl.baseSymbol.appendChild(Doc.symbolize(mkt.xc.assets[mkt.baseid], true))
    tmpl.quoteSymbol.appendChild(Doc.symbolize(mkt.xc.assets[mkt.quoteid], true))
    if (this.mkt.xc.connectionStatus !== ConnectionStatus.Connected) Doc.show(tmpl.disconnectedIco)
  }
}

/* makeMarket creates a market object that specifies basic market details. */
function makeMarket (host: string, base?: number, quote?: number) {
  return {
    host: host,
    base: base,
    quote: quote
  }
}

/* marketID creates a DEX-compatible market name from the ticker symbols. */
export function marketID (b: string, q: string) { return `${b}_${q}` }

/* convertNumberToAtoms converts the float string to atoms. */
function convertNumberToAtoms (v: number, conversionFactor: number) {
  return Math.round(v * conversionFactor)
}

/*
 * wireOrder prepares a copy of the order with the options field converted to a
 * string -> string map.
 */
function wireOrder (order: TradeForm) {
  const stringyOptions: Record<string, string> = {}
  for (const [k, v] of Object.entries(order.options)) stringyOptions[k] = JSON.stringify(v)
  return Object.assign({}, order, { options: stringyOptions })
}

// OrderTableRowManager manages the data within a row in an order table. Each row
// represents all the orders in the order book with the same rate, but orders that
// are booked or still in the epoch queue are displayed in separate rows.
class OrderTableRowManager {
  tableRow: HTMLElement
  page: Record<string, PageElement>
  market: CurrentMarket
  orderBin: MiniOrder[]
  sell: boolean
  msgRate: number
  epoch: boolean
  baseUnitInfo: UnitInfo

  constructor (tableRow: HTMLElement, orderBin: MiniOrder[], market: CurrentMarket) {
    const { baseUnitInfo, quoteUnitInfo, cfg: { ratestep: rateStepAtom } } = market

    this.tableRow = tableRow
    const page = this.page = Doc.parseTemplate(tableRow)
    this.market = market
    this.orderBin = orderBin
    this.sell = orderBin[0].sell
    this.msgRate = orderBin[0].msgRate
    this.epoch = !!orderBin[0].epoch
    this.baseUnitInfo = baseUnitInfo
    const rateText = Doc.formatRateAtomFullPrecision(this.msgRate, baseUnitInfo, quoteUnitInfo, rateStepAtom)
    Doc.setVis(this.isEpoch(), this.page.epoch)

    if (this.msgRate === 0) {
      page.rate.innerText = 'market'
    } else {
      const cssClass = this.isSell() ? 'sellcolor' : 'buycolor'
      page.rate.innerText = rateText
      page.rate.classList.add(cssClass)
    }
    this.redrawOrderRowEl()
  }

  // updateQtyNumOrdersEl populates the quantity element in the row, displays the
  // number of orders if there is more than one order in the order bin, and also
  // displays "own marker" if the row contains order(s) that belong to the user.
  redrawOrderRowEl () {
    const { page, market, orderBin } = this
    const qty = orderBin.reduce((total, curr) => total + curr.qtyAtomic, 0)
    const numOrders = orderBin.length
    page.qty.innerText = Doc.formatFullPrecision(qty, this.baseUnitInfo)
    if (numOrders > 1) {
      page.numOrders.removeAttribute('hidden')
      page.numOrders.innerText = String(numOrders)
      page.numOrders.title = `quantity is comprised of ${numOrders} orders`
    } else {
      page.numOrders.setAttribute('hidden', 'true')
    }

    // to see if we need to add "own marker" to this row we check against current active
    // orders user has. We receive user orders(updates) through "user notifications feed",
    // while here we are re-drawing order-book table rows as the result of processing
    // "order book feed" events (so, we consume 2 different WS feeds in JS app). Because
    // there is no way to synchronize between events from these 2 feeds the best we can
    // do here is to try and update order book-table rows in delayed manner via issuing
    // 2 setTimeout calls (executing 100ms and 2s into the future), this will provide some
    // time buffer for order notification to get delivered via "user notifications feed"
    // and update corresponding active user orders in JS app. We issue 2 setTimeout calls
    // because the 1st one (having short delay) targets the most likely scenario of active
    // user orders being up-to-date while the 2nd one is just here for the worst case
    // scenario to make sure that we do eventually mark/unmark this row as needed (even
    // in delayed manner, it's still better to resolve it's state properly).
    // Note, because we brute-force all the orders in this row against all active user
    // orders (the freshest version we have) there is no possible issues we can encounter
    // caused by races that might/will happen between different setTimeout calls since
    // every call executes as atomic unit with respect to other similar calls.
    const markUnmarkOwnOrders = () => {
      const userOrders = app().orders(market.dex.host, marketID(market.baseCfg.symbol, market.quoteCfg.symbol))
      let ownOrderSpotted = false
      for (const bin of orderBin) {
        for (const userOrder of userOrders) {
          if (userOrder.id === bin.id) {
            ownOrderSpotted = true
            break
          }
        }
        if (ownOrderSpotted) {
          break
        }
      }
      if (ownOrderSpotted) {
        Doc.show(this.page.ownBookOrder)
      } else {
        // remove "own marker" in case we no longer have user orders in this row
        Doc.hide(this.page.ownBookOrder)
      }
    }
    setTimeout(markUnmarkOwnOrders, 100) // 100ms delay
    setTimeout(markUnmarkOwnOrders, 2000) // 2s delay
  }

  // insertOrder adds an order to the order bin and updates the row elements
  // accordingly.
  insertOrder (order: MiniOrder) {
    this.orderBin.push(order)
    this.redrawOrderRowEl()
  }

  // updateOrderQuantity updates the quantity of the order identified by a token,
  // if it exists in the row, and updates the row elements accordingly. The function
  // returns true if the order is in the bin, and false otherwise.
  updateOrderQty (update: RemainderUpdate) {
    const { id, qty, qtyAtomic } = update
    for (let i = 0; i < this.orderBin.length; i++) {
      if (this.orderBin[i].id === id) {
        this.orderBin[i].qty = qty
        this.orderBin[i].qtyAtomic = qtyAtomic
        this.redrawOrderRowEl()
        return true
      }
    }
    return false
  }

  // removeOrder removes the order identified by id, if it exists in the row,
  // and updates the row elements accordingly. If the order bin is empty, the row is
  // removed from the screen. The function returns true if an order was removed, and
  // false otherwise.
  removeOrder (id: string) {
    const index = this.orderBin.findIndex(order => order.id === id)
    if (index < 0) return false
    this.orderBin.splice(index, 1)
    if (!this.orderBin.length) this.tableRow.remove()
    else this.redrawOrderRowEl()
    return true
  }

  // removeEpochOrders removes all the orders from the row that are not in the
  // new epoch's epoch queue and updates the elements accordingly.
  removeEpochOrders (newEpoch?: number) {
    this.orderBin = this.orderBin.filter((order) => {
      return !(order.epoch && order.epoch !== newEpoch)
    })
    if (!this.orderBin.length) this.tableRow.remove()
    else this.redrawOrderRowEl()
  }

  // getRate returns the rate of the orders in the row.
  getRate () {
    return this.msgRate
  }

  // isEpoch returns whether the orders in this row are in the epoch queue.
  isEpoch () {
    return this.epoch
  }

  // isSell returns whether the orders in this row are sell orders.
  isSell () {
    return this.sell
  }

  // compare takes an order and returns 0 if the order belongs in this row,
  // 1 if the order should go after this row in the table, and -1 if it should
  // be before this row in the table. Sell orders are displayed in ascending order,
  // buy orders are displayed in descending order, and epoch orders always come
  // after booked orders.
  compare (order: MiniOrder) {
    if (this.getRate() === order.msgRate && this.isEpoch() === !!order.epoch) {
      return 0
    } else if (this.getRate() !== order.msgRate) {
      return (this.getRate() > order.msgRate) === order.sell ? 1 : -1
    } else {
      return this.isEpoch() ? 1 : -1
    }
  }
}

interface ExchangeMarket extends Market {
  xc: Exchange
  baseName: string
  bui: UnitInfo
}

function sortedMarkets (): ExchangeMarket[] {
  const mkts: ExchangeMarket[] = []
  const assets = app().assets
  const convertMarkets = (xc: Exchange, mkts: Market[]) => {
    return mkts.map((mkt: Market) => {
      const a = assets[mkt.baseid]
      const baseName = a ? a.name : mkt.basesymbol
      const bui = app().unitInfo(mkt.baseid, xc)
      return Object.assign({ xc, baseName, bui }, mkt)
    })
  }
  for (const xc of Object.values(app().exchanges)) mkts.push(...convertMarkets(xc, Object.values(xc.markets || {})))
  mkts.sort((a: ExchangeMarket, b: ExchangeMarket): number => {
    if (!a.spot) {
      if (b.spot) return 1 // put b first, since we have the spot
      // no spots. compare market name then host name
      if (a.name === b.name) return a.xc.host.localeCompare(b.xc.host)
      return a.name.localeCompare(b.name)
    } else if (!b.spot) return -1 // put a first, since we have the spot
    const [aLots, bLots] = [a.spot.vol24 / a.lotsize, b.spot.vol24 / b.lotsize]
    return bLots - aLots // whoever has more volume by lot count
  })
  return mkts
}

/**
 * highlightBackgroundRed returns Animation-factory that will construct Animation that will
 * change element background color to red and back in a smooth transition.
 * Note: Animation will start when constructed by "new" ^ right away - that's why
 * we return constructor-func here (aka factory), instead of constructing Animation
 * right away.
 */
function highlightBackgroundRed (element: PageElement): () => Animation {
  const [r, g, b, a] = State.isDark() ? [203, 94, 94, 0.8] : [153, 48, 43, 0.6]
  return (): Animation => {
    return new Animation(animationLength, (progress: number) => {
      element.style.backgroundColor = `rgba(${r}, ${g}, ${b}, ${a - a * progress})`
    },
    'easeIn',
    () => {
      // Setting background color to 'none' SOMETIMES results in a no-op for some reason, wat.
      // Hence, setting to 'transparent' instead.
      element.style.backgroundColor = 'transparent'
    })
  }
}

/**
 * highlightOutlineRed returns Animation-factory that will construct Animation that will
 * change element outline color to red and back in a smooth transition.
 * Note: Animation will start when constructed by "new" ^ right away - that's why
 * we return constructor-func here (aka factory), instead of constructing Animation
 * right away.
 */
function highlightOutlineRed (element: PageElement): () => Animation {
  const [r, g, b, a] = State.isDark() ? [203, 94, 94, 0.8] : [153, 48, 43, 0.8]
  return (): Animation => {
    element.style.outline = '2px solid'
    return new Animation(animationLength, (progress: number) => {
      element.style.outlineColor = `rgba(${r}, ${g}, ${b}, ${a - a * progress})`
    },
    'easeIn',
    () => {
      element.style.outlineColor = 'transparent'
    })
  }
}
