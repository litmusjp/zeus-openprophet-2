package services

import (
	"testing"

	"prophet-trader/interfaces"
)

func TestIsRiskRelevantLocalOrderSeparatesApplicationIntentsFromBrokerRisk(t *testing.T) {
	cases := []struct {
		name  string
		order *interfaces.Order
		want  bool
	}{
		{name: "bounded planned stock intent is broker risk", order: &interfaces.Order{Status: "planned_for_next_session", Purpose: "entry", LimitPrice: floatPtr(100)}, want: true},
		{name: "bounded planned stop intent is broker risk", order: &interfaces.Order{Status: "planned_for_next_session", Purpose: "entry", StopPrice: floatPtr(99)}, want: true},
		{name: "unbounded planned intent is not broker risk", order: &interfaces.Order{Status: "planned_for_next_session", Purpose: "entry"}, want: false},
		{name: "unsubmitted priced failure is not broker risk", order: &interfaces.Order{Status: "submit_failed", Purpose: "entry", LimitPrice: floatPtr(100), SubmissionAttempted: false}, want: false},
		{name: "pending local intent before boundary is not broker risk", order: &interfaces.Order{Status: "pending", Purpose: "entry", SubmissionAttempted: false}, want: false},
		{name: "broker identity remains risk relevant", order: &interfaces.Order{Status: "pending", ID: "broker-1", Purpose: "entry"}, want: true},
		{name: "uncertain submission remains risk relevant", order: &interfaces.Order{Status: "submission_uncertain", Purpose: "entry", SubmissionAttempted: true}, want: true},
		{name: "risk reducing exit remains safe and irrelevant to opening caps", order: &interfaces.Order{Status: "pending", ID: "broker-exit", Purpose: "close"}, want: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsRiskRelevantLocalOrder(tc.order); got != tc.want {
				t.Fatalf("IsRiskRelevantLocalOrder() = %v, want %v for %#v", got, tc.want, tc.order)
			}
		})
	}
}
