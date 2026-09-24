package controllers

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"prophet-trader/interfaces"

	"github.com/gin-gonic/gin"
)

func TestValidateOptionsAssessmentRequestRejectsIncompleteRequestBeforeProvider(t *testing.T) {
	req := OptionsOrderRequest{Symbol: "SPY", Underlying: "SPY", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit"}
	err := validateOptionsAssessmentRequest(req)
	var structured *optionsAssessmentValidationError
	if err == nil || !errors.As(err, &structured) {
		t.Fatal("expected local assessment validation error")
	}
	if !strings.Contains(structured.Fields["symbol"], "OCC") {
		t.Fatalf("symbol validation = %#v, want field-level OCC symbol detail", structured.Fields)
	}
}

func TestAssessOptionsStrategyReturnsStructuredLocalValidationWithoutProviderCall(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/options/assessment", bytes.NewBufferString(`{"symbol":"SPY","underlying":"SPY","qty":1,"side":"buy","position_intent":"buy_to_open","type":"limit","time_in_force":"day"}`))
	ctx.Request.Header.Set("Content-Type", "application/json")
	(&OrderController{}).AssessOptionsStrategy(ctx)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"category":"local_validation"`) || !strings.Contains(recorder.Body.String(), `"symbol"`) {
		t.Fatalf("status=%d body=%s, want structured local validation", recorder.Code, recorder.Body.String())
	}
}

func TestValidateOptionsAssessmentRequestRequiresExactEvidenceWhenSupplied(t *testing.T) {
	req := OptionsOrderRequest{Symbol: "SPY251219C00400000", Underlying: "SPY", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day"}
	err := validateOptionsAssessmentRequest(req)
	var structured *optionsAssessmentValidationError
	if err == nil || !errors.As(err, &structured) || !strings.Contains(structured.Fields["legs"], "required") {
		t.Fatalf("error = %v, want missing legs field", err)
	}
}

func TestValidateOptionsAssessmentRequestAcceptsExactEvidence(t *testing.T) {
	price := 1.25
	req := OptionsOrderRequest{Symbol: "SPY251219C00400000", Underlying: "SPY", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: &price, StrategyType: "SINGLE_LEG_OPTION"}
	req.AssessmentLegs = []interfaces.AlphaDeskAssessmentLeg{{Symbol: req.Symbol, Side: "buy", Quantity: 1, Price: price, Bid: 1.2, Ask: 1.3, QuoteSize: 10, QuotedAt: time.Now()}}
	maxLoss := 125.0
	req.MaxLoss = &maxLoss
	req.Greeks = map[string]float64{"delta": 0.5}
	req.MarketEvidenceAt = time.Now()
	req.ObservedAt = time.Now()
	req.ExpiresAt = time.Now().Add(time.Minute)
	if err := validateOptionsAssessmentRequest(req); err != nil {
		t.Fatalf("exact evidence request rejected: %v", err)
	}
}

func TestValidateOptionsAssessmentRequestAcceptsTwoLegVertical(t *testing.T) {
	quoted := time.Date(2026, 9, 24, 1, 0, 0, 0, time.UTC)
	price := 2.50
	maxLoss := 250.0
	req := OptionsOrderRequest{
		Symbol:           "SPY261016C00400000",
		Underlying:       "SPY",
		Qty:              1,
		Side:             "buy",
		PositionIntent:   "buy_to_open",
		Type:             "limit",
		TimeInForce:      "day",
		LimitPrice:       &price,
		StrategyType:     "VERTICAL",
		MaxLoss:          &maxLoss,
		Greeks:           map[string]float64{"delta": 0.25, "gamma": 0.01},
		MarketEvidenceAt: quoted,
		ObservedAt:       quoted.Add(time.Second),
		ExpiresAt:        quoted.Add(time.Minute),
		AssessmentLegs: []interfaces.AlphaDeskAssessmentLeg{
			{Symbol: "SPY261016C00400000", Side: "buy", Quantity: 1, Price: 2.50, Bid: 2.40, Ask: 2.60, QuoteSize: 10, QuotedAt: quoted},
			{Symbol: "SPY261016C00405000", Side: "sell", Quantity: 1, Price: 1.25, Bid: 1.20, Ask: 1.30, QuoteSize: 12, QuotedAt: quoted},
		},
	}
	if err := validateOptionsAssessmentRequest(req); err != nil {
		t.Fatalf("valid two-leg vertical rejected: %v", err)
	}
}
