package services

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

// The one cache path that does not compare the policy or evaluator version is the legacy non-managed contract on the
// read-only assessment path. These tests pin its scope: it is unreachable under the live (managed) configuration and
// it is never what an order guard uses.
func TestLegacyNonManagedCacheExceptionIsExplicitlyScoped(t *testing.T) {
	now := time.Now().UTC()
	p := spreadProposal("AAPL261106C00200000")

	t.Run("legacy_read_only_path_is_bounded_by_the_receipt_expiry", func(t *testing.T) {
		f := &evaluatorFixture{receiptProfile: scoreProfileV1, ratio: "0.09"}
		_, service := newEvaluatorServer(t, f, now)
		identity := service.standaloneIdentity()
		if _, err := service.alphaDesk.cachedStandalone(context.Background(), identity, p, false); err != nil {
			t.Fatal(err)
		}
		getsAfterFirst := f.gets
		// The policy moves to v2: this legacy branch does not read it (documented), so the cached v1 receipt is served.
		f.set(func(f *evaluatorFixture) { f.policyProfile = scoreProfileV2 })
		if _, err := service.alphaDesk.cachedStandalone(context.Background(), identity, p, false); err != nil {
			t.Fatal(err)
		}
		if f.posts != 1 || f.gets != getsAfterFirst {
			t.Fatalf("the exception changed: posts=%d gets=%d (was %d)", f.posts, f.gets, getsAfterFirst)
		}
		// ...but its own expiry still ends it.
		service.alphaDesk.Now = func() time.Time { return now.Add(3 * time.Minute) }
		if _, err := service.alphaDesk.cachedStandalone(context.Background(), identity, p, false); err == nil && f.posts == 1 {
			t.Fatal("an expired receipt was served from the legacy branch")
		}
	})

	t.Run("an_order_guard_never_uses_the_exception", func(t *testing.T) {
		f := &evaluatorFixture{receiptProfile: scoreProfileV1, ratio: "0.09"}
		_, service := newEvaluatorServer(t, f, now)
		identity := service.standaloneIdentity()
		if _, err := service.alphaDesk.cachedStandalone(context.Background(), identity, p, false); err != nil {
			t.Fatal(err)
		}
		f.set(func(f *evaluatorFixture) { f.policyProfile = scoreProfileV2 })
		audits := 0
		order := evaluatorOrder(&audits)
		if err := service.requirePaperAdvisoryQualification(context.Background(), order); err == nil || audits != 0 || order.AlphaDeskAssessment != nil {
			t.Fatalf("a cached v1 receipt crossed the order guard after the evaluator moved to v2: err=%v", err)
		}
	})

	t.Run("unreachable_when_the_managed_gate_is_required", func(t *testing.T) {
		f := &evaluatorFixture{receiptProfile: scoreProfileV1, ratio: "0.09"}
		_, service := newEvaluatorServer(t, f, now)
		service.alphaDesk.RequireManagedApprovalGate = true
		identity := service.standaloneIdentity()
		for attempt := 0; attempt < 2; attempt++ {
			_, err := service.alphaDesk.cachedStandalone(context.Background(), identity, p, false)
			var unavailable *AlphaDeskUnavailableError
			if !errors.As(err, &unavailable) || unavailable.Stage != "approval_gate" {
				t.Fatalf("attempt %d: a non-managed receipt was accepted under the managed configuration: %v", attempt, err)
			}
		}
		if len(service.alphaDesk.standaloneCache) != 0 {
			t.Fatal("a non-managed receipt was cached under the managed configuration")
		}
	})

	t.Run("the_exception_is_documented_at_the_branch", func(t *testing.T) {
		source, err := readServiceSource("alphadesk_standalone_guard.go")
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(source, "Explicit exception, limited to this branch") {
			t.Fatal("the legacy cache exception lost its explicit scope comment")
		}
	})
}

func readServiceSource(name string) (string, error) {
	data, err := os.ReadFile(name)
	return string(data), err
}
