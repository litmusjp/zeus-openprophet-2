package services

import (
	"prophet-trader/models"
	"strings"
	"testing"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	"github.com/shopspring/decimal"
)

func TestCancellationReadbackCarriesTerminalFillEvidence(t *testing.T) {
	price := decimal.NewFromFloat(12.5)
	err := classifyCancellationReadback("broker-1", &alpaca.Order{
		ID: "broker-1", Status: "canceled", Qty: decimalPtr(decimal.NewFromInt(2)),
		FilledQty: decimal.NewFromInt(1), FilledAvgPrice: &price,
	}, nil, models.DurableIdentity{BrokerAccountID: "acct", PaperLive: "paper", TenantID: "tenant", SandboxID: "sandbox"})
	if !IsSubmissionUncertain(err) || !strings.Contains(err.Error(), "filled") {
		t.Fatalf("err = %v, want uncertain terminal fill", err)
	}
	var uncertain *SubmissionUncertainError
	if !asSubmissionUncertain(err, &uncertain) || uncertain.Result == nil || uncertain.Result.FilledQty != 1 || uncertain.Result.Status != "canceled" {
		t.Fatalf("uncertain evidence = %#v, want canceled fill result", uncertain)
	}
	if uncertain.Result.BrokerAccountID != "acct" || uncertain.Result.PaperLive != "paper" || uncertain.Result.TenantID != "tenant" || uncertain.Result.SandboxID != "sandbox" {
		t.Fatalf("cancellation evidence identity = %#v, want server-owned identity", uncertain.Result)
	}
}

func asSubmissionUncertain(err error, target **SubmissionUncertainError) bool {
	if value, ok := err.(*SubmissionUncertainError); ok {
		*target = value
		return true
	}
	return false
}
