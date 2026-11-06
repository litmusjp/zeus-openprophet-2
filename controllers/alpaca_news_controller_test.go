package controllers

import (
	"context"
	"testing"

	"github.com/gin-gonic/gin"

	"prophet-trader/services"
)

type fakeNewsService struct {
	*reconciliationTradingService
	result  services.AlpacaNewsResult
	err     error
	request services.AlpacaNewsRequest
}

func (s *fakeNewsService) GetAlpacaNews(_ context.Context, req services.AlpacaNewsRequest) (services.AlpacaNewsResult, error) {
	s.request = req
	return s.result, s.err
}

func TestAlpacaNewsEndpointDefaultsToTheAlphaDeskWindowAndPassesThrough(t *testing.T) {
	fake := &fakeNewsService{reconciliationTradingService: &reconciliationTradingService{}, result: services.AlpacaNewsResult{
		Provider: "alpaca", Status: "available", Count: 1, HasMore: true, NextPageToken: "TOKEN",
		Articles: []services.AlpacaNewsArticle{{ID: 7, Headline: "h", Source: "benzinga", CreatedAt: "2026-11-06T00:00:00Z", UpdatedAt: "2026-11-06T01:00:00Z"}},
	}}
	controller := NewOrderController(fake, nil, nil)
	recorder, body := getJSON(t, controller.HandleGetAlpacaNews, "/x?symbols=aapl,%20nvda,AAPL", gin.Params{})
	if recorder.Code != 200 || body["provider"] != "alpaca" || body["has_more"] != true || body["next_page_token"] != "TOKEN" {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if got := fake.request.Symbols; len(got) != 2 || got[0] != "AAPL" || got[1] != "NVDA" {
		t.Fatalf("symbols are upper-cased and de-duplicated: %v", got)
	}
	if hours := fake.request.End.Sub(fake.request.Start).Hours(); hours < 35.99 || hours > 36.01 || fake.request.Limit != 20 {
		t.Fatalf("default window must be 36 hours and limit 20: hours=%v limit=%d", hours, fake.request.Limit)
	}
	articles := body["articles"].([]interface{})
	first := articles[0].(map[string]interface{})
	if first["source"] != "benzinga" || first["created_at"] == first["updated_at"] {
		t.Fatalf("source and both clocks are passed through: %v", first)
	}
}

func TestAlpacaNewsEndpointForwardsHoursLimitAndPageToken(t *testing.T) {
	fake := &fakeNewsService{reconciliationTradingService: &reconciliationTradingService{}, result: services.AlpacaNewsResult{Provider: "alpaca", Status: "empty"}}
	controller := NewOrderController(fake, nil, nil)
	recorder, _ := getJSON(t, controller.HandleGetAlpacaNews, "/x?symbols=SPY&hours=12&limit=5&page_token=ABC", gin.Params{})
	if recorder.Code != 200 || fake.request.Limit != 5 || fake.request.PageToken != "ABC" {
		t.Fatalf("status=%d request=%+v", recorder.Code, fake.request)
	}
	if hours := fake.request.End.Sub(fake.request.Start).Hours(); hours < 11.99 || hours > 12.01 {
		t.Fatalf("hours = %v", hours)
	}
}

func TestAlpacaNewsEndpointValidatesInput(t *testing.T) {
	controller := NewOrderController(&fakeNewsService{reconciliationTradingService: &reconciliationTradingService{}}, nil, nil)
	for _, path := range []string{"/x", "/x?symbols=bad%20symbol", "/x?symbols=AAPL&hours=0", "/x?symbols=AAPL&hours=999", "/x?symbols=AAPL&limit=0", "/x?symbols=AAPL&limit=51", "/x?symbols=AAPL&hours=abc"} {
		if recorder, _ := getJSON(t, controller.HandleGetAlpacaNews, path, gin.Params{}); recorder.Code != 400 {
			t.Fatalf("%s should be 400, got %d", path, recorder.Code)
		}
	}
}

func TestAlpacaNewsEndpointReportsFailuresAsUnavailableWithACategory(t *testing.T) {
	for category, status := range map[string]int{"permission": 403, "rate_limited": 429, "timeout": 0, "provider_unavailable": 500} {
		fake := &fakeNewsService{reconciliationTradingService: &reconciliationTradingService{}, err: &services.AlpacaNewsError{Category: category, Status: status}}
		controller := NewOrderController(fake, nil, nil)
		recorder, body := getJSON(t, controller.HandleGetAlpacaNews, "/x?symbols=AAPL", gin.Params{})
		if recorder.Code != 503 || body["status"] != "unavailable" || body["category"] != category {
			t.Fatalf("%s: status=%d body=%s", category, recorder.Code, recorder.Body.String())
		}
	}
	plain := NewOrderController(&reconciliationTradingService{}, nil, nil)
	if recorder, body := getJSON(t, plain.HandleGetAlpacaNews, "/x?symbols=AAPL", gin.Params{}); recorder.Code != 503 || body["status"] != "unavailable" {
		t.Fatalf("a service without news support must be unavailable: %d %s", recorder.Code, recorder.Body.String())
	}
}
