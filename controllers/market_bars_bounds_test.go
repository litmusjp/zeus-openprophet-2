package controllers

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"prophet-trader/interfaces"
)

type recordingBars struct {
	start, end time.Time
	ctx        context.Context
}

func (r *recordingBars) GetHistoricalBars(ctx context.Context, _ string, start, end time.Time, _ string) ([]*interfaces.Bar, error) {
	r.ctx, r.start, r.end = ctx, start, end
	return []*interfaces.Bar{{Symbol: "X"}}, nil
}
func (*recordingBars) GetLatestBar(context.Context, string) (*interfaces.Bar, error) { return nil, nil }
func (*recordingBars) GetLatestQuote(context.Context, string) (*interfaces.Quote, error) {
	return nil, nil
}
func (*recordingBars) GetLatestTrade(context.Context, string) (*interfaces.Trade, error) {
	return nil, nil
}
func (*recordingBars) StreamBars(context.Context, []string) (<-chan *interfaces.Bar, error) {
	return nil, nil
}

func requestBars(t *testing.T, query string, data *recordingBars) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Params = gin.Params{{Key: "symbol", Value: "X"}}
	req := httptest.NewRequest("GET", "/?"+query, nil).WithContext(context.WithValue(context.Background(), barsContextKey{}, "request"))
	c.Request = req
	NewOrderController(nil, data, nil).HandleGetBars(c)
	return w
}

type barsContextKey struct{}

func TestHandleGetBarsDateBoundsAreTradingDaysAndValidated(t *testing.T) {
	data := &recordingBars{}
	r := requestBars(t, "start=2026-03-09&end=2026-03-09&timeframe=1Min", data)
	if r.Code != 200 || data.end.Sub(data.start) < time.Hour*6 {
		t.Fatalf("same-day bars = %d, %v..%v", r.Code, data.start, data.end)
	}
	if data.ctx.Value(barsContextKey{}) != "request" {
		t.Fatal("request context was not propagated")
	}
	if _, err := time.LoadLocation("America/New_York"); err != nil {
		t.Fatal(err)
	}
	loc, _ := time.LoadLocation("America/New_York")
	if data.start.Location().String() != loc.String() || data.start.Hour() != 0 {
		t.Fatalf("start not NY midnight: %v", data.start)
	}
	data = &recordingBars{}
	requestBars(t, "start=2026-03-08&end=2026-03-08&timeframe=5Min", data)
	if data.end.Sub(data.start) != 23*time.Hour {
		t.Fatalf("DST trading day duration=%v", data.end.Sub(data.start))
	}
	data = &recordingBars{}
	requestBars(t, "start=2026-03-07&end=2026-03-09", data)
	if data.end.Sub(data.start) != 71*time.Hour {
		t.Fatalf("multi-day range duration=%v", data.end.Sub(data.start))
	}
	data = &recordingBars{}
	requestBars(t, "start=2026-10-13T13:15:00Z&end=2026-10-13T14:45:00Z", data)
	if data.start.Format(time.RFC3339) != "2026-10-13T13:15:00Z" || data.end.Format(time.RFC3339) != "2026-10-13T14:45:00Z" {
		t.Fatalf("timestamp bounds=%v..%v", data.start, data.end)
	}
	today := time.Now().In(loc).Format("2006-01-02")
	data = &recordingBars{}
	requestBars(t, "start="+today+"&end="+today, data)
	if data.end.After(time.Now().Add(time.Second)) {
		t.Fatalf("today not capped: %v", data.end)
	}
	r = requestBars(t, "start=bad&end=2026-03-09", &recordingBars{})
	if r.Code != 400 {
		t.Fatalf("bad date status %d", r.Code)
	}
	r = requestBars(t, "start=2026-03-10&end=2026-03-09", &recordingBars{})
	if r.Code != 400 {
		t.Fatalf("inverted status %d", r.Code)
	}
}
