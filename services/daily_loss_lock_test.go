package services

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	"github.com/sirupsen/logrus"

	"prophet-trader/interfaces"
)

func lockTestService(t *testing.T, dir string, clock *alpaca.Clock, clockErr error) *AlpacaTradingService {
	t.Helper()
	return &AlpacaTradingService{
		logger:        logrus.New(),
		clockReader:   fakeMarketClock{clock: clock, err: clockErr},
		policy:        &TradingPolicy{IsPaper: true, AllowPaperTrading: true, AllowOptions: true, MaxDailyLoss: 5, MaxPositionPct: 100, MaxDeployedPct: 100, MaxOpenPositions: 10, Allow0DTE: true},
		dailyLossLock: NewDailyLossLockStore(filepath.Join(dir, "daily-loss-lock.json")),
	}
}

func lossAccount(pct float64) *interfaces.Account {
	return &interfaces.Account{PortfolioValue: 100_000, Equity: 100_000 * (1 + pct/100), LastEquity: 100_000, DailyPnL: 1000 * pct, DailyPnLPercent: pct, DailyPnLValid: true}
}

func openClock(ts string) *alpaca.Clock {
	at, _ := time.Parse(time.RFC3339, ts)
	return &alpaca.Clock{Timestamp: at, IsOpen: true}
}

func openingOption() *interfaces.OptionsOrder {
	return &interfaces.OptionsOrder{ClientOrderID: "lock-open", Symbol: "AAPL270115C00200000", Underlying: "AAPL", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(1)}
}

func closingOption() *interfaces.OptionsOrder {
	return &interfaces.OptionsOrder{ClientOrderID: "lock-close", Symbol: "AAPL270115C00200000", Underlying: "AAPL", Qty: 1, Side: "sell", PositionIntent: "sell_to_close", Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(1)}
}

func heldOption() []*interfaces.Position {
	return []*interfaces.Position{{Symbol: "AAPL270115C00200000", Qty: 1, Side: "long", MarketValue: 100}}
}

func snapshotWithLock(account *interfaces.Account, lock *interfaces.DailyLossLockStatus, lockErr error) BrokerRiskSnapshot {
	return BrokerRiskSnapshot{Account: account, Positions: heldOption(), Lock: lock, LockErr: lockErr}
}

func TestDailyLossLockLatchesDuringTheOpenSessionAndSurvivesRecovery(t *testing.T) {
	dir := t.TempDir()
	s := lockTestService(t, dir, openClock("2026-11-16T15:00:00Z"), nil) // 10:00 ET, Monday
	status, err := s.evaluateDailyLossLock(context.Background(), true, lossAccount(-5.4), true)
	if err != nil || !status.Locked || !status.NewlyLocked || status.SessionDate != "2026-11-16" {
		t.Fatalf("breach during the open session must latch: %+v %v", status, err)
	}
	// Marks recover: the lock stays, and is not "newly" set again.
	status, err = s.evaluateDailyLossLock(context.Background(), true, lossAccount(-1.0), false)
	if err != nil || !status.Locked || status.NewlyLocked || status.LossPct < 5 {
		t.Fatalf("lock must survive a same-session recovery: %+v %v", status, err)
	}
	// A restart (new service instance, same file) is still locked.
	restarted := lockTestService(t, dir, openClock("2026-11-16T17:00:00Z"), nil)
	status, err = restarted.DailyLossLockState(context.Background())
	if err != nil || !status.Locked {
		t.Fatalf("lock must survive a restart: %+v %v", status, err)
	}
	// Opening refused, closing allowed, at the policy boundary.
	policy := *s.policy
	if _, err := policy.ValidateOptionsOrder(openingOption(), snapshotWithLock(lossAccount(-1.0), status, nil)); err == nil || !strings.Contains(err.Error(), "new openings are blocked") {
		t.Fatalf("opening must be refused while locked, got %v", err)
	}
	if _, err := policy.ValidateOptionsOrder(closingOption(), snapshotWithLock(lossAccount(-1.0), status, nil)); err != nil {
		t.Fatalf("closing must stay allowed while locked, got %v", err)
	}
}

func TestDailyLossLockNeverLatchesOutsideTheOpenSession(t *testing.T) {
	dir := t.TempDir()
	closed := &alpaca.Clock{Timestamp: time.Date(2026, 11, 16, 14, 15, 0, 0, time.UTC), IsOpen: false} // 9:15 ET pre-market
	s := lockTestService(t, dir, closed, nil)
	status, err := s.evaluateDailyLossLock(context.Background(), true, lossAccount(-9), false)
	if err != nil || status.Locked {
		t.Fatalf("pre-market marks must not create a lock: %+v %v", status, err)
	}
	if lock, _ := s.dailyLossLock.Load(); lock != nil {
		t.Fatalf("nothing may be persisted outside the session: %+v", lock)
	}
	// The existing instant cap still refuses pre-market openings on its own.
	if _, err := s.policy.ValidateOptionsOrder(openingOption(), BrokerRiskSnapshot{Account: lossAccount(-9)}); err == nil || !strings.Contains(err.Error(), "daily loss cap exceeded") {
		t.Fatalf("instant cap must be unchanged, got %v", err)
	}
}

