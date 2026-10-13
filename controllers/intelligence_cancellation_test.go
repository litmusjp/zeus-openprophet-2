package controllers

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"prophet-trader/interfaces"
	"prophet-trader/services"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

type canceledRequestDataService struct{ observed chan bool }

func (s canceledRequestDataService) GetLatestQuote(ctx context.Context, _ string) (*interfaces.Quote, error) {
	s.observed <- ctx.Err() != nil
	return nil, errors.New("fixture canceled request")
}
func (canceledRequestDataService) GetHistoricalBars(context.Context, string, time.Time, time.Time, string) ([]*interfaces.Bar, error) {
	return nil, nil
}
func (canceledRequestDataService) GetLatestBar(context.Context, string) (*interfaces.Bar, error) {
	return nil, nil
}
func (canceledRequestDataService) GetLatestTrade(context.Context, string) (*interfaces.Trade, error) {
	return nil, nil
}
func (canceledRequestDataService) StreamBars(context.Context, []string) (<-chan *interfaces.Bar, error) {
	return nil, nil
}

func TestAnalyzeMultiplePropagatesCanceledRequestContext(t *testing.T) {
	gin.SetMode(gin.TestMode)
	observed := make(chan bool, 1)
	analysis := services.NewStockAnalysisService(canceledRequestDataService{observed: observed}, nil, nil)
	controller := &IntelligenceController{stockAnalysisService: analysis}
	router := gin.New()
	router.POST("/api/v1/intelligence/analyze-multiple", controller.HandleAnalyzeMultipleStocks)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/intelligence/analyze-multiple", strings.NewReader(`{"symbols":["AAPL"]}`)).WithContext(ctx)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if !<-observed {
		t.Fatal("analysis service did not receive canceled HTTP request context")
	}
}
