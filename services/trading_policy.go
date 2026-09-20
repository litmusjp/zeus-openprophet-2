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
// broker boundary. Zero-valued permissions fail closed for order submission.
type TradingPolicy struct {
	IsPaper              bool
	AllowLiveTrading     bool
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
}

type BrokerRiskSnapshot struct {
	Account       *interfaces.Account
	Positions     []*interfaces.Position
	PendingOrders []*interfaces.Order
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
	allowOptions, optionsOK := strictBoolEnv("OPENPROPHET_ALLOW_OPTIONS", false)
	allowStocks, stocksOK := strictBoolEnv("OPENPROPHET_ALLOW_STOCKS", false)
	allow0DTE, dteOK := strictBoolEnv("OPENPROPHET_ALLOW_0DTE", false)
	requireConfirmation, confirmationOK := strictBoolEnv("OPENPROPHET_REQUIRE_CONFIRMATION", true)
	maxOrderValue, orderValueOK := strictFloatEnv("OPENPROPHET_MAX_ORDER_VALUE", 0)
	maxPositionPct, positionPctOK := strictFloatEnv("OPENPROPHET_MAX_POSITION_PCT", 0)
	maxDeployedPct, deployedPctOK := strictFloatEnv("OPENPROPHET_MAX_DEPLOYED_PCT", 0)
	maxOpenPositions, openPositionsOK := strictIntEnv("OPENPROPHET_MAX_OPEN_POSITIONS", 0)
	maxDailyLoss, dailyLossOK := strictFloatEnv("OPENPROPHET_MAX_DAILY_LOSS", 0)
	return &TradingPolicy{
		IsPaper:              isPaper,
		AllowLiveTrading:     allowLive,
		AllowOptions:         allowOptions,
		AllowStocks:          allowStocks,
		Allow0DTE:            allow0DTE,
		RequireConfirmation:  requireConfirmation,
		MaxOrderValue:        maxOrderValue,
		MaxPositionPct:       maxPositionPct,
		MaxDeployedPct:       maxDeployedPct,
		MaxOpenPositions:     maxOpenPositions,
		MaxDailyLoss:         maxDailyLoss,
		InvalidConfiguration: !(liveOK && optionsOK && stocksOK && dteOK && confirmationOK && orderValueOK && positionPctOK && deployedPctOK && openPositionsOK && dailyLossOK),
	}
}

func (p TradingPolicy) validateCommon(orderSide, assetClass string, opening bool) error {
	if p.InvalidConfiguration {
		return fmt.Errorf("trading policy configuration is invalid; execution is blocked")
	}
	if !p.IsPaper && !p.AllowLiveTrading {
		return fmt.Errorf("allowLiveTrading policy is disabled for live trading")
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
	if p.MaxOrderValue <= 0 || p.MaxPositionPct <= 0 || p.MaxDeployedPct <= 0 || p.MaxOpenPositions <= 0 || p.MaxDailyLoss <= 0 {
		return fmt.Errorf("opening risk caps must all be explicitly positive")
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
		if !isPositiveFinite(snapshot.Account.LastEquity) {
			return fmt.Errorf("last equity is unavailable; daily loss cap cannot be evaluated")
		}
		if snapshot.Account.PortfolioValue-snapshot.Account.LastEquity < 0 {
			lossPct := (snapshot.Account.LastEquity - snapshot.Account.PortfolioValue) / snapshot.Account.LastEquity * 100
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
		openPositions++
		deployed += math.Abs(position.MarketValue)
		if strings.EqualFold(position.Symbol, symbol) {
			knownSymbol = true
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
	opening := strings.HasSuffix(order.PositionIntent, "_to_open")
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
		if ok && sameUTCDay(expiry, time.Now().UTC()) {
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

func sameUTCDay(a, b time.Time) bool {
	y1, m1, d1 := a.UTC().Date()
	y2, m2, d2 := b.UTC().Date()
	return y1 == y2 && m1 == m2 && d1 == d2
}
