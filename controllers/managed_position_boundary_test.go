package controllers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"prophet-trader/database"
	"prophet-trader/interfaces"
	"prophet-trader/services"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

type managedQuoteData struct {
	err   error
	quote *interfaces.Quote
}

func (d *managedQuoteData) GetLatestQuote(context.Context, string) (*interfaces.Quote, error) {
	return d.quote, d.err
}
func (d *managedQuoteData) GetHistoricalBars(context.Context, string, time.Time, time.Time, string) ([]*interfaces.Bar, error) {
	return nil, nil
}
func (d *managedQuoteData) GetLatestBar(context.Context, string) (*interfaces.Bar, error) {
	return nil, nil
}
func (d *managedQuoteData) GetLatestTrade(context.Context, string) (*interfaces.Trade, error) {
	return nil, nil
}
func (d *managedQuoteData) StreamBars(context.Context, []string) (<-chan *interfaces.Bar, error) {
	return nil, nil
}

func managedPositionRequest(t *testing.T, pm *services.PositionManager, body string) *httptest.ResponseRecorder {
	t.Helper()
	router := gin.New()
	router.POST("/positions/managed", NewPositionManagementController(pm).HandlePlaceManagedPosition)
	req := httptest.NewRequest(http.MethodPost, "/positions/managed", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func managedResponse(t *testing.T, rec *httptest.ResponseRecorder) map[string]interface{} {
	t.Helper()
	var body map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response JSON: %v; body=%s", err, rec.Body.String())
	}
	return body
}

func TestManagedPositionGinBoundaryClassifiesInvalidRequest(t *testing.T) {
	t.Setenv("ALPACA_ACCOUNT_ID", "test-broker-account")
	t.Setenv("ALPACA_PAPER", "true")
	t.Setenv("OPENPROPHET_TENANT_ID", "test-tenant")
	t.Setenv("OPENPROPHET_SANDBOX_ID", "test-sandbox")
	storage, err := database.NewLocalStorage(t.TempDir() + "/managed-invalid.db")
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()
	pm := services.NewPositionManager(&reconciliationTradingService{}, &managedQuoteData{}, storage)
	rec := managedPositionRequest(t, pm, `{"client_order_id":"managed-invalid","symbol":"AAPL","side":"buy","allocation_dollars":1000,"entry_strategy":"market","entry_price":100,"stop_loss_price":90}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s; want 400", rec.Code, rec.Body.String())
	}
	body := managedResponse(t, rec)
	if body["category"] != "invalid_request" || body["retryable"] != false {
		t.Fatalf("body=%v; want structured non-retryable invalid diagnostic", body)
	}
}

func TestManagedPositionGinBoundaryClassifiesMarketDataUnavailable(t *testing.T) {
	t.Setenv("ALPACA_ACCOUNT_ID", "test-broker-account")
	t.Setenv("ALPACA_PAPER", "true")
	t.Setenv("OPENPROPHET_TENANT_ID", "test-tenant")
	t.Setenv("OPENPROPHET_SANDBOX_ID", "test-sandbox")
	storage, err := database.NewLocalStorage(t.TempDir() + "/managed-unavailable.db")
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()
	pm := services.NewPositionManager(&reconciliationTradingService{}, &managedQuoteData{err: errors.New("quote provider unavailable")}, storage)
	rec := managedPositionRequest(t, pm, `{"client_order_id":"managed-unavailable","symbol":"AAPL","side":"buy","allocation_dollars":1000,"entry_strategy":"limit","entry_price":100,"stop_loss_price":90}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s; want 503", rec.Code, rec.Body.String())
	}
	body := managedResponse(t, rec)
	if body["category"] != "market_data_unavailable" || body["retryable"] != true {
		t.Fatalf("body=%v; want structured retryable availability diagnostic", body)
	}
}

func TestCloseManagedPositionMissingIDReturnsStructured404(t *testing.T) {
	t.Setenv("TRADING_BOT_OPERATOR_TOKEN", "operator-secret")
	t.Setenv("ALPACA_ACCOUNT_ID", "test-broker-account")
	t.Setenv("ALPACA_PAPER", "true")
	t.Setenv("OPENPROPHET_TENANT_ID", "test-tenant")
	t.Setenv("OPENPROPHET_SANDBOX_ID", "test-sandbox")
	storage, err := database.NewLocalStorage(t.TempDir() + "/managed-close-missing.db")
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()
	pm := services.NewPositionManager(&reconciliationTradingService{}, &managedQuoteData{}, storage)
	router := gin.New()
	router.DELETE("/positions/managed/:id", NewPositionManagementController(pm).HandleCloseManagedPosition)
	req := httptest.NewRequest(http.MethodDelete, "/positions/managed/missing", nil)
	req.Header.Set("X-OpenProphet-Operator-Token", "operator-secret")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s; want 404", rec.Code, rec.Body.String())
	}
	body := managedResponse(t, rec)
	if body["category"] != "not_found" || body["error"] != "managed_position_not_found" {
		t.Fatalf("body=%v; want structured 404", body)
	}
}

