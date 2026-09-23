package controllers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"prophet-trader/database"
	"prophet-trader/interfaces"
	"prophet-trader/services"
)

func TestOptionsOrderRequestHasNoClientAssessmentAuthorizationField(t *testing.T) {
	if _, ok := reflect.TypeOf(OptionsOrderRequest{}).FieldByName("Assessment"); ok {
		t.Fatal("OptionsOrderRequest must not accept a client-supplied AlphaDesk assessment")
	}
}

type plannedOptionsTradingService struct {
	*reconciliationTradingService
	nextOpen time.Time
}

type optionsResultTradingService struct {
	*reconciliationTradingService
	result *interfaces.OrderResult
}

type emptyOptionsChainTradingService struct {
	*reconciliationTradingService
	clock *interfaces.MarketClock
}

type recordingOptionsTradingService struct {
	*reconciliationTradingService
	identity    *interfaces.OptionsOrder
	result      *interfaces.OrderResult
	auditCalled bool
}

func (s *recordingOptionsTradingService) PlaceOptionsOrder(_ context.Context, order *interfaces.OptionsOrder) (*interfaces.OrderResult, error) {
	s.identity = order
	assessment := &interfaces.AlphaDeskAssessment{AssessmentID: "assessment-controller-boundary", Decision: "PASS", Pass: true, Qualified: true}
	s.auditCalled = true
	if err := order.AssessmentAuditSink(assessment); err != nil {
		return nil, err
	}
	result := *s.result
	return &result, nil
}

func (s *emptyOptionsChainTradingService) GetMarketClock(context.Context) (*interfaces.MarketClock, error) {
	return s.clock, nil
}

func TestOptionsChainEmptyResultDistinguishesClosedFromValidEmpty(t *testing.T) {
	for _, tc := range []struct {
		name string
		open bool
		want int
	}{
		{name: "pre-market", open: false, want: http.StatusServiceUnavailable},
		{name: "post-open empty", open: true, want: http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			trading := &emptyOptionsChainTradingService{
				reconciliationTradingService: &reconciliationTradingService{},
				clock:                        &interfaces.MarketClock{IsOpen: tc.open},
			}
			controller := NewOrderController(trading, nil, nil)
			recorder := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			ctx.Params = gin.Params{{Key: "symbol", Value: "XLF"}}
			ctx.Request = httptest.NewRequest(http.MethodGet, "/api/options/chain/XLF", nil)
			controller.GetOptionsChain(ctx)
			if recorder.Code != tc.want {
				t.Fatalf("status = %d, want %d; body=%s", recorder.Code, tc.want, recorder.Body.String())
			}
		})
	}
}

func (s *optionsResultTradingService) PlaceOptionsOrder(context.Context, *interfaces.OptionsOrder) (*interfaces.OrderResult, error) {
	result := *s.result
	return &result, nil
}

func TestPlaceOptionsOrderValidatesProviderResultAgainstServerIdentity(t *testing.T) {
	tests := []struct {
		name       string
		mutate     func(*interfaces.OrderResult)
		wantStatus int
	}{
		{name: "complete matching identity", wantStatus: 200},
		{name: "missing identity", mutate: func(result *interfaces.OrderResult) { result.SandboxID = "" }, wantStatus: 502},
		{name: "mismatched identity", mutate: func(result *interfaces.OrderResult) { result.TenantID = "other-tenant" }, wantStatus: 502},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			storage, err := database.NewLocalStorage(filepath.Join(t.TempDir(), "orders.db"))
			if err != nil {
				t.Fatalf("NewLocalStorage() error = %v", err)
			}
			defer storage.Close()
			identity := storage.DurableIdentity()

			result := &interfaces.OrderResult{
				OrderID: "broker-options-1", Status: "accepted", ClientOrderID: "opt-identity-1", Symbol: "TSLA251219C00400000",
				Side: "buy", Qty: 1, Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(1.25),
				PositionIntent: "buy_to_open", Purpose: "entry",
				BrokerAccountID: identity.BrokerAccountID, PaperLive: identity.PaperLive, TenantID: identity.TenantID, SandboxID: identity.SandboxID,
			}
			if testCase.mutate != nil {
				testCase.mutate(result)
			}
			trading := &optionsResultTradingService{
				reconciliationTradingService: &reconciliationTradingService{},
				result:                       result,
			}
			controller := NewOrderController(trading, nil, storage)
			recorder := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			ctx.Request = httptest.NewRequest(http.MethodPost, "/api/options/order", bytes.NewBufferString(`{"client_order_id":"opt-identity-1","symbol":"TSLA251219C00400000","underlying":"TSLA","qty":1,"side":"buy","position_intent":"buy_to_open","type":"limit","limit_price":1.25}`))
			ctx.Request.Header.Set("Content-Type", "application/json")

			controller.PlaceOptionsOrder(ctx)
			if recorder.Code != testCase.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s", recorder.Code, testCase.wantStatus, recorder.Body.String())
			}
		})
	}
}

