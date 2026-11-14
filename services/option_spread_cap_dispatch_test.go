package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	"github.com/sirupsen/logrus"
	"prophet-trader/interfaces"
)

// These tests run the real PlaceOptionsOrder (every local check, the AlphaDesk assessment, both final guards and the broker
// call) so the cap's final validation and the dispatch are exercised together, in the modes the system can run.
type dispatchFixture struct {
	service     *AlpacaTradingService
	brokerCalls func() int
	alphaCalls  func() int
}

func newDispatchFixture(t *testing.T, mode string, ratio string, onBroker func()) *dispatchFixture {
	t.Helper()
	now := time.Now().UTC()
	var mu sync.Mutex
	brokerCalls, alphaCalls := 0, 0
	alpha := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			snapshot, version := standaloneFixturePolicyAt("65")
			_ = json.NewEncoder(w).Encode(map[string]any{"scope": "TRADE_ASSESSMENT", "execution_allowed": false, "policy_version": version, "policy_snapshot": snapshot, "minimum_passing_score": "65"})
			return
		}
		mu.Lock()
		alphaCalls++
		mu.Unlock()
		var proposal StandaloneTradeProposal
		if err := json.NewDecoder(r.Body).Decode(&proposal); err != nil {
			t.Errorf("decode proposal: %v", err)
			return
		}
		receipt := standaloneFixtureReceipt(proposal, now)
		receipt["checks"] = []map[string]any{{"code": "quality", "passed": true}, {"code": "leg_0_quote", "passed": true, "actual": ratio, "threshold": "0.50"}}
		_ = json.NewEncoder(w).Encode(receipt)
	}))
	t.Cleanup(alpha.Close)
	broker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v2/account":
			_, _ = w.Write([]byte(`{"id":"fixture","equity":"10000","last_equity":"10000","cash":"10000","portfolio_value":"10000","buying_power":"10000","daytrade_count":0}`))
		case "/v2/positions":
			// the fixture holds one long contract so that an exit is backed by broker exposure
			_, _ = w.Write([]byte(`[{"symbol":"AAPL261106C00200000","qty":"1","avg_entry_price":"2","market_value":"100","cost_basis":"100","unrealized_pl":"0","unrealized_plpc":"0","current_price":"2","side":"long","asset_class":"us_option"}]`))
		case "/v2/orders":
			_, _ = w.Write([]byte(`[]`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(broker.Close)
	policy := &TradingPolicy{IsPaper: true, AllowPaperTrading: true, AllowOptions: true, AllowStocks: true, RequireConfirmation: false, MaxPositionPct: 100, MaxDeployedPct: 100, MaxOpenPositions: 10, MaxDailyLoss: 100}
	s := &AlpacaTradingService{client: alpaca.NewClient(alpaca.ClientOpts{APIKey: "fixture", APISecret: "fixture", BaseURL: broker.URL, HTTPClient: broker.Client()}), clockReader: fakeMarketClock{clock: &alpaca.Clock{IsOpen: true}}, logger: logrus.New(), policy: policy,
		expectedAccountID: "fixture", expectedPaper: true, expectedTenantID: "fixture", expectedSandboxID: "fixture",
		localOrderProvider: func(context.Context) ([]*interfaces.Order, error) { return nil, nil },
		alphaDesk:          &AlphaDeskClient{Enabled: true, SignalQualityEnabled: true, ExecutionMode: mode, URL: alpha.URL, APIKey: "fixture", HTTP: alpha.Client(), Now: func() time.Time { return now }},
		placeOrderFn: func(req alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
			mu.Lock()
			brokerCalls++
			mu.Unlock()
			if onBroker != nil {
				onBroker()
			}
			return &alpaca.Order{ID: "paper-order", ClientOrderID: req.ClientOrderID, Symbol: req.Symbol, Side: req.Side, Type: req.Type, TimeInForce: req.TimeInForce, PositionIntent: req.PositionIntent, Qty: req.Qty, LimitPrice: req.LimitPrice, Status: "accepted"}, nil
		},
	}
	s.SetSubmissionMarker(func(string) error { return nil })
	s.SetManagedExecutionBlockCheck(func() bool { return false })
	s.SetOpeningReservationLock(filepath.Join(t.TempDir(), "reservation.lock"))
	return &dispatchFixture{service: s,
		brokerCalls: func() int { mu.Lock(); defer mu.Unlock(); return brokerCalls },
		alphaCalls:  func() int { mu.Lock(); defer mu.Unlock(); return alphaCalls }}
}

func (f *dispatchFixture) opening(id string, revision *int64) *interfaces.OptionsOrder {
	price := 2.0
	return &interfaces.OptionsOrder{ClientOrderID: id, Symbol: "AAPL261106C00200000", Underlying: "AAPL", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: &price, CapRevision: revision,
		AssessmentAuditSink: func(*interfaces.AlphaDeskAssessment) error { return nil }}
}

func (f *dispatchFixture) closing(id string) *interfaces.OptionsOrder {
	price := 1.9
	return &interfaces.OptionsOrder{ClientOrderID: id, Symbol: "AAPL261106C00200000", Underlying: "AAPL", Qty: 1, Side: "sell", PositionIntent: "sell_to_close", Type: "limit", TimeInForce: "day", LimitPrice: &price}
}

// A setter that competes AFTER the final revision check cannot change the cap until the broker call has returned.
func TestACapSetterCompetingAfterTheFinalCheckWaitsForTheBrokerCall(t *testing.T) {
	var f *dispatchFixture
	started, done := make(chan struct{}), make(chan struct{})
	finishedDuringDispatch := false
	f = newDispatchFixture(t, "PAPER_ADVISORY_OP2", "0.05", func() {
		// Inside the broker call: the final check has passed and the lease is held. (No cap state is read here: a read would
		// queue behind the waiting writer.)
		go func() {
			close(started)
			_ = f.service.SetOptionSpreadCapPct(15)
			close(done)
		}()
		<-started
		select {
		case <-done:
			finishedDuringDispatch = true
		case <-time.After(200 * time.Millisecond):
		}
	})
	if err := f.service.SetOptionSpreadCapPct(10); err != nil {
		t.Fatal(err)
	}
	revision := f.service.OptionSpreadCapRevision()
	if _, err := f.service.PlaceOptionsOrder(context.Background(), f.opening("after-check", &revision)); err != nil {
		t.Fatalf("a confirmed opening was refused: %v", err)
	}
	if finishedDuringDispatch {
		t.Fatal("a cap change completed while the order was being dispatched")
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the cap change never ran after the dispatch finished")
	}
	if f.brokerCalls() != 1 {
		t.Fatalf("broker calls=%d, want 1", f.brokerCalls())
	}
	if pct, _, _, now := f.service.OptionSpreadCapState(); pct != 15 || now != revision+1 {
		t.Fatalf("the waiting change was lost or applied twice: pct=%v revision=%d (was %d)", pct, now, revision)
	}
}

// A setter that competes in the gap between the final guard and the lease is caught by the lease's own revision check.
func TestACapSetterCompetingBetweenTheFinalGuardAndTheLeaseIsRefused(t *testing.T) {
	f := newDispatchFixture(t, "PAPER_ADVISORY_OP2", "0.05", nil)
	_ = f.service.SetOptionSpreadCapPct(10)
	revision := f.service.OptionSpreadCapRevision()
	f.service.capLeaseHook = func() { _ = f.service.SetOptionSpreadCapPct(15) } // lands after every guard, before the lease
	_, err := f.service.PlaceOptionsOrder(context.Background(), f.opening("gap", &revision))
	if spreadCapCode(err) != optionSpreadCapChanged || !IsPreSubmissionRejection(err) {
		t.Fatalf("a change in the final gap was not refused: %v", err)
	}
	if f.brokerCalls() != 0 {
		t.Fatal("the order reached the broker")
	}
	// A fresh confirmation lets the retry through.
	f.service.capLeaseHook = nil
	fresh := f.service.OptionSpreadCapRevision()
	if _, err := f.service.PlaceOptionsOrder(context.Background(), f.opening("gap-retry", &fresh)); err != nil || f.brokerCalls() != 1 {
		t.Fatalf("retry with a fresh confirmation failed: err=%v broker=%d", err, f.brokerCalls())
	}
}

// The requirement is at the common boundary: every execution mode, before any assessment work.
func TestTheCapRequirementIsAtTheCommonOpeningBoundaryForEveryMode(t *testing.T) {
	for _, mode := range []string{"", "ACCOUNT_VERIFIED", "SIGNAL_QUALITY_OP2", "STANDALONE_OP2", "PAPER_ADVISORY_OP2"} {
		t.Run("no_revision_"+mode, func(t *testing.T) {
			f := newDispatchFixture(t, mode, "0.05", nil)
			_ = f.service.SetOptionSpreadCapPct(10)
			_, err := f.service.PlaceOptionsOrder(context.Background(), f.opening("no-rev", nil))
			supported := mode == "STANDALONE_OP2" || mode == "PAPER_ADVISORY_OP2"
			want := optionSpreadCapUnsupported
			if supported {
				want = optionSpreadCapRevision
			}
			if spreadCapCode(err) != want || !IsPreSubmissionRejection(err) {
				t.Fatalf("mode %q: code=%q (%v), want %q", mode, spreadCapCode(err), err, want)
			}
			if f.alphaCalls() != 0 || f.brokerCalls() != 0 {
				t.Fatalf("mode %q: the refusal came after assessment or broker work: alpha=%d broker=%d", mode, f.alphaCalls(), f.brokerCalls())
			}
		})
		t.Run("with_revision_"+mode, func(t *testing.T) {
			f := newDispatchFixture(t, mode, "0.05", nil)
			_ = f.service.SetOptionSpreadCapPct(10)
			revision := f.service.OptionSpreadCapRevision()
			_, err := f.service.PlaceOptionsOrder(context.Background(), f.opening("rev", &revision))
			if mode == "PAPER_ADVISORY_OP2" {
				if err != nil || f.brokerCalls() != 1 {
					t.Fatalf("a confirmed opening was refused: %v", err)
				}
				return
			}
			if mode == "STANDALONE_OP2" {
				return // this fixture's advisory receipt cannot authorize in standalone mode; covered by the no-revision case above
			}
			if spreadCapCode(err) != optionSpreadCapUnsupported || f.brokerCalls() != 0 {
				t.Fatalf("mode %q: an unsupported combination was not rejected: %v", mode, err)
			}
		})
	}
}

func TestWithNoCapInForceOrWithAnInvalidOneTheBoundaryBehavesAsDocumented(t *testing.T) {
	for _, mode := range []string{"", "ACCOUNT_VERIFIED", "PAPER_ADVISORY_OP2"} {
		f := newDispatchFixture(t, mode, "0.05", nil)
		if err := f.service.checkOptionSpreadCapBoundary(f.opening("none", nil)); err != nil {
			t.Fatalf("mode %q: no cap in force must not refuse: %v", mode, err)
		}
		if release, err := f.service.leaseOptionSpreadCap(f.opening("none", nil)); err != nil {
			t.Fatalf("mode %q: no cap in force must not refuse at the lease: %v", mode, err)
		} else {
			release()
		}
	}
	t.Setenv(optionSpreadCapEnv, "abc")
	f := newDispatchFixture(t, "ACCOUNT_VERIFIED", "0.05", nil)
	f.service.LoadOptionSpreadCapFromEnv()
	for _, mode := range []string{"ACCOUNT_VERIFIED", "PAPER_ADVISORY_OP2"} {
		f.service.alphaDesk.ExecutionMode = mode
		if got := spreadCapCode(f.service.checkOptionSpreadCapBoundary(f.opening("bad", nil))); got != optionSpreadCapConfigErr {
			t.Fatalf("mode %q: an invalid cap did not fail closed at the common boundary: %q", mode, got)
		}
	}
}

// Exits never reach a refusal and never wait for a cap change.
func TestExitsAreNeverRefusedForTheCapAndNeverWaitOnIt(t *testing.T) {
	for _, mode := range []string{"", "ACCOUNT_VERIFIED", "PAPER_ADVISORY_OP2"} {
		t.Run(mode, func(t *testing.T) {
			var f *dispatchFixture
			started, done := make(chan struct{}), make(chan struct{})
			f = newDispatchFixture(t, mode, "0.05", func() {
				go func() {
					close(started)
					_ = f.service.SetOptionSpreadCapPct(15)
					close(done)
				}()
				<-started
				select {
				case <-done:
				case <-time.After(2 * time.Second):
					t.Error("an exit held up a cap change")
				}
			})
			_ = f.service.SetOptionSpreadCapPct(10)
			if _, err := f.service.PlaceOptionsOrder(context.Background(), f.closing("exit")); err != nil {
				t.Fatalf("an exit was refused: %v", err)
			}
			if f.brokerCalls() != 1 || f.alphaCalls() != 0 {
				t.Fatalf("broker=%d alpha=%d", f.brokerCalls(), f.alphaCalls())
			}
		})
	}
}

// Under the race detector: many openings and many cap changes together never deadlock and never let a stale revision through.
func TestOpeningsAndCapChangesTogetherNeverDeadlockOrAcceptAStaleRevision(t *testing.T) {
	f := newDispatchFixture(t, "PAPER_ADVISORY_OP2", "0.05", nil)
	_ = f.service.SetOptionSpreadCapPct(10)
	stop := make(chan struct{})
	var group sync.WaitGroup
	group.Add(1)
	go func() {
		defer group.Done()
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
				_ = f.service.SetOptionSpreadCapPct(float64(8 + i%2*2))
				time.Sleep(time.Millisecond)
			}
		}
	}()
	accepted, refused := 0, 0
	deadline := time.After(20 * time.Second)
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		for i := 0; i < 40; i++ {
			revision := f.service.OptionSpreadCapRevision()
			_, err := f.service.PlaceOptionsOrder(context.Background(), f.opening("race-"+time.Now().Format("150405.000000000"), &revision))
			switch {
			case err == nil:
				accepted++
			case spreadCapCode(err) == optionSpreadCapChanged || spreadCapCode(err) == optionSpreadAboveCapCode:
				refused++
			default:
				t.Errorf("unexpected refusal: %v", err)
			}
		}
	}()
	select {
	case <-finished:
	case <-deadline:
		t.Fatal("openings and cap changes deadlocked")
	}
	close(stop)
	group.Wait()
	if accepted+refused != 40 || f.brokerCalls() != accepted {
		t.Fatalf("accepted=%d refused=%d broker=%d", accepted, refused, f.brokerCalls())
	}
}
