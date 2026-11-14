package services

import "testing"

func verticalProposal() StandaloneTradeProposal {
	return spreadProposal("AAPL261106C00200000", "AAPL261106C00210000") // long (buy) first, then the short (sell) leg
}

func verticalQuote(symbol, side, bid, ask string) map[string]any {
	return map[string]any{"symbol": symbol, "side": side, "bid": bid, "ask": ask, "bid_size": "10", "ask_size": "10"}
}

// Quote N is the quote behind the leg_N_quote check. Comparing sorted values would let two quotes swap places; the
// binding is per leg, and each quote must carry the side the proposal gave that contract.
func TestOptionSpreadCapV2QuotesAreBoundToTheirOwnLegs(t *testing.T) {
	p := verticalProposal()
	s := capService(t, 15)
	long := verticalQuote("AAPL261106C00200000", "buy", "9.75", "10.25")   // 5%
	short := verticalQuote("AAPL261106C00210000", "sell", "9.40", "10.60") // 12%
	build := func(first, second map[string]any) map[string]any {
		doc := spreadDoc(scoreProfileV2, "0.05", "0.12")
		doc["option_quotes"] = []any{first, second}
		return doc
	}
	if err := s.enforceOptionSpreadCap(p, build(long, short)); err != nil {
		t.Fatalf("matching per-leg evidence refused: %v", err)
	}
	for name, doc := range map[string]map[string]any{
		"swapped_quotes":    build(short, long),
		"long_marked_sell":  build(verticalQuote("AAPL261106C00200000", "sell", "9.75", "10.25"), short),
		"short_marked_buy":  build(long, verticalQuote("AAPL261106C00210000", "buy", "9.40", "10.60")),
		"side_missing":      build(map[string]any{"symbol": "AAPL261106C00200000", "bid": "9.75", "ask": "10.25"}, short),
		"same_symbol_twice": build(long, verticalQuote("AAPL261106C00200000", "buy", "9.40", "10.60")),
	} {
		t.Run(name, func(t *testing.T) {
			if got := spreadCapCode(s.enforceOptionSpreadCap(p, doc)); got != optionSpreadEvidenceCode {
				t.Fatalf("code=%q, want %q", got, optionSpreadEvidenceCode)
			}
		})
	}
	// A tighter cap judges the worst leg of correctly bound evidence.
	if got := spreadCapCode(capService(t, 10).enforceOptionSpreadCap(p, build(long, short))); got != optionSpreadAboveCapCode {
		t.Fatalf("a 12%% short leg was not refused by a 10%% cap: %q", got)
	}
}