func TestDailyLossLockClearsOnTheNextSessionDate(t *testing.T) {
	dir := t.TempDir()
	s := lockTestService(t, dir, openClock("2026-11-16T15:00:00Z"), nil)
	if status, _ := s.evaluateDailyLossLock(context.Background(), true, lossAccount(-6), false); !status.Locked {
		t.Fatal("expected a lock")
	}
	next := lockTestService(t, dir, openClock("2026-11-17T15:00:00Z"), nil)
	status, err := next.evaluateDailyLossLock(context.Background(), true, lossAccount(-1), false)
	if err != nil || status.Locked {
		t.Fatalf("a new session date must clear the lock: %+v %v", status, err)
	}
	// The New York date, not UTC, decides: 02:00 UTC Nov 17 is still Nov 16 in New York (evening).
	late := lockTestService(t, dir, &alpaca.Clock{Timestamp: time.Date(2026, 11, 17, 2, 0, 0, 0, time.UTC), IsOpen: false}, nil)
	status, _ = late.DailyLossLockState(context.Background())
	if !status.Locked {
		t.Fatalf("Nov 16 evening ET is still the Nov 16 session: %+v", status)
	}
}

func TestDailyLossLockMissingClockBlocksOpeningsButNeverClosings(t *testing.T) {
	dir := t.TempDir()
	policy := *lockTestService(t, dir, nil, nil).policy
	opening, closing := openingOption(), closingOption()

	// No lock stored and the broker clock is unavailable: the session state cannot be verified, so openings are refused.
	broken := lockTestService(t, dir, nil, fmt.Errorf("clock down"))
	status, err := broken.DailyLossLockState(context.Background())
	if err != nil || !status.Enabled || status.ClockAvailable || status.Locked {
		t.Fatalf("expected an enabled, clockless, unlocked status: %+v %v", status, err)
	}
	if _, err := policy.ValidateOptionsOrder(opening, snapshotWithLock(lossAccount(0), status, nil)); err == nil || !strings.Contains(err.Error(), "session clock is unavailable") {
		t.Fatalf("opening must be refused without a valid broker clock, got %v", err)
	}
	if _, err := policy.ValidateOptionsOrder(closing, snapshotWithLock(lossAccount(0), status, nil)); err != nil {
		t.Fatalf("closing must never depend on the clock, got %v", err)
	}
	// A zero timestamp is not a valid clock either.
	zero := lockTestService(t, dir, &alpaca.Clock{IsOpen: true}, nil)
	if status, _ = zero.DailyLossLockState(context.Background()); status.ClockAvailable {
		t.Fatalf("a zero broker timestamp must count as unavailable: %+v", status)
	}

	// A stored lock of any age stays reported as locked while the clock is unavailable (no wall-clock expiry), and openings stay refused.
	old := DailyLossLock{SessionDate: "2026-11-10", LossPct: 6, LimitPct: 5, LatchedAt: time.Now().Add(-72 * time.Hour)}
	if err := broken.dailyLossLock.Save(old); err != nil {
		t.Fatal(err)
	}
	status, err = broken.DailyLossLockState(context.Background())
	if err != nil || !status.Locked || status.ClockAvailable {
		t.Fatalf("an old lock must not be forgotten on elapsed time alone: %+v %v", status, err)
	}
	if _, err := policy.ValidateOptionsOrder(opening, snapshotWithLock(lossAccount(0), status, nil)); err == nil {
		t.Fatal("opening must stay refused with an old lock and no clock")
	}
	if _, err := policy.ValidateOptionsOrder(closing, snapshotWithLock(lossAccount(0), status, nil)); err != nil {
		t.Fatalf("closing must stay allowed, got %v", err)
	}

	// A valid clock on a later session date restores normal evaluation: the old lock is cleared and an opening is allowed.
	recovered := lockTestService(t, dir, openClock("2026-11-16T15:00:00Z"), nil)
	status, err = recovered.DailyLossLockState(context.Background())
	if err != nil || status.Locked || !status.ClockAvailable {
		t.Fatalf("a valid next-session clock must clear the old lock: %+v %v", status, err)
	}
	if _, err := policy.ValidateOptionsOrder(opening, snapshotWithLock(lossAccount(0), status, nil)); err != nil {
		t.Fatalf("opening must be allowed again, got %v", err)
	}

	// With the limit switched off the rule is not enabled, so the missing clock is not what refuses an opening.
	noLimit := lockTestService(t, t.TempDir(), nil, fmt.Errorf("clock down"))
	noLimit.policy.MaxDailyLoss = 0
	if status, _ = noLimit.DailyLossLockState(context.Background()); status.Enabled {
		t.Fatalf("no limit means the session rule is not enabled: %+v", status)
	}
}

