package services

import (
	"context"
	"testing"
	"time"
)

// Linearization rule: a setter that wins before an opening's lease is observed and checked; a setter that loses to the lease
// cannot finish until dispatch has returned. It holds for the first cap (no cap configured yet) exactly as for a configured one.

// 1. No cap configured: a legitimate no-cap opening is allowed, and the FIRST setter, started inside the broker callback,
// cannot complete until that callback returns.
func TestTheFirstCapSetterStartedInsideTheBrokerCallbackWaitsForIt(t *testing.T) {
	var f *dispatchFixture
	started, done := make(chan struct{}), make(chan struct{})
	finishedDuringDispatch := false
	f = newDispatchFixture(t, "PAPER_ADVISORY_OP2", "0.05", func() {
		go func() {
			close(started)
			_ = f.service.SetOptionSpreadCapPct(12) // the first cap: unconfigured -> configured
			close(done)
		}()
		<-started
		select {
		case <-done:
			finishedDuringDispatch = true
		case <-time.After(200 * time.Millisecond):
		}
	})
	if _, configured, _, revision := f.service.OptionSpreadCapState(); configured || revision != 0 {
		t.Fatal("the fixture must start with no cap")
	}
	if _, err := f.service.PlaceOptionsOrder(context.Background(), f.opening("no-cap-opening", nil)); err != nil {
		t.Fatalf("a legitimate no-cap opening was refused: %v", err)
	}
	if finishedDuringDispatch {
		t.Fatal("the first cap was activated while an opening was being dispatched")
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the first cap never applied after the dispatch returned")
	}
	if f.brokerCalls() != 1 {
		t.Fatalf("broker calls=%d, want 1", f.brokerCalls())
	}
	if pct, configured, invalid, revision := f.service.OptionSpreadCapState(); pct != 12 || !configured || invalid || revision != 1 {
		t.Fatalf("the waiting first cap was lost or applied twice: pct=%v configured=%v invalid=%v revision=%d", pct, configured, invalid, revision)
	}
}

// 2. No cap configured when the opening started; the first setter lands in the pre-lease hook. The newly configured state is
// re-read: the revisionless opening is rejected before any broker call.
func TestTheFirstCapSetterLandingBeforeTheLeaseIsObservedAndRejectsARevisionlessOpening(t *testing.T) {
	f := newDispatchFixture(t, "PAPER_ADVISORY_OP2", "0.05", nil)
	f.service.capLeaseHook = func() { _ = f.service.SetOptionSpreadCapPct(12) }
	_, err := f.service.PlaceOptionsOrder(context.Background(), f.opening("first-cap-gap", nil))
	if spreadCapCode(err) != optionSpreadCapRevision || !IsPreSubmissionRejection(err) {
		t.Fatalf("a first cap that landed before the lease was not observed: %v", err)
	}
	if f.brokerCalls() != 0 {
		t.Fatal("the revisionless opening reached the broker")
	}
	// The lock was released on the rejection: a later setter and a confirmed opening both proceed.
	f.service.capLeaseHook = nil
	if err := f.service.SetOptionSpreadCapPct(10); err != nil {
		t.Fatal(err)
	}
	revision := f.service.OptionSpreadCapRevision()
	if _, err := f.service.PlaceOptionsOrder(context.Background(), f.opening("first-cap-retry", &revision)); err != nil || f.brokerCalls() != 1 {
		t.Fatalf("the confirmed retry failed: err=%v broker=%d", err, f.brokerCalls())
	}
}

// The same landing in an unsupported mode: asserted at the lease itself (an unsupported-mode opening cannot reach the lease in
// this local fixture because its mode-specific assessment path needs live legacy evidence).
func TestTheFirstCapSetterLandingBeforeTheLeaseIsObservedInAnUnsupportedMode(t *testing.T) {
	for _, mode := range []string{"", "ACCOUNT_VERIFIED", "SIGNAL_QUALITY_OP2"} {
		f := newDispatchFixture(t, mode, "0.05", nil)
		f.service.capLeaseHook = func() { _ = f.service.SetOptionSpreadCapPct(12) }
		release, err := f.service.leaseOptionSpreadCap(f.opening("unsupported-gap", nil))
		if spreadCapCode(err) != optionSpreadCapUnsupported || !IsPreSubmissionRejection(err) {
			t.Fatalf("mode %q: the first cap was not observed at the lease: %v", mode, err)
		}
		release()
		// every rejection unlocked before returning: a setter still completes immediately
		done := make(chan struct{})
		go func() { _ = f.service.SetOptionSpreadCapPct(9); close(done) }()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatalf("mode %q: a rejection left the cap state locked", mode)
		}
	}
}

// Every rejection path of the lease unlocks before returning.
func TestEveryLeaseRejectionUnlocksBeforeReturning(t *testing.T) {
	stale := int64(999)
	cases := map[string]func(f *dispatchFixture) error{
		"invalid": func(f *dispatchFixture) error {
			t.Setenv(optionSpreadCapEnv, "abc")
			f.service.LoadOptionSpreadCapFromEnv()
			_, err := f.service.leaseOptionSpreadCap(f.opening("x", nil))
			return err
		},
		"unsupported_mode": func(f *dispatchFixture) error {
			f.service.alphaDesk.ExecutionMode = "ACCOUNT_VERIFIED"
			_ = f.service.SetOptionSpreadCapPct(10)
			_, err := f.service.leaseOptionSpreadCap(f.opening("x", nil))
			return err
		},
		"missing_revision": func(f *dispatchFixture) error {
			_ = f.service.SetOptionSpreadCapPct(10)
			_, err := f.service.leaseOptionSpreadCap(f.opening("x", nil))
			return err
		},
		"stale_revision": func(f *dispatchFixture) error {
			_ = f.service.SetOptionSpreadCapPct(10)
			_, err := f.service.leaseOptionSpreadCap(f.opening("x", &stale))
			return err
		},
	}
	for name, run := range cases {
		t.Run(name, func(t *testing.T) {
			f := newDispatchFixture(t, "PAPER_ADVISORY_OP2", "0.05", nil)
			if err := run(f); err == nil || !IsPreSubmissionRejection(err) {
				t.Fatalf("expected a pre-submission rejection, got %v", err)
			}
			done := make(chan struct{})
			go func() { _ = f.service.SetOptionSpreadCapPct(9); close(done) }()
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				t.Fatal("the rejection left the cap state locked")
			}
		})
	}
}

// Exits keep the no-lock path with no cap configured as well.
func TestAnExitDoesNotHoldUpTheFirstCapSetter(t *testing.T) {
	var f *dispatchFixture
	started, done := make(chan struct{}), make(chan struct{})
	f = newDispatchFixture(t, "PAPER_ADVISORY_OP2", "0.05", func() {
		go func() {
			close(started)
			_ = f.service.SetOptionSpreadCapPct(12)
			close(done)
		}()
		<-started
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("an exit held up the first cap setter")
		}
	})
	if _, err := f.service.PlaceOptionsOrder(context.Background(), f.closing("exit-no-cap")); err != nil {
		t.Fatalf("an exit was refused: %v", err)
	}
	if f.brokerCalls() != 1 {
		t.Fatalf("broker calls=%d", f.brokerCalls())
	}
}
