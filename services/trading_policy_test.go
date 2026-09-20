package services

import (
	"strings"
	"testing"

	"prophet-trader/interfaces"
)

func validRiskAccount() *interfaces.Account {
	return &interfaces.Account{PortfolioValue: 10_000, Equity: 10_000, LastEquity: 10_000, DailyPnLValid: true, DailyPnLPercent: 0}
}

func TestTradingPolicyAllowsProtectionWithoutPrice(t *testing.T) {
	policy := TradingPolicy{
		AllowLiveTrading:    true,
		AllowStocks:         true,
		RequireConfirmation: false,
	}
	order := &interfaces.Order{Symbol: "AAPL", Qty: 10, Side: "sell", Purpose: "protection"}
	if _, err := policy.ValidateOrder(order, BrokerRiskSnapshot{
		Positions: []*interfaces.Position{{Symbol: "AAPL", Qty: 10, Side: "long"}},
	}); err != nil {
		t.Fatalf("protection order should not require a quote: %v", err)
	}
}

func TestTradingPolicyRejectsUnbackedClose(t *testing.T) {
	policy := TradingPolicy{AllowLiveTrading: true, AllowStocks: true}
	order := &interfaces.Order{Symbol: "AAPL", Qty: 1, Side: "sell", Purpose: "close"}
	if _, err := policy.ValidateOrder(order, BrokerRiskSnapshot{}); err == nil || !strings.Contains(err.Error(), "matching broker exposure") {
		t.Fatalf("unbacked close error = %v, want exposure proof rejection", err)
	}
}

func TestTradingPolicyRejectsOpeningOrderWhenPolicyDisabled(t *testing.T) {
	policy := TradingPolicy{
		IsPaper:          false,
		AllowLiveTrading: false,
		AllowStocks:      true,
		MaxPositionPct:   15,
		MaxDeployedPct:   80,
		MaxOpenPositions: 10, MaxDailyLoss: 100,
	}
	order := &interfaces.Order{
		Symbol: "AAPL", Qty: 1, Side: "buy", Type: "limit", TimeInForce: "day",
		LimitPrice: floatPtr(100), Purpose: "entry",
	}
	_, err := policy.ValidateOrder(order, BrokerRiskSnapshot{
		Account: validRiskAccount(),
	})
	if err == nil || !strings.Contains(err.Error(), "allowLiveTrading") {
		t.Fatalf("ValidateOrder() error = %v, want allowLiveTrading policy rejection", err)
	}
}

func TestTradingPolicyRejectsOptionNotionalAndAllowsOnlyValidOpeningRoute(t *testing.T) {
	policy := TradingPolicy{
		IsPaper:          true,
		AllowLiveTrading: true,
		AllowOptions:     true,
		AllowStocks:      true,
		MaxOrderValue:    500,
		MaxPositionPct:   100,
		MaxDeployedPct:   100,
		MaxOpenPositions: 10, MaxDailyLoss: 100,
	}
	order := &interfaces.OptionsOrder{
		ClientOrderID: "op-policy",
		Symbol:        "TSLA251219C00400000", Underlying: "TSLA", Qty: 1, Side: "buy",
		PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(10),
	}
	_, err := policy.ValidateOptionsOrder(order, BrokerRiskSnapshot{
		Account: validRiskAccount(),
	})
	if err == nil || !strings.Contains(err.Error(), "max order value") {
		t.Fatalf("ValidateOptionsOrder() error = %v, want multiplier-aware max order value rejection", err)
	}
}

func TestTradingPolicyRequiresPriceWhenOpeningCapCannotBeEvaluated(t *testing.T) {
	policy := TradingPolicy{
		IsPaper:          true,
		AllowLiveTrading: true,
		AllowStocks:      true,
		MaxOrderValue:    1000,
		MaxPositionPct:   15,
		MaxDeployedPct:   80,
		MaxOpenPositions: 10, MaxDailyLoss: 100,
	}
	order := &interfaces.Order{
		Symbol: "AAPL", Qty: 1, Side: "buy", Type: "market", TimeInForce: "day", Purpose: "entry",
	}
	_, err := policy.ValidateOrder(order, BrokerRiskSnapshot{
		Account: validRiskAccount(),
	})
	if err == nil || !strings.Contains(err.Error(), "price") {
		t.Fatalf("ValidateOrder() error = %v, want fail-closed price error", err)
	}
}

func TestTradingPolicyAllowsProtectionWithoutOpeningPositionCaps(t *testing.T) {
	policy := TradingPolicy{
		IsPaper:          true,
		AllowLiveTrading: true,
		AllowStocks:      true,
		MaxOrderValue:    100,
		MaxPositionPct:   1,
		MaxDeployedPct:   1,
		MaxOpenPositions: 1,
	}
	order := &interfaces.Order{
		Symbol: "AAPL", Qty: 10, Side: "sell", Type: "stop", TimeInForce: "gtc",
		StopPrice: floatPtr(100), Purpose: "protection",
	}
	if _, err := policy.ValidateOrder(order, BrokerRiskSnapshot{
		Account:   validRiskAccount(),
		Positions: []*interfaces.Position{{Symbol: "AAPL", Qty: 10, MarketValue: 1_000}},
	}); err != nil {
		t.Fatalf("protection order rejected: %v", err)
	}
}

func TestTradingPolicyDailyLossUsesBrokerEquityAndFailsClosed(t *testing.T) {
	policy := TradingPolicy{IsPaper: true, AllowStocks: true, RequireConfirmation: false, MaxOrderValue: 1000, MaxPositionPct: 100, MaxDeployedPct: 100, MaxOpenPositions: 10, MaxDailyLoss: 5}
	order := &interfaces.Order{Symbol: "AAPL", Qty: 1, Side: "buy", Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(10), Purpose: "entry"}
	account := &interfaces.Account{PortfolioValue: 9_000, Equity: 9_000, LastEquity: 10_000, DailyPnL: -1_000, DailyPnLPercent: -10, DailyPnLValid: true}
	if _, err := policy.ValidateOrder(order, BrokerRiskSnapshot{Account: account}); err == nil || !strings.Contains(err.Error(), "daily loss cap exceeded") {
		t.Fatalf("expected broker-equity daily loss rejection, got %v", err)
	}
	account.DailyPnLValid = false
	if _, err := policy.ValidateOrder(order, BrokerRiskSnapshot{Account: account}); err == nil || !strings.Contains(err.Error(), "daily P&L is unavailable") {
		t.Fatalf("expected invalid daily P&L to fail closed, got %v", err)
	}
}
