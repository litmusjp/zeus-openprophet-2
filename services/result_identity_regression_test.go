package services

import (
	"prophet-trader/interfaces"
	"prophet-trader/models"
	"testing"
)

func TestValidateOrderResultIdentityRequiresExactDurableIdentity(t *testing.T) {
	expected := models.DurableIdentity{BrokerAccountID: "acct", PaperLive: "paper", TenantID: "tenant", SandboxID: "sandbox"}
	base := &interfaces.OrderResult{OrderID: "broker-1", ClientOrderID: "client-1", Status: "accepted", Symbol: "AAPL", Side: "buy", Qty: 1, Type: "market", TimeInForce: "day", BrokerAccountID: "acct", PaperLive: "paper", TenantID: "tenant", SandboxID: "sandbox"}
	for name, mutate := range map[string]func(*interfaces.OrderResult){
		"missing":     func(r *interfaces.OrderResult) { r.SandboxID = "" },
		"account":     func(r *interfaces.OrderResult) { r.BrokerAccountID = "other" },
		"environment": func(r *interfaces.OrderResult) { r.PaperLive = "live" },
		"tenant":      func(r *interfaces.OrderResult) { r.TenantID = "other" },
		"sandbox":     func(r *interfaces.OrderResult) { r.SandboxID = "other" },
	} {
		t.Run(name, func(t *testing.T) {
			result := *base
			mutate(&result)
			if err := ValidateOrderResultIdentityForExecution(&result, expected); err == nil {
				t.Fatal("accepted invalid durable identity")
			}
		})
	}
	if err := ValidateOrderResultIdentityForExecution(base, expected); err != nil {
		t.Fatalf("valid identity rejected: %v", err)
	}
}
