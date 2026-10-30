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
		IsPaper:             true,
		AllowLiveTrading:    true,
		AllowPaperTrading:   true,
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
	policy := TradingPolicy{IsPaper: true, AllowLiveTrading: true, AllowPaperTrading: true, AllowStocks: true}
	order := &interfaces.Order{Symbol: "AAPL", Qty: 1, Side: "sell", Purpose: "close"}
	if _, err := policy.ValidateOrder(order, BrokerRiskSnapshot{}); err == nil || !strings.Contains(err.Error(), "matching broker exposure") {
		t.Fatalf("unbacked close error = %v, want exposure proof rejection", err)
	}
}

func TestTradingPolicyRejectsOpeningOrderWhenPolicyDisabled(t *testing.T) {
	policy := TradingPolicy{
		IsPaper:          false,
		AllowLiveTrading: true,
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
	if err == nil || !strings.Contains(err.Error(), "live trading is prohibited") {
		t.Fatalf("ValidateOrder() error = %v, want live-account policy rejection", err)
	}
}

func TestTradingPolicyAllowsPaperOpeningWhenLiveCapabilityIsFalse(t *testing.T) {
	policy := TradingPolicy{
		IsPaper: true, AllowLiveTrading: false, AllowPaperTrading: true,
		AllowStocks: true, RequireConfirmation: false,
		MaxOrderValue: 1000, MaxPositionPct: 100, MaxDeployedPct: 100,
		MaxOpenPositions: 10, MaxDailyLoss: 100,
	}
	order := &interfaces.Order{Symbol: "AAPL", Qty: 1, Side: "buy", Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(100), Purpose: "entry"}
	if _, err := policy.ValidateOrder(order, BrokerRiskSnapshot{Account: validRiskAccount()}); err != nil {
		t.Fatalf("paper opening order should be allowed: %v", err)
	}
}

func TestTradingPolicyAllowsUncappedOrderValueWithOtherOpeningCaps(t *testing.T) {
	policy := TradingPolicy{
		IsPaper: true, AllowPaperTrading: true, AllowStocks: true, RequireConfirmation: false,
		MaxPositionPct: 100, MaxDeployedPct: 100, MaxOpenPositions: 10, MaxDailyLoss: 100,
	}
	order := &interfaces.Order{Symbol: "XLF", Qty: 10, Side: "buy", Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(1000), Purpose: "entry"}
	if _, err := policy.ValidateOrder(order, BrokerRiskSnapshot{Account: validRiskAccount()}); err != nil {
		t.Fatalf("zero max order value should be uncapped when other opening caps are positive: %v", err)
	}
}

func TestTradingPolicyAllowsBackedXLFCloseWithZeroOrderValueCap(t *testing.T) {
	policy := TradingPolicy{IsPaper: true, AllowPaperTrading: true, AllowStocks: true, RequireConfirmation: false}
	order := &interfaces.Order{Symbol: "XLF", Qty: 10, Side: "sell", Purpose: "close"}
	if _, err := policy.ValidateOrder(order, BrokerRiskSnapshot{
		Positions: []*interfaces.Position{{Symbol: "XLF", Qty: 10, Side: "long"}},
	}); err != nil {
		t.Fatalf("backed XLF close should remain allowed with zero max order value: %v", err)
	}
}

func TestTradingPolicyRejectsLiveOpeningEvenWhenLiveCapabilityIsTrue(t *testing.T) {
	policy := TradingPolicy{IsPaper: false, AllowLiveTrading: true, AllowPaperTrading: true, AllowStocks: true, RequireConfirmation: false}
	order := &interfaces.Order{Symbol: "AAPL", Qty: 1, Side: "buy", Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(100), Purpose: "entry"}
	if _, err := policy.ValidateOrder(order, BrokerRiskSnapshot{Account: validRiskAccount()}); err == nil || !strings.Contains(err.Error(), "live trading is prohibited") {
		t.Fatalf("live opening order error = %v, want unconditional live rejection", err)
	}
}

func TestTradingPolicyRejectsOptionNotionalAndAllowsOnlyValidOpeningRoute(t *testing.T) {
	policy := TradingPolicy{
		IsPaper:           true,
		AllowLiveTrading:  true,
		AllowPaperTrading: true,
		AllowOptions:      true,
		AllowStocks:       true,
		MaxOrderValue:     500,
		MaxPositionPct:    100,
		MaxDeployedPct:    100,
		MaxOpenPositions:  10, MaxDailyLoss: 100,
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
		IsPaper:           true,
		AllowLiveTrading:  true,
		AllowPaperTrading: true,
		AllowStocks:       true,
		MaxOrderValue:     1000,
		MaxPositionPct:    15,
		MaxDeployedPct:    80,
		MaxOpenPositions:  10, MaxDailyLoss: 100,
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
		IsPaper:           true,
		AllowLiveTrading:  true,
		AllowPaperTrading: true,
		AllowStocks:       true,
		MaxOrderValue:     100,
		MaxPositionPct:    1,
		MaxDeployedPct:    1,
		MaxOpenPositions:  1,
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
	policy := TradingPolicy{IsPaper: true, AllowPaperTrading: true, AllowStocks: true, RequireConfirmation: false, MaxOrderValue: 1000, MaxPositionPct: 100, MaxDeployedPct: 100, MaxOpenPositions: 10, MaxDailyLoss: 5}
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

func TestValidateOptionsOrderAllowsQuantityTwoWithinTenPositionCapacity(t *testing.T) {
	policy := TradingPolicy{
		IsPaper: true, AllowPaperTrading: true, AllowOptions: true,
		MaxPositionPct: 100, MaxDeployedPct: 100, MaxOpenPositions: 10, MaxDailyLoss: 100,
		Allow0DTE: true,
	}
	order := &interfaces.OptionsOrder{
		ClientOrderID: "capacity-qty-two", Symbol: "AAPL270115C00200000", Underlying: "AAPL",
		Qty: 2, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(1),
	}
	for _, existing := range []int{1, 9} {
		t.Run(strings.Join([]string{"existing", strings.TrimSpace(string(rune('0' + existing)))}, "-"), func(t *testing.T) {
			positions := make([]*interfaces.Position, 0, existing)
			for i := 0; i < existing; i++ {
				positions = append(positions, &interfaces.Position{Symbol: "OLD" + string(rune('A'+i)), Qty: 1, Side: "long", MarketValue: 100})
			}
			notional, err := policy.ValidateOptionsOrder(order, BrokerRiskSnapshot{Account: validRiskAccount(), Positions: positions})
			if err != nil {
				t.Fatalf("valid quantity-two options entry with %d existing distinct positions was rejected: %v", existing, err)
			}
			if notional != 200 {
				t.Fatalf("notional = %.2f, want 200.00", notional)
			}
		})
	}
}

func TestValidateOptionsOrderBlocksEleventhDistinctPositionAtCapacityTen(t *testing.T) {
	policy := TradingPolicy{
		IsPaper: true, AllowPaperTrading: true, AllowOptions: true,
		MaxPositionPct: 100, MaxDeployedPct: 100, MaxOpenPositions: 10, MaxDailyLoss: 100,
		Allow0DTE: true,
	}
	order := &interfaces.OptionsOrder{
		ClientOrderID: "capacity-eleven", Symbol: "AAPL270115C00200000", Underlying: "AAPL",
		Qty: 2, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(1),
	}
	positions := make([]*interfaces.Position, 0, 10)
	for i := 0; i < 10; i++ {
		positions = append(positions, &interfaces.Position{Symbol: "OLD" + string(rune('A'+i)), Qty: 1, Side: "long", MarketValue: 100})
	}
	_, err := policy.ValidateOptionsOrder(order, BrokerRiskSnapshot{Account: validRiskAccount(), Positions: positions})
	if err == nil || !strings.Contains(err.Error(), "max open positions exceeded") {
		t.Fatalf("eleventh distinct options position error = %v, want capacity rejection", err)
	}
}