func TestDailyLossLockIsReportedAsNewOnlyOnceEvenWhenAnOrderCheckLatchedIt(t *testing.T) {
	dir := t.TempDir()
	s := lockTestService(t, dir, openClock("2026-11-16T15:00:00Z"), nil)
	// An order-policy check (snapshot path) latches the lock first: that path never reports it as new.
	status, err := s.evaluateDailyLossLock(context.Background(), true, lossAccount(-6), false)
	if err != nil || !status.Locked || status.NewlyLocked {
		t.Fatalf("snapshot path latches without announcing: %+v %v", status, err)
	}
	// The beat-end evaluate then announces it exactly once.
	status, err = s.EvaluateDailyLossLock(context.Background())
	if err != nil || !status.Locked || !status.NewlyLocked {
		t.Fatalf("evaluate must report the lock as new once: %+v %v", status, err)
	}
	status, _ = s.EvaluateDailyLossLock(context.Background())
	if !status.Locked || status.NewlyLocked {
		t.Fatalf("second evaluate must not announce again: %+v", status)
	}
	// Restart: still not announced again.
	again := lockTestService(t, dir, openClock("2026-11-16T17:00:00Z"), nil)
	if status, _ = again.EvaluateDailyLossLock(context.Background()); !status.Locked || status.NewlyLocked {
		t.Fatalf("a restart must not announce again: %+v", status)
	}
}

func TestDailyLossLockUnreadableStateBlocksOpeningsButNotClosings(t *testing.T) {
	dir := t.TempDir()
	s := lockTestService(t, dir, openClock("2026-11-16T15:00:00Z"), nil)
	if err := os.WriteFile(filepath.Join(dir, "daily-loss-lock.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	status, err := s.evaluateDailyLossLock(context.Background(), true, lossAccount(0), false)
	if err == nil || status != nil {
		t.Fatalf("a corrupt lock file must be an error, got %+v %v", status, err)
	}
	policy := *s.policy
	if _, err := policy.ValidateOptionsOrder(openingOption(), snapshotWithLock(lossAccount(0), nil, err)); err == nil || !strings.Contains(err.Error(), "lock state is unavailable") {
		t.Fatalf("opening must fail closed on an unreadable lock, got %v", err)
	}
	if _, err := policy.ValidateOptionsOrder(closingOption(), snapshotWithLock(lossAccount(0), nil, err)); err != nil {
		t.Fatalf("closing must not depend on the lock, got %v", err)
	}
}

func TestDailyLossLockIsOffWithoutAStoreOrALimit(t *testing.T) {
	s := &AlpacaTradingService{logger: logrus.New(), clockReader: fakeMarketClock{clock: openClock("2026-11-16T15:00:00Z")}, policy: &TradingPolicy{MaxDailyLoss: 5}}
	status, err := s.evaluateDailyLossLock(context.Background(), true, lossAccount(-9), false)
	if err != nil || status.Locked || status.Enabled {
		t.Fatalf("no store means no lock: %+v %v", status, err)
	}
	noLimit := lockTestService(t, t.TempDir(), openClock("2026-11-16T15:00:00Z"), nil)
	noLimit.policy.MaxDailyLoss = 0
	status, err = noLimit.evaluateDailyLossLock(context.Background(), true, lossAccount(-9), false)
	if err != nil || status.Locked {
		t.Fatalf("no limit means no lock: %+v %v", status, err)
	}
}

func TestDailyLossLockIgnoresLossBelowTheLimitAndInvalidPnL(t *testing.T) {
	s := lockTestService(t, t.TempDir(), openClock("2026-11-16T15:00:00Z"), nil)
	if status, _ := s.evaluateDailyLossLock(context.Background(), true, lossAccount(-4.9), false); status.Locked {
		t.Fatalf("4.9%% is below the 5%% limit: %+v", status)
	}
	invalid := lossAccount(-9)
	invalid.DailyPnLValid = false
	if status, _ := s.evaluateDailyLossLock(context.Background(), true, invalid, false); status.Locked {
		t.Fatalf("invalid daily P&L must not latch: %+v", status)
	}
	if status, _ := s.evaluateDailyLossLock(context.Background(), true, lossAccount(+3), false); status.Locked {
		t.Fatalf("a gain must not latch: %+v", status)
	}
}