func TestPlaceOptionsOrderPassesStableIdentityFieldsAndAuditSinkToService(t *testing.T) {
	storage, err := database.NewLocalStorage(filepath.Join(t.TempDir(), "orders.db"))
	if err != nil {
		t.Fatalf("NewLocalStorage() error = %v", err)
	}
	defer storage.Close()
	identity := storage.DurableIdentity()
	limit := 1.25
	maxLoss := 42.0
	observedAt := time.Date(2026, 9, 23, 13, 0, 0, 0, time.UTC)
	trading := &recordingOptionsTradingService{
		reconciliationTradingService: &reconciliationTradingService{},
		result: &interfaces.OrderResult{
			OrderID: "broker-boundary-1", Status: "accepted", ClientOrderID: "opt-boundary-1",
			Symbol: "TSLA251219C00400000", Side: "buy", Qty: 2, Type: "limit", TimeInForce: "day", LimitPrice: &limit,
			PositionIntent: "buy_to_open", Purpose: "entry", BrokerAccountID: identity.BrokerAccountID, PaperLive: identity.PaperLive,
			TenantID: identity.TenantID, SandboxID: identity.SandboxID,
		},
	}
	controller := NewOrderController(trading, nil, storage)
	body := `{"client_order_id":"opt-boundary-1","symbol":"TSLA251219C00400000","underlying":"TSLA","qty":2,"side":"buy","position_intent":"buy_to_open","type":"limit","time_in_force":"day","limit_price":1.25,"strategy_type":"vertical","max_loss":42,"observed_at":"2026-09-23T13:00:00Z"}`
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/options/order", bytes.NewBufferString(body))
	ctx.Request.Header.Set("Content-Type", "application/json")
	controller.PlaceOptionsOrder(ctx)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	passed := trading.identity
	if passed == nil {
		t.Fatal("service did not receive an options order")
	}
	if !trading.auditCalled {
		t.Fatal("service did not invoke the assessment audit sink")
	}
	if passed.ClientOrderID != "opt-boundary-1" || passed.Symbol != "TSLA251219C00400000" || passed.Underlying != "TSLA" || passed.Qty != 2 || passed.Side != "buy" || passed.PositionIntent != "buy_to_open" || passed.Type != "limit" || passed.TimeInForce != "day" || passed.LimitPrice == nil || *passed.LimitPrice != limit || passed.StrategyType != "vertical" || passed.AssessmentMaxLoss == nil || *passed.AssessmentMaxLoss != maxLoss || !passed.ObservedAt.Equal(observedAt) {
		t.Fatalf("service received incomplete options order: %#v", passed)
	}
	if passed.AssessmentAuditSink == nil {
		t.Fatal("service did not receive the assessment audit sink")
	}
	durable, err := storage.GetOrderByClientOrderID("opt-boundary-1")
	if err != nil {
		t.Fatalf("GetOrderByClientOrderID() error = %v", err)
	}
	if durable == nil || !strings.Contains(durable.Metadata, "assessment-controller-boundary") {
		t.Fatalf("durable intent metadata = %#v, want assessment audit", durable)
	}
}

func (s *plannedOptionsTradingService) PlaceOptionsOrder(context.Context, *interfaces.OptionsOrder) (*interfaces.OrderResult, error) {
	return nil, &services.MarketClosedError{NextOpen: s.nextOpen}
}

