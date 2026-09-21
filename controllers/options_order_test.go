package controllers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
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
