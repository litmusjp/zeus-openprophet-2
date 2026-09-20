package services

import "testing"

func TestHasExactlyOneExecutableProtectionLeg(t *testing.T) {
	tests := []struct {
		name string
		pos  *ManagedPosition
		want bool
	}{
		{name: "stop-only", pos: &ManagedPosition{Status: "ACTIVE", StopLossOrderID: "stop-1"}, want: true},
		{name: "take-profit-only", pos: &ManagedPosition{Status: "ACTIVE", TakeProfitOrderID: "take-1"}, want: true},
		{name: "partial-exit-only", pos: &ManagedPosition{Status: "ACTIVE", PartialExitOrders: []string{"partial-1"}}, want: true},
		{name: "missing-protection", pos: &ManagedPosition{Status: "ACTIVE"}, want: false},
		{name: "competing-legs", pos: &ManagedPosition{Status: "ACTIVE", StopLossOrderID: "stop-1", TakeProfitOrderID: "take-1"}, want: false},
		{name: "malformed-partial", pos: &ManagedPosition{Status: "ACTIVE", PartialExitOrders: []string{""}}, want: false},
		{name: "blocked", pos: &ManagedPosition{Status: "PROTECTION_BLOCKED", StopLossOrderID: "stop-1"}, want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := hasExactlyOneExecutableProtectionLeg(tt.pos); got != tt.want {
				t.Fatalf("hasExactlyOneExecutableProtectionLeg() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestClearExecutionBlockIfSafeAcceptsEachSingleProtectionLeg(t *testing.T) {
	for _, position := range []*ManagedPosition{
		{Status: "ACTIVE", StopLossOrderID: "stop-1"},
		{Status: "ACTIVE", TakeProfitOrderID: "take-1"},
		{Status: "ACTIVE", PartialExitOrders: []string{"partial-1"}},
	} {
		pm := &PositionManager{positions: map[string]*ManagedPosition{"p": position}, executionBlocked: true}
		pm.clearExecutionBlockIfSafe()
		if pm.ExecutionBlocked() {
			t.Fatalf("single protection leg %q did not clear execution block", position.StopLossOrderID+position.TakeProfitOrderID)
		}
	}
}