func TestPlaceOptionsOrderPersistsPlannedIntentWhenMarketClosed(t *testing.T) {
	storage, err := database.NewLocalStorage(filepath.Join(t.TempDir(), "orders.db"))
	if err != nil {
		t.Fatalf("NewLocalStorage() error = %v", err)
	}
	defer storage.Close()

	nextOpen := time.Date(2026, 9, 21, 13, 30, 0, 0, time.UTC)
	trading := &plannedOptionsTradingService{
		reconciliationTradingService: &reconciliationTradingService{},
		nextOpen:                     nextOpen,
	}
	controller := NewOrderController(trading, nil, storage)

	body, err := json.Marshal(map[string]any{
		"client_order_id": "opt-planned-1",
		"symbol":          "TSLA251219C00400000",
		"underlying":      "TSLA",
		"qty":             1,
		"side":            "buy",
		"position_intent": "buy_to_open",
		"type":            "limit",
		"limit_price":     1.25,
	})
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/options/order", bytes.NewReader(body))
	ctx.Request.Header.Set("Content-Type", "application/json")
	controller.PlaceOptionsOrder(ctx)

	if ctx.Writer.Status() != http.StatusAccepted {
		t.Fatalf("status = %d, want %d", ctx.Writer.Status(), http.StatusAccepted)
	}
	var response interfaces.OrderResult
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("response JSON error = %v; body=%s", err, recorder.Body.String())
	}
	if response.Status != "planned_for_next_session" || response.ClientOrderID == "" || response.NextEligibleAt == nil || !response.NextEligibleAt.Equal(nextOpen) {
		t.Fatalf("response = %#v, want planned status, stable client ID, and next open", response)
	}

	var retryPayload map[string]any
	if err := json.Unmarshal(body, &retryPayload); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	retryPayload["client_order_id"] = response.ClientOrderID
	planned, err := storage.GetOrderByClientOrderID(response.ClientOrderID)
	if err != nil {
		t.Fatalf("GetOrderByClientOrderID() error = %v", err)
	}
	eligible := time.Now().Add(-time.Minute)
	expires := time.Now().Add(time.Hour)
	planned.NextEligibleAt = &eligible
	planned.ExpiresAt = &expires
	if err := storage.SaveOrder(planned); err != nil {
		t.Fatalf("SaveOrder(eligible retry) error = %v", err)
	}
	retryBody, err := json.Marshal(retryPayload)
	if err != nil {
		t.Fatalf("Marshal(retry) error = %v", err)
	}
	retryRecorder := httptest.NewRecorder()
	retryCtx, _ := gin.CreateTestContext(retryRecorder)
	retryCtx.Request = httptest.NewRequest(http.MethodPost, "/api/options/order", bytes.NewReader(retryBody))
	retryCtx.Request.Header.Set("Content-Type", "application/json")
	controller.PlaceOptionsOrder(retryCtx)
	if retryCtx.Writer.Status() != http.StatusAccepted {
		t.Fatalf("retry status = %d, want %d", retryCtx.Writer.Status(), http.StatusAccepted)
	}

	listRecorder := httptest.NewRecorder()
	listCtx, _ := gin.CreateTestContext(listRecorder)
	listCtx.Request = httptest.NewRequest(http.MethodGet, "/api/orders?status=all", nil)
	controller.HandleGetOrders(listCtx)
	if listCtx.Writer.Status() != http.StatusOK {
		t.Fatalf("list status = %d, want %d", listCtx.Writer.Status(), http.StatusOK)
	}
	var visibleResponse struct {
		Orders   []*interfaces.Order `json:"orders"`
		Complete bool                `json:"complete"`
	}
	if err := json.Unmarshal(listRecorder.Body.Bytes(), &visibleResponse); err != nil {
		t.Fatalf("visible orders JSON error = %v; body=%s", err, listRecorder.Body.String())
	}
	visible := visibleResponse.Orders
	if !visibleResponse.Complete || len(visible) != 1 || visible[0].Status != "planned_for_next_session" || visible[0].ClientOrderID != response.ClientOrderID {
		t.Fatalf("visible orders = %#v, want one durable planned intent", visible)
	}

	plannedOrders, err := storage.GetOrders("planned_for_next_session")
	if err != nil {
		t.Fatalf("GetOrders() error = %v", err)
	}
	if len(plannedOrders) != 1 || plannedOrders[0].AssetClass != "us_option" || plannedOrders[0].Underlying != "TSLA" || plannedOrders[0].PositionIntent != "buy_to_open" || plannedOrders[0].ID != "" {
		t.Fatalf("planned order = %#v, want durable unsubmitted option intent", plannedOrders)
	}
}

func TestPlannedIntentEligibilityWinsAtExactSessionOpen(t *testing.T) {
	now := time.Date(2026, 9, 21, 13, 30, 0, 0, time.UTC)
	expires := now.Add(time.Hour)
	order := &interfaces.Order{Status: "planned_for_next_session", NextEligibleAt: &now, ExpiresAt: &expires}
	controller := &OrderController{}
	eligible, expired := controller.plannedIntentState(order, now)
	if !eligible || expired {
		t.Fatalf("at next eligible boundary: eligible=%v expired=%v; want eligible=true expired=false", eligible, expired)
	}
	stale := now.Add(2 * time.Hour)
	eligible, expired = controller.plannedIntentState(order, stale)
	if eligible || !expired {
		t.Fatalf("after explicit expiry: eligible=%v expired=%v; want eligible=false expired=true", eligible, expired)
	}
}
