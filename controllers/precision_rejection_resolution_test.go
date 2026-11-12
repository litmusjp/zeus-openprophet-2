package controllers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"prophet-trader/interfaces"
	"prophet-trader/models"
	"prophet-trader/services"
)

// lookupTrading answers the broker lookup by client_order_id only; any other call panics (nil embedded service),
// which proves the resolution never submits, cancels or replays anything.
type lookupTrading struct {
	interfaces.TradingService
	order *interfaces.Order
	err   error
	calls int
}

func (s *lookupTrading) GetOrderByClientOrderID(_ context.Context, clientOrderID string) (*interfaces.Order, error) {
	s.calls++
	if s.err != nil || s.order != nil {
		return s.order, s.err
	}
	return nil, &services.OrderLookupError{ClientOrderID: clientOrderID, NotFound: true, Err: errors.New("order not found")}
}

const precisionFailureMetadata = `{"op2_failure":{"status":"submission_uncertain","reason":"submission_uncertain: broker submission result is unknown: failed to place options order with client_order_id ge-scalp-20261111-1451-01: limit price must be limited to 2 decimal places (HTTP 422, Code 42210000)"},"other":"kept"}`

func precisionOrder() *interfaces.Order {
	return &interfaces.Order{
		BrokerAccountID: "test-broker-account", PaperLive: "paper", TenantID: "test-tenant", SandboxID: "test-sandbox",
		ID: "", ClientOrderID: "ge-scalp-20261111-1451-01", Symbol: "GE261120C00337500", Status: "submission_uncertain",
		SubmissionAttempted: true, Metadata: precisionFailureMetadata,
	}
}

func precisionIdentity() models.DurableIdentity {
	return models.DurableIdentity{BrokerAccountID: "test-broker-account", PaperLive: "paper", TenantID: "test-tenant", SandboxID: "test-sandbox"}
}