func TestCancelOrderGinBoundaryRejectsPlannedIntentWithoutBrokerCall(t *testing.T) {
	t.Setenv("TRADING_BOT_OPERATOR_TOKEN", "operator-secret")
	order := cancelTestOrder()
	order.ID = ""
	order.Status = "planned_for_next_session"
	trading := &cancelTestTrading{}
	oc := cancelTestController(order, trading)
	router := gin.New()
	router.DELETE("/orders/:id", oc.HandleCancelOrder)
	req := httptest.NewRequest(http.MethodDelete, "/orders/"+order.ClientOrderID, nil)
	req.Header.Set("X-OpenProphet-Operator-Token", "operator-secret")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s; want 409", rec.Code, rec.Body.String())
	}
	body := managedResponse(t, rec)
	if body["category"] != "planned_intent_conflict" || body["retryable"] != false {
		t.Fatalf("body=%v; want non-retryable conflict", body)
	}
	if trading.calls != 0 {
		t.Fatalf("broker cancel calls=%d; want 0 for planned intent", trading.calls)
	}
}

func TestCancelOrderGinBoundaryRejectsUnsubmittedFailureWithoutBrokerCall(t *testing.T) {
	t.Setenv("TRADING_BOT_OPERATOR_TOKEN", "operator-secret")
	order := cancelTestOrder()
	order.ID = ""
	order.Status = "submit_failed"
	order.SubmissionAttempted = false
	trading := &cancelTestTrading{}
	oc := cancelTestController(order, trading)
	router := gin.New()
	router.DELETE("/orders/:id", oc.HandleCancelOrder)
	req := httptest.NewRequest(http.MethodDelete, "/orders/"+order.ClientOrderID, nil)
	req.Header.Set("X-OpenProphet-Operator-Token", "operator-secret")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s; want 409", rec.Code, rec.Body.String())
	}
	body := managedResponse(t, rec)
	if body["error"] != "planned_intent_not_broker_visible" || body["category"] != "local_intent_not_broker_visible" {
		t.Fatalf("body=%v; want structured local-intent conflict", body)
	}
	if trading.calls != 0 {
		t.Fatalf("broker cancel calls=%d; want 0 for unsubmitted local failure", trading.calls)
	}
}

func TestCancelOrderGinBoundaryAllowsLocalIntentClassificationWhileExecutionBlocked(t *testing.T) {
	t.Setenv("TRADING_BOT_OPERATOR_TOKEN", "operator-secret")
	order := cancelTestOrder()
	order.ID = ""
	order.Status = "planned_for_next_session"
	order.SubmissionAttempted = false
	trading := &cancelTestTrading{}
	oc := cancelTestController(order, trading)
	oc.SetExecutionBlocked(true)
	router := gin.New()
	router.DELETE("/orders/:id", oc.HandleCancelOrder)
	req := httptest.NewRequest(http.MethodDelete, "/orders/"+order.ClientOrderID, nil)
	req.Header.Set("X-OpenProphet-Operator-Token", "operator-secret")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s; want 409 local conflict", rec.Code, rec.Body.String())
	}
	body := managedResponse(t, rec)
	if body["error"] != "planned_intent_not_broker_visible" {
		t.Fatalf("body=%v; want local not-broker-visible result", body)
	}
	if trading.calls != 0 {
		t.Fatalf("broker cancel calls=%d; want 0 for local intent", trading.calls)
	}
}

func TestCancelOrderGinBoundaryRejectsBrokerCancellationWhileExecutionBlocked(t *testing.T) {
	t.Setenv("TRADING_BOT_OPERATOR_TOKEN", "operator-secret")
	order := cancelTestOrder()
	order.ID = "broker-visible-1"
	order.Status = "open"
	order.SubmissionAttempted = true
	trading := &cancelTestTrading{}
	oc := cancelTestController(order, trading)
	oc.SetExecutionBlocked(true)
	router := gin.New()
	router.DELETE("/orders/:id", oc.HandleCancelOrder)
	req := httptest.NewRequest(http.MethodDelete, "/orders/"+order.ID, nil)
	req.Header.Set("X-OpenProphet-Operator-Token", "operator-secret")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s; want 503 blocked response", rec.Code, rec.Body.String())
	}
	if trading.calls != 0 {
		t.Fatalf("broker cancel calls=%d; want 0 while blocked", trading.calls)
	}
}
