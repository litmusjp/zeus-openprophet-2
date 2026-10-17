package services

import "testing"

func TestManagedGateUnavailableOnlyClaimsHumanReviewWhenCurrentPolicyIsOn(t *testing.T) {
	for _, tc := range []struct {
		name string
		on   bool
		want string
	}{{"authoritative ON", true, "managed_review_required"}, {"revised OFF", false, "response_validation"}, {"unknown", false, "response_validation"}} {
		t.Run(tc.name, func(t *testing.T) {
			err := managedGateUnavailable("gate outcome", tc.on).(*AlphaDeskUnavailableError)
			if err.Category != tc.want || err.Decision != "UNAVAILABLE" || err.Stage != "approval_gate" {
				t.Fatalf("error=%+v, want category %s and unavailable approval gate", err, tc.want)
			}
		})
	}
}
