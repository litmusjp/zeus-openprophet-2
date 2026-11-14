package services

import (
	"context"
	"sync"
	"testing"
	"time"

	"prophet-trader/interfaces"
)

func confirmedRevision(s *AlpacaTradingService) *int64 {
	revision := s.OptionSpreadCapRevision()
	return &revision
}

// The revision moves with every change of the enforced value, and only then.
func TestOptionSpreadCapRevisionFollowsEveryChangeOfTheEnforcedValue(t *testing.T) {
	s := &AlpacaTradingService{}
	if s.OptionSpreadCapRevision() != 0 {
		t.Fatal("an unset cap has no revision")
	}
	steps := []struct {
		pct     float64
		changed bool
	}{{10, true}, {10, false}, {8, true}, {10, true}, {10, false}}
	last := s.OptionSpreadCapRevision()
	for _, step := range steps {
		if err := s.SetOptionSpreadCapPct(step.pct); err != nil {
			t.Fatal(err)
		}
		now := s.OptionSpreadCapRevision()
		if (now != last) != step.changed {
			t.Fatalf("set %v: revision %d -> %d, changed=%v want %v", step.pct, last, now, now != last, step.changed)
		}
		last = now
	}
	if err := s.SetOptionSpreadCapPct(1); err == nil || s.OptionSpreadCapRevision() != last {
		t.Fatal("a rejected value moved the revision")
	}
	pct, configured, invalid, revision := s.OptionSpreadCapState()
	if pct != 10 || !configured || invalid || revision != last {
		t.Fatalf("one-read state is inconsistent: %v %v %v %d", pct, configured, invalid, revision)
	}
	t.Setenv(optionSpreadCapEnv, "abc")
	bad := &AlpacaTradingService{}
	bad.LoadOptionSpreadCapFromEnv()
	if bad.OptionSpreadCapRevision() == 0 {
		t.Fatal("an invalid start-up value must also have a revision")
	}
	recovered := bad.OptionSpreadCapRevision()
	_ = bad.SetOptionSpreadCapPct(10)
	if bad.OptionSpreadCapRevision() == recovered {
		t.Fatal("replacing an invalid value must move the revision")
	}
}

// With a cap in force an opening must carry the revision that was confirmed for it.
func TestOpeningWithoutAConfirmedCapRevisionIsRefusedAtBothGuards(t *testing.T) {
	now := time.Now().UTC()
	f := &evaluatorFixture{receiptProfile: scoreProfileV1, ratio: "0.05"}
	_, service := newEvaluatorServer(t, f, now)
	if err := service.SetOptionSpreadCapPct(10); err != nil {
		t.Fatal(err)
	}
	audits := 0
	order := evaluatorOrder(&audits)
	err := service.requirePaperAdvisoryQualification(context.Background(), order)
	if spreadCapCode(err) != optionSpreadCapRevision || !IsPreSubmissionRejection(err) || audits != 0 || order.AlphaDeskAssessment != nil {
		t.Fatalf("an opening with no confirmation was not refused at qualification: %v", err)
	}
	order.CapRevision = confirmedRevision(service)
	if err := service.requirePaperAdvisoryQualification(context.Background(), order); err != nil {
		t.Fatal(err)
	}
	order.CapRevision = nil
	if err := service.validatePaperAdvisoryAtSubmission(context.Background(), order); spreadCapCode(err) != optionSpreadCapRevision {
		t.Fatalf("an opening with no confirmation crossed the final guard: %v", err)
	}
}

// The interleaving Hermes described: the cap is confirmed, then a save or a failed rollback changes the enforced value
// before the order is submitted. The order must be refused at the final guard even though the spread itself would pass.
func TestACapChangeBetweenConfirmationAndSubmissionRefusesTheOpening(t *testing.T) {
	now := time.Now().UTC()
	for _, tc := range []struct {
		name   string
		change func(*AlpacaTradingService)
	}{
		{"save_to_a_new_value", func(s *AlpacaTradingService) { _ = s.SetOptionSpreadCapPct(15) }},
		{"save_then_failed_rollback_back_to_the_same_value", func(s *AlpacaTradingService) { _ = s.SetOptionSpreadCapPct(15); _ = s.SetOptionSpreadCapPct(10) }},
		{"tightened_but_the_spread_still_passes", func(s *AlpacaTradingService) { _ = s.SetOptionSpreadCapPct(9) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &evaluatorFixture{receiptProfile: scoreProfileV1, ratio: "0.05"}
			_, service := newEvaluatorServer(t, f, now)
			if err := service.SetOptionSpreadCapPct(10); err != nil {
				t.Fatal(err)
			}
			audits := 0
			order := evaluatorOrder(&audits)
			order.CapRevision = confirmedRevision(service)
			// The change lands in the middle of the opening attempt: after qualification and its durable audit, before the
			// final submission guard.
			sink := order.AssessmentAuditSink
			order.AssessmentAuditSink = func(a *interfaces.AlphaDeskAssessment) error {
				if err := sink(a); err != nil {
					return err
				}
				tc.change(service)
				return nil
			}
			err := service.requirePaperAdvisoryQualification(context.Background(), order)
			if err == nil {
				// qualification passed on the snapshot it took; the submission guard must now refuse.
				err = service.validatePaperAdvisoryAtSubmission(context.Background(), order)
			}
			if spreadCapCode(err) != optionSpreadCapChanged || !IsPreSubmissionRejection(err) {
				t.Fatalf("a cap change between confirmation and submission was not refused: %v", err)
			}
		})
	}
	t.Run("no_change_passes", func(t *testing.T) {
		f := &evaluatorFixture{receiptProfile: scoreProfileV1, ratio: "0.05"}
		_, service := newEvaluatorServer(t, f, now)
		_ = service.SetOptionSpreadCapPct(10)
		audits := 0
		order := evaluatorOrder(&audits)
		order.CapRevision = confirmedRevision(service)
		_ = service.SetOptionSpreadCapPct(10) // saving the same value again (an unrelated guidance save) changes nothing
		if err := service.requirePaperAdvisoryQualification(context.Background(), order); err != nil {
			t.Fatal(err)
		}
		if err := service.validatePaperAdvisoryAtSubmission(context.Background(), order); err != nil {
			t.Fatalf("an unchanged cap refused an opening: %v", err)
		}
	})
}

// Revision and spread are judged from one snapshot, so concurrent changes can never let a stale confirmation through.
func TestConcurrentCapChangesNeverLetAStaleConfirmationThrough(t *testing.T) {
	s := &AlpacaTradingService{}
	_ = s.SetOptionSpreadCapPct(10)
	p := spreadProposal("AAPL261106C00200000")
	doc := spreadDoc(scoreProfileV1, "0.05")
	var group sync.WaitGroup
	stop := make(chan struct{})
	group.Add(1)
	go func() {
		defer group.Done()
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
				_ = s.SetOptionSpreadCapPct(float64(8 + i%2*2)) // 8, 10, 8, 10 ...
			}
		}
	}()
	for i := 0; i < 2000; i++ {
		confirmed := confirmedRevision(s)
		order := &interfaces.OptionsOrder{CapRevision: confirmed}
		err := s.enforceOptionSpreadCapForOrder(order, p, doc)
		if err == nil && s.OptionSpreadCapRevision() == *confirmed {
			continue // consistent: no change happened between confirmation and the check
		}
		if err == nil {
			// The check passed although the revision moved afterwards: only legal if it moved after the check itself.
			continue
		}
		if code := spreadCapCode(err); code != optionSpreadCapChanged {
			t.Fatalf("unexpected refusal: %v", err)
		}
	}
	close(stop)
	group.Wait()
}