func resolveRequest(oc *OrderController, clientOrderID, token string) *httptest.ResponseRecorder {
	router := gin.New()
	router.POST("/orders/resolve-precision-rejection", oc.HandleResolvePrecisionRejection)
	body, _ := json.Marshal(map[string]string{"client_order_id": clientOrderID})
	req := httptest.NewRequest(http.MethodPost, "/orders/resolve-precision-rejection", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("X-OpenProphet-Operator-Token", token)
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func TestResolvePrecisionRejectionSucceedsOnlyWithAllEvidenceAndKeepsTheRecord(t *testing.T) {
	t.Setenv("TRADING_BOT_OPERATOR_TOKEN", "operator-secret")
	order := precisionOrder()
	storage := &cancelTestStorage{identity: precisionIdentity(), order: order}
	trading := &lookupTrading{}
	oc := NewOrderController(trading, nil, storage)
	rec := resolveRequest(oc, order.ClientOrderID, "operator-secret")
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if storage.order.Status != "rejected" || storage.order.ClientOrderID != "ge-scalp-20261111-1451-01" || !storage.order.SubmissionAttempted ||
		storage.order.Symbol != "GE261120C00337500" || storage.order.ID != "" || storage.order.FilledQty != 0 {
		t.Fatalf("record not kept as expected: %#v", storage.order)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal([]byte(storage.order.Metadata), &doc); err != nil {
		t.Fatal(err)
	}
	if _, ok := doc["op2_failure"]; !ok {
		t.Fatal("original failure evidence was lost")
	}
	if string(doc["other"]) != `"kept"` {
		t.Fatalf("other metadata lost: %s", storage.order.Metadata)
	}
	var resolution map[string]string
	if err := json.Unmarshal(doc["resolution"], &resolution); err != nil {
		t.Fatalf("resolution metadata missing: %v", err)
	}
	if resolution["by"] != "operator" || resolution["rule"] != precisionResolutionRule || resolution["broker_lookup"] != "not_found" || resolution["previous_status"] != "submission_uncertain" || resolution["at"] == "" {
		t.Fatalf("unexpected resolution metadata: %v", resolution)
	}
	if trading.calls != 1 {
		t.Fatalf("broker lookups=%d, want exactly 1", trading.calls)
	}
}

func TestResolvePrecisionRejectionRefusesAndChangesNothingOtherwise(t *testing.T) {
	cases := map[string]struct {
		mutate  func(*interfaces.Order)
		trading *lookupTrading
		token   string
		code    int
	}{
		"no operator token":     {func(o *interfaces.Order) {}, &lookupTrading{}, "", http.StatusForbidden},
		"wrong operator token":  {func(o *interfaces.Order) {}, &lookupTrading{}, "nope", http.StatusForbidden},
		"broker has the order":  {func(o *interfaces.Order) {}, &lookupTrading{order: &interfaces.Order{ID: "b1", Status: "new"}}, "operator-secret", http.StatusConflict},
		"broker lookup unclear": {func(o *interfaces.Order) {}, &lookupTrading{err: errors.New("timeout")}, "operator-secret", http.StatusConflict},
		"different failure reason": {func(o *interfaces.Order) {
			o.Metadata = `{"op2_failure":{"status":"submission_uncertain","reason":"client_order_id must be unique (HTTP 422, Code 42210000)"}}`
		}, &lookupTrading{}, "operator-secret", http.StatusConflict},
		"no failure evidence": {func(o *interfaces.Order) { o.Metadata = "" }, &lookupTrading{}, "operator-secret", http.StatusConflict},
		"filled quantity":     {func(o *interfaces.Order) { o.FilledQty = 1 }, &lookupTrading{}, "operator-secret", http.StatusConflict},
		"broker order id":     {func(o *interfaces.Order) { o.ID = "broker-1" }, &lookupTrading{}, "operator-secret", http.StatusConflict},
		"not uncertain":       {func(o *interfaces.Order) { o.Status = "submit_failed" }, &lookupTrading{}, "operator-secret", http.StatusConflict},
		"other sandbox":       {func(o *interfaces.Order) { o.SandboxID = "another-sandbox" }, &lookupTrading{}, "operator-secret", http.StatusConflict},
		"not paper":           {func(o *interfaces.Order) { o.PaperLive = "live" }, &lookupTrading{}, "operator-secret", http.StatusConflict},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Setenv("TRADING_BOT_OPERATOR_TOKEN", "operator-secret")
			order := precisionOrder()
			tc.mutate(order)
			before := *order
			storage := &cancelTestStorage{identity: precisionIdentity(), order: order}
			oc := NewOrderController(tc.trading, nil, storage)
			rec := resolveRequest(oc, "ge-scalp-20261111-1451-01", tc.token)
			if rec.Code != tc.code {
				t.Fatalf("status=%d, want %d; body=%s", rec.Code, tc.code, rec.Body.String())
			}
			if storage.order.Status != before.Status || storage.order.Metadata != before.Metadata || storage.order.ID != before.ID ||
				storage.order.FilledQty != before.FilledQty || storage.order.SandboxID != before.SandboxID || storage.order.PaperLive != before.PaperLive {
				t.Fatalf("record changed on a refusal: %#v", storage.order)
			}
		})
	}
}

func TestResolvePrecisionRejectionUnknownOrderAndBadRequest(t *testing.T) {
	t.Setenv("TRADING_BOT_OPERATOR_TOKEN", "operator-secret")
	oc := NewOrderController(&lookupTrading{}, nil, &cancelTestStorage{identity: precisionIdentity(), order: precisionOrder()})
	if rec := resolveRequest(oc, "does-not-exist", "operator-secret"); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown order status=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := resolveRequest(oc, "  ", "operator-secret"); rec.Code != http.StatusBadRequest {
		t.Fatalf("empty id status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(precisionFailureReason(precisionFailureMetadata), "42210000") {
		t.Fatal("reason helper does not read op2_failure.reason")
	}
}
