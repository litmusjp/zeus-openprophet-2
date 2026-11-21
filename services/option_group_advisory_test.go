package services

import (
	"context"
	"strings"
	"testing"
	"time"

	"prophet-trader/interfaces"
)

// Phase C, Step 4 (plan 8.1 item 6): the near-expiry in-the-money short-leg advisory is information only.

func TestShortLegExpiryAdvisory(t *testing.T) {
	legs, _ := EncodeGroupLegs([]interfaces.OptionLeg{leg(callLow, "buy", "buy_to_open"), leg(callHigh, "sell", "sell_to_open")})
	// callHigh is the 210 call expiring 2026-12-18.
	day := func(s string) time.Time { v, _ := time.Parse("2006-01-02", s); return v.Add(15 * time.Hour) }
	cases := []struct {
		name  string
		now   time.Time
		price float64
		want  bool
	}{
		{"seven days out and in the money", day("2026-12-11"), 215, true},
		{"expiry day and in the money", day("2026-12-18"), 211, true},
		{"in the money but eight days out", day("2026-12-10"), 215, false},
		{"near expiry but out of the money", day("2026-12-16"), 205, false},
		{"exactly at the strike is not in the money", day("2026-12-16"), 210, false},
		{"already expired", day("2026-12-19"), 215, false},
	}
	for _, tc := range cases {
		got, err := ShortLegExpiryAdvisory(legs, "", tc.now, tc.price)
		if err != nil || (got != "") != tc.want {
			t.Errorf("%s: got %q err=%v", tc.name, got, err)
		}
		if tc.want && (!strings.Contains(got, callHigh) || !strings.Contains(got, "information only") || !strings.Contains(got, "nothing is closed, rolled or changed")) {
			t.Errorf("%s: the advisory must name the leg and say it is information only: %q", tc.name, got)
		}
	}
	// Only a SHORT leg is flagged: a deep in-the-money long leg alone never is.
	if got, _ := ShortLegExpiryAdvisory(legs, "", day("2026-12-16"), 250); !strings.Contains(got, callHigh) || strings.Contains(got, callLow) {
		t.Errorf("only the short leg may be flagged, got %q", got)
	}
	// A put spread: the short put is flagged when the price is below its strike.
	puts, _ := EncodeGroupLegs([]interfaces.OptionLeg{leg(putHigh, "buy", "buy_to_open"), leg(putLow, "sell", "sell_to_open")})
	if got, _ := ShortLegExpiryAdvisory(puts, "", day("2026-12-16"), 185); !strings.Contains(got, putLow) {
		t.Errorf("a short put below its strike must be flagged, got %q", got)
	}
	// A short leg already detached (single-leg management) is not the group's concern.
	detached, _ := EncodeGroupLegs([]interfaces.OptionLeg{leg(callHigh, "sell", "sell_to_open")})
	if got, _ := ShortLegExpiryAdvisory(legs, detached, day("2026-12-16"), 250); got != "" {
		t.Errorf("a detached leg must not be flagged, got %q", got)
	}
	if _, err := ShortLegExpiryAdvisory("{nope", "", day("2026-12-16"), 250); err == nil {
		t.Error("unreadable legs must be an error")
	}
}

func TestResolverRecordsAndClearsTheAdvisoryWithoutAnyOrderOrVeto(t *testing.T) {
	orders := &memOrders{}
	state := baselined(callSpreadState(2), 0)
	store := newLiveGroupStore(orders, state)
	broker := openBroker(optPos(callLow, 2), optPos(callHigh, -2))
	r := newResolver(store, orders, broker)
	near := time.Date(2026, 12, 16, 15, 0, 0, 0, time.UTC)
	r.Now = func() time.Time { return near }
	broker.quoteAt = near.Add(-5 * time.Second)
	broker.bid, broker.ask = 214.9, 215.1 // in the money
	if _, err := r.ResolveOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := store.groups["gc"].Advisory; !strings.Contains(got, callHigh) || len(broker.placed) != 0 || len(broker.grants) != 0 {
		t.Fatalf("the advisory must be recorded with no order or grant: advisory=%q placed=%d grants=%d", got, len(broker.placed), len(broker.grants))
	}
	// A stale quote leaves it as it is; a fresh out-of-the-money quote clears it.
	broker.quoteAt = near.Add(-10 * time.Minute)
	broker.bid, broker.ask = 199.9, 200.1
	_, _ = r.ResolveOnce(context.Background())
	if store.groups["gc"].Advisory == "" {
		t.Fatal("a stale quote must leave the advisory untouched")
	}
	broker.quoteAt = near.Add(-5 * time.Second)
	_, _ = r.ResolveOnce(context.Background())
	if got := store.groups["gc"].Advisory; got != "" {
		t.Fatalf("a fresh out-of-the-money quote must clear the advisory, got %q", got)
	}
	// An advisory never vetoes or changes an entry or close: policy does not read it.
	group := ownedGroup("gc", 2, callLow, callHigh)
	if _, err := spreadPolicy("").ValidateOptionsOrder(bullCallClose(), spreadSnapshot(group)); err != nil {
		t.Fatalf("an advisory must never block a close: %v", err)
	}
}
