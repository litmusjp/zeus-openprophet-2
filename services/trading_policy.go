package services

import (
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"time"

	"prophet-trader/interfaces"
)

// TradingPolicy is the server-owned execution policy applied at the final
// broker boundary. Zero-valued risk caps are interpreted according to their
// individual semantics: maxOrderValue==0 is uncapped, while the other opening
// caps must be explicitly positive.
type TradingPolicy struct {
	IsPaper              bool
	AllowLiveTrading     bool
	AllowPaperTrading    bool
	AllowOptions         bool
	AllowStocks          bool
	Allow0DTE            bool
	RequireConfirmation  bool
	MaxOrderValue        float64
	MaxPositionPct       float64
	MaxDeployedPct       float64
	MaxOpenPositions     int
	MaxDailyLoss         float64
	InvalidConfiguration bool
	// AllowedStructures gates NEW option exposure by structure (Phase C): a canonical, sorted, comma separated allow-list
	// (a string so the policy stays comparable). Empty means the default (single long legs only). It never blocks reads,
	// reconciliation or a valid grouped reducing close.
	AllowedStructures string
}

// OptionGroupRisk is the risk view of one open multi-leg group: its exact leg symbols, the units still open and the
// maximum loss that is counted against the position, deployed and open-position limits (a debit vertical's maximum
// loss is its net debit x units x 100).
type OptionGroupRisk struct {
	ID          string
	LegSymbols  []string
	OpenUnits   float64
	MaxLoss     float64
	Broken      bool
	Closing     bool
	StructureID string
}

type BrokerRiskSnapshot struct {
	Account       *interfaces.Account
	Positions     []*interfaces.Position
	PendingOrders []*interfaces.Order
	// Groups are the open multi-leg groups of this sandbox, read from the durable group ledger. A leg that belongs to an
	// open group is counted once, through its group, and cannot be closed by a single-leg order.
	Groups []OptionGroupRisk
	// Lock is the persisted per-session daily-loss lock; LockErr is set when it could not be read.
	Lock    *interfaces.DailyLossLockStatus
	LockErr error
}

// IsRiskRelevantLocalOrder excludes application records that never crossed
// the broker submission boundary from the broker risk snapshot.
func IsRiskRelevantLocalOrder(order *interfaces.Order) bool {
	if order == nil {
		return false
	}
	status := strings.ToLower(strings.TrimSpace(order.Status))
	switch status {
	case "filled", "canceled", "cancelled", "rejected", "rejected_before_submission", "expired", "done_for_day", "replaced":
		return false
	}
	if status == "planned_for_next_session" && strings.TrimSpace(order.ID) == "" {
		if strings.EqualFold(strings.TrimSpace(order.Purpose), "entry") {
			return positivePrice(order.LimitPrice) || positivePrice(order.StopPrice)
		}
		return false
	}
	if status == "submit_failed" && !order.SubmissionAttempted && strings.TrimSpace(order.ID) == "" {
		return false
	}
	return strings.TrimSpace(order.ID) != "" || order.SubmissionAttempted
}

func positivePrice(price *float64) bool {
	return price != nil && *price > 0
}

func boolEnv(name string, fallback bool) bool {
	value, ok := os.LookupEnv(name)
	if !ok || strings.TrimSpace(value) == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	return err == nil && parsed
}

func floatEnv(name string, fallback float64) float64 {
	value, ok := os.LookupEnv(name)
	if !ok || strings.TrimSpace(value) == "" {
		return fallback
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed < 0 {
		return 0
	}
	return parsed
}

func intEnv(name string, fallback int) int {
	value, ok := os.LookupEnv(name)
	if !ok || strings.TrimSpace(value) == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 0 {
		return 0
	}
	return parsed
}

func strictBoolEnv(name string, fallback bool) (bool, bool) {
	value, ok := os.LookupEnv(name)
	if !ok || strings.TrimSpace(value) == "" {
		return fallback, true
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback, false
	}
	return parsed, true
}

func strictFloatEnv(name string, fallback float64) (float64, bool) {
	value, ok := os.LookupEnv(name)
	if !ok || strings.TrimSpace(value) == "" {
		return fallback, true
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed < 0 {
		return fallback, false
	}
	return parsed, true
}

func strictIntEnv(name string, fallback int) (int, bool) {
	value, ok := os.LookupEnv(name)
	if !ok || strings.TrimSpace(value) == "" {
		return fallback, true
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 0 {
		return fallback, false
	}
	return parsed, true
}

func TradingPolicyFromEnv(isPaper bool) *TradingPolicy {
	allowLive, liveOK := strictBoolEnv("OPENPROPHET_ALLOW_LIVE_TRADING", false)
	allowPaper, paperOK := strictBoolEnv("OPENPROPHET_ALLOW_PAPER_TRADING", true)
	allowOptions, optionsOK := strictBoolEnv("OPENPROPHET_ALLOW_OPTIONS", false)
	allowStocks, stocksOK := strictBoolEnv("OPENPROPHET_ALLOW_STOCKS", false)
	allow0DTE, dteOK := strictBoolEnv("OPENPROPHET_ALLOW_0DTE", false)
	requireConfirmation, confirmationOK := strictBoolEnv("OPENPROPHET_REQUIRE_CONFIRMATION", true)
	maxOrderValue, orderValueOK := strictFloatEnv("OPENPROPHET_MAX_ORDER_VALUE", 0)
	maxPositionPct, positionPctOK := strictFloatEnv("OPENPROPHET_MAX_POSITION_PCT", 0)
	maxDeployedPct, deployedPctOK := strictFloatEnv("OPENPROPHET_MAX_DEPLOYED_PCT", 0)
	maxOpenPositions, openPositionsOK := strictIntEnv("OPENPROPHET_MAX_OPEN_POSITIONS", 0)
	maxDailyLoss, dailyLossOK := strictFloatEnv("OPENPROPHET_MAX_DAILY_LOSS", 0)
	allowedStructures, structuresOK := canonicalAllowedStructures(os.Getenv("OPENPROPHET_ALLOWED_STRUCTURES"))
	return &TradingPolicy{
		AllowedStructures:    allowedStructures,
		IsPaper:              isPaper,
		AllowLiveTrading:     allowLive,
		AllowPaperTrading:    allowPaper,
		AllowOptions:         allowOptions,
		AllowStocks:          allowStocks,
		Allow0DTE:            allow0DTE,
		RequireConfirmation:  requireConfirmation,
		MaxOrderValue:        maxOrderValue,
		MaxPositionPct:       maxPositionPct,
		MaxDeployedPct:       maxDeployedPct,
		MaxOpenPositions:     maxOpenPositions,
		MaxDailyLoss:         maxDailyLoss,
		InvalidConfiguration: !(liveOK && paperOK && optionsOK && stocksOK && dteOK && confirmationOK && orderValueOK && positionPctOK && deployedPctOK && openPositionsOK && dailyLossOK && structuresOK),
	}
}

func (p TradingPolicy) validateCommon(orderSide, assetClass string, opening bool) error {
	if p.InvalidConfiguration {
		return fmt.Errorf("trading policy configuration is invalid; execution is blocked")
	}
	if !p.IsPaper {
		return fmt.Errorf("live trading is prohibited; only paper accounts may submit orders")
	}
	if !p.AllowPaperTrading {
		return fmt.Errorf("allowPaperTrading policy is disabled for paper trading")
	}
	if assetClass == "us_option" && !p.AllowOptions {
		return fmt.Errorf("options trading is disabled by broker policy")
	}
	if assetClass != "us_option" && !p.AllowStocks {
		return fmt.Errorf("stock trading is disabled by broker policy")
	}
	if p.RequireConfirmation {
		return fmt.Errorf("operator confirmation is required by broker policy")
	}
	if orderSide != "buy" && orderSide != "sell" {
		return fmt.Errorf("order side must be buy or sell")
	}
	if !opening {
		return nil
	}
	if p.MaxPositionPct <= 0 || p.MaxDeployedPct <= 0 || p.MaxOpenPositions <= 0 || p.MaxDailyLoss <= 0 {
		return fmt.Errorf("opening risk caps other than maxOrderValue must all be explicitly positive")
	}
	return nil
}

func priceForOrder(order *interfaces.Order) (float64, error) {
	if order == nil {
		return 0, fmt.Errorf("order is required")
	}
	if order.LimitPrice != nil {
		if !isPositiveFinite(*order.LimitPrice) {
			return 0, fmt.Errorf("order limit price must be positive and finite")
		}
		return *order.LimitPrice, nil
	}
	if order.StopPrice != nil {
		if !isPositiveFinite(*order.StopPrice) {
			return 0, fmt.Errorf("order stop price must be positive and finite")
		}
		return *order.StopPrice, nil
	}
	return 0, fmt.Errorf("a positive executable price is required to evaluate opening risk caps")
}

func optionPrice(order *interfaces.OptionsOrder) (float64, error) {
	if order == nil || order.LimitPrice == nil {
		return 0, fmt.Errorf("a positive executable options price is required to evaluate opening risk caps")
	}
	if !isPositiveFinite(*order.LimitPrice) {
		return 0, fmt.Errorf("options limit price must be positive and finite")
	}
	return *order.LimitPrice, nil
}

func (p TradingPolicy) validateCaps(notional float64, opening bool, snapshot BrokerRiskSnapshot, symbol string) error {
	if !opening {
		return nil
	}
	if snapshot.LockErr != nil {
		return fmt.Errorf("daily loss lock state is unavailable; opening order blocked")
	}
	if snapshot.Lock != nil && snapshot.Lock.Enabled && !snapshot.Lock.ClockAvailable {
		return fmt.Errorf("broker session clock is unavailable; the daily loss session state cannot be verified; opening order blocked")
	}
	if snapshot.Lock != nil && snapshot.Lock.Locked {
		return fmt.Errorf("daily loss limit reached earlier this session (%.2f%%); new openings are blocked until the next session", snapshot.Lock.LossPct)
	}
	if !isPositiveFinite(notional) {
		return fmt.Errorf("order notional is unavailable or invalid")
	}
	if snapshot.Account == nil || !isPositiveFinite(snapshot.Account.PortfolioValue) {
		return fmt.Errorf("portfolio value is unavailable; opening order blocked")
	}
	if p.MaxOrderValue > 0 && notional > p.MaxOrderValue+1e-9 {
		return fmt.Errorf("max order value exceeded: %.2f > %.2f", notional, p.MaxOrderValue)
	}
	if p.MaxDailyLoss > 0 {
		if !snapshot.Account.DailyPnLValid || !isPositiveFinite(snapshot.Account.Equity) || !isPositiveFinite(snapshot.Account.LastEquity) {
			return fmt.Errorf("account daily P&L is unavailable or invalid; daily loss cap cannot be evaluated")
		}
		if snapshot.Account.DailyPnL < 0 {
			lossPct := -snapshot.Account.DailyPnLPercent
			if lossPct >= p.MaxDailyLoss {
				return fmt.Errorf("daily loss cap exceeded")
			}
		}
	}
	if p.MaxPositionPct > 0 && notional/snapshot.Account.PortfolioValue*100 > p.MaxPositionPct+1e-9 {
		return fmt.Errorf("max position percentage exceeded")
	}
	deployed := 0.0
	openPositions := 0
	knownSymbol := false
	for _, position := range snapshot.Positions {
		if position == nil || position.Qty == 0 {
			continue
		}
		if openGroupOwningSymbol(snapshot.Groups, position.Symbol) != "" {
			// A grouped leg is counted once, through its group (below), never as a position of its own.
			if strings.EqualFold(position.Symbol, symbol) {
				knownSymbol = true
			}
			continue
		}
		openPositions++
		deployed += math.Abs(position.MarketValue)
		if strings.EqualFold(position.Symbol, symbol) {
			knownSymbol = true
		}
	}
	for _, group := range snapshot.Groups {
		if group.OpenUnits <= 0 {
			continue
		}
		// One open position per group, with its maximum loss as the amount deployed.
		openPositions++
		deployed += group.MaxLoss
		for _, leg := range group.LegSymbols {
			if strings.EqualFold(leg, symbol) {
				knownSymbol = true
			}
		}
	}
	for _, pending := range snapshot.PendingOrders {
		if pending == nil || pending.Qty <= 0 || pending.Purpose == "close" || pending.Purpose == "protection" || strings.HasSuffix(strings.ToLower(pending.PositionIntent), "_to_close") {
			continue
		}
		pendingPrice, priceErr := priceForOrder(pending)
		if priceErr != nil {
			return fmt.Errorf("pending broker order %q has no bounded executable price", pending.ClientOrderID)
		}
		pendingNotional := pendingPrice * pending.Qty
		if IsOCCOptionSymbol(pending.Symbol) {
			pendingNotional *= 100
		}
		deployed += pendingNotional
		if strings.EqualFold(pending.Symbol, symbol) {
			knownSymbol = true
		} else {
			openPositions++
		}
	}
	if p.MaxDeployedPct > 0 && (deployed+notional)/snapshot.Account.PortfolioValue*100 > p.MaxDeployedPct+1e-9 {
		return fmt.Errorf("max deployed percentage exceeded")
	}
	if p.MaxOpenPositions > 0 && !knownSymbol && openPositions+1 > p.MaxOpenPositions {
		return fmt.Errorf("max open positions exceeded")
	}
	return nil
}

func (p TradingPolicy) hasMatchingExposure(symbol, side string, qty float64, positions []*interfaces.Position) bool {
	if qty <= 0 {
		return false
	}
	for _, position := range positions {
		if position == nil || !strings.EqualFold(strings.TrimSpace(position.Symbol), strings.TrimSpace(symbol)) {
			continue
		}
		positionQty := math.Abs(position.Qty)
		if positionQty+1e-9 < qty {
			continue
		}
		positionSide := strings.ToLower(strings.TrimSpace(position.Side))
		if side == "sell" && (positionSide == "long" || positionSide == "buy" || position.Qty > 0) {
			return true
		}
		if side == "buy" && (positionSide == "short" || positionSide == "sell" || position.Qty < 0) {
			return true
		}
	}
	return false
}

func validEquitySymbol(symbol string) bool {
	symbol = strings.TrimSpace(symbol)
	if symbol == "" || len(symbol) > 10 || IsOCCOptionSymbol(symbol) {
		return false
	}
	for _, r := range symbol {
		if !(r >= 'A' && r <= 'Z') && !(r >= 'a' && r <= 'z') && !(r >= '0' && r <= '9') && r != '.' && r != '-' {
			return false
		}
	}
	return true
}

func (p TradingPolicy) ValidateOrder(order *interfaces.Order, snapshot BrokerRiskSnapshot) (float64, error) {
	if order == nil {
		return 0, fmt.Errorf("order is required")
	}
	if IsOCCOptionSymbol(order.Symbol) {
		return 0, fmt.Errorf("OCC option symbol must use the options route")
	}
	if !validEquitySymbol(order.Symbol) {
		return 0, fmt.Errorf("equity symbol is invalid")
	}
	if order.AssetClass != "" && order.AssetClass != "us_equity" {
		return 0, fmt.Errorf("unsupported equity asset class %q", order.AssetClass)
	}
	if order.Qty <= 0 || math.IsNaN(order.Qty) || math.IsInf(order.Qty, 0) {
		return 0, fmt.Errorf("quantity must be positive and finite")
	}
	if order.Purpose != "entry" && order.Purpose != "close" && order.Purpose != "protection" {
		return 0, fmt.Errorf("order purpose must be one of entry, close, or protection")
	}
	reducing := order.Purpose == "close" || order.Purpose == "protection"
	if reducing && !p.hasMatchingExposure(order.Symbol, order.Side, order.Qty, snapshot.Positions) {
		return 0, fmt.Errorf("%s order is not backed by matching broker exposure", order.Purpose)
	}
	opening := !reducing
	if err := p.validateCommon(order.Side, "us_equity", opening); err != nil {
		return 0, err
	}
	if !opening {
		return 0, nil
	}
	price, err := priceForOrder(order)
	if err != nil {
		return 0, err
	}
	notional := price * order.Qty
	if err := p.validateCaps(notional, opening, snapshot, order.Symbol); err != nil {
		return 0, err
	}
	return notional, nil
}

func (p TradingPolicy) ValidateOptionsOrder(order *interfaces.OptionsOrder, snapshot BrokerRiskSnapshot) (float64, error) {
	if err := validateOptionsOrder(order); err != nil {
		return 0, err
	}
	if len(order.Legs) > 0 {
		return p.validateSpreadOptionsOrder(order, snapshot)
	}
	opening := strings.HasSuffix(order.PositionIntent, "_to_open")
	if !opening {
		if groupID := openGroupOwningSymbol(snapshot.Groups, order.Symbol); groupID != "" {
			return 0, fmt.Errorf("%s belongs to open spread group %s and cannot be closed by a single-leg order; close the spread as one order", order.Symbol, groupID)
		}
	}
	if !opening && !p.hasMatchingExposure(order.Symbol, order.Side, order.Qty, snapshot.Positions) {
		return 0, fmt.Errorf("options close order is not backed by matching broker exposure")
	}
	if err := p.validateCommon(order.Side, "us_option", opening); err != nil {
		return 0, err
	}
	if !opening {
		return 0, nil
	}
	if !p.Allow0DTE {
		_, expiry, _, _, ok := parseOCCOptionSymbol(order.Symbol)
		if ok && sameUTCDay(expiry, PolicyNow()) {
			return 0, fmt.Errorf("0DTE options are disabled by broker policy")
		}
	}
	price, err := optionPrice(order)
	if err != nil {
		return 0, err
	}
	notional := price * order.Qty * 100
	if err := p.validateCaps(notional, opening, snapshot, order.Symbol); err != nil {
		return 0, err
	}
	return notional, nil
}

// openGroupOwningSymbol returns the id of the open (not fully closed) group that still holds this leg, or "".
func openGroupOwningSymbol(groups []OptionGroupRisk, symbol string) string {
	for _, group := range groups {
		if group.OpenUnits <= 0 {
			continue
		}
		for _, leg := range group.LegSymbols {
			if strings.EqualFold(strings.TrimSpace(leg), strings.TrimSpace(symbol)) {
				return group.ID
			}
		}
	}
	return ""
}

// findGroupForLegs returns the open group whose attached legs are exactly this order's leg symbols.
func findGroupForLegs(groups []OptionGroupRisk, legs []interfaces.OptionLeg) *OptionGroupRisk {
	for i := range groups {
		group := &groups[i]
		if group.OpenUnits <= 0 || len(group.LegSymbols) != len(legs) {
			continue
		}
		matched := 0
		for _, leg := range legs {
			for _, symbol := range group.LegSymbols {
				if strings.EqualFold(strings.TrimSpace(symbol), strings.TrimSpace(leg.Symbol)) {
					matched++
					break
				}
			}
		}
		if matched == len(legs) {
			return group
		}
	}
	return nil
}

// validateSpreadOptionsOrder is the group-aware policy for an atomic two-leg vertical. The structure comes from the exact
// legs; the permission gates new exposure only; a close must be backed by the group's own open units and by broker
// exposure on every leg; the amount counted against the caps is the spread's maximum loss (net debit x units x 100).
func (p TradingPolicy) validateSpreadOptionsOrder(order *interfaces.OptionsOrder, snapshot BrokerRiskSnapshot) (float64, error) {
	structure, err := ClassifyOptionsStructure(order)
	if err != nil {
		return 0, err
	}
	opening, _ := legsDirection(order.Legs)
	if order.Type != "limit" {
		return 0, fmt.Errorf("spread orders must be limit orders")
	}
	kind := strings.TrimSpace(order.PriceKind)
	if kind == "" {
		if opening {
			kind = PriceKindDebit
		} else {
			kind = PriceKindCredit
		}
	}
	if opening && kind != PriceKindDebit {
		return 0, fmt.Errorf("a debit vertical opens for a net debit")
	}
	if !opening && kind != PriceKindCredit {
		return 0, fmt.Errorf("a debit vertical closes for a net credit")
	}
	if opening {
		if !p.allowsStructure(structure) {
			return 0, fmt.Errorf("structure %s is not allowed for this sandbox", structure)
		}
	} else {
		group := findGroupForLegs(snapshot.Groups, order.Legs)
		if group == nil {
			return 0, fmt.Errorf("spread close is not backed by an open spread group")
		}
		if group.Broken {
			return 0, fmt.Errorf("spread group %s is broken; its remaining legs are managed as single legs", group.ID)
		}
		if order.Qty > group.OpenUnits+1e-9 {
			return 0, fmt.Errorf("spread close of %.0f units exceeds the %.0f open units of group %s", order.Qty, group.OpenUnits, group.ID)
		}
		for _, leg := range order.Legs {
			if !p.hasMatchingExposure(leg.Symbol, leg.Side, order.Qty*float64(leg.RatioQty), snapshot.Positions) {
				return 0, fmt.Errorf("spread close leg %s is not backed by matching broker exposure", leg.Symbol)
			}
		}
	}
	if err := p.validateCommon(order.Side, "us_option", opening); err != nil {
		return 0, err
	}
	if !opening {
		return 0, nil
	}
	if !p.Allow0DTE {
		_, expiry, _, _, ok := parseOCCOptionSymbol(order.Symbol)
		if ok && sameUTCDay(expiry, PolicyNow()) {
			return 0, fmt.Errorf("0DTE options are disabled by broker policy")
		}
	}
	price, err := optionPrice(order)
	if err != nil {
		return 0, err
	}
	width, err := SpreadWidth(order.Legs)
	if err != nil {
		return 0, err
	}
	if price > width+1e-9 {
		return 0, fmt.Errorf("net debit %.2f exceeds the spread width %.2f", price, width)
	}
	maxLoss := price * order.Qty * 100
	if err := p.validateCaps(maxLoss, true, snapshot, order.Symbol); err != nil {
		return 0, err
	}
	return maxLoss, nil
}

// PolicyNow is the clock the 0DTE rule reads. Production leaves it on the real clock; tests that use
// fixed-date option contracts set it so a fixture expiry cannot become "today" and fail the suite on that date.
var PolicyNow = func() time.Time { return time.Now().UTC() }

func sameUTCDay(a, b time.Time) bool {
	y1, m1, d1 := a.UTC().Date()
	y2, m2, d2 := b.UTC().Date()
	return y1 == y2 && m1 == m2 && d1 == d2
}
